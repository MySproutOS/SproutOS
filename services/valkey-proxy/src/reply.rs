//! Reply framing, for the few commands that echo a key back.
//!
//! Replies are forwarded byte-for-byte wherever possible — a proxy that reinterprets every reply
//! shape breaks when the server grows a new one. But some commands *return a key name*:
//!
//! ```text
//! BLPOP jobs 0   →   1) "jobs"      ← the key, as the client sent it
//!                    2) "payload"
//! ```
//!
//! Namespaced on the way in, that reply comes back as `{kv:01hb…}:jobs`. A client that reads the
//! key out of the reply — which BullMQ does — then sends it back and gets it namespaced twice. So
//! for those commands the first element is un-namespaced on the way out.
//!
//! Doing that requires knowing where one reply ends, which is why this parses framing at all. It
//! does not interpret anything else.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ReplyError {
    #[error("malformed reply: {0}")]
    Malformed(&'static str),
}

/// One complete reply, and where its first bulk string sits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Framed {
    /// Total bytes this reply occupies.
    pub len: usize,
    /// Byte range of the first element's payload, when the reply is an array whose first element
    /// is a bulk string. `None` for anything else, including nulls and errors.
    pub first_bulk: Option<(usize, usize)>,
}

/// Measures one reply, returning `None` when the buffer holds only part of it.
pub fn frame(buffer: &[u8]) -> Result<Option<Framed>, ReplyError> {
    let Some(len) = scan(buffer, 0)? else {
        return Ok(None);
    };

    // Only array replies carry a key, and only in the first slot.
    let first_bulk = match buffer.first() {
        Some(b'*') => first_bulk_range(buffer)?,
        _ => None,
    };

    Ok(Some(Framed { len, first_bulk }))
}

/// Whether a complete RESP2 pub/sub frame is an unsolicited delivery rather than an acknowledgement.
pub fn is_pubsub_push(buffer: &[u8]) -> Result<bool, ReplyError> {
    let Some(elements) = array_elements(buffer, 0)? else {
        return Ok(false);
    };
    Ok(matches!(
        (
            array_bulk(buffer, 0)?.map(|range| &buffer[range.0..range.1]),
            elements.len()
        ),
        (Some(b"message" | b"smessage"), 3) | (Some(b"pmessage"), 4)
    ))
}

/// The number of live subscriptions reported by a RESP2 pub/sub acknowledgement.
///
/// `message` and `pmessage` frames deliberately return `None`: their final element is customer
/// payload, not protocol state. An error reply also returns `None`, so a refused subscription does
/// not make the proxy believe it entered subscribed mode.
pub fn pubsub_subscription_count(buffer: &[u8]) -> Result<Option<usize>, ReplyError> {
    let Some(elements) = array_elements(buffer, 0)? else {
        return Ok(None);
    };
    let kind = array_bulk(buffer, 0)?.map(|range| &buffer[range.0..range.1]);
    if !matches!(
        kind,
        Some(
            b"subscribe"
                | b"unsubscribe"
                | b"psubscribe"
                | b"punsubscribe"
                | b"ssubscribe"
                | b"sunsubscribe"
        )
    ) {
        return Ok(None);
    }
    let Some(&(offset, _)) = elements.get(2) else {
        return Err(ReplyError::Malformed(
            "pub/sub acknowledgement has no subscription count",
        ));
    };
    if buffer.get(offset) != Some(&b':') {
        return Err(ReplyError::Malformed(
            "pub/sub subscription count is not an integer",
        ));
    }
    let Some(end) = line_end(buffer, offset)? else {
        return Err(ReplyError::Malformed(
            "pub/sub subscription count is incomplete",
        ));
    };
    let count = std::str::from_utf8(&buffer[offset + 1..end - 2])
        .map_err(|_| ReplyError::Malformed("pub/sub subscription count is not a number"))?
        .parse::<usize>()
        .map_err(|_| ReplyError::Malformed("pub/sub subscription count is not a number"))?;
    Ok(Some(count))
}

/// Strip tenant prefixes from only the channel-bearing fields of a RESP2 pub/sub frame.
///
/// Payloads are deliberately never searched or rewritten: a message body is arbitrary customer
/// data and may legitimately equal a physical channel name.
pub fn rewrite_pubsub(buffer: &[u8], prefix: &[u8]) -> Result<Vec<u8>, ReplyError> {
    let kind = array_bulk(buffer, 0)?.map(|range| &buffer[range.0..range.1]);
    let indices: &[usize] = match kind {
        Some(
            b"message" | b"smessage" | b"subscribe" | b"unsubscribe" | b"psubscribe"
            | b"punsubscribe" | b"ssubscribe" | b"sunsubscribe",
        ) => &[1],
        Some(b"pmessage") => &[1, 2],
        _ => return Ok(buffer.to_vec()),
    };
    rewrite_array_bulks(buffer, prefix, indices)
}

/// Strip the physical stream name from each top-level XREAD/XREADGROUP result row.
pub fn rewrite_xread_streams(
    buffer: &[u8],
    prefix: &[u8],
    newly_prefixed: &[Vec<u8>],
) -> Result<Vec<u8>, ReplyError> {
    let Some(items) = array_elements(buffer, 0)? else {
        return Ok(buffer.to_vec());
    };
    let mut ranges = Vec::new();
    for (offset, _) in items {
        if let Some(range) = array_bulk_at(buffer, offset, 0)?
            && newly_prefixed
                .iter()
                .any(|key| key.as_slice() == &buffer[range.0..range.1])
        {
            ranges.push(range);
        }
    }
    rewrite_ranges(buffer, prefix, &ranges)
}

fn rewrite_array_bulks(
    buffer: &[u8],
    prefix: &[u8],
    indices: &[usize],
) -> Result<Vec<u8>, ReplyError> {
    let mut ranges = Vec::new();
    for index in indices {
        if let Some(range) = array_bulk(buffer, *index)?
            && buffer[range.0..range.1].starts_with(prefix)
        {
            ranges.push(range);
        }
    }
    rewrite_ranges(buffer, prefix, &ranges)
}

fn rewrite_ranges(
    buffer: &[u8],
    prefix: &[u8],
    ranges: &[(usize, usize)],
) -> Result<Vec<u8>, ReplyError> {
    let mut out = buffer.to_vec();
    for &(start, end) in ranges.iter().rev() {
        let payload = &buffer[start + prefix.len()..end];
        let marker = start
            .checked_sub(1)
            .and_then(|before| buffer[..before].iter().rposition(|byte| *byte == b'$'))
            .ok_or(ReplyError::Malformed("bulk payload has no header"))?;
        out.splice(
            marker..end,
            [format!("${}\r\n", payload.len()).as_bytes(), payload].concat(),
        );
    }
    Ok(out)
}

/// Top-level elements for an array beginning at `offset`, as `(offset, length)` pairs.
fn array_elements(buffer: &[u8], offset: usize) -> Result<Option<Vec<(usize, usize)>>, ReplyError> {
    if buffer.get(offset) != Some(&b'*') {
        return Ok(None);
    }
    let Some((count, aggregate_header)) = header(buffer, offset)? else {
        return Ok(None);
    };
    if count < 0 {
        return Ok(Some(Vec::new()));
    }
    let mut cursor = offset + aggregate_header;
    let mut elements = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let Some(len) = scan(buffer, cursor)? else {
            return Ok(None);
        };
        elements.push((cursor, len));
        cursor += len;
    }
    Ok(Some(elements))
}

/// Payload range of top-level array element `index` when it is a non-null bulk string.
fn array_bulk(buffer: &[u8], index: usize) -> Result<Option<(usize, usize)>, ReplyError> {
    array_bulk_at(buffer, 0, index)
}

fn array_bulk_at(
    buffer: &[u8],
    array_offset: usize,
    index: usize,
) -> Result<Option<(usize, usize)>, ReplyError> {
    let Some(elements) = array_elements(buffer, array_offset)? else {
        return Ok(None);
    };
    let Some(&(offset, _)) = elements.get(index) else {
        return Ok(None);
    };
    if buffer.get(offset) != Some(&b'$') {
        return Ok(None);
    }
    let Some((len, bulk_header)) = header(buffer, offset)? else {
        return Ok(None);
    };
    if len < 0 {
        return Ok(None);
    }
    let start = offset + bulk_header;
    Ok(Some((start, start + len as usize)))
}

/// The byte length of one reply starting at `offset`, or `None` if it is incomplete.
fn scan(buffer: &[u8], offset: usize) -> Result<Option<usize>, ReplyError> {
    let Some(&marker) = buffer.get(offset) else {
        return Ok(None);
    };

    match marker {
        // Simple string, error, integer, boolean, double, big number, null: one line each.
        b'+' | b'-' | b':' | b'#' | b',' | b'(' | b'_' => {
            Ok(line_end(buffer, offset)?.map(|end| end - offset))
        }

        // Bulk string and verbatim string: a length, then that many bytes, then CRLF.
        b'$' | b'=' => {
            let Some((len, header)) = header(buffer, offset)? else {
                return Ok(None);
            };
            if len < 0 {
                // RESP2 null bulk string, `$-1\r\n`.
                return Ok(Some(header));
            }
            let total = header + len as usize + 2;
            if buffer.len() < offset + total {
                return Ok(None);
            }
            Ok(Some(total))
        }

        // Aggregates: a count, then that many replies. Maps and attributes carry pairs.
        b'*' | b'~' | b'>' | b'%' | b'|' => {
            let Some((count, header)) = header(buffer, offset)? else {
                return Ok(None);
            };
            if count < 0 {
                return Ok(Some(header));
            }
            let elements = if matches!(marker, b'%' | b'|') {
                count as usize * 2
            } else {
                count as usize
            };

            let mut cursor = offset + header;
            for _ in 0..elements {
                let Some(len) = scan(buffer, cursor)? else {
                    return Ok(None);
                };
                cursor += len;
            }
            Ok(Some(cursor - offset))
        }

        _ => Err(ReplyError::Malformed("unknown reply type marker")),
    }
}

/// The payload range of an array's first element, when that element is a bulk string.
fn first_bulk_range(buffer: &[u8]) -> Result<Option<(usize, usize)>, ReplyError> {
    // Named rather than `header` so it does not shadow the function of the same name below.
    let Some((count, array_header)) = header(buffer, 0)? else {
        return Ok(None);
    };
    if count <= 0 {
        return Ok(None);
    }
    if buffer.get(array_header) != Some(&b'$') {
        return Ok(None);
    }

    let Some((len, bulk_header)) = header(buffer, array_header)? else {
        return Ok(None);
    };
    if len < 0 {
        return Ok(None);
    }

    let start = array_header + bulk_header;
    Ok(Some((start, start + len as usize)))
}

fn line_end(buffer: &[u8], offset: usize) -> Result<Option<usize>, ReplyError> {
    // Bounded: a reply line that never terminates should not make the proxy scan the whole buffer
    // on every read.
    let limit = (offset + 512).min(buffer.len());
    match buffer[offset..limit].iter().position(|byte| *byte == b'\n') {
        Some(index) => Ok(Some(offset + index + 1)),
        None if limit - offset >= 512 => Err(ReplyError::Malformed("reply line too long")),
        None => Ok(None),
    }
}

fn header(buffer: &[u8], offset: usize) -> Result<Option<(i64, usize)>, ReplyError> {
    let Some(end) = line_end(buffer, offset)? else {
        return Ok(None);
    };
    if end < offset + 3 || buffer[end - 2] != b'\r' {
        return Err(ReplyError::Malformed("a header must end with CRLF"));
    }

    let text = std::str::from_utf8(&buffer[offset + 1..end - 2])
        .map_err(|_| ReplyError::Malformed("a header length is not a number"))?;
    let value: i64 = text
        .parse()
        .map_err(|_| ReplyError::Malformed("a header length is not a number"))?;

    Ok(Some((value, end - offset)))
}

/// Commands whose reply begins with the key they operated on.
///
/// Every one of them is a blocking pop, and every one is a command BullMQ actually uses — which is
/// why refusing them was not an option.
pub fn echoes_key(verb: &str) -> bool {
    matches!(
        verb,
        "BLPOP" | "BRPOP" | "BZPOPMIN" | "BZPOPMAX" | "LMPOP" | "BLMPOP" | "ZMPOP" | "BZMPOP"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(bytes: &[u8]) -> Framed {
        frame(bytes).unwrap().unwrap()
    }

    #[test]
    fn measures_the_simple_types() {
        for bytes in [
            &b"+OK\r\n"[..],
            &b"-ERR nope\r\n"[..],
            &b":42\r\n"[..],
            &b"_\r\n"[..],
            &b"#t\r\n"[..],
            &b",3.14\r\n"[..],
        ] {
            assert_eq!(
                framed(bytes).len,
                bytes.len(),
                "{:?}",
                String::from_utf8_lossy(bytes)
            );
            assert_eq!(framed(bytes).first_bulk, None);
        }
    }

    #[test]
    fn measures_bulk_strings_including_the_null() {
        assert_eq!(framed(b"$5\r\nhello\r\n").len, 11);
        assert_eq!(framed(b"$0\r\n\r\n").len, 6);
        assert_eq!(framed(b"$-1\r\n").len, 5);
    }

    #[test]
    fn a_bulk_string_containing_crlf_is_measured_by_its_length() {
        // Scanning for a terminator instead of trusting the length would cut this reply in half and
        // desynchronise every reply after it.
        let bytes = b"$6\r\na\r\nb\r\n\r\n";
        assert_eq!(framed(bytes).len, bytes.len());
    }

    #[test]
    fn measures_nested_aggregates() {
        // A reply inside a reply inside a reply. Getting the total wrong here means the next reply
        // starts at the wrong byte, and every reply from then on belongs to the wrong command.
        let bytes = b"*2\r\n*2\r\n$1\r\na\r\n:1\r\n*1\r\n$2\r\nbb\r\n";
        assert_eq!(framed(bytes).len, bytes.len());
    }

    #[test]
    fn measures_maps_as_pairs() {
        // RESP3 `%1` is one *pair*, so two elements. Counting it as one truncates the reply.
        let bytes = b"%1\r\n$1\r\nk\r\n$1\r\nv\r\n";
        assert_eq!(framed(bytes).len, bytes.len());
    }

    #[test]
    fn measures_the_empty_and_null_array() {
        assert_eq!(framed(b"*0\r\n").len, 4);
        assert_eq!(framed(b"*-1\r\n").len, 5);
        assert_eq!(framed(b"*0\r\n").first_bulk, None);
        assert_eq!(framed(b"*-1\r\n").first_bulk, None);
    }

    /// Every prefix must report incomplete rather than a wrong length — a short count here is a
    /// reply boundary in the wrong place, which is the one failure that corrupts the whole stream.
    #[test]
    fn every_prefix_of_a_reply_is_incomplete() {
        let whole = b"*2\r\n$4\r\njobs\r\n$7\r\npayload\r\n";
        for split in 1..whole.len() {
            assert_eq!(
                frame(&whole[..split]).unwrap(),
                None,
                "{split} bytes should be incomplete"
            );
        }
        assert_eq!(framed(whole).len, whole.len());
    }

    #[test]
    fn a_trailing_reply_does_not_extend_the_first() {
        // Two replies in one read: the first must measure only itself.
        let bytes = b"+OK\r\n+SECOND\r\n";
        assert_eq!(framed(bytes).len, 5);
    }

    /// This is the leak the module exists to prevent: BLPOP returns the key it popped from, and the
    /// key the server saw is the namespaced one.
    #[test]
    fn finds_the_key_a_blocking_pop_echoes_back() {
        let bytes = b"*2\r\n$14\r\n{kv:01hb}:jobs\r\n$7\r\npayload\r\n";
        let (start, end) = framed(bytes).first_bulk.unwrap();
        assert_eq!(&bytes[start..end], b"{kv:01hb}:jobs");
    }

    #[test]
    fn a_blocking_pop_that_timed_out_has_no_key() {
        // `*-1\r\n` — nothing to rewrite, and reaching for a first element would be a panic.
        assert_eq!(framed(b"*-1\r\n").first_bulk, None);
    }

    #[test]
    fn no_first_bulk_when_the_first_element_is_not_a_bulk_string() {
        assert_eq!(framed(b"*2\r\n:1\r\n$1\r\na\r\n").first_bulk, None);
        assert_eq!(framed(b"*2\r\n$-1\r\n$1\r\na\r\n").first_bulk, None);
        assert_eq!(framed(b"$4\r\njobs\r\n").first_bulk, None);
    }

    #[test]
    fn an_unknown_marker_is_refused() {
        assert!(frame(b"?nope\r\n").is_err());
    }

    #[test]
    fn a_line_that_never_terminates_is_refused() {
        let bytes = vec![b'+'; 600];
        assert!(frame(&bytes).is_err());
    }

    #[test]
    fn only_blocking_pops_echo_a_key() {
        for verb in [
            "BLPOP", "BRPOP", "BZPOPMIN", "BZPOPMAX", "LMPOP", "BLMPOP", "ZMPOP", "BZMPOP",
        ] {
            assert!(echoes_key(verb), "{verb}");
        }
        for verb in ["GET", "LPOP", "EVALSHA", "SMEMBERS", "HGETALL"] {
            assert!(!echoes_key(verb), "{verb}");
        }
    }

    #[test]
    fn pubsub_rewrites_channels_without_touching_payloads() {
        let prefix = b"{kv:01hb}:";
        let message =
            b"*3\r\n$7\r\nmessage\r\n$16\r\n{kv:01hb}:events\r\n$16\r\n{kv:01hb}:events\r\n";
        assert!(is_pubsub_push(message).unwrap());
        assert_eq!(
            rewrite_pubsub(message, prefix).unwrap(),
            b"*3\r\n$7\r\nmessage\r\n$6\r\nevents\r\n$16\r\n{kv:01hb}:events\r\n"
        );

        let pattern = b"*4\r\n$8\r\npmessage\r\n$15\r\n{kv:01hb}:news*\r\n$15\r\n{kv:01hb}:news1\r\n$2\r\nhi\r\n";
        assert_eq!(
            rewrite_pubsub(pattern, prefix).unwrap(),
            b"*4\r\n$8\r\npmessage\r\n$5\r\nnews*\r\n$5\r\nnews1\r\n$2\r\nhi\r\n"
        );
    }

    #[test]
    fn sharded_pubsub_uses_the_same_tenant_safe_channel_rewrite() {
        let prefix = b"{kv:01hb}:";
        let message = b"*3\r\n$8\r\nsmessage\r\n$16\r\n{kv:01hb}:events\r\n$2\r\nhi\r\n";
        assert!(is_pubsub_push(message).unwrap());
        assert_eq!(
            rewrite_pubsub(message, prefix).unwrap(),
            b"*3\r\n$8\r\nsmessage\r\n$6\r\nevents\r\n$2\r\nhi\r\n"
        );
        assert_eq!(
            pubsub_subscription_count(b"*3\r\n$10\r\nssubscribe\r\n$6\r\nevents\r\n:1\r\n")
                .unwrap(),
            Some(1)
        );
    }

    #[test]
    fn pubsub_acknowledgements_report_confirmed_protocol_state() {
        assert_eq!(
            pubsub_subscription_count(b"*3\r\n$9\r\nsubscribe\r\n$6\r\nevents\r\n:1\r\n").unwrap(),
            Some(1)
        );
        assert_eq!(
            pubsub_subscription_count(b"*3\r\n$11\r\nunsubscribe\r\n$6\r\nevents\r\n:0\r\n")
                .unwrap(),
            Some(0)
        );
        assert_eq!(
            pubsub_subscription_count(b"*3\r\n$7\r\nmessage\r\n$6\r\nevents\r\n$1\r\nx\r\n")
                .unwrap(),
            None
        );
        assert_eq!(
            pubsub_subscription_count(b"-NOPERM denied\r\n").unwrap(),
            None
        );
    }

    #[test]
    fn xread_rewrites_only_each_stream_name() {
        let reply =
            b"*2\r\n*2\r\n$13\r\n{kv:01hb}:one\r\n*0\r\n*2\r\n$13\r\n{kv:01hb}:two\r\n*0\r\n";
        assert_eq!(
            rewrite_xread_streams(
                reply,
                b"{kv:01hb}:",
                &[b"{kv:01hb}:one".to_vec(), b"{kv:01hb}:two".to_vec()],
            )
            .unwrap(),
            b"*2\r\n*2\r\n$3\r\none\r\n*0\r\n*2\r\n$3\r\ntwo\r\n*0\r\n"
        );
    }
}
