//! The tenant boundary for object storage.
//!
//! A customer's Obsidian, `rclone`, or any S3 client points here instead of at a bucket. It signs
//! SigV4 with a `SPROUT…` access key exactly as it would against AWS — the client cannot tell the
//! difference, which is the whole point — and this proxy answers the three questions the client's
//! signature cannot answer for itself:
//!
//! 1. **Who is this key?** One indexed lookup against `service_credential`, joined through to the
//!    service and the organization. No live row means no tenant, whatever the signature says.
//! 2. **Did they sign it?** The secret is derived from the platform root key (see
//!    `deriveObjectStorageSecret` in `lib/typescript/services`), the canonical request is rebuilt
//!    from what actually arrived, and the signature is compared in constant time.
//! 3. **Is this their bucket?** The bucket in the path must be the one this service's id produces.
//!    This is the line that makes the whole thing tenant-based, and it is one string comparison
//!    against a value the customer cannot influence.
//!
//! Only then is the request re-signed with the platform's own credential and forwarded. The
//! customer never holds a cloud credential, and the store never sees a customer.
//!
//! ## Why this exists rather than an IAM policy per tenant
//!
//! Because the boundary should be somewhere it can be read, tested and changed. Scoping a real AWS
//! key with an inline policy works, and it puts the answer to "can this customer see that vault" in
//! a JSON document on someone else's system, months out of date with what the platform believes.
//! The same argument retired the per-tenant CouchDB. It also lifts a ceiling nobody would have
//! found until it hit: an AWS account allows 5,000 IAM users.
//!
//! ## What is deliberately not supported
//!
//! **Presigned URLs** (`X-Amz-Algorithm` in the query string). They are a signature over a request
//! that has not happened yet, with its own expiry rules, and no client this serves uses them —
//! `livesync` signs every request with a header. They are refused with a message that says so,
//! rather than falling through to a 403 that reads like a wrong key.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use aws_credential_types::Credentials;
use aws_credential_types::provider::{ProvideCredentials, SharedCredentialsProvider};
use sproutos_s3_sigv4::{
    AuthorizationHeader, CanonicalRequest, STREAMING_PAYLOAD, STREAMING_UNSIGNED_PAYLOAD_TRAILER,
    UNSIGNED_PAYLOAD, canonical_query, parse_authorization, sha256_hex, sign, string_to_sign,
    verify,
};
use sproutos_service_credentials::{CredentialStore, ResolvedService};
use sproutos_tenant_auth::encode_short_id;

/// The platform's own credential for the backing store.
#[derive(Debug, Clone)]
pub struct UpstreamCredential {
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Present for temporary credentials — IRSA, `AssumeRole`, an instance profile.
    pub session_token: Option<String>,
}

/// Refreshable credentials used to sign requests to the backing store.
///
/// The AWS SDK normally caches identities inside a generated service client. This proxy signs
/// requests itself, so it owns the corresponding cache. Expiring credentials are refreshed before
/// their expiry while non-expiring credentials (for example the environment provider used by a
/// local test) remain cached.
#[derive(Debug)]
pub struct UpstreamCredentialProvider {
    provider: SharedCredentialsProvider,
    cached: tokio::sync::Mutex<Option<Credentials>>,
    refresh_before: Duration,
}

impl UpstreamCredentialProvider {
    const DEFAULT_REFRESH_BEFORE: Duration = Duration::from_secs(5 * 60);

    pub fn new(provider: SharedCredentialsProvider) -> Self {
        Self::with_refresh_window(provider, Self::DEFAULT_REFRESH_BEFORE)
    }

    /// A provider for tests and local callers that deliberately supply a fixed credential.
    pub fn fixed(credential: UpstreamCredential) -> Self {
        Self::new(SharedCredentialsProvider::new(Credentials::new(
            credential.access_key_id,
            credential.secret_access_key,
            credential.session_token,
            None,
            "storage-proxy-fixed",
        )))
    }

    fn with_refresh_window(provider: SharedCredentialsProvider, refresh_before: Duration) -> Self {
        Self {
            provider,
            cached: tokio::sync::Mutex::new(None),
            refresh_before,
        }
    }

    /// Resolve the credential to use for this request, refreshing temporary credentials as needed.
    pub async fn current(
        &self,
    ) -> Result<UpstreamCredential, aws_credential_types::provider::error::CredentialsError> {
        let mut cached = self.cached.lock().await;
        if let Some(credential) = cached.as_ref().filter(|credential| {
            credential.expiry().is_none_or(|expiry| {
                expiry
                    .duration_since(SystemTime::now())
                    .is_ok_and(|remaining| remaining > self.refresh_before)
            })
        }) {
            return Ok(credential.into());
        }

        let credential = self.provider.provide_credentials().await?;
        let current = (&credential).into();
        *cached = Some(credential);
        Ok(current)
    }
}

impl From<&Credentials> for UpstreamCredential {
    fn from(credential: &Credentials) -> Self {
        Self {
            access_key_id: credential.access_key_id().to_owned(),
            secret_access_key: credential.secret_access_key().to_owned(),
            session_token: credential.session_token().map(str::to_owned),
        }
    }
}

pub struct Proxy {
    pub store: Arc<CredentialStore>,
    /// The root key every tenant secret is derived from. Shared with the control plane.
    pub root_key: String,
    /// Where the buckets actually live: `https://s3.us-east-1.amazonaws.com`, or LocalStack.
    pub upstream: String,
    pub region: String,
    pub credential_provider: UpstreamCredentialProvider,
    pub client: reqwest::Client,
    /*
      The one real bucket every tenant lives in (§4.5).

      `None` keeps the old shape — a real S3 bucket per tenant — which is what every existing
      deployment has. The two cannot be mixed per request: a proxy that guessed would send half a
      customer's objects to one layout and half to the other, and the half in the wrong place would
      look like data loss.
    */
    pub shared_bucket: Option<String>,
}

/// Authorization state that can be established before a request body is admitted into memory.
///
/// Keep the fields private. The caller may only complete authorization through
/// [`finish_authorization`], which verifies the payload signature and bucket boundary before the
/// resolved tenant is returned.
pub struct PreparedAuthorization {
    auth: AuthorizationHeader,
    resolved: ResolvedService,
    secret: String,
    signature_checked: bool,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Denied {
    #[error("no Authorization header")]
    Unsigned,

    #[error("presigned URLs are not supported by this endpoint; sign the request with a header")]
    Presigned,

    #[error("the Authorization header is not usable: {0}")]
    Malformed(&'static str),

    #[error("unknown access key")]
    UnknownKey,

    #[error("the signature does not match")]
    BadSignature,

    #[error("that bucket does not belong to this credential")]
    WrongBucket,

    #[error("no bucket in the request path")]
    NoBucket,
}

/// What a client is told when a request is refused for a reason it is not entitled to know.
///
/// S3's own wording, and deliberately one string. See [`Denied::as_s3_error`].
const OPAQUE_DENIAL: &str = "Access Denied";

impl Denied {
    /// The HTTP status, S3 error code, and message a client will understand.
    ///
    /// **The message is part of the answer, not decoration.** Every 403 here returns the same code
    /// *and the same message*: an unknown key, a wrong signature and a bucket belonging to someone
    /// else are one outcome as far as the caller is concerned. Distinguishing them — even only in
    /// the text — hands out an oracle: "unknown access key" versus "that bucket is not yours" is the
    /// difference between guessing at random and confirming that a key exists, and then that a
    /// bucket exists.
    ///
    /// This was wrong when first written: the codes matched and the messages did not, so the leak
    /// survived a test asserting on the code alone. The integration suite now compares the bodies.
    ///
    /// The 400s say what they mean, because a malformed header or a presigned URL is a mistake the
    /// caller made in the open and can only fix if told.
    pub fn as_s3_error(&self) -> (u16, &'static str, String) {
        match self {
            Denied::Presigned | Denied::Malformed(_) | Denied::NoBucket => {
                (400, "InvalidRequest", self.to_string())
            }
            Denied::Unsigned | Denied::UnknownKey | Denied::BadSignature | Denied::WrongBucket => {
                (403, "AccessDenied", OPAQUE_DENIAL.to_owned())
            }
        }
    }
}

/// The bucket a path-style request names: the first segment.
///
/// Path style only, and the control plane hands every customer `forcePathStyle: true` for that
/// reason. Virtual-host style would put the bucket in the `Host` header, which means one wildcard
/// DNS record and one wildcard certificate per tenant — and a `Host` a client controls deciding
/// which tenant it is, which is a boundary made of DNS.
pub fn bucket_from_path(path: &str) -> Option<&str> {
    let trimmed = path.strip_prefix('/').unwrap_or(path);
    let bucket = trimmed.split('/').next()?;
    if bucket.is_empty() {
        None
    } else {
        Some(bucket)
    }
}

/// The bucket name a service id produces. Mirrors `bucketNameFor` in `lib/typescript/services`.
///
/// Still what the *customer* addresses, and still what their signature covers, even though every
/// tenant now lives in one real bucket (§4.5). Changing what they address would invalidate every
/// stored connection URI and every signature computed against it.
pub fn bucket_for(backend_service_id: uuid::Uuid) -> String {
    format!("v-{}", encode_short_id(backend_service_id))
}

/// Why a request could not be rewritten onto the shared bucket.
#[derive(Debug, PartialEq, Eq)]
pub enum RewriteError {
    /// A key that could address something outside the tenant's prefix.
    Escapes,
}

/// The upstream path for a request the tenant addressed to their own bucket.
///
/// ## This function is the tenant boundary now
///
/// Every tenant used to have a real S3 bucket, and the boundary was S3's: a policy naming
/// `arn:aws:s3:::v-abc*` could not reach `v-def` however the request was built. §4.5 puts every
/// tenant in one bucket under a prefix, which moves that boundary into this code — the same trade
/// the proxy already makes for Valkey and OpenSearch, and worth naming because it is a real loss of
/// defence in depth.
///
/// **So a key that could escape the prefix is refused rather than sanitised.** `..` in an S3 key is
/// a legal, opaque byte sequence and S3 itself does nothing with it — but this proxy builds a URL
/// string, and between here and S3 there is a URL parser, an HTTP client, and possibly a proxy,
/// any of which may normalise. Rewriting the key to something safe would silently store the
/// customer's object somewhere they did not ask for; refusing tells them.
pub fn upstream_path(
    shared_bucket: &str,
    tenant_bucket: &str,
    request_path: &str,
) -> Result<String, RewriteError> {
    let trimmed = request_path.strip_prefix('/').unwrap_or(request_path);
    let key = trimmed
        .strip_prefix(tenant_bucket)
        .map(|rest| rest.strip_prefix('/').unwrap_or(rest))
        .unwrap_or("");

    if escapes(key) {
        return Err(RewriteError::Escapes);
    }

    if key.is_empty() {
        // A bucket-level operation — a list, a bucket HEAD. Scoped to the tenant's prefix by the
        // query rewrite, not by the path, which is why this is the prefix and not the bare bucket.
        return Ok(format!("/{shared_bucket}/{tenant_bucket}/"));
    }

    Ok(format!("/{shared_bucket}/{tenant_bucket}/{key}"))
}

/// Whether a request is a list of the bucket rather than an operation on one object.
///
/// `GET /v-abc/?list-type=2`. The path carries no key, so the tenant scoping cannot come from the
/// path — it has to come from `prefix`, which is the one query parameter this proxy is not allowed
/// to take from the client unchanged.
pub fn is_list(method: &str, tenant_bucket: &str, path: &str, query: &str) -> bool {
    if method != "GET" && method != "HEAD" {
        return false;
    }
    let trimmed = path.strip_prefix('/').unwrap_or(path);
    let bucket_level = trimmed == tenant_bucket || trimmed == format!("{tenant_bucket}/");
    bucket_level && (query.is_empty() || query.contains("list-type") || query.contains("prefix"))
}

/// The query for a list, with the tenant's prefix forced onto it.
///
/// The client's own `prefix` is kept — a vault listing one folder should list one folder — but it
/// is placed *under* the tenant's, never instead of it. A client asking for `prefix=v-def/` gets
/// `v-abc/v-def/`, which is empty, rather than another tenant's objects.
///
/// `delimiter`, `max-keys` and the continuation token pass through: none of them can widen what a
/// prefix has narrowed.
pub fn upstream_query(tenant_bucket: &str, query: &str) -> Result<String, RewriteError> {
    let mut parts: Vec<String> = Vec::new();
    let mut client_prefix = String::new();

    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (name, value) = match pair.split_once('=') {
            Some((name, value)) => (name, value),
            None => (pair, ""),
        };
        if name == "prefix" {
            client_prefix = percent_decode(value).ok_or(RewriteError::Escapes)?;
        } else {
            parts.push(pair.to_owned());
        }
    }

    if escapes(&client_prefix) {
        return Err(RewriteError::Escapes);
    }

    parts.push(format!(
        "prefix={}",
        percent_encode(&format!("{tenant_bucket}/{client_prefix}"))
    ));
    parts.sort();
    Ok(parts.join("&"))
}

/// Percent-encoding for a query value, escaping everything S3 does not treat as unreserved.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            // `/` is *not* unreserved here. SigV4's canonical query string percent-encodes it in
            // a value, and a URL carrying a raw slash that the signature covers as `%2F` is a
            // mismatch S3 reports as SignatureDoesNotMatch — which reads like a wrong key.
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Whether a response body is a listing rather than an object.
///
/// Checked on the bytes, not on the request: a `GET` on a bucket-level path is a list, but so is a
/// `GET` with a `versions` or `uploads` query, and a customer's own object could be XML. Looking at
/// what came back is the one check that cannot mistake one for the other.
pub fn is_listing_response(body: &[u8]) -> bool {
    let head = &body[..body.len().min(512)];
    let Ok(text) = std::str::from_utf8(head) else {
        return false;
    };
    text.contains("<ListBucketResult") || text.contains("<ListVersionsResult")
}

/// Strip the tenant's prefix out of a list response.
///
/// S3 answers with the keys it stored, which now all begin `v-abc/`. A client that asked for
/// `notes/one.md` and is told the object is called `v-abc/notes/one.md` will store the wrong name
/// and ask for the wrong thing next time — for `livesync` that is a full resync of the vault, every
/// time it opens.
pub fn strip_prefix_from_listing(body: &str, tenant_bucket: &str) -> String {
    let prefix = format!("{tenant_bucket}/");
    body.replace(&format!("<Key>{prefix}"), "<Key>")
        .replace(&format!("<Prefix>{prefix}"), "<Prefix>")
        .replace(
            &format!("<Prefix>{tenant_bucket}</Prefix>"),
            "<Prefix></Prefix>",
        )
}

/// Whether a key could address something outside the prefix it is placed under.
///
/// Checked on the raw and the percent-decoded form. A client that sends `%2e%2e%2f` has sent `../`
/// to anything that decodes before resolving, and checking only the bytes on the wire is how a
/// traversal check is passed by the thing it exists to stop.
fn escapes(key: &str) -> bool {
    fn dangerous(value: &str) -> bool {
        value.split('/').any(|segment| segment == "..")
            || value.starts_with('/')
            || value.contains("//")
            || value.contains('\\')
    }

    if dangerous(key) {
        return true;
    }

    match percent_decode(key) {
        Some(decoded) => dangerous(&decoded),
        // Undecodable percent-escapes: refused rather than passed through, because what S3 does
        // with them is not something this proxy should be guessing at.
        None => true,
    }
}

/// Percent-decoding, enough to see a traversal through one.
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(out).ok()
}

/// The canonical headers block for exactly the headers the client said it signed.
///
/// **Only the named headers, in the order the header list gives, and no others.** A proxy that
/// canonicalised everything it received would include whatever a load balancer added on the way in
/// and never match. A missing signed header is an error rather than an empty line: skipping it
/// silently produces a mismatch that looks like a wrong password.
pub fn canonical_headers(
    signed: &[String],
    lookup: &BTreeMap<String, String>,
) -> Result<String, Denied> {
    let mut out = String::new();
    for name in signed {
        let value = lookup
            .get(name.as_str())
            .ok_or(Denied::Malformed("a signed header was not sent"))?;
        // Sequential internal whitespace collapses and the ends are trimmed — SigV4's rule, and one
        // an intermediary can otherwise break just by reformatting a header.
        let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
        out.push_str(name);
        out.push(':');
        out.push_str(&collapsed);
        out.push('\n');
    }
    Ok(out)
}

/// What the client's signature has to be checked against.
pub struct IncomingRequest<'a> {
    pub method: &'a str,
    /// As it arrived on the wire, still percent-encoded. S3 does not re-encode the path.
    pub path: &'a str,
    pub query: &'a str,
    /// Lowercase header names to values.
    pub headers: BTreeMap<String, String>,
    pub body: &'a [u8],
}

/// The payload hash to canonicalise with.
///
/// A client that sends `x-amz-content-sha256` decides this — including the two literals that mean
/// "do not hash the body". Browser clients send `UNSIGNED-PAYLOAD` over HTTPS because they cannot
/// read a stream twice, and Obsidian is a browser-shaped runtime, so this is the common path here.
///
/// **The hash a client claims is not taken on trust when it is a real hash.** It is compared with
/// the body that actually arrived, because the canonical request only commits to the digest — a
/// proxy that copied the header through without checking would let a signed request carry a
/// different body than the one signed.
pub fn payload_hash(request: &IncomingRequest<'_>) -> Result<String, Denied> {
    let claimed = request
        .headers
        .get("x-amz-content-sha256")
        .map(String::as_str);

    match claimed {
        Some(UNSIGNED_PAYLOAD) => Ok(UNSIGNED_PAYLOAD.to_owned()),
        Some(STREAMING_UNSIGNED_PAYLOAD_TRAILER) => {
            Ok(STREAMING_UNSIGNED_PAYLOAD_TRAILER.to_owned())
        }
        // Chunked uploads carry their own per-chunk signatures. This proxy buffers whole requests,
        // so it cannot verify them, and accepting the literal would be verifying nothing.
        Some(STREAMING_PAYLOAD) => Err(Denied::Malformed("streaming uploads are not supported")),
        Some(hash) => {
            let actual = sha256_hex(request.body);
            if hash.eq_ignore_ascii_case(&actual) {
                Ok(actual)
            } else {
                Err(Denied::BadSignature)
            }
        }
        // No header at all: the body is what it is. Signing it is the pre-SigV4-S3 default and some
        // minimal clients still do it.
        None => Ok(sha256_hex(request.body)),
    }
}

/// Parse the `Authorization` header, refusing what this endpoint does not serve.
pub fn authorization(request: &IncomingRequest<'_>) -> Result<AuthorizationHeader, Denied> {
    if request.query.contains("X-Amz-Algorithm=") {
        return Err(Denied::Presigned);
    }

    let header = request
        .headers
        .get("authorization")
        .ok_or(Denied::Unsigned)?;

    parse_authorization(header).map_err(|_| Denied::Malformed("not an AWS4-HMAC-SHA256 header"))
}

/// Rebuild the string the client signed and check the signature against the derived secret.
pub fn check_signature(
    request: &IncomingRequest<'_>,
    auth: &AuthorizationHeader,
    secret: &str,
) -> Result<(), Denied> {
    let hash = payload_hash(request)?;
    check_signature_with_payload_hash(request, auth, secret, &hash)
}

/// Check a request using the digest produced while its body was written to a bounded disk spool.
pub fn check_signature_with_payload_hash(
    request: &IncomingRequest<'_>,
    auth: &AuthorizationHeader,
    secret: &str,
    actual_payload_hash: &str,
) -> Result<(), Denied> {
    let hash = match request
        .headers
        .get("x-amz-content-sha256")
        .map(String::as_str)
    {
        Some(UNSIGNED_PAYLOAD) => UNSIGNED_PAYLOAD,
        Some(STREAMING_UNSIGNED_PAYLOAD_TRAILER) => STREAMING_UNSIGNED_PAYLOAD_TRAILER,
        Some(STREAMING_PAYLOAD) => {
            return Err(Denied::Malformed("streaming uploads are not supported"));
        }
        Some(claimed) if claimed.eq_ignore_ascii_case(actual_payload_hash) => actual_payload_hash,
        Some(_) => return Err(Denied::BadSignature),
        None => actual_payload_hash,
    };
    let headers = canonical_headers(&auth.signed_headers, &request.headers)?;
    let signed = auth.signed_headers.join(";");

    let canonical = CanonicalRequest {
        method: request.method,
        path: request.path,
        query: &canonical_query(request.query),
        canonical_headers: &headers,
        signed_headers: &signed,
        payload_hash: hash,
    };

    // `x-amz-date` is always signed — it is what binds a signature to a moment — so it is present
    // in the lookup whenever the header list names it.
    let amz_date = request
        .headers
        .get("x-amz-date")
        .ok_or(Denied::Malformed("no x-amz-date"))?;

    let to_sign = string_to_sign(
        amz_date,
        &auth.credential.as_scope(),
        &canonical.to_string_form(),
    );

    verify(secret, &auth.credential, &to_sign, &auth.signature).map_err(|_| Denied::BadSignature)
}

/// The request as it will leave for the backing store.
#[derive(Debug, Clone, Copy)]
pub struct OutgoingRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a str,
    /// The *upstream's* host, not the one the client signed. It is part of the new signature.
    pub host: &'a str,
    /// SHA-256 already verified while the body was written to the bounded disk spool.
    pub payload_hash: &'a str,
    pub amz_date: &'a str,
    pub content_type: Option<&'a str>,
}

/// The headers to send upstream, signed with the platform's credential.
///
/// A fresh signature over a fresh canonical request, not a rewrite of the client's. The `Host`
/// differs (theirs named this proxy), the date is now, and the credential is the platform's — three
/// of the six lines of the canonical request — so there is nothing of the original to preserve.
///
/// Only the headers this signs are sent. Anything the client sent that is not in this list is
/// dropped, which is deliberate: an unsigned header forwarded to S3 is a header the customer can
/// set without the platform having agreed to it.
pub fn upstream_headers(
    region: &str,
    credential: &UpstreamCredential,
    outgoing: &OutgoingRequest<'_>,
) -> BTreeMap<String, String> {
    let OutgoingRequest {
        method,
        path,
        query,
        host,
        payload_hash,
        amz_date,
        content_type,
    } = *outgoing;

    let mut headers = BTreeMap::new();
    headers.insert("host".to_owned(), host.to_owned());
    headers.insert("x-amz-content-sha256".to_owned(), payload_hash.to_owned());
    headers.insert("x-amz-date".to_owned(), amz_date.to_owned());
    if let Some(token) = &credential.session_token {
        headers.insert("x-amz-security-token".to_owned(), token.clone());
    }
    if let Some(value) = content_type {
        headers.insert("content-type".to_owned(), value.to_owned());
    }

    let signed = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical_header_block = headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect::<String>();

    let scope = sproutos_s3_sigv4::CredentialScope {
        access_key_id: credential.access_key_id.clone(),
        date: amz_date.get(..8).unwrap_or_default().to_owned(),
        region: region.to_owned(),
        service: "s3".to_owned(),
    };

    let canonical = CanonicalRequest {
        method,
        path,
        query: &canonical_query(query),
        canonical_headers: &canonical_header_block,
        signed_headers: &signed,
        payload_hash,
    };

    let signature = sign(
        &credential.secret_access_key,
        &scope,
        &string_to_sign(amz_date, &scope.as_scope(), &canonical.to_string_form()),
    );

    headers.insert(
        "authorization".to_owned(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            credential.access_key_id,
            scope.as_scope(),
            signed,
            signature
        ),
    );

    headers
}

/// Everything between "a request arrived" and "it may be forwarded".
///
/// Split out from the HTTP handler so the decision can be tested without a socket, and so the order
/// of the checks is visible in one place: identify, authenticate, *then* authorize. Doing the bucket
/// check before the signature check would tell an unauthenticated caller whether a bucket exists.
pub async fn prepare_authorization(
    proxy: &Proxy,
    request: &IncomingRequest<'_>,
) -> Result<PreparedAuthorization, Denied> {
    let auth = authorization(request)?;

    let resolved = proxy
        .store
        .resolve_access_key(&auth.credential.access_key_id)
        .await
        .map_err(|cause| {
            sproutos_service_credentials::report(&cause);
            // An unreachable control plane is not a bad key, but there is nothing better to tell
            // the client; the log is where the difference lives.
            Denied::UnknownKey
        })?
        .ok_or(Denied::UnknownKey)?;

    let secret = sproutos_s3_sigv4::tenant::derive_secret(
        proxy.root_key.as_bytes(),
        &auth.credential.access_key_id,
    );

    // Browser-shaped S3 clients normally use UNSIGNED-PAYLOAD over HTTPS. Its signature is
    // independent of the body, so verify it now, before the handler allocates any body bytes. This
    // turns a forged request carrying a real-looking access-key id into a small 403 rather than a
    // 16 MiB allocation. Requests carrying an actual payload digest are completed after buffering.
    let signature_checked = request
        .headers
        .get("x-amz-content-sha256")
        .is_some_and(|hash| {
            matches!(
                hash.as_str(),
                UNSIGNED_PAYLOAD | STREAMING_UNSIGNED_PAYLOAD_TRAILER
            )
        });
    if signature_checked {
        check_signature(request, &auth, &secret)?;
    }

    Ok(PreparedAuthorization {
        auth,
        resolved,
        secret,
        signature_checked,
    })
}

/// Complete payload authentication and the tenant bucket check after the bounded body is read.
pub async fn finish_authorization(
    proxy: &Proxy,
    request: &IncomingRequest<'_>,
    prepared: PreparedAuthorization,
) -> Result<ResolvedService, Denied> {
    let actual_payload_hash = sha256_hex(request.body);
    finish_authorization_with_payload_hash(proxy, request, prepared, &actual_payload_hash).await
}

/// Complete authorization without copying a disk-spooled request body back into memory.
pub async fn finish_authorization_with_payload_hash(
    proxy: &Proxy,
    request: &IncomingRequest<'_>,
    prepared: PreparedAuthorization,
    actual_payload_hash: &str,
) -> Result<ResolvedService, Denied> {
    if !prepared.signature_checked {
        check_signature_with_payload_hash(
            request,
            &prepared.auth,
            &prepared.secret,
            actual_payload_hash,
        )?;
    }

    let bucket = bucket_from_path(request.path).ok_or(Denied::NoBucket)?;
    if bucket != bucket_for(prepared.resolved.backend_service_id) {
        return Err(Denied::WrongBucket);
    }

    proxy.store.mark_used(prepared.resolved.credential_id).await;
    Ok(prepared.resolved)
}

/// Convenience path for callers that already hold a bounded body.
pub async fn authorize(
    proxy: &Proxy,
    request: &IncomingRequest<'_>,
) -> Result<ResolvedService, Denied> {
    let prepared = prepare_authorization(proxy, request).await?;
    finish_authorization(proxy, request, prepared).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_credential_types::provider::future;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn headers(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn reads_the_bucket_from_a_path_style_request() {
        assert_eq!(bucket_from_path("/v-abc/notes/one.md"), Some("v-abc"));
        assert_eq!(bucket_from_path("/v-abc"), Some("v-abc"));
        assert_eq!(bucket_from_path("/"), None);
    }

    #[test]
    fn names_the_same_bucket_the_control_plane_does() {
        // The comparison in `authorize` is only a boundary if both sides compute the name the same
        // way. `lib/typescript/services` asserts the other half against the same short-id encoding,
        // and this literal came from running it rather than from reading the algorithm.
        let id = uuid::Uuid::parse_str("01a02486-be04-776f-a9e2-c655b19e16b7").unwrap();

        assert_eq!(bucket_for(id), "v-01m0j8dfg4exqtkrp6aprsw5nq");
    }

    #[test]
    fn rewrites_a_tenant_request_onto_the_shared_bucket() {
        assert_eq!(
            upstream_path("sproutos-tenants", "v-abc", "/v-abc/notes/one.md"),
            Ok("/sproutos-tenants/v-abc/notes/one.md".to_owned())
        );

        // A bucket-level operation lands on the prefix, not the bare bucket: a list scoped to the
        // bucket would enumerate every tenant.
        assert_eq!(
            upstream_path("sproutos-tenants", "v-abc", "/v-abc"),
            Ok("/sproutos-tenants/v-abc/".to_owned())
        );
    }

    #[test]
    fn refuses_a_key_that_could_leave_the_prefix() {
        /*
          The whole of §4.5's risk in one test.

          With a bucket per tenant this was S3's problem and a policy answered it. With one bucket
          and a prefix it is ours, and every one of these is a way a customer reads or overwrites
          another customer's object.
        */
        for key in [
            "/v-abc/../v-def/secret",
            "/v-abc/notes/../../v-def/secret",
            "/v-abc//v-def/secret",
            "/v-abc/..",
            "/v-abc/nested/..",
        ] {
            assert_eq!(
                upstream_path("sproutos-tenants", "v-abc", key),
                Err(RewriteError::Escapes),
                "{key} should have been refused"
            );
        }
    }

    #[test]
    fn sees_a_traversal_through_percent_encoding() {
        // `%2e%2e%2f` is `../` to anything that decodes before it resolves. Checking only the bytes
        // on the wire is how a traversal check is passed by the thing it exists to stop.
        assert_eq!(
            upstream_path("sproutos-tenants", "v-abc", "/v-abc/%2e%2e/v-def/secret"),
            Err(RewriteError::Escapes)
        );
        assert_eq!(
            upstream_path("sproutos-tenants", "v-abc", "/v-abc/%2E%2E%2Fv-def/secret"),
            Err(RewriteError::Escapes)
        );
        // Undecodable escapes are refused too: what S3 does with them is not ours to guess.
        assert_eq!(
            upstream_path("sproutos-tenants", "v-abc", "/v-abc/%zz"),
            Err(RewriteError::Escapes)
        );
    }

    #[test]
    fn keeps_ordinary_keys_that_merely_look_alarming() {
        // A dot-file, and a name containing dots, are both legal keys a customer may hold. Refusing
        // them would be a proxy that broke a working vault to feel safe.
        assert_eq!(
            upstream_path("sproutos-tenants", "v-abc", "/v-abc/.obsidian/app.json"),
            Ok("/sproutos-tenants/v-abc/.obsidian/app.json".to_owned())
        );
        assert_eq!(
            upstream_path("sproutos-tenants", "v-abc", "/v-abc/notes/a..b.md"),
            Ok("/sproutos-tenants/v-abc/notes/a..b.md".to_owned())
        );
    }

    #[test]
    fn forces_the_tenant_prefix_onto_a_list() {
        // No prefix from the client: the tenant's own, so a bare list is their objects and not the
        // whole bucket.
        assert_eq!(
            upstream_query("v-abc", "list-type=2"),
            Ok("list-type=2&prefix=v-abc%2F".to_owned())
        );

        // The client's prefix is kept, and placed under the tenant's rather than instead of it.
        assert_eq!(
            upstream_query("v-abc", "list-type=2&prefix=notes/"),
            Ok("list-type=2&prefix=v-abc%2Fnotes%2F".to_owned())
        );
    }

    #[test]
    fn a_client_prefix_cannot_reach_another_tenant() {
        // Asking for `v-def/` gets `v-abc/v-def/`, which is empty. This is the case a naive
        // implementation gets wrong by letting the client's prefix replace the tenant's.
        assert_eq!(
            upstream_query("v-abc", "prefix=v-def/"),
            Ok("prefix=v-abc%2Fv-def%2F".to_owned())
        );

        // And a traversal in the prefix is refused, the same as one in a key.
        assert_eq!(
            upstream_query("v-abc", "prefix=../v-def/"),
            Err(RewriteError::Escapes)
        );
        assert_eq!(
            upstream_query("v-abc", "prefix=%2e%2e%2fv-def/"),
            Err(RewriteError::Escapes)
        );
    }

    #[test]
    fn a_listing_comes_back_named_the_way_the_client_asked() {
        let body = "<ListBucketResult><Prefix>v-abc/notes/</Prefix>\
<Contents><Key>v-abc/notes/one.md</Key></Contents>\
<Contents><Key>v-abc/notes/two.md</Key></Contents></ListBucketResult>";

        let stripped = strip_prefix_from_listing(body, "v-abc");

        // A client told its object is called `v-abc/notes/one.md` stores that name and asks for the
        // wrong thing next time. For `livesync` that is a full resync of the vault on every open.
        assert!(stripped.contains("<Key>notes/one.md</Key>"));
        assert!(stripped.contains("<Prefix>notes/</Prefix>"));
        assert!(!stripped.contains("v-abc/"));
    }

    #[test]
    fn knows_a_list_from_an_object_get() {
        assert!(is_list("GET", "v-abc", "/v-abc", "list-type=2"));
        assert!(is_list("GET", "v-abc", "/v-abc/", ""));
        // An object GET is not a list, however much its key looks like one.
        assert!(!is_list("GET", "v-abc", "/v-abc/list-type=2", ""));
        assert!(!is_list("PUT", "v-abc", "/v-abc", "list-type=2"));
    }

    #[test]
    fn canonicalises_only_the_headers_the_client_signed() {
        // A load balancer's `x-forwarded-for` must not enter the canonical request; the client never
        // saw it and never signed it.
        let lookup = headers(&[
            ("host", "storage.example.com"),
            ("x-amz-date", "20260821T000000Z"),
            ("x-forwarded-for", "10.0.0.1"),
        ]);
        let signed = vec!["host".to_owned(), "x-amz-date".to_owned()];

        assert_eq!(
            canonical_headers(&signed, &lookup).unwrap(),
            "host:storage.example.com\nx-amz-date:20260821T000000Z\n"
        );
    }

    #[test]
    fn refuses_a_signed_header_that_was_not_sent() {
        // Rather than canonicalising an empty line, which mismatches for a reason nobody can see.
        let lookup = headers(&[("host", "storage.example.com")]);
        let signed = vec!["host".to_owned(), "x-amz-date".to_owned()];

        assert!(matches!(
            canonical_headers(&signed, &lookup),
            Err(Denied::Malformed(_))
        ));
    }

    #[test]
    fn collapses_whitespace_in_a_header_value() {
        // SigV4's rule. Without it an intermediary that reformats a header breaks every signature.
        let lookup = headers(&[("x-amz-meta-note", "  two   words  ")]);

        assert_eq!(
            canonical_headers(&["x-amz-meta-note".to_owned()], &lookup).unwrap(),
            "x-amz-meta-note:two words\n"
        );
    }

    #[test]
    fn checks_a_claimed_payload_hash_against_the_body_that_arrived() {
        /*
          The canonical request commits to the digest, not to the bytes. A proxy that copied the
          client's `x-amz-content-sha256` through unchecked would forward a validly signed request
          carrying a body nobody signed.
        */
        let mismatched = IncomingRequest {
            method: "PUT",
            path: "/v-abc/one.md",
            query: "",
            headers: headers(&[("x-amz-content-sha256", &sha256_hex(b"signed"))]),
            body: b"substituted",
        };

        assert_eq!(payload_hash(&mismatched), Err(Denied::BadSignature));
    }

    #[test]
    fn accepts_the_unsigned_payload_literal_browsers_send() {
        // Obsidian is a browser-shaped runtime and cannot read an upload stream twice, so the AWS
        // SDK sends this over HTTPS. Refusing it would refuse the plugin this exists for.
        let request = IncomingRequest {
            method: "PUT",
            path: "/v-abc/one.md",
            query: "",
            headers: headers(&[("x-amz-content-sha256", UNSIGNED_PAYLOAD)]),
            body: b"anything",
        };

        assert_eq!(payload_hash(&request).unwrap(), UNSIGNED_PAYLOAD);
    }

    #[test]
    fn accepts_the_checksum_trailer_marker_current_aws_sdks_sign() {
        let request = IncomingRequest {
            method: "PUT",
            path: "/v-abc/one.md",
            query: "",
            headers: headers(&[("x-amz-content-sha256", STREAMING_UNSIGNED_PAYLOAD_TRAILER)]),
            body: b"the aws-chunked envelope is decoded by the HTTP service",
        };

        assert_eq!(
            payload_hash(&request).unwrap(),
            STREAMING_UNSIGNED_PAYLOAD_TRAILER
        );
    }

    #[test]
    fn refuses_a_streaming_upload_rather_than_pretending_to_verify_it() {
        let request = IncomingRequest {
            method: "PUT",
            path: "/v-abc/one.md",
            query: "",
            headers: headers(&[("x-amz-content-sha256", STREAMING_PAYLOAD)]),
            body: b"",
        };

        assert!(matches!(payload_hash(&request), Err(Denied::Malformed(_))));
    }

    #[test]
    fn refuses_a_presigned_url_with_a_reason() {
        // Rather than a 403, which a customer reads as a wrong key and cannot act on.
        let request = IncomingRequest {
            method: "GET",
            path: "/v-abc/one.md",
            query: "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=900",
            headers: BTreeMap::new(),
            body: b"",
        };

        assert_eq!(authorization(&request), Err(Denied::Presigned));
    }

    #[test]
    fn every_403_is_indistinguishable_to_the_caller() {
        /*
          Otherwise the endpoint is an oracle: "unknown access key" versus "that bucket is not
          yours" confirms first that a key exists and then that a bucket does.

          Asserted on the whole tuple including the message, because the first version of this got
          the code right and the message wrong — and a test that compared only the code passed.
        */
        let expected = (403, "AccessDenied", "Access Denied".to_owned());

        assert_eq!(Denied::UnknownKey.as_s3_error(), expected);
        assert_eq!(Denied::BadSignature.as_s3_error(), expected);
        assert_eq!(Denied::WrongBucket.as_s3_error(), expected);
        assert_eq!(Denied::Unsigned.as_s3_error(), expected);
    }

    #[test]
    fn a_400_says_what_the_caller_did_wrong() {
        // A mistake made in the open, which the caller can only fix if told.
        let (status, _, message) = Denied::Presigned.as_s3_error();

        assert_eq!(status, 400);
        assert!(message.contains("presigned"));
    }

    #[test]
    fn a_request_the_tenant_signed_verifies() {
        let secret = sproutos_s3_sigv4::tenant::derive_secret(
            b"root",
            &sproutos_s3_sigv4::tenant::access_key_id("01m0j8dfg4exqtkrp6aprsw5nq", 1),
        );
        let access_key_id =
            sproutos_s3_sigv4::tenant::access_key_id("01m0j8dfg4exqtkrp6aprsw5nq", 1);

        let request = IncomingRequest {
            method: "GET",
            path: "/v-01m0j8dfg4exqtkrp6aprsw5nq/notes/one.md",
            query: "",
            headers: headers(&[
                ("host", "storage.example.com"),
                ("x-amz-content-sha256", UNSIGNED_PAYLOAD),
                ("x-amz-date", "20260821T000000Z"),
            ]),
            body: b"",
        };

        let scope = sproutos_s3_sigv4::CredentialScope {
            access_key_id: access_key_id.clone(),
            date: "20260821".into(),
            region: "us-east-1".into(),
            service: "s3".into(),
        };
        let signed = vec![
            "host".to_owned(),
            "x-amz-content-sha256".to_owned(),
            "x-amz-date".to_owned(),
        ];
        let canonical = CanonicalRequest {
            method: "GET",
            path: request.path,
            query: "",
            canonical_headers: &canonical_headers(&signed, &request.headers).unwrap(),
            signed_headers: &signed.join(";"),
            payload_hash: UNSIGNED_PAYLOAD,
        };
        let signature = sign(
            &secret,
            &scope,
            &string_to_sign(
                "20260821T000000Z",
                &scope.as_scope(),
                &canonical.to_string_form(),
            ),
        );

        let auth = AuthorizationHeader {
            credential: scope,
            signed_headers: signed,
            signature,
        };

        assert!(check_signature(&request, &auth, &secret).is_ok());

        // And one byte of the path elsewhere does not.
        let tampered = IncomingRequest {
            path: "/v-01m0j8dfg4exqtkrp6aprsw5nq/notes/two.md",
            ..request
        };
        assert_eq!(
            check_signature(&tampered, &auth, &secret),
            Err(Denied::BadSignature)
        );
    }

    #[derive(Debug)]
    struct RotatingProvider {
        calls: Arc<AtomicUsize>,
    }

    impl ProvideCredentials for RotatingProvider {
        fn provide_credentials<'a>(&'a self) -> future::ProvideCredentials<'a>
        where
            Self: 'a,
        {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            let expiry = if call == 1 {
                SystemTime::now() + Duration::from_secs(30)
            } else {
                SystemTime::now() + Duration::from_secs(60 * 60)
            };
            future::ProvideCredentials::ready(Ok(Credentials::new(
                format!("ACCESS{call}"),
                format!("secret{call}"),
                Some(format!("token{call}")),
                Some(expiry),
                "rotating-test",
            )))
        }
    }

    #[tokio::test]
    async fn refreshes_temporary_credentials_before_they_expire() -> anyhow::Result<()> {
        let calls = Arc::new(AtomicUsize::new(0));
        let provider = UpstreamCredentialProvider::with_refresh_window(
            SharedCredentialsProvider::new(RotatingProvider {
                calls: calls.clone(),
            }),
            Duration::from_secs(60),
        );

        assert_eq!(provider.current().await?.access_key_id, "ACCESS1");
        assert_eq!(provider.current().await?.access_key_id, "ACCESS2");
        // The second credential is outside the refresh window, so another request reuses it.
        assert_eq!(provider.current().await?.access_key_id, "ACCESS2");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        Ok(())
    }

    #[test]
    fn signs_each_request_with_the_credential_it_was_given() {
        let request = OutgoingRequest {
            method: "GET",
            path: "/bucket/key",
            query: "",
            host: "s3.us-east-1.amazonaws.com",
            payload_hash: &sha256_hex(b""),
            amz_date: "20260827T120000Z",
            content_type: None,
        };
        let first = UpstreamCredential {
            access_key_id: "ACCESS1".to_owned(),
            secret_access_key: "secret1".to_owned(),
            session_token: Some("token1".to_owned()),
        };
        let second = UpstreamCredential {
            access_key_id: "ACCESS2".to_owned(),
            secret_access_key: "secret2".to_owned(),
            session_token: Some("token2".to_owned()),
        };

        let first_headers = upstream_headers("us-east-1", &first, &request);
        let second_headers = upstream_headers("us-east-1", &second, &request);

        assert!(first_headers["authorization"].contains("Credential=ACCESS1/"));
        assert_eq!(first_headers["x-amz-security-token"], "token1");
        assert!(second_headers["authorization"].contains("Credential=ACCESS2/"));
        assert_eq!(second_headers["x-amz-security-token"], "token2");
        assert_ne!(
            first_headers["authorization"],
            second_headers["authorization"]
        );
    }
}
