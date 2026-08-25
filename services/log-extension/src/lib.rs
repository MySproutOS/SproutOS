//! A Lambda extension that ships a customer's logs to Kafka.
//!
//! It runs beside the customer's handler in their execution environment, subscribes to the
//! Telemetry API, and produces each batch to the topic ClickHouse consumes.
//!
//! **Why this and not a CloudWatch subscription filter.** CloudWatch Logs charges $0.50 per GB
//! ingested, before a line reaches us at all — a straight tax on a platform whose thesis is cost.
//! The extension writes to Kafka directly and skips it. The price is real and worth stating: this
//! is our code inside the customer's execution environment, so it shares their memory limit and
//! adds to their billed duration, and it must be attached to every function or that function has
//! no logs.

pub mod runtime;
pub mod sink;
pub mod telemetry;
