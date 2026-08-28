//! The front door.
//!
//! One process in front of every customer application: it resolves the `Host` header to a Lambda
//! alias through the platform Valkey, builds the event the customer's framework adapter expects,
//! invokes the function, and returns what came back.
//!
//! Per ADR 0026 this also takes over what `valkey-proxy`, `search-proxy` and `storage-proxy` do
//! today — the tenant splits for Valkey, OpenSearch and S3. Those move in; this module is the piece
//! that had no prior art in the repository.

pub mod credit;
pub mod dispatch;
pub mod listeners;
pub mod log_kafka;
pub mod log_token;
pub mod logs;
pub mod payload;
pub mod resolve;
pub mod route;
pub mod sandbox_egress;
pub mod sandbox_egress_metering;
pub mod serve;
pub mod site_metering;

/// Choose the TLS implementation for this process.
///
/// rustls 0.23 takes its cipher suites from a process-wide `CryptoProvider` and infers one only
/// when exactly one is compiled in. Two are: the AWS SDK brings `aws-lc-rs` and redis brings
/// `ring`. With both present rustls does not choose — it **panics on the first TLS connection**.
///
/// `main` has called this since the day an Auto Scaling group was replacing an instance every three
/// minutes over it. A test binary is a different process and links the library rather than `main`,
/// so it inherited none of that: `produces.rs` panicked on its first HTTPS call whenever Kafka was
/// actually reachable, which is to say whenever it was not skipping. Sharing one function is what
/// stops the binary and the tests disagreeing about a process-wide choice.
///
/// The result is ignored deliberately: it fails only if a provider is already installed, which is
/// the desired state.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}
