//! The `storage-proxy` binary: an axum server that authorizes, then forwards.
//!
//! Everything that decides anything lives in `lib.rs`; this file is the socket, the buffering, and
//! the two cases that only exist because a browser is on the other end — the CORS preflight and the
//! CORS response headers.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use sproutos_service_credentials::CredentialStore;
use storage_proxy::{
    Denied, IncomingRequest, OutgoingRequest, Proxy, UpstreamCredential, authorize,
    upstream_headers,
};
use tracing::{info, warn};

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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
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

    let credential = UpstreamCredential {
        access_key_id: std::env::var("AWS_ACCESS_KEY_ID")
            .map_err(|_| anyhow::anyhow!("AWS_ACCESS_KEY_ID is not set"))?,
        secret_access_key: std::env::var("AWS_SECRET_ACCESS_KEY")
            .map_err(|_| anyhow::anyhow!("AWS_SECRET_ACCESS_KEY is not set"))?,
        session_token: std::env::var("AWS_SESSION_TOKEN").ok(),
    };

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

    let proxy = Arc::new(Proxy {
        store,
        root_key,
        upstream: upstream.trim_end_matches('/').to_owned(),
        region,
        credential,
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()?,
    });

    let app = Router::new().fallback(any(handle)).with_state(proxy);

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

async fn handle(State(proxy): State<Arc<Proxy>>, request: Request) -> Response {
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

    // Buffered whole. Verifying a signature over a payload hash means having the payload, and a
    // vault object is a note — `livesync` chunks large files itself. `DEFAULT_BODY_LIMIT` bounds it.
    let body = match axum::body::to_bytes(request.into_body(), 64 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return s3_error(
                &Denied::Malformed("the request body could not be read"),
                origin.as_deref(),
            );
        }
    };

    let incoming = IncomingRequest {
        method: method.as_str(),
        path: &path,
        query: &query,
        headers,
        body: &body,
    };

    let resolved = match authorize(&proxy, &incoming).await {
        Ok(resolved) => resolved,
        Err(denied) => {
            warn!(%method, %path, %denied, "refused");
            return s3_error(&denied, origin.as_deref());
        }
    };

    match forward(&proxy, &method, &path, &query, &incoming, &body).await {
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
    body: &Bytes,
) -> anyhow::Result<Response> {
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
    let signed = upstream_headers(
        proxy,
        &OutgoingRequest {
            method: method.as_str(),
            path,
            query,
            host: &host,
            body,
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

    let upstream = builder.body(body.clone()).send().await?;
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let bytes = upstream.bytes().await?;

    let mut response = Response::builder().status(status);
    for (name, value) in &upstream_headers {
        // Hop-by-hop and length headers are the client's business, not the upstream's: the body is
        // re-sent by this server and `content-length` would describe the wrong one.
        if matches!(
            name.as_str(),
            "connection" | "transfer-encoding" | "content-length" | "keep-alive"
        ) {
            continue;
        }
        if let Ok(name) = HeaderName::try_from(name.as_str()) {
            response = response.header(name, value.clone());
        }
    }

    Ok(response.body(axum::body::Body::from(bytes))?)
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
}
