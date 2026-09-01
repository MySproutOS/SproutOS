//! AWS Signature Version 4, from both ends.
//!
//! The storage proxy is the only thing here that has to *verify* a signature rather than produce
//! one, and that turns out to decide a schema question elsewhere.
//!
//! Every other credential on this platform is stored as a one-way hash: the client presents the
//! secret, the server hashes it, and the comparison is against something a database leak cannot
//! replay. SigV4 does not present the secret. It presents an HMAC over a canonicalised request, and
//! the only way to check it is to recompute the same HMAC — which needs the secret itself. So an
//! object-storage credential has to be *recoverable* by the platform, and is sealed with
//! `@lib/envelope` rather than hashed.
//!
//! That is a real weakening and it is a property of the scheme, not a shortcut. It is written here
//! because this is the file that forces it.
//!
//! Implemented rather than taken from the AWS SDK because the SDK signs and does not verify: it has
//! no notion of "is this signature the one this secret would have produced", which is the whole job.

pub mod tenant;

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

/// The payload hash a client sends when it declines to hash the body.
pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

/// The payload hash a client sends when the body is signed in chunks.
///
/// The seed signature still covers the headers, so a request in this form can be authenticated
/// exactly like any other — what differs is that the *body* arrives with per-chunk signatures the
/// proxy must consume rather than forward.
pub const STREAMING_PAYLOAD: &str = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD";

/// The payload marker emitted by current AWS SDKs when request checksums are carried in a trailer.
///
/// Unlike [`STREAMING_PAYLOAD`], the body chunks are not individually signed. The seed signature
/// authenticates this marker and the trailer declaration; the transport is HTTPS, and the proxy
/// separately validates the advertised checksum while decoding the aws-chunked body.
pub const STREAMING_UNSIGNED_PAYLOAD_TRAILER: &str = "STREAMING-UNSIGNED-PAYLOAD-TRAILER";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SignatureError {
    #[error("the Authorization header is not AWS4-HMAC-SHA256")]
    NotSigV4,
    #[error("the Authorization header is malformed: {0}")]
    Malformed(&'static str),
    #[error("the credential scope is malformed: {0}")]
    BadScope(&'static str),
    #[error("the signature does not match")]
    Mismatch,
}

/// The `Credential=` part of an `Authorization` header: who, and for what scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialScope {
    pub access_key_id: String,
    /// `YYYYMMDD`, and the reason a signing key is only good for a day.
    pub date: String,
    pub region: String,
    pub service: String,
}

impl CredentialScope {
    /// `20260821/us-east-1/s3/aws4_request`
    pub fn as_scope(&self) -> String {
        format!(
            "{}/{}/{}/aws4_request",
            self.date, self.region, self.service
        )
    }
}

/// Everything an `Authorization: AWS4-HMAC-SHA256 …` header carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationHeader {
    pub credential: CredentialScope,
    /// Lowercase, semicolon-separated, in the order they were signed. Order is part of the string.
    pub signed_headers: Vec<String>,
    pub signature: String,
}

/// Parse an `Authorization` header.
///
/// Deliberately strict about the three parts and lenient about the whitespace between them: AWS's
/// own SDKs emit `, ` and some clients emit `,`, and a proxy that refuses one of them fails for a
/// reason no user can act on.
pub fn parse_authorization(header: &str) -> Result<AuthorizationHeader, SignatureError> {
    let rest = header
        .strip_prefix("AWS4-HMAC-SHA256")
        .ok_or(SignatureError::NotSigV4)?;

    let mut credential = None;
    let mut signed_headers = None;
    let mut signature = None;

    for part in rest.split(',') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix("Credential=") {
            credential = Some(value);
        } else if let Some(value) = part.strip_prefix("SignedHeaders=") {
            signed_headers = Some(value);
        } else if let Some(value) = part.strip_prefix("Signature=") {
            signature = Some(value);
        }
    }

    let credential = credential.ok_or(SignatureError::Malformed("no Credential"))?;
    let signed_headers = signed_headers.ok_or(SignatureError::Malformed("no SignedHeaders"))?;
    let signature = signature.ok_or(SignatureError::Malformed("no Signature"))?;

    Ok(AuthorizationHeader {
        credential: parse_scope(credential)?,
        signed_headers: signed_headers.split(';').map(str::to_owned).collect(),
        signature: signature.to_owned(),
    })
}

fn parse_scope(value: &str) -> Result<CredentialScope, SignatureError> {
    // `<access-key>/<date>/<region>/<service>/aws4_request`. Split from the right, because an
    // access key id is opaque and a future one containing a slash would otherwise shift every field.
    let parts: Vec<&str> = value.split('/').collect();
    if parts.len() < 5 {
        return Err(SignatureError::BadScope(
            "expected five slash-separated parts",
        ));
    }
    if parts[parts.len() - 1] != "aws4_request" {
        return Err(SignatureError::BadScope("does not end in aws4_request"));
    }

    let n = parts.len();
    Ok(CredentialScope {
        access_key_id: parts[..n - 4].join("/"),
        date: parts[n - 4].to_owned(),
        region: parts[n - 3].to_owned(),
        service: parts[n - 2].to_owned(),
    })
}

/// One request, canonicalised the way SigV4 requires.
#[derive(Debug, Clone)]
pub struct CanonicalRequest<'a> {
    pub method: &'a str,
    /// Already URI-encoded, as it appeared on the wire. S3 does *not* double-encode the path.
    pub path: &'a str,
    /// Sorted, `k=v` pairs joined by `&`, each part URI-encoded.
    pub query: &'a str,
    /// `name:value` per line, lowercase name, trimmed value, sorted by name, trailing newline.
    pub canonical_headers: &'a str,
    pub signed_headers: &'a str,
    pub payload_hash: &'a str,
}

impl CanonicalRequest<'_> {
    pub fn to_string_form(&self) -> String {
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            self.method,
            self.path,
            self.query,
            self.canonical_headers,
            self.signed_headers,
            self.payload_hash,
        )
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The string that is actually signed.
pub fn string_to_sign(amz_date: &str, scope: &str, canonical_request: &str) -> String {
    format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        scope,
        sha256_hex(canonical_request.as_bytes()),
    )
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// The date-scoped signing key.
///
/// Four nested HMACs, and the nesting is the point: the key handed to the final signature is
/// scoped to one day, one region and one service, so a signature captured from an S3 request cannot
/// be replayed against another service or on another date.
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    hmac(&k_service, b"aws4_request")
}

pub fn sign(secret: &str, scope: &CredentialScope, string_to_sign: &str) -> String {
    let key = signing_key(secret, &scope.date, &scope.region, &scope.service);
    hex::encode(hmac(&key, string_to_sign.as_bytes()))
}

/// Whether a presented signature is the one this secret would have produced.
///
/// Constant-time, because the comparison is against a value an attacker chooses and can vary one
/// byte at a time. A short-circuiting `==` here leaks the signature a byte per request.
pub fn verify(
    secret: &str,
    scope: &CredentialScope,
    string_to_sign: &str,
    presented: &str,
) -> Result<(), SignatureError> {
    let expected = sign(secret, scope, string_to_sign);

    if expected.as_bytes().ct_eq(presented.as_bytes()).into() {
        Ok(())
    } else {
        Err(SignatureError::Mismatch)
    }
}

/// URI-encode one path segment or query component, per SigV4's rules.
///
/// Not `url::form_urlencoded`: SigV4 requires the unreserved set to stay literal, everything else
/// to be percent-encoded with **uppercase** hex, and a space to become `%20` and never `+`. A
/// library that emits `+` produces a canonical request that differs from the client's by one byte
/// and a signature mismatch with nothing to point at.
pub fn uri_encode(value: &str, encode_slash: bool) -> String {
    uri_encode_bytes(value.as_bytes(), encode_slash)
}

fn uri_encode_bytes(value: &[u8], encode_slash: bool) -> String {
    let mut out = String::with_capacity(value.len());

    for &byte in value {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            b'/' if !encode_slash => out.push('/'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }

    out
}

/// Decode the URI escapes already present in an HTTP query component.
///
/// The request URI handed to the server is still percent-encoded. SigV4 canonicalization encodes
/// the *component value*, not the textual percent signs in that wire representation. Treating
/// `prefix=photos%2F` as the literal characters `%2F` produces `photos%252F`, which is exactly how
/// boto3's otherwise ordinary `ListObjectsV2` request used to fail authentication here. A `+`
/// remains a plus byte; query strings signed by SigV4 are not HTML form encoding.
fn decoded_query_component(value: &str) -> Vec<u8> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }

    decoded
}

/// Canonicalise a query string: each key and value encoded, sorted by key then value, joined.
pub fn canonical_query(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }

    let mut pairs: Vec<(String, String)> = raw
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| match part.split_once('=') {
            Some((key, value)) => (
                uri_encode_bytes(&decoded_query_component(key), true),
                uri_encode_bytes(&decoded_query_component(value), true),
            ),
            // A bare key signs as `key=`, not as `key`.
            None => (
                uri_encode_bytes(&decoded_query_component(part), true),
                String::new(),
            ),
        })
        .collect();

    pairs.sort();
    pairs
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AWS's own worked example, from the SigV4 documentation.
    ///
    /// Taken from the published test suite rather than generated here, because a signature
    /// implementation checked only against itself agrees with its own mistakes. These constants are
    /// the ones AWS publishes alongside the algorithm.
    const EXAMPLE_SECRET: &str = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

    #[test]
    fn derives_the_signing_key_aws_documents() {
        // From the SigV4 "Examples of how to derive a signing key" page: for `20150830`,
        // `us-east-1`, `iam`, the key is this exact byte string.
        let key = signing_key(EXAMPLE_SECRET, "20150830", "us-east-1", "iam");

        assert_eq!(
            hex::encode(key),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
        );
    }

    #[test]
    fn signs_the_worked_example() {
        // The `get-vanilla` case from AWS's SigV4 test suite.
        let canonical = CanonicalRequest {
            method: "GET",
            path: "/",
            query: "",
            canonical_headers: "host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n",
            signed_headers: "host;x-amz-date",
            payload_hash: &sha256_hex(b""),
        };

        let scope = CredentialScope {
            access_key_id: "AKIDEXAMPLE".into(),
            date: "20150830".into(),
            region: "us-east-1".into(),
            service: "service".into(),
        };

        let to_sign = string_to_sign(
            "20150830T123600Z",
            &scope.as_scope(),
            &canonical.to_string_form(),
        );

        assert_eq!(
            sign(EXAMPLE_SECRET, &scope, &to_sign),
            "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
        );
    }

    #[test]
    fn verifies_only_the_signature_the_secret_produces() {
        let scope = CredentialScope {
            access_key_id: "AKIDEXAMPLE".into(),
            date: "20150830".into(),
            region: "us-east-1".into(),
            service: "s3".into(),
        };
        let to_sign = "AWS4-HMAC-SHA256\n20150830T123600Z\nscope\nhash";
        let good = sign(EXAMPLE_SECRET, &scope, to_sign);

        assert_eq!(verify(EXAMPLE_SECRET, &scope, to_sign, &good), Ok(()));
        assert_eq!(
            verify("some-other-secret", &scope, to_sign, &good),
            Err(SignatureError::Mismatch),
        );
        // One byte different, which is what an attacker probing a non-constant-time compare sends.
        let mut tampered = good.clone();
        tampered.replace_range(0..1, if good.starts_with('a') { "b" } else { "a" });
        assert_eq!(
            verify(EXAMPLE_SECRET, &scope, to_sign, &tampered),
            Err(SignatureError::Mismatch),
        );
    }

    #[test]
    fn parses_an_authorization_header() {
        let parsed = parse_authorization(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request, \
             SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=abc123",
        )
        .expect("parses");

        assert_eq!(parsed.credential.access_key_id, "AKIDEXAMPLE");
        assert_eq!(parsed.credential.date, "20150830");
        assert_eq!(parsed.credential.region, "us-east-1");
        assert_eq!(parsed.credential.service, "s3");
        assert_eq!(
            parsed.signed_headers,
            vec!["host", "x-amz-content-sha256", "x-amz-date"],
        );
        assert_eq!(parsed.signature, "abc123");
    }

    #[test]
    fn accepts_a_header_without_spaces_after_the_commas() {
        // AWS's SDKs emit `, ` and some clients emit `,`. Refusing one of them fails for a reason
        // no user can act on.
        let parsed = parse_authorization(
            "AWS4-HMAC-SHA256 Credential=AK/20150830/us-east-1/s3/aws4_request,\
             SignedHeaders=host,Signature=abc",
        )
        .expect("parses");

        assert_eq!(parsed.signature, "abc");
    }

    #[test]
    fn refuses_anything_that_is_not_sigv4() {
        assert_eq!(
            parse_authorization("Basic dXNlcjpwYXNz"),
            Err(SignatureError::NotSigV4),
        );
    }

    #[test]
    fn encodes_the_way_sigv4_requires_and_not_the_way_forms_do() {
        // Uppercase hex, `%20` for a space and never `+`, and the unreserved set left literal. A
        // library that emits `+` differs from the client by one byte and produces a mismatch with
        // nothing to point at.
        assert_eq!(uri_encode("a b", true), "a%20b");
        assert_eq!(uri_encode("a/b", false), "a/b");
        assert_eq!(uri_encode("a/b", true), "a%2Fb");
        assert_eq!(uri_encode("-._~", true), "-._~");
        assert_eq!(uri_encode("ä", true), "%C3%A4");
    }

    #[test]
    fn canonicalises_a_query_string_by_sorting_and_encoding() {
        assert_eq!(canonical_query("b=2&a=1"), "a=1&b=2");
        // A bare key signs as `key=`, not `key`. S3 sends `?acl` and `?uploads` exactly this way.
        assert_eq!(canonical_query("uploads"), "uploads=");
        assert_eq!(
            canonical_query("prefix=notes/&max-keys=2"),
            "max-keys=2&prefix=notes%2F"
        );
        assert_eq!(canonical_query(""), "");
        assert_eq!(
            canonical_query("list-type=2&prefix=python%2F&encoding-type=url"),
            "encoding-type=url&list-type=2&prefix=python%2F"
        );
        assert_eq!(canonical_query("literal=a+b"), "literal=a%2Bb");
        assert_eq!(canonical_query("percent=%25"), "percent=%25");
    }
}
