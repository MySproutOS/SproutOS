//! The `storage-proxy` binary: an axum server that authorizes, then forwards.
//!
//! Everything that decides anything lives in `lib.rs`; this file is the socket, the body spool, and
//! the two cases that only exist because a browser is on the other end — the CORS preflight and the
//! CORS response headers.

mod metering;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use futures_util::StreamExt;
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use sproutos_metering_proto::UsageDimension;
use sproutos_service_credentials::CredentialStore;
use storage_proxy::{
    Denied, IncomingRequest, OutgoingRequest, Proxy, UpstreamCredentialProvider, bucket_from_path,
    finish_authorization_with_payload_hash, is_list, is_listing_response, prepare_authorization,
    strip_prefix_from_listing, upstream_headers, upstream_path, upstream_query,
};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;
use tracing::{debug, info, warn};

use crate::metering::{StorageMeter, StorageUsage};

/// The origins a vault client sends. Mirrors `VAULT_ORIGINS` in `lib/typescript/services`.
///
/// The proxy is the origin a browser sees now, not the bucket, so these have to be answered here.
/// Obsidian desktop sends `app://obsidian.md` and mobile `capacitor://localhost`; an endpoint that
/// does not name them fails the preflight, and the plugin reports something the customer cannot
/// tell from a wrong key.
const VAULT_ORIGINS: [&str; 3] = [
    "app://obsidian.md",
    "capacitor://localhost",
    "http://localhost",
];

/// Headers a client may send on a signed request.
///
/// `*` would be simpler and is not allowed to mean anything useful here: a request carrying
/// `Authorization` is credentialed, and the wildcard is ignored for credentialed requests.
const ALLOWED_HEADERS: &str = "authorization,content-type,content-length,content-md5,\
x-amz-content-sha256,x-amz-date,x-amz-security-token,x-amz-acl,x-amz-meta-*,range,if-match,\
if-none-match";

/// Headers the plugin needs to be able to read off the response.
///
/// `ETag` is load-bearing: `livesync` reads it to decide what changed, and a cross-origin response
/// without it makes every object look new — a full resync of the customer's vault, on every open.
const EXPOSED_HEADERS: &str = "ETag,Content-Length,Content-Type,x-amz-request-id,x-amz-version-id";

// Four simultaneous 64 MiB disk spools bound ephemeral storage at 256 MiB while keeping request
// bodies out of the 1 GiB router host's RAM. High-level S3 clients multipart large files into parts
// below this ceiling. Both values may be lowered operationally, but invalid or zero overrides are
// refused at boot rather than silently removing the bound.
const DEFAULT_MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const DEFAULT_MAX_INFLIGHT_BODIES: usize = 4;
const DEFAULT_BODY_READ_TIMEOUT_SECONDS: usize = 300;

struct AppState {
    proxy: Arc<Proxy>,
    body_slots: tokio::sync::Semaphore,
    max_body_bytes: usize,
    body_read_timeout: Duration,
    credit: Option<redis::aio::ConnectionManager>,
    meter: Option<StorageMeter>,
}

fn positive_usize(name: &str, default: usize) -> anyhow::Result<usize> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<usize>()
            .ok()
            .filter(|parsed| *parsed > 0)
            .ok_or_else(|| anyhow::anyhow!("{name} must be a positive integer")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(cause) => Err(anyhow::anyhow!("{name} is not valid Unicode: {cause}")),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "storage_proxy=info".into()),
        )
        .init();

    let listen: SocketAddr = std::env::var("STORAGE_PROXY_LISTEN")
        .unwrap_or_else(|_| "0.0.0.0:9000".into())
        .parse()?;
    let upstream = std::env::var("STORAGE_PROXY_UPSTREAM").map_err(|_| {
        anyhow::anyhow!("STORAGE_PROXY_UPSTREAM is not set; there is nowhere to forward to")
    })?;
    let region = std::env::var("STORAGE_PROXY_REGION")
        .or_else(|_| std::env::var("AWS_REGION"))
        .map_err(|_| anyhow::anyhow!("STORAGE_PROXY_REGION is not set; SigV4 needs a region"))?;

    // The root key is the one secret this process cannot start without: every tenant's secret is a
    // function of it, so a default would make every deployment's credentials identical.
    let root_key = std::env::var("SERVICE_OBJECT_STORAGE_ROOT_KEY").map_err(|_| {
        anyhow::anyhow!("SERVICE_OBJECT_STORAGE_ROOT_KEY is not set; no tenant could be verified")
    })?;

    // The default chain supports local environment credentials as well as refreshable ECS task,
    // web-identity, profile and instance credentials. Keep the provider rather than extracting a
    // credential once: temporary role credentials expire while this process is still running.
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let credential_provider = UpstreamCredentialProvider::new(
        aws_config
            .credentials_provider()
            .ok_or_else(|| anyhow::anyhow!("the AWS default credential chain is unavailable"))?,
    );
    // Fail a deployment at boot when the chain cannot resolve at all. The result is deliberately
    // discarded; the refreshable provider remains in the proxy and supplies each request.
    credential_provider
        .current()
        .await
        .map_err(|cause| anyhow::anyhow!("the AWS default credential chain failed: {cause}"))?;

    let database_url = std::env::var("STORAGE_PROXY_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .map_err(|_| {
            anyhow::anyhow!("STORAGE_PROXY_DATABASE_URL is not set; the proxy cannot authenticate")
        })?;
    let pool_size: usize = std::env::var("STORAGE_PROXY_DB_POOL")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8);

    let store = Arc::new(CredentialStore::connect(&database_url, pool_size)?);
    // Checked at boot: a bad URL should stop a deploy rather than turn every customer's first sync
    // into an operational error.
    store.check().await?;

    let credit = match std::env::var("VALKEY_URL") {
        Ok(url) if !url.is_empty() => Some(
            redis::Client::open(url)?
                .get_connection_manager()
                .await
                .map_err(|cause| anyhow::anyhow!("credit-state Valkey is unavailable: {cause}"))?,
        ),
        _ => {
            warn!("VALKEY_URL is not configured; object-storage credit cutoff is disabled");
            None
        }
    };

    let metering_required = std::env::var("STORAGE_METERING_REQUIRED").as_deref() == Ok("1");
    let ingest_url = std::env::var("METERING_INGEST_URL")
        .ok()
        .filter(|value| !value.is_empty());
    let metering_key = std::env::var("METERING_INGEST_HMAC_KEY")
        .ok()
        .filter(|value| !value.is_empty());
    let meter = match (ingest_url, metering_key) {
        (Some(ingest_url), Some(metering_key)) => {
            let directory = std::env::var("STORAGE_METERING_SPOOL_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| std::path::PathBuf::from(".data/storage-metering"));
            let spool = sproutos_llm_proxy::spool::MeteringSpool::open(
                directory,
                sproutos_llm_proxy::spool::SpoolLimits::default(),
            )?;
            spool.spawn_delivery(sproutos_llm_proxy::spool::DeliveryConfig::new(
                reqwest::Client::new(),
                ingest_url,
                metering_key.into_bytes(),
            ));
            Some(StorageMeter::new(spool))
        }
        _ if metering_required => {
            anyhow::bail!(
                "storage metering is required but METERING_INGEST_URL or METERING_INGEST_HMAC_KEY is missing"
            )
        }
        _ => {
            warn!("object-storage metering is not configured; intended only for local development");
            None
        }
    };

    let proxy = Arc::new(Proxy {
        store,
        root_key,
        upstream: upstream.trim_end_matches('/').to_owned(),
        region,
        credential_provider,
        shared_bucket: std::env::var("STORAGE_PROXY_SHARED_BUCKET").ok(),
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()?,
    });

    let max_body_bytes = positive_usize("STORAGE_PROXY_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)?;
    let max_inflight = positive_usize(
        "STORAGE_PROXY_MAX_INFLIGHT_BODIES",
        DEFAULT_MAX_INFLIGHT_BODIES,
    )?;
    let body_read_timeout = Duration::from_secs(
        positive_usize(
            "STORAGE_PROXY_BODY_READ_TIMEOUT_SECONDS",
            DEFAULT_BODY_READ_TIMEOUT_SECONDS,
        )?
        .try_into()
        .map_err(|_| anyhow::anyhow!("STORAGE_PROXY_BODY_READ_TIMEOUT_SECONDS is too large"))?,
    );
    let state = Arc::new(AppState {
        proxy,
        body_slots: tokio::sync::Semaphore::new(max_inflight),
        max_body_bytes,
        body_read_timeout,
        credit,
        meter,
    });

    let app = Router::new().fallback(any(handle)).with_state(state);

    let listener = tokio::net::TcpListener::bind(listen).await?;
    info!(%listen, "storage-proxy listening");
    axum::serve(listener, app).await?;
    Ok(())
}

/// `<Error><Code>…` — the shape every S3 client already knows how to report.
///
/// A JSON body or a bare status would surface inside the AWS SDK as an unparseable response, and the
/// customer would see "UnknownError" for what is actually a clear refusal.
fn s3_error(denied: &Denied, origin: Option<&str>) -> Response {
    let (status, code, message) = denied.as_s3_error();
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
<Error><Code>{code}</Code><Message>{message}</Message></Error>"
    );

    let mut response = (
        StatusCode::from_u16(status).unwrap_or(StatusCode::FORBIDDEN),
        body,
    )
        .into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/xml"),
    );
    // CORS on the error too. Without it the browser replaces a legible 403 with an opaque network
    // failure, and the customer is told nothing at all.
    apply_cors(response.headers_mut(), origin);
    response
}

fn body_error(
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    origin: Option<&str>,
) -> Response {
    let mut response = (
        status,
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>{code}</Code><Message>{message}</Message></Error>"
        ),
    )
        .into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/xml"),
    );
    apply_cors(response.headers_mut(), origin);
    response
}

#[derive(Debug, Eq, PartialEq)]
enum BodyReadFailure {
    TooLarge,
    Rejected,
    TimedOut,
    Spool,
}

struct SpooledBody {
    file: tokio::fs::File,
    len: u64,
    payload_hash: String,
}

struct MeteredResponseStream {
    inner: Pin<Box<dyn futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    usage: Option<StorageUsage>,
    bytes: u64,
}

impl MeteredResponseStream {
    fn new(
        stream: impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
        usage: Option<StorageUsage>,
    ) -> Self {
        Self {
            inner: Box::pin(stream),
            usage,
            bytes: 0,
        }
    }

    fn commit(&mut self) {
        if let Some(usage) = self.usage.take() {
            usage.commit(self.bytes);
        }
    }
}

impl futures_util::Stream for MeteredResponseStream {
    type Item = Result<Bytes, reqwest::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => {
                self.bytes = self.bytes.saturating_add(bytes.len() as u64);
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(None) => {
                self.commit();
                Poll::Ready(None)
            }
            other => other,
        }
    }
}

impl Drop for MeteredResponseStream {
    fn drop(&mut self) {
        // A disconnected client still received `bytes`; the unused reservation is committed with
        // that partial transfer rather than silently turning delivered traffic into free traffic.
        self.commit();
    }
}

async fn spool_body(
    body: Body,
    max_body_bytes: usize,
    timeout: Duration,
) -> Result<SpooledBody, BodyReadFailure> {
    let receive = async move {
        let file = tempfile::tempfile().map_err(|_| BodyReadFailure::Spool)?;
        let mut file = tokio::fs::File::from_std(file);
        let mut stream = body.into_data_stream();
        let mut payload_hash = Sha256::new();
        let mut len = 0_u64;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| BodyReadFailure::Rejected)?;
            len = len
                .checked_add(chunk.len() as u64)
                .ok_or(BodyReadFailure::TooLarge)?;
            if len > max_body_bytes as u64 {
                return Err(BodyReadFailure::TooLarge);
            }
            payload_hash.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| BodyReadFailure::Spool)?;
        }

        file.flush().await.map_err(|_| BodyReadFailure::Spool)?;
        file.rewind().await.map_err(|_| BodyReadFailure::Spool)?;
        Ok(SpooledBody {
            file,
            len,
            payload_hash: hex::encode(payload_hash.finalize()),
        })
    };

    tokio::time::timeout(timeout, receive)
        .await
        .map_err(|_| BodyReadFailure::TimedOut)?
}

fn declared_body_too_large(headers: &BTreeMap<String, String>, max_body_bytes: usize) -> bool {
    headers
        .get("content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > max_body_bytes as u64)
}

fn billable_dimension(method: &str, path: &str, query: &str) -> Option<UsageDimension> {
    let bucket = bucket_from_path(path).unwrap_or_default();
    if is_list(method, bucket, path, query) {
        return Some(UsageDimension::ObjectStorageWriteRequest);
    }
    match method {
        "PUT" | "POST" => Some(UsageDimension::ObjectStorageWriteRequest),
        "GET" | "HEAD" => Some(UsageDimension::ObjectStorageReadRequest),
        // S3 does not charge for DELETE. OPTIONS and health checks never reach this function.
        _ => None,
    }
}

async fn credit_exhausted(
    manager: Option<&redis::aio::ConnectionManager>,
    organization_id: uuid::Uuid,
) -> bool {
    let Some(manager) = manager else {
        return false;
    };
    let mut connection = manager.clone();
    match connection
        .get::<_, Option<String>>(format!("credit:{organization_id}"))
        .await
    {
        Ok(Some(state)) => state == "exhausted",
        Ok(None) => false,
        Err(cause) => {
            warn!(%cause, %organization_id, "could not read object-storage credit state");
            false
        }
    }
}

/// Reflect the request's origin when it is one we serve.
///
/// Reflected rather than wildcarded because these responses are credentialed, and
/// `Access-Control-Allow-Origin: *` is ignored on a credentialed request. Only the known origins are
/// reflected — echoing whatever arrives would make every site a customer visits able to read their
/// vault with their own cookies.
fn apply_cors(headers: &mut axum::http::HeaderMap, origin: Option<&str>) {
    let Some(origin) = origin.filter(|value| VAULT_ORIGINS.contains(value)) else {
        return;
    };
    let Ok(value) = HeaderValue::from_str(origin) else {
        return;
    };

    headers.insert(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    headers.insert(
        axum::http::header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSED_HEADERS),
    );
    headers.insert(axum::http::header::VARY, HeaderValue::from_static("Origin"));
}

async fn handle(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let path = uri.path().to_owned();
    let query = uri.query().unwrap_or("").to_owned();

    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    for (name, value) in request.headers() {
        if let Ok(text) = value.to_str() {
            headers.insert(name.as_str().to_ascii_lowercase(), text.to_owned());
        }
    }
    let origin = headers.get("origin").cloned();

    /*
      Liveness, before anything that needs a credential.

      A probe cannot sign a request, and the alternative — a TCP check — goes ready as soon as the
      socket binds, which is before the control-plane pool has been checked. `/healthz` cannot
      collide with a bucket: every bucket this serves is named `v-<short-id>`.

      It says only "up". Whether the database is reachable is deliberately not reported: a
      control-plane blip would then roll every proxy pod at once, and a proxy that cannot look up a
      credential should refuse requests, not leave the cluster.
    */
    if path == "/healthz" {
        return (StatusCode::OK, "ok").into_response();
    }

    /*
      The preflight is answered here and never forwarded.

      A browser sends `OPTIONS` with no `Authorization` — that is the point of a preflight — so it
      cannot be authenticated, and forwarding it would ask S3 to answer for a tenant nobody has
      identified. There is nothing secret in the answer: it says which methods and headers this
      endpoint accepts, which is the same for every tenant.
    */
    if method == axum::http::Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_cors(response.headers_mut(), origin.as_deref());
        response.headers_mut().insert(
            axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET,PUT,POST,DELETE,HEAD"),
        );
        response.headers_mut().insert(
            axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(ALLOWED_HEADERS),
        );
        response.headers_mut().insert(
            axum::http::header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("3000"),
        );
        return response;
    }

    // Reject unsigned, unknown-key and bad UNSIGNED-PAYLOAD signatures before admitting the body.
    // Without this ordering any anonymous caller could consume one full body allocation merely to
    // receive the 403 that was knowable from its headers.
    let headers_only = IncomingRequest {
        method: method.as_str(),
        path: &path,
        query: &query,
        headers: headers.clone(),
        body: &[],
    };
    let prepared = match prepare_authorization(&state.proxy, &headers_only).await {
        Ok(prepared) => prepared,
        Err(denied) => {
            warn!(%method, %path, %denied, "refused before body admission");
            return s3_error(&denied, origin.as_deref());
        }
    };

    // Content-Length is not trusted for correctness — the bounded reader below remains the
    // authority — but rejecting an honest oversized upload here avoids reserving one of the four
    // scarce body slots for bytes that can never be accepted.
    if declared_body_too_large(&headers, state.max_body_bytes) {
        return body_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "EntityTooLarge",
            "The request body is too large.",
            origin.as_deref(),
        );
    }

    // Do not queue an unbounded number of authenticated bodies behind the four disk spools. A
    // valid tenant can retry SlowDown; the router sharing this host cannot recover from an OOM.
    let _body_slot = match state.body_slots.try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            return body_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "SlowDown",
                "Reduce your request rate.",
                origin.as_deref(),
            );
        }
    };

    // SigV4 commits to the payload digest before S3 sees the request. Write into an unlinked
    // temporary file while hashing, then verify that digest before forwarding. This preserves body
    // integrity without turning four multipart uploads into four large resident allocations.
    let body = match spool_body(
        request.into_body(),
        state.max_body_bytes,
        state.body_read_timeout,
    )
    .await
    {
        Ok(body) => body,
        Err(BodyReadFailure::TooLarge) => {
            return body_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "EntityTooLarge",
                "The request body is too large.",
                origin.as_deref(),
            );
        }
        Err(BodyReadFailure::Rejected) => {
            return body_error(
                StatusCode::BAD_REQUEST,
                "IncompleteBody",
                "The request body could not be read.",
                origin.as_deref(),
            );
        }
        Err(BodyReadFailure::TimedOut) => {
            return body_error(
                StatusCode::REQUEST_TIMEOUT,
                "RequestTimeout",
                "The request body took too long to arrive.",
                origin.as_deref(),
            );
        }
        Err(BodyReadFailure::Spool) => {
            return body_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "SlowDown",
                "Temporary upload capacity is unavailable.",
                origin.as_deref(),
            );
        }
    };

    let incoming = IncomingRequest {
        method: method.as_str(),
        path: &path,
        query: &query,
        headers,
        body: &[],
    };

    let resolved = match finish_authorization_with_payload_hash(
        &state.proxy,
        &incoming,
        prepared,
        &body.payload_hash,
    )
    .await
    {
        Ok(resolved) => resolved,
        Err(denied) => {
            warn!(%method, %path, %denied, "refused");
            return s3_error(&denied, origin.as_deref());
        }
    };

    if credit_exhausted(state.credit.as_ref(), resolved.organization_id).await {
        return body_error(
            StatusCode::PAYMENT_REQUIRED,
            "InsufficientCredit",
            "This service is suspended until credit is available.",
            origin.as_deref(),
        );
    }

    let usage = match state.meter.as_ref() {
        Some(meter) => {
            match meter.begin(resolved, billable_dimension(method.as_str(), &path, &query)) {
                Ok(usage) => Some(usage),
                Err(cause) => {
                    warn!(%cause, service = %resolved.backend_service_id, "object-storage metering capacity is unavailable");
                    return body_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "SlowDown",
                        "Metering capacity is temporarily unavailable.",
                        origin.as_deref(),
                    );
                }
            }
        }
        None => None,
    };

    // At debug, not info: this is per-request on a data path. It exists because the question
    // "which S3 operations does this client actually use" has no other answer, and the IAM policy
    // the proxy runs under is built from that answer.
    debug!(
        %method,
        %path,
        service = %resolved.backend_service_id,
        bytes = body.len,
        "forwarding"
    );

    match forward(&state.proxy, &method, &path, &query, &incoming, body, usage).await {
        Ok(mut response) => {
            apply_cors(response.headers_mut(), origin.as_deref());
            response
        }
        Err(cause) => {
            warn!(
                service = %resolved.backend_service_id,
                %cause,
                "upstream request failed"
            );
            (StatusCode::BAD_GATEWAY, "upstream unavailable").into_response()
        }
    }
}

async fn forward(
    proxy: &Proxy,
    method: &axum::http::Method,
    path: &str,
    query: &str,
    incoming: &IncomingRequest<'_>,
    body: SpooledBody,
    usage: Option<StorageUsage>,
) -> anyhow::Result<Response> {
    /*
      Where the request actually goes.

      With a bucket per tenant this was the path the client sent, unchanged. With one shared bucket
      it is that path rewritten under the tenant's prefix — and the rewrite is the tenant boundary,
      so a key that could escape it is refused here rather than sanitised.
    */
    let (path, query) = match proxy.shared_bucket.as_deref() {
        None => (path.to_owned(), query.to_owned()),
        Some(shared) => {
            let tenant_bucket = bucket_from_path(path).unwrap_or_default();
            let listing = is_list(method.as_str(), tenant_bucket, path, query);

            let rewritten_query = if listing {
                upstream_query(tenant_bucket, query)
                    .map_err(|_| anyhow::anyhow!("the request key leaves the tenant's prefix"))?
            } else {
                query.to_owned()
            };

            let rewritten_path = if listing {
                // A list is on the bucket with a prefix, not on the prefix as a path: listing
                // `/shared/v-abc/` returns nothing, because that is not how S3 lists.
                format!("/{shared}")
            } else {
                upstream_path(shared, tenant_bucket, path)
                    .map_err(|_| anyhow::anyhow!("the request key leaves the tenant's prefix"))?
            };

            (rewritten_path, rewritten_query)
        }
    };
    let (path, query) = (path.as_str(), query.as_str());

    let target = if query.is_empty() {
        format!("{}{}", proxy.upstream, path)
    } else {
        format!("{}{}?{}", proxy.upstream, path, query)
    };
    let url = reqwest::Url::parse(&target)?;
    let host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_owned(),
    };

    let amz_date = now_amz_date();
    let credential = proxy.credential_provider.current().await?;
    let signed = upstream_headers(
        &proxy.region,
        &credential,
        &OutgoingRequest {
            method: method.as_str(),
            path,
            query,
            host: &host,
            payload_hash: &body.payload_hash,
            amz_date: &amz_date,
            content_type: incoming.headers.get("content-type").map(String::as_str),
        },
    );

    let mut builder = proxy.client.request(method.clone(), url);
    for (name, value) in &signed {
        // `host` is set by the HTTP client from the URL; setting it twice is how a request ends up
        // with two Host headers and a 400 from S3 with no explanation.
        if name == "host" {
            continue;
        }
        builder = builder.header(name.as_str(), value.as_str());
    }

    let upstream = builder
        .header(axum::http::header::CONTENT_LENGTH, body.len)
        .body(reqwest::Body::wrap_stream(ReaderStream::new(body.file)))
        .send()
        .await?;
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let tenant_bucket = bucket_from_path(incoming.path).unwrap_or_default();
    let rewrites_listing = proxy.shared_bucket.is_some()
        && status.is_success()
        && is_list(
            method.as_str(),
            tenant_bucket,
            incoming.path,
            incoming.query,
        );

    let mut response = Response::builder().status(status);
    for (name, value) in &upstream_headers {
        // Hop-by-hop headers belong to the two separate HTTP connections. Content-Length remains
        // valid for a byte-for-byte streamed object, but not for a listing whose keys are rewritten.
        if matches!(
            name.as_str(),
            "connection" | "transfer-encoding" | "keep-alive"
        ) || (rewrites_listing && name == axum::http::header::CONTENT_LENGTH)
        {
            continue;
        }
        if let Ok(name) = HeaderName::try_from(name.as_str()) {
            response = response.header(name, value.clone());
        }
    }

    if !rewrites_listing {
        // This is the common media GET path. No `bytes().await`: backpressure travels from the
        // customer socket through reqwest to S3, and the router retains only transport buffers.
        return Ok(response.body(Body::from_stream(MeteredResponseStream::new(
            upstream.bytes_stream(),
            usage,
        )))?);
    }

    let bytes = upstream.bytes().await?;

    /*
      A listing comes back naming the keys S3 stored, which all begin with the tenant's prefix.

      Told its object is `v-abc/notes/one.md`, a client stores that name and asks for the wrong
      thing next time — for `livesync`, a full resync of the vault on every open. Only listings are
      rewritten: an object body is the customer's bytes and must not be touched.
    */
    let bytes = if is_listing_response(&bytes) {
        match std::str::from_utf8(&bytes) {
            Ok(text) => Bytes::from(strip_prefix_from_listing(text, tenant_bucket)),
            Err(_) => bytes,
        }
    } else {
        bytes
    };
    if let Some(usage) = usage {
        usage.commit(bytes.len() as u64);
    }
    Ok(response.body(Body::from(bytes))?)
}

/// `YYYYMMDDTHHMMSSZ`, the only date format SigV4 accepts.
///
/// Formatted by hand from a unix timestamp rather than pulling in a date library: this is the one
/// place a date is needed, and the civil-from-days conversion below is Howard Hinnant's, which is
/// the algorithm every date library uses anyway.
fn now_amz_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let days = (secs / 86_400) as i64;
    let seconds_of_day = secs % 86_400;

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        y,
        m,
        d,
        seconds_of_day / 3600,
        (seconds_of_day % 3600) / 60,
        seconds_of_day % 60,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_a_date_the_way_sigv4_requires() {
        // A wrong date here is not a wrong timestamp, it is a signature over a different scope —
        // every request rejected, with "SignatureDoesNotMatch" and nothing pointing at the clock.
        assert_eq!(now_amz_date().len(), 16);
        assert!(now_amz_date().contains('T'));
        assert!(now_amz_date().ends_with('Z'));
    }

    #[test]
    fn exposes_the_etag_the_plugin_syncs_on() {
        // Stripped by CORS, every object looks new and the customer resyncs their whole vault.
        assert!(EXPOSED_HEADERS.contains("ETag"));
    }

    #[test]
    fn reflects_only_the_origins_it_serves() {
        // Echoing whatever arrives would let any site the customer visits read their vault.
        let mut headers = axum::http::HeaderMap::new();
        apply_cors(&mut headers, Some("https://evil.example.com"));
        assert!(headers.is_empty());

        apply_cors(&mut headers, Some("app://obsidian.md"));
        assert_eq!(
            headers
                .get(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "app://obsidian.md"
        );
    }

    #[test]
    fn rejects_a_declared_oversized_body_before_admission() {
        let mut headers = BTreeMap::new();
        headers.insert("content-length".to_owned(), "17".to_owned());
        assert!(declared_body_too_large(&headers, 16));

        headers.insert("content-length".to_owned(), "16".to_owned());
        assert!(!declared_body_too_large(&headers, 16));
    }

    #[tokio::test]
    async fn stops_a_body_that_never_arrives() {
        let stream = futures_util::stream::pending::<Result<Bytes, std::io::Error>>();
        let body = Body::from_stream(stream);
        assert!(matches!(
            spool_body(body, 16, Duration::from_millis(1)).await,
            Err(BodyReadFailure::TimedOut)
        ));
    }
}
