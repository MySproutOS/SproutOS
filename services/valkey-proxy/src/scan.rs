//! Tenant-safe implementation of the keyspace-wide `SCAN` command.
//!
//! Valkey ACL key patterns do not filter `SCAN`, so the tenant connection is deliberately denied
//! the command. The proxy runs a constrained form over a short-lived administrator connection,
//! forces the tenant prefix into `MATCH`, and removes it from every returned key.

use anyhow::{Context, Result};
use bytes::BytesMut;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::reply::frame;
use crate::resp::Command;
use crate::upstream;

const MAX_COUNT: u64 = 1_000;
const MAX_REPLY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanRequest {
    args: Vec<Vec<u8>>,
}

impl ScanRequest {
    pub fn parse(command: &Command, prefix: &[u8]) -> Result<Self, &'static str> {
        if command.args.len() < 2 {
            return Err("SCAN requires a cursor");
        }
        let cursor = &command.args[1];
        if cursor.is_empty() || !cursor.iter().all(u8::is_ascii_digit) {
            return Err("SCAN cursor must be an unsigned integer");
        }

        let mut pattern: Option<&[u8]> = None;
        let mut count: Option<u64> = None;
        let mut index = 2;
        while index < command.args.len() {
            let option = command.args[index].to_ascii_uppercase();
            let Some(value) = command.args.get(index + 1) else {
                return Err("SCAN option requires a value");
            };
            match option.as_slice() {
                b"MATCH" if pattern.is_none() => pattern = Some(value),
                b"COUNT" if count.is_none() => {
                    let parsed = std::str::from_utf8(value)
                        .ok()
                        .and_then(|raw| raw.parse::<u64>().ok())
                        .filter(|value| *value > 0)
                        .ok_or("SCAN COUNT must be a positive integer")?;
                    count = Some(parsed.min(MAX_COUNT));
                }
                b"MATCH" | b"COUNT" => return Err("SCAN option may only be specified once"),
                _ => return Err("only MATCH and COUNT are supported by SCAN"),
            }
            index += 2;
        }

        let mut forced_pattern = Vec::with_capacity(prefix.len() + pattern.map_or(1, <[u8]>::len));
        forced_pattern.extend_from_slice(prefix);
        forced_pattern.extend_from_slice(pattern.unwrap_or(b"*"));

        let mut args = vec![
            b"SCAN".to_vec(),
            cursor.clone(),
            b"MATCH".to_vec(),
            forced_pattern,
        ];
        if let Some(count) = count {
            args.push(b"COUNT".to_vec());
            args.push(count.to_string().into_bytes());
        }
        Ok(Self { args })
    }
}

pub async fn execute(backend: &str, request: &ScanRequest, prefix: &[u8]) -> Result<Vec<u8>> {
    let mut stream = upstream::connect(backend).await?;
    stream
        .write_all(&Command::new(request.args.clone()).encode())
        .await?;
    stream.flush().await?;

    let mut reply = BytesMut::with_capacity(8 * 1024);
    loop {
        let read = stream.read_buf(&mut reply).await?;
        anyhow::ensure!(read > 0, "Valkey closed before answering SCAN");
        anyhow::ensure!(
            reply.len() <= MAX_REPLY_BYTES,
            "Valkey SCAN reply exceeded the bounded reply size"
        );
        if let Some(framed) = frame(&reply).context("Valkey returned malformed SCAN reply")? {
            anyhow::ensure!(
                framed.len == reply.len(),
                "Valkey returned trailing SCAN data"
            );
            return rewrite_reply(&reply, prefix);
        }
    }
}

fn rewrite_reply(reply: &[u8], prefix: &[u8]) -> Result<Vec<u8>> {
    let mut parser = Parser::new(reply);
    parser.array_len(2)?;
    let cursor = parser.bulk()?;
    let key_count = parser.array()?;
    let mut keys = Vec::with_capacity(key_count);
    for _ in 0..key_count {
        let key = parser.bulk()?;
        let bare = key
            .strip_prefix(prefix)
            .context("administrator SCAN returned a key outside the tenant namespace")?;
        keys.push(bare);
    }
    anyhow::ensure!(parser.done(), "SCAN reply had trailing fields");

    let mut out = Vec::with_capacity(reply.len());
    out.extend_from_slice(b"*2\r\n");
    push_bulk(&mut out, cursor);
    out.extend_from_slice(format!("*{}\r\n", keys.len()).as_bytes());
    for key in keys {
        push_bulk(&mut out, key);
    }
    Ok(out)
}

fn push_bulk(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(format!("${}\r\n", value.len()).as_bytes());
    out.extend_from_slice(value);
    out.extend_from_slice(b"\r\n");
}

struct Parser<'a> {
    bytes: &'a [u8],
    cursor: usize,
}

impl<'a> Parser<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, cursor: 0 }
    }

    fn array_len(&mut self, expected: usize) -> Result<()> {
        anyhow::ensure!(self.array()? == expected, "unexpected SCAN reply shape");
        Ok(())
    }

    fn array(&mut self) -> Result<usize> {
        self.number(b'*')
    }

    fn bulk(&mut self) -> Result<&'a [u8]> {
        let len = self.number(b'$')?;
        let end = self.cursor.checked_add(len).context("SCAN bulk overflow")?;
        anyhow::ensure!(end + 2 <= self.bytes.len(), "truncated SCAN bulk string");
        anyhow::ensure!(
            &self.bytes[end..end + 2] == b"\r\n",
            "malformed SCAN bulk string"
        );
        let value = &self.bytes[self.cursor..end];
        self.cursor = end + 2;
        Ok(value)
    }

    fn number(&mut self, marker: u8) -> Result<usize> {
        anyhow::ensure!(
            self.bytes.get(self.cursor) == Some(&marker),
            "unexpected SCAN reply type"
        );
        let start = self.cursor + 1;
        let relative_end = self.bytes[start..]
            .windows(2)
            .position(|bytes| bytes == b"\r\n")
            .context("truncated SCAN reply header")?;
        let end = start + relative_end;
        let value = std::str::from_utf8(&self.bytes[start..end])?.parse::<usize>()?;
        self.cursor = end + 2;
        Ok(value)
    }

    fn done(&self) -> bool {
        self.cursor == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(args: &[&str]) -> Command {
        Command::new(args.iter().map(|arg| arg.as_bytes().to_vec()).collect())
    }

    #[test]
    fn request_forces_prefix_and_caps_count() {
        let request = ScanRequest::parse(
            &command(&["SCAN", "42", "MATCH", "jobs:*", "COUNT", "999999"]),
            b"{kv:tenant}:",
        )
        .unwrap();
        assert_eq!(
            request.args,
            command(&["SCAN", "42", "MATCH", "{kv:tenant}:jobs:*", "COUNT", "1000"]).args
        );
    }

    #[test]
    fn reply_strips_prefix_and_fails_closed_on_foreign_keys() {
        let prefix = b"{kv:t}:";
        let reply = b"*2\r\n$1\r\n0\r\n*2\r\n$10\r\n{kv:t}:one\r\n$10\r\n{kv:t}:two\r\n";
        assert_eq!(
            rewrite_reply(reply, prefix).unwrap(),
            b"*2\r\n$1\r\n0\r\n*2\r\n$3\r\none\r\n$3\r\ntwo\r\n"
        );
        assert!(rewrite_reply(b"*2\r\n$1\r\n0\r\n*1\r\n$7\r\nforeign\r\n", prefix).is_err());
    }
}
