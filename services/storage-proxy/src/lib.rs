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

use sproutos_s3_sigv4::{
    AuthorizationHeader, CanonicalRequest, STREAMING_PAYLOAD, UNSIGNED_PAYLOAD, canonical_query,
    parse_authorization, sha256_hex, sign, string_to_sign, verify,
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

pub struct Proxy {
    pub store: Arc<CredentialStore>,
    /// The root key every tenant secret is derived from. Shared with the control plane.
    pub root_key: String,
    /// Where the buckets actually live: `https://s3.us-east-1.amazonaws.com`, or LocalStack.
    pub upstream: String,
    pub region: String,
    pub credential: UpstreamCredential,
    pub client: reqwest::Client,
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
pub fn bucket_for(backend_service_id: uuid::Uuid) -> String {
    format!("v-{}", encode_short_id(backend_service_id))
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
    let headers = canonical_headers(&auth.signed_headers, &request.headers)?;
    let signed = auth.signed_headers.join(";");

    let canonical = CanonicalRequest {
        method: request.method,
        path: request.path,
        query: &canonical_query(request.query),
        canonical_headers: &headers,
        signed_headers: &signed,
        payload_hash: &hash,
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
    pub body: &'a [u8],
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
pub fn upstream_headers(proxy: &Proxy, outgoing: &OutgoingRequest<'_>) -> BTreeMap<String, String> {
    let OutgoingRequest {
        method,
        path,
        query,
        host,
        body,
        amz_date,
        content_type,
    } = *outgoing;

    let hash = sha256_hex(body);

    let mut headers = BTreeMap::new();
    headers.insert("host".to_owned(), host.to_owned());
    headers.insert("x-amz-content-sha256".to_owned(), hash.clone());
    headers.insert("x-amz-date".to_owned(), amz_date.to_owned());
    if let Some(token) = &proxy.credential.session_token {
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
        access_key_id: proxy.credential.access_key_id.clone(),
        date: amz_date.get(..8).unwrap_or_default().to_owned(),
        region: proxy.region.clone(),
        service: "s3".to_owned(),
    };

    let canonical = CanonicalRequest {
        method,
        path,
        query: &canonical_query(query),
        canonical_headers: &canonical_header_block,
        signed_headers: &signed,
        payload_hash: &hash,
    };

    let signature = sign(
        &proxy.credential.secret_access_key,
        &scope,
        &string_to_sign(amz_date, &scope.as_scope(), &canonical.to_string_form()),
    );

    headers.insert(
        "authorization".to_owned(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            proxy.credential.access_key_id,
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
pub async fn authorize(
    proxy: &Proxy,
    request: &IncomingRequest<'_>,
) -> Result<ResolvedService, Denied> {
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
    check_signature(request, &auth, &secret)?;

    let bucket = bucket_from_path(request.path).ok_or(Denied::NoBucket)?;
    if bucket != bucket_for(resolved.backend_service_id) {
        return Err(Denied::WrongBucket);
    }

    proxy.store.mark_used(resolved.credential_id).await;
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
