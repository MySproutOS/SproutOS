//! SproutOS's exact integration pin for the deployment-template protocol.
//!
//! The canonical crate, schemas, documentation, and golden vectors live in
//! `MySproutOS/Deployment-Templates`. This facade intentionally defines no wire types of its own;
//! every consumer in this workspace receives the exact canonical API through the re-export.

pub use canonical::*;

/// The immutable canonical source revision used until version 0.1.0 is published to crates.io.
pub const CANONICAL_GIT_REV: &str = "4cc6f56695d1f2a7e5a643973566372a329429b5";

/// SHA-256 of `git archive --format=tar CANONICAL_GIT_REV` from Deployment-Templates.
pub const CANONICAL_SOURCE_TREE_SHA256: &str =
    "7563b7c56f644ec429ff82bf734558e16fd367d9077c503b4ced18e76ef1dc8b";

#[cfg(test)]
mod tests {
    #[test]
    fn facade_is_pinned_to_protocol_v1() {
        assert_eq!(super::PROTOCOL_VERSION, 1);
        assert_eq!(super::CANONICAL_GIT_REV.len(), 40);
        assert_eq!(super::CANONICAL_SOURCE_TREE_SHA256.len(), 64);

        // The strict canonical decoders, not a locally reimplemented parser, are the API exposed
        // to sprout-core and sprout-node.
        let _parse_request = super::parse_request;
        let _parse_response = super::parse_response;
    }
}
