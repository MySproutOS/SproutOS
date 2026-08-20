//! RESP, the protocol Valkey speaks.
//!
//! Only what a proxy needs: read a client's command, rewrite it, write it on. Replies are
//! forwarded byte-for-byte without being parsed, because a proxy that understands every reply
//! shape is a proxy that breaks when the server grows a new one — and there is nothing in a reply
//! this proxy needs to change.
//!
//! Commands are always RESP arrays of bulk strings. That is the only inbound shape a client sends,
//! so it is the only one parsed here; the inline command format exists for humans typing at
//! `telnet` and is refused rather than half-supported.

use std::io;

use bytes::{Buf, BufMut, BytesMut};
use thiserror::Error;

/// The largest command this proxy will assemble.
///
/// A client that claims a 4 GB bulk string would otherwise have the proxy allocate it before
/// discovering the connection is hostile. BullMQ payloads are kilobytes; 64 MiB is generous.
pub const MAX_COMMAND_BYTES: usize = 64 * 1024 * 1024;

/// The most arguments one command may carry.
///
/// `DEL` over a large key set is the legitimate reason this is not smaller.
pub const MAX_ARGS: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum RespError {
    /// The bytes are not a command a client would send.
    #[error("malformed command: {0}")]
    Malformed(&'static str),

    /// A declared length exceeds what this proxy will hold.
    #[error("command too large: {actual} bytes exceeds the {max} byte limit")]
    TooLarge { actual: usize, max: usize },

    #[error(transparent)]
    Io(#[from] io::Error),
}

/// One command: the verb and its arguments, exactly as the client sent them.
///
/// Arguments are bytes rather than strings. Valkey keys and values are binary-safe, and a proxy
/// that assumed UTF-8 would mangle a serialized payload — which is precisely what BullMQ stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub args: Vec<Vec<u8>>,
}

impl Command {
    pub fn new(args: Vec<Vec<u8>>) -> Self {
        Self { args }
    }

    /// The command verb, uppercased.
    ///
    /// Valkey verbs are case-insensitive and clients are inconsistent — `redis-cli` sends `get`,
    /// BullMQ's Lua sends `EVALSHA`. Matching on the raw bytes would let `Get` slip past a check
    /// looking for `GET`, which for a command table deciding what is a key is a security bug.
    pub fn verb(&self) -> String {
        self.args
            .first()
            .map(|arg| String::from_utf8_lossy(arg).to_uppercase())
            .unwrap_or_default()
    }

    /// Serializes back to RESP.
    pub fn encode(&self) -> Vec<u8> {
        let mut out =
            Vec::with_capacity(16 + self.args.iter().map(|a| a.len() + 16).sum::<usize>());
        out.put_slice(format!("*{}\r\n", self.args.len()).as_bytes());
        for arg in &self.args {
            out.put_slice(format!("${}\r\n", arg.len()).as_bytes());
            out.put_slice(arg);
            out.put_slice(b"\r\n");
        }
        out
    }
}

/// Reads one command out of a buffer.
///
/// Returns `Ok(None)` when the buffer holds only part of a command — the caller reads more and
/// tries again. The buffer is only advanced once a whole command has been parsed, so a partial
/// read never loses bytes.
pub fn parse_command(buffer: &mut BytesMut) -> Result<Option<Command>, RespError> {
    let Some((count, header_len)) = parse_header(buffer, b'*')? else {
        return Ok(None);
    };

    if count < 0 {
        return Err(RespError::Malformed("a command cannot be a null array"));
    }
    let count = count as usize;
    if count == 0 {
        return Err(RespError::Malformed("a command needs at least a verb"));
    }
    if count > MAX_ARGS {
        return Err(RespError::TooLarge {
            actual: count,
            max: MAX_ARGS,
        });
    }

    let mut cursor = header_len;
    let mut args = Vec::with_capacity(count.min(64));

    for _ in 0..count {
        let Some((len, len_header)) = parse_header_at(buffer, cursor, b'$')? else {
            return Ok(None);
        };
        if len < 0 {
            return Err(RespError::Malformed("a command argument cannot be null"));
        }
        let len = len as usize;
        if len > MAX_COMMAND_BYTES {
            return Err(RespError::TooLarge {
                actual: len,
                max: MAX_COMMAND_BYTES,
            });
        }

        let start = cursor + len_header;
        let end = start + len;
        // +2 for the trailing CRLF, which must be present before the argument is complete.
        if buffer.len() < end + 2 {
            return Ok(None);
        }
        if &buffer[end..end + 2] != b"\r\n" {
            return Err(RespError::Malformed("a bulk string must end with CRLF"));
        }

        args.push(buffer[start..end].to_vec());
        cursor = end + 2;
    }

    buffer.advance(cursor);
    Ok(Some(Command::new(args)))
}

/// Reads `<prefix><number>\r\n` at the start of the buffer.
fn parse_header(buffer: &BytesMut, prefix: u8) -> Result<Option<(i64, usize)>, RespError> {
    parse_header_at(buffer, 0, prefix)
}

fn parse_header_at(
    buffer: &BytesMut,
    offset: usize,
    prefix: u8,
) -> Result<Option<(i64, usize)>, RespError> {
    if buffer.len() <= offset {
        return Ok(None);
    }
    if buffer[offset] != prefix {
        return Err(RespError::Malformed(
            "expected an array of bulk strings; inline commands are not supported",
        ));
    }

    // Bounded so a client that never sends CRLF cannot make the proxy scan an unbounded buffer on
    // every read. 32 digits is far past any real length.
    let limit = (offset + 34).min(buffer.len());
    let Some(newline) = buffer[offset..limit].iter().position(|byte| *byte == b'\n') else {
        if limit - offset >= 34 {
            return Err(RespError::Malformed(
                "a header line is too long to be a number",
            ));
        }
        return Ok(None);
    };
    let newline = offset + newline;

    if newline == offset || buffer[newline - 1] != b'\r' {
        return Err(RespError::Malformed("a header must end with CRLF"));
    }

    let digits = &buffer[offset + 1..newline - 1];
    let text = std::str::from_utf8(digits)
        .map_err(|_| RespError::Malformed("a header length is not a number"))?;
    let value: i64 = text
        .parse()
        .map_err(|_| RespError::Malformed("a header length is not a number"))?;

    Ok(Some((value, newline + 1 - offset)))
}

/// A RESP simple string, `+OK\r\n`.
pub fn simple_string(text: &str) -> Vec<u8> {
    format!("+{text}\r\n").into_bytes()
}

/// A RESP error, `-ERR ...\r\n`.
///
/// Newlines are stripped: an error containing one would terminate the reply early and leave the
/// client parsing our message as the next reply.
pub fn error(message: &str) -> Vec<u8> {
    let cleaned: String = message
        .chars()
        .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        .collect();
    format!("-ERR {cleaned}\r\n").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buffer(bytes: &[u8]) -> BytesMut {
        BytesMut::from(bytes)
    }

    fn args_of(command: &Command) -> Vec<String> {
        command
            .args
            .iter()
            .map(|a| String::from_utf8_lossy(a).into_owned())
            .collect()
    }

    #[test]
    fn parses_a_whole_command() {
        let mut buf = buffer(b"*2\r\n$3\r\nGET\r\n$4\r\njobs\r\n");
        let command = parse_command(&mut buf).unwrap().unwrap();
        assert_eq!(args_of(&command), vec!["GET", "jobs"]);
        assert!(buf.is_empty(), "a parsed command should be consumed");
    }

    /// TCP does not deliver messages, it delivers bytes. Every prefix of a command arrives on its
    /// own at some point under load, and each one must leave the buffer untouched for the next read.
    #[test]
    fn a_partial_command_consumes_nothing() {
        let whole = b"*2\r\n$3\r\nGET\r\n$4\r\njobs\r\n";
        for split in 1..whole.len() {
            let mut buf = buffer(&whole[..split]);
            let before = buf.len();
            assert!(
                parse_command(&mut buf).unwrap().is_none(),
                "{split} bytes should not parse as a whole command"
            );
            assert_eq!(
                buf.len(),
                before,
                "a partial parse consumed bytes at {split}"
            );
        }
    }

    #[test]
    fn a_command_split_across_reads_parses_once_complete() {
        let mut buf = buffer(b"*2\r\n$3\r\nGET\r\n$4\r\njo");
        assert!(parse_command(&mut buf).unwrap().is_none());
        buf.extend_from_slice(b"bs\r\n");
        assert_eq!(
            args_of(&parse_command(&mut buf).unwrap().unwrap()),
            vec!["GET", "jobs"]
        );
    }

    #[test]
    fn pipelined_commands_parse_one_at_a_time() {
        // BullMQ pipelines aggressively; two commands routinely arrive in one read.
        let mut buf = buffer(b"*1\r\n$4\r\nPING\r\n*1\r\n$5\r\nMULTI\r\n");
        assert_eq!(
            args_of(&parse_command(&mut buf).unwrap().unwrap()),
            vec!["PING"]
        );
        assert_eq!(
            args_of(&parse_command(&mut buf).unwrap().unwrap()),
            vec!["MULTI"]
        );
        assert!(parse_command(&mut buf).unwrap().is_none());
    }

    #[test]
    fn arguments_are_binary_safe() {
        let mut buf = BytesMut::from(&b"*2\r\n$3\r\nSET\r\n$3\r\n"[..]);
        buf.extend_from_slice(&[0xff, 0x0a, 0x00]);
        buf.extend_from_slice(b"\r\n");
        let command = parse_command(&mut buf).unwrap().unwrap();
        // The 0x0a is a newline inside a payload. Length-prefixed parsing must not treat it as a
        // terminator — line-scanning would truncate the value here.
        assert_eq!(command.args[1], vec![0xff, 0x0a, 0x00]);
    }

    #[test]
    fn an_empty_argument_is_legitimate() {
        let mut buf = buffer(b"*2\r\n$3\r\nSET\r\n$0\r\n\r\n");
        assert_eq!(
            parse_command(&mut buf).unwrap().unwrap().args[1],
            Vec::<u8>::new()
        );
    }

    #[test]
    fn inline_commands_are_refused() {
        // `PING\r\n` typed at telnet. Supporting it half-way would mean a command path that never
        // passes through the namespacing table.
        let mut buf = buffer(b"PING\r\n");
        assert!(matches!(
            parse_command(&mut buf),
            Err(RespError::Malformed(_))
        ));
    }

    #[test]
    fn malformed_commands_are_refused() {
        for bytes in [
            &b"*-1\r\n"[..],              // null array
            &b"*0\r\n"[..],               // no verb
            &b"*1\r\n$-1\r\n"[..],        // null argument
            &b"*1\r\n$3\r\nGETX\r\n"[..], // length disagrees with the CRLF
            &b"*x\r\n"[..],               // not a number
            &b"*1\n"[..],                 // LF without CR
        ] {
            let mut buf = buffer(bytes);
            assert!(
                parse_command(&mut buf).is_err(),
                "{:?} should be refused",
                String::from_utf8_lossy(bytes)
            );
        }
    }

    /// Without this the proxy allocates whatever a hostile client claims, before reading a byte of it.
    #[test]
    fn oversized_declarations_are_refused_before_allocating() {
        let mut buf = buffer(format!("*{}\r\n", MAX_ARGS + 1).as_bytes());
        assert!(matches!(
            parse_command(&mut buf),
            Err(RespError::TooLarge { .. })
        ));

        let mut buf =
            buffer(format!("*2\r\n$3\r\nGET\r\n${}\r\n", MAX_COMMAND_BYTES + 1).as_bytes());
        assert!(matches!(
            parse_command(&mut buf),
            Err(RespError::TooLarge { .. })
        ));
    }

    /// A client that opens with `*` and then never sends a newline would otherwise have the proxy
    /// rescan a growing buffer on every read, forever.
    #[test]
    fn a_header_that_never_ends_is_refused_rather_than_scanned_forever() {
        let mut buf = buffer(b"*11111111111111111111111111111111111111");
        assert!(matches!(
            parse_command(&mut buf),
            Err(RespError::Malformed(_))
        ));
    }

    #[test]
    fn encode_round_trips() {
        let command = Command::new(vec![b"SET".to_vec(), b"k".to_vec(), vec![0xff, 0x00]]);
        let mut buf = BytesMut::from(&command.encode()[..]);
        assert_eq!(parse_command(&mut buf).unwrap().unwrap(), command);
    }

    #[test]
    fn the_verb_is_uppercased_and_lossless_on_junk() {
        assert_eq!(Command::new(vec![b"get".to_vec()]).verb(), "GET");
        // A verb that is not UTF-8 must not panic; it simply will not match the command table.
        assert!(!Command::new(vec![vec![0xff]]).verb().is_empty());
        assert_eq!(Command::new(vec![]).verb(), "");
    }

    #[test]
    fn an_error_reply_cannot_smuggle_a_second_reply() {
        // A message carrying CRLF would end the error early and leave the client reading our text
        // as the reply to its next command — every subsequent reply off by one.
        let encoded = error("bad\r\n+OK");
        assert_eq!(encoded, b"-ERR bad  +OK\r\n");
        assert_eq!(encoded.windows(2).filter(|w| *w == b"\r\n").count(), 1);
    }

    #[test]
    fn simple_strings_encode() {
        assert_eq!(simple_string("OK"), b"+OK\r\n");
    }
}
