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
pub mod payload;
pub mod resolve;
pub mod route;
pub mod serve;
