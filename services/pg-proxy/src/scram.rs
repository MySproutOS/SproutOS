//! SCRAM-SHA-256, client side.
//!
//! Postgres has defaulted to this since 14, so it is not an edge case — it is the only case a
//! modern cluster presents. The first version of this proxy handled trust, cleartext and MD5 and
//! returned an error here, which meant it could not connect to the Postgres in `docker-compose`.
//! The integration test found that immediately, which is the argument for having written the
//! integration test.
//!
//! The exchange, from RFC 5802 and Postgres's `SASLInitialResponse` framing:
//!
//! ```text
//! → client-first  n,,n=,r=<nonce>
//! ← server-first  r=<nonce><server-nonce>,s=<salt>,i=<iterations>
//! → client-final  c=biws,r=<nonce><server-nonce>,p=<proof>
//! ← server-final  v=<server signature>
//! ```
//!
//! `n=` is empty because Postgres takes the username from the startup packet and ignores this one —
//! sending it anyway is what the spec requires and what libpq does.
//!
//! `c=biws` is base64 of `n,,`: channel binding not used. Not a shortcut — binding requires the TLS
//! exporter, and this proxy connects to the cluster over a private subnet without TLS. On a
//! deployment where the backend hop is encrypted, this is the line to revisit.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, thiserror::Error)]
pub enum ScramError {
    #[error("the server's first message was malformed: {0}")]
    Malformed(String),

    #[error("the server's nonce does not extend the one we sent")]
    NonceMismatch,

    #[error("the server's signature did not verify")]
    BadSignature,
}

/// Everything needed to finish an exchange once the server has replied.
pub struct ClientFirst {
    /// `n=,r=<nonce>` — the bare form, which the auth message is built from.
    pub bare: String,
    pub nonce: String,
}

/// Begin an exchange.
///
/// The nonce is caller-supplied so a test can pin it against a published vector; in the binary it
/// comes from the OS.
///
/// `username` is empty for Postgres — the server takes it from the startup packet and ignores this
/// field — but it is a parameter rather than a constant because it is part of the auth message the
/// proof is computed over. Hard-coding the empty string made it impossible to check this
/// implementation against RFC 7677's worked example, which uses `n=user`, and an implementation of
/// a cryptographic exchange that cannot be checked against its own specification is one I would not
/// trust.
pub fn client_first(username: &str, nonce: &str) -> (ClientFirst, String) {
    let bare = format!("n={username},r={nonce}");
    // `n,,` is the GS2 header: no channel binding, no authorization identity.
    let message = format!("n,,{bare}");
    (
        ClientFirst {
            bare,
            nonce: nonce.to_owned(),
        },
        message,
    )
}

pub struct ServerFirst {
    pub nonce: String,
    pub salt: Vec<u8>,
    pub iterations: u32,
}

/// Parse `r=…,s=…,i=…`.
pub fn parse_server_first(message: &str) -> Result<ServerFirst, ScramError> {
    let mut nonce = None;
    let mut salt = None;
    let mut iterations = None;

    for field in message.split(',') {
        let (key, value) = field
            .split_once('=')
            .ok_or_else(|| ScramError::Malformed(field.to_owned()))?;
        match key {
            "r" => nonce = Some(value.to_owned()),
            "s" => {
                salt = Some(
                    BASE64
                        .decode(value)
                        .map_err(|_| ScramError::Malformed("salt is not base64".to_owned()))?,
                );
            }
            "i" => {
                iterations =
                    Some(value.parse().map_err(|_| {
                        ScramError::Malformed("iterations is not a number".to_owned())
                    })?);
            }
            // `m=` is a mandatory extension we do not understand, which per the RFC means the
            // exchange must fail rather than continue.
            "m" => return Err(ScramError::Malformed("unsupported extension".to_owned())),
            _ => {}
        }
    }

    Ok(ServerFirst {
        nonce: nonce.ok_or_else(|| ScramError::Malformed("no nonce".to_owned()))?,
        salt: salt.ok_or_else(|| ScramError::Malformed("no salt".to_owned()))?,
        iterations: iterations.ok_or_else(|| ScramError::Malformed("no iterations".to_owned()))?,
    })
}

pub struct ClientFinal {
    pub message: String,
    /// Kept so the server's own signature can be checked when it replies.
    pub server_signature: Vec<u8>,
}

/// Build `client-final`, and the signature the server should send back.
///
/// Verifying the server's signature is not optional politeness: it is what makes SCRAM mutual. A
/// client that skips it will happily complete an exchange with something that does not know the
/// password, which is the attack the protocol exists to prevent.
pub fn client_final(
    first: &ClientFirst,
    server: &ServerFirst,
    server_first_message: &str,
    password: &str,
) -> Result<ClientFinal, ScramError> {
    // The server's nonce must begin with ours. Without this check a server could replay a nonce
    // from another session.
    if !server.nonce.starts_with(&first.nonce) {
        return Err(ScramError::NonceMismatch);
    }

    let salted = hi(password.as_bytes(), &server.salt, server.iterations);

    let client_key = hmac(&salted, b"Client Key");
    let stored_key: [u8; 32] = Sha256::digest(client_key).into();

    let without_proof = format!("c=biws,r={}", server.nonce);
    let auth_message = format!("{},{},{}", first.bare, server_first_message, without_proof);

    let client_signature = hmac(&stored_key, auth_message.as_bytes());

    // ClientProof = ClientKey XOR ClientSignature.
    let mut proof = client_key;
    for (byte, signature) in proof.iter_mut().zip(client_signature.iter()) {
        *byte ^= signature;
    }

    let server_key = hmac(&salted, b"Server Key");
    let server_signature = hmac(&server_key, auth_message.as_bytes());

    Ok(ClientFinal {
        message: format!("{without_proof},p={}", BASE64.encode(proof)),
        server_signature: server_signature.to_vec(),
    })
}

/// Check the `v=` the server sends in `AuthenticationSASLFinal`.
pub fn verify_server_final(message: &str, expected: &[u8]) -> Result<(), ScramError> {
    let value = message
        .strip_prefix("v=")
        .ok_or_else(|| ScramError::Malformed(message.to_owned()))?;
    let signature = BASE64
        .decode(value)
        .map_err(|_| ScramError::Malformed("signature is not base64".to_owned()))?;

    // Constant time: a comparison that returns early leaks how much of the signature matched.
    if signature.len() != expected.len() {
        return Err(ScramError::BadSignature);
    }
    let mut difference = 0u8;
    for (a, b) in signature.iter().zip(expected.iter()) {
        difference |= a ^ b;
    }
    if difference == 0 {
        Ok(())
    } else {
        Err(ScramError::BadSignature)
    }
}

fn hmac(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message);
    mac.finalize().into_bytes().into()
}

/// `Hi` from RFC 5802: PBKDF2-HMAC-SHA256.
fn hi(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password, salt, iterations, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vector from RFC 7677 §3, which is SCRAM-SHA-256's own worked example.
    ///
    /// Using the RFC's numbers rather than something generated here is the point: it checks this
    /// implementation against the specification, not against itself.
    #[test]
    fn matches_the_rfc_7677_vector() {
        let (first, message) = client_first("user", "rOprNGfwEbeRWgbNEkqO");
        assert_eq!(message, "n,,n=user,r=rOprNGfwEbeRWgbNEkqO");

        let server_first_message = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
        let server = parse_server_first(server_first_message).expect("parse");
        assert_eq!(server.iterations, 4096);

        let final_message =
            client_final(&first, &server, server_first_message, "pencil").expect("client final");

        assert_eq!(
            final_message.message,
            "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,\
             p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
        );

        // And the server signature the RFC says should come back.
        verify_server_final(
            "v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
            &final_message.server_signature,
        )
        .expect("the RFC's server signature should verify");
    }

    #[test]
    fn a_server_nonce_that_does_not_extend_ours_is_refused() {
        let (first, _) = client_first("", "ours");
        let server_first_message = "r=theirs,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
        let server = parse_server_first(server_first_message).expect("parse");

        // A server that replies with an unrelated nonce is replaying somebody else's exchange.
        assert!(matches!(
            client_final(&first, &server, server_first_message, "pencil"),
            Err(ScramError::NonceMismatch)
        ));
    }

    #[test]
    fn a_wrong_server_signature_is_refused() {
        // The first version of this compared base64-of-zeros against `[0u8; 32]` — which match, so
        // it asserted that a correct signature is rejected and failed for the right reason by
        // accident. The expected value here is deliberately not what the message decodes to.
        assert!(matches!(
            verify_server_final("v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", &[7u8; 32]),
            Err(ScramError::BadSignature)
        ));

        // And a signature of the wrong length is refused before any comparison happens.
        assert!(matches!(
            verify_server_final("v=AAAA", &[7u8; 32]),
            Err(ScramError::BadSignature)
        ));
    }

    #[test]
    fn the_right_server_signature_verifies() {
        // The other half of the pair: the check must accept as well as reject, or "refuses a wrong
        // signature" is satisfied by a function that refuses everything.
        assert!(
            verify_server_final(&format!("v={}", BASE64.encode([7u8; 32])), &[7u8; 32]).is_ok()
        );
    }

    #[test]
    fn a_mandatory_extension_we_do_not_understand_fails_the_exchange() {
        // RFC 5802: `m=` means "you must understand this to continue". Ignoring it would be
        // completing an exchange whose terms we did not read.
        assert!(parse_server_first("m=something,r=abc,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096").is_err());
    }
}
