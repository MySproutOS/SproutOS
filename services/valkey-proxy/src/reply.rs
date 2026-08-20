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
        "BLPOP" | "BRPOP" | "BZPOPMIN" | "BZPOPMAX" | "BLMPOP" | "BZMPOP"
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
        for verb in ["BLPOP", "BRPOP", "BZPOPMIN", "BZPOPMAX", "BLMPOP", "BZMPOP"] {
            assert!(echoes_key(verb), "{verb}");
        }
        for verb in ["GET", "LPOP", "EVALSHA", "SMEMBERS", "HGETALL"] {
            assert!(!echoes_key(verb), "{verb}");
        }
    }
}
