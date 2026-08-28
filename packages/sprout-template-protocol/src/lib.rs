//! SproutOS's exact integration pin for the deployment-template protocol.
//!
//! The canonical crate, schemas, documentation, and golden vectors live in
//! `MySproutOS/Deployment-Templates`. This facade intentionally defines no wire types of its own;
//! every consumer in this workspace receives the exact canonical API through the re-export.

pub use canonical::*;

/// The immutable canonical source revision tagged as `protocol-v0.1.0`.
pub const CANONICAL_GIT_REV: &str = "fea608ab7c8da209354e89df5fa4a98ee2cfcf45";

/// SHA-256 of `git archive --format=tar CANONICAL_GIT_REV` from Deployment-Templates.
pub const CANONICAL_SOURCE_TREE_SHA256: &str =
    "90faf62f2a3e044a05adbc1d711cdad61fa7227eb33499112b23a48bf87c774b";

/// SHA-256 of the attested `sprout-template-protocol-0.1.0.crate` release asset.
pub const CANONICAL_CRATE_SHA256: &str =
    "1d27782f98cff576d297a7817b2411c80d6baa0322ecf0c76e4e5b5bef3a322d";

#[cfg(test)]
mod tests {
    #[test]
    fn facade_is_pinned_to_protocol_v1() {
        assert_eq!(super::PROTOCOL_VERSION, 1);
        assert_eq!(super::CANONICAL_GIT_REV.len(), 40);
        assert_eq!(super::CANONICAL_SOURCE_TREE_SHA256.len(), 64);
        assert_eq!(super::CANONICAL_CRATE_SHA256.len(), 64);

        // The strict canonical decoders, not a locally reimplemented parser, are the API exposed
        // to sprout-core and sprout-node.
        let _parse_request = super::parse_request;
        let _parse_response = super::parse_response;
    }
}
