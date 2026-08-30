//! End to end: a real client, through the proxy, to the real Valkey in docker-compose.
//!
//! The unit tests prove each piece in isolation — that `BLPOP`'s timeout is not a key, that a map
//! reply is measured as pairs. None of them prove the pieces are wired to each other, and the
//! failure this service exists to prevent is a wiring failure: a key that reaches the shared
//! keyspace unprefixed is a key every other tenant can read.
//!
//! So this drives the whole thing. It provisions two tenants against the compose Postgres, has
//! each write to the same key name, and checks that neither can see the other's value — and it
//! checks it *from the outside*, by looking at the raw keys the backend actually holds.
//!
//! Skipped, not failed, when the services are not running: `docker compose up -d` first.

use std::net::SocketAddr;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;
use valkey_proxy::CredentialStore;
use valkey_proxy::master::MasterQueue;
use valkey_proxy::provision::AclProvisioner;

/// The shared Valkey these tests proxy to.
///
/// Defaults to the docker-compose port so a developer needs no setup beyond `docker compose up -d`.
/// CI overrides it, because a workflow's service containers pick their own mapping.
fn backend() -> String {
    std::env::var("VALKEY_PROXY_BACKEND").unwrap_or_else(|_| "127.0.0.1:41023".into())
}

fn database_url() -> Option<String> {
    // The same URL the TypeScript side uses. Read from the environment rather than hard-coded so
    // this runs against whatever the developer's compose stack is bound to.
    std::env::var("VALKEY_PROXY_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
        .map(|url| url.split('?').next().unwrap_or(&url).to_owned())
}

async fn services_up(url: &str) -> bool {
    let valkey = TcpStream::connect(backend()).await.is_ok();
    let postgres = match CredentialStore::connect(url, 2) {
        Ok(store) => store.check().await.is_ok(),
        Err(_) => false,
    };

    /*
      On a developer's machine a missing service is a skip: `cargo test` should not fail because
      docker is not running.

      In CI it is a failure. A skipped isolation test looks exactly like a passing one in the
      summary, so a workflow that lost its service container would go on reporting green while the
      tests that check tenants cannot read each other's keys had stopped running entirely.
    */
    if (!valkey || !postgres) && std::env::var("CI").is_ok() {
        panic!(
            "the integration services are not reachable in CI (valkey={valkey}, postgres={postgres}); \
             these tests must not silently skip here"
        );
    }

    if !valkey || !postgres {
        eprintln!("skipping: run `docker compose up -d` and apply migrations first");
    }
    valkey && postgres
}

/// A client that speaks just enough RESP to drive the proxy.
struct Client {
    stream: TcpStream,
}

impl Client {
    async fn connect(address: SocketAddr) -> Self {
        Self {
            stream: TcpStream::connect(address).await.expect("connect"),
        }
    }

    async fn send(&mut self, args: &[&str]) -> String {
        self.write(args).await;

        self.read_reply().await
    }

    async fn write(&mut self, args: &[&str]) {
        let bytes = args.iter().map(|arg| arg.as_bytes()).collect::<Vec<_>>();
        self.write_bytes(&bytes).await;
    }

    async fn write_bytes(&mut self, args: &[&[u8]]) {
        let mut out = format!("*{}\r\n", args.len()).into_bytes();
        for arg in args {
            out.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
            out.extend_from_slice(arg);
            out.extend_from_slice(b"\r\n");
        }
        self.stream.write_all(&out).await.expect("write");
    }

    async fn read_reply(&mut self) -> String {
        String::from_utf8_lossy(&self.read_reply_bytes().await).into_owned()
    }

    async fn read_reply_bytes(&mut self) -> Vec<u8> {
        let mut buffer = bytes::BytesMut::new();
        loop {
            if let Some(framed) = valkey_proxy::reply::frame(&buffer).expect("valid reply") {
                return buffer.split_to(framed.len).to_vec();
            }
            // Read exactly one byte so a second pub/sub acknowledgement cannot be consumed into a
            // method-local buffer and lost when this call returns the first frame.
            let mut byte = [0_u8; 1];
            let read = tokio::time::timeout(Duration::from_secs(5), self.stream.read(&mut byte))
                .await
                .expect("the proxy did not reply in time")
                .expect("read");
            assert!(read > 0, "the proxy closed before a complete reply");
            buffer.extend_from_slice(&byte[..read]);
        }
    }

    async fn pipeline(&mut self, commands: &[&[&str]]) -> Vec<String> {
        let out = encode_pipeline(commands);
        self.stream.write_all(&out).await.expect("write pipeline");

        let mut buffer = bytes::BytesMut::new();
        let mut replies = Vec::new();
        while replies.len() < commands.len() {
            tokio::time::timeout(Duration::from_secs(5), self.stream.read_buf(&mut buffer))
                .await
                .expect("the proxy did not reply to the pipeline in time")
                .expect("read pipeline");
            while let Some(framed) = valkey_proxy::reply::frame(&buffer).expect("valid reply") {
                replies.push(String::from_utf8_lossy(&buffer.split_to(framed.len)).into_owned());
            }
        }
        replies
    }
}

fn encode_pipeline(commands: &[&[&str]]) -> Vec<u8> {
    let mut out = Vec::new();
    for args in commands {
        out.extend_from_slice(format!("*{}\r\n", args.len()).as_bytes());
        for arg in *args {
            out.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
            out.extend_from_slice(arg.as_bytes());
            out.extend_from_slice(b"\r\n");
        }
    }
    out
}

fn bulk_payload(reply: &[u8]) -> &[u8] {
    assert_eq!(reply.first(), Some(&b'$'), "not a bulk reply: {reply:?}");
    let header = reply
        .windows(2)
        .position(|window| window == b"\r\n")
        .unwrap()
        + 2;
    let len = std::str::from_utf8(&reply[1..header - 2])
        .unwrap()
        .parse::<usize>()
        .unwrap();
    &reply[header..header + len]
}

#[tokio::test]
async fn management_compatibility_commands_are_local_and_safe() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;
    let mut client = Client::connect(address).await;
    assert_eq!(client.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    let info = client.send(&["INFO"]).await;
    assert!(
        info.starts_with('$') && info.contains("redis_version:"),
        "{info:?}"
    );
    assert_eq!(
        client
            .send(&["CLIENT", "SETINFO", "LIB-NAME", "integration"])
            .await,
        "+OK\r\n"
    );
    assert_eq!(client.send(&["COMMAND", "DOCS", "GET"]).await, "*0\r\n");
    assert!(
        client
            .send(&["CLIENT", "LIST"])
            .await
            .contains("disallowed"),
        "only CLIENT SETINFO may be local"
    );

    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn a_command_pipelined_with_auth_is_not_stranded() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;
    let mut client = Client::connect(address).await;
    let replies = client
        .pipeline(&[
            &["AUTH", &username, &secret],
            &["SET", "pipelined", "0"],
            &["INCR", "pipelined"],
            &["GET", "pipelined"],
            &["PING"],
        ])
        .await;

    assert_eq!(
        replies,
        ["+OK\r\n", "+OK\r\n", ":1\r\n", "$1\r\n1\r\n", "+PONG\r\n"]
    );
    assert_eq!(client.send(&["DEL", "pipelined"]).await, ":1\r\n");
    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn broad_tenant_data_structures_work_without_cross_tenant_keys() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username_a, secret_a, _service_a, fixtures_a) = provision(&url).await;
    let (username_b, secret_b, _service_b, fixtures_b) = provision(&url).await;
    let mut a = Client::connect(address).await;
    let mut b = Client::connect(address).await;
    assert_eq!(a.send(&["AUTH", &username_a, &secret_a]).await, "+OK\r\n");
    assert_eq!(b.send(&["AUTH", &username_b, &secret_b]).await, "+OK\r\n");

    assert_eq!(a.send(&["SET", "bits-a", "a"]).await, "+OK\r\n");
    assert_eq!(a.send(&["SET", "bits-b", "b"]).await, "+OK\r\n");
    assert!(
        a.send(&["BITOP", "AND", "bits-out", "bits-a", "bits-b"])
            .await
            .starts_with(':')
    );
    assert_eq!(a.send(&["HSET", "hash", "field", "value"]).await, ":1\r\n");
    assert_eq!(a.send(&["HSTRLEN", "hash", "field"]).await, ":5\r\n");

    for (key, member) in [("set-a", "one"), ("set-b", "one")] {
        assert_eq!(a.send(&["SADD", key, member]).await, ":1\r\n");
    }
    assert_eq!(
        a.send(&["SINTERSTORE", "set-out", "set-a", "set-b"]).await,
        ":1\r\n"
    );

    for (key, score) in [("z-a", "1"), ("z-b", "2")] {
        assert_eq!(a.send(&["ZADD", key, score, "one"]).await, ":1\r\n");
    }
    assert_eq!(
        a.send(&[
            "ZINTERSTORE",
            "z-out",
            "2",
            "z-a",
            "z-b",
            "AGGREGATE",
            "SUM",
        ])
        .await,
        ":1\r\n"
    );
    assert_eq!(
        a.send(&["GEOADD", "places", "0", "0", "origin"]).await,
        ":1\r\n"
    );
    assert_eq!(a.send(&["PFADD", "visitors", "alice"]).await, ":1\r\n");
    assert_eq!(a.send(&["PFCOUNT", "visitors"]).await, ":1\r\n");

    // The same logical names in another tenant are empty. This is the end-to-end property the
    // command table alone cannot prove.
    for key in ["bits-out", "hash", "set-out", "z-out", "places", "visitors"] {
        assert_eq!(b.send(&["EXISTS", key]).await, ":0\r\n", "{key}");
    }

    a.send(&[
        "DEL", "bits-a", "bits-b", "bits-out", "hash", "set-a", "set-b", "set-out", "z-a", "z-b",
        "z-out", "places", "visitors",
    ])
    .await;
    cleanup(&url, &fixtures_a).await;
    cleanup(&url, &fixtures_b).await;
}

#[tokio::test]
async fn fragmented_auth_preserves_a_fragmented_following_command() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;
    let mut client = Client::connect(address).await;
    let bytes = encode_pipeline(&[
        &["AUTH", &username, &secret],
        &["SET", "fragmented", "kept"],
        &["GET", "fragmented"],
    ]);
    let auth_end = bytes
        .windows(secret.len())
        .position(|window| window == secret.as_bytes())
        .expect("secret in encoded AUTH")
        + secret.len()
        + 2;
    let partial_command_end = auth_end + 9;

    // Split both the AUTH frame and the next command. The authentication reader must retain the
    // partial application frame, then the forwarding reader must join it to the later bytes once.
    client
        .stream
        .write_all(&bytes[..7])
        .await
        .expect("AUTH prefix");
    tokio::task::yield_now().await;
    client
        .stream
        .write_all(&bytes[7..partial_command_end])
        .await
        .expect("AUTH suffix and partial command");
    assert_eq!(client.read_reply().await, "+OK\r\n");
    client
        .stream
        .write_all(&bytes[partial_command_end..])
        .await
        .expect("remaining commands");

    assert_eq!(client.read_reply().await, "+OK\r\n");
    assert_eq!(client.read_reply().await, "$4\r\nkept\r\n");
    assert_eq!(client.send(&["DEL", "fragmented"]).await, ":1\r\n");
    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn a_command_coalesced_with_failed_auth_never_reaches_valkey() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;
    let mut rejected = Client::connect(address).await;
    let bytes = encode_pipeline(&[
        &["AUTH", &username, "not-the-secret"],
        &["SET", "after-wrongpass", "must-not-exist"],
    ]);
    rejected
        .stream
        .write_all(&bytes)
        .await
        .expect("write pipeline");
    assert_eq!(
        rejected.read_reply().await,
        "-ERR WRONGPASS invalid username or password\r\n"
    );
    let mut trailing = [0_u8; 1];
    let read = tokio::time::timeout(Duration::from_secs(5), rejected.stream.read(&mut trailing))
        .await
        .expect("failed authentication did not close")
        .expect("read after failed authentication");
    assert_eq!(read, 0, "a coalesced command produced a second reply");

    let mut accepted = Client::connect(address).await;
    assert_eq!(
        accepted.send(&["AUTH", &username, &secret]).await,
        "+OK\r\n"
    );
    assert_eq!(accepted.send(&["GET", "after-wrongpass"]).await, "$-1\r\n");
    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn xread_and_xreadgroup_are_scoped_and_hide_physical_stream_names() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, service, fixtures) = provision(&url).await;
    let mut client = Client::connect(address).await;
    assert_eq!(client.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    assert!(
        client
            .send(&["XADD", "events", "*", "kind", "one"])
            .await
            .starts_with('$')
    );
    let read = client.send(&["XREAD", "STREAMS", "events", "0-0"]).await;
    assert!(read.contains("\r\nevents\r\n"), "{read}");
    assert!(!read.contains("{kv:"), "physical stream leaked: {read}");
    let published = format!(
        "{{kv:{}}}:events",
        sproutos_tenant_auth::encode_short_id(service)
    );
    let published_read = client.send(&["XREAD", "STREAMS", &published, "0-0"]).await;
    assert!(
        published_read.contains(&format!("\r\n{published}\r\n")),
        "a caller's already-prefixed spelling changed: {published_read}"
    );

    assert_eq!(
        client
            .send(&["XGROUP", "CREATE", "jobs", "workers", "0", "MKSTREAM"])
            .await,
        "+OK\r\n"
    );
    client.send(&["XADD", "jobs", "*", "kind", "two"]).await;
    let grouped = client
        .send(&[
            "XREADGROUP",
            "GROUP",
            "workers",
            "one",
            "STREAMS",
            "jobs",
            ">",
        ])
        .await;
    assert!(grouped.contains("\r\njobs\r\n"), "{grouped}");
    assert!(
        !grouped.contains("{kv:"),
        "physical stream leaked: {grouped}"
    );

    client.send(&["DEL", "events", "jobs"]).await;
    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn rounded_out_key_commands_execute_against_real_valkey() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;
    let mut client = Client::connect(address).await;
    assert_eq!(client.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    assert_eq!(client.send(&["SET", "text", "abcdef"]).await, "+OK\r\n");
    assert_eq!(
        client.send(&["GETRANGE", "text", "1", "3"]).await,
        "$3\r\nbcd\r\n"
    );
    assert_eq!(
        client.send(&["SETRANGE", "text", "2", "XY"]).await,
        ":6\r\n"
    );
    assert!(client.send(&["BITCOUNT", "text"]).await.starts_with(':'));
    assert!(client.send(&["BITPOS", "text", "1"]).await.starts_with(':'));
    assert_eq!(client.send(&["PEXPIRE", "text", "60000"]).await, ":1\r\n");
    assert!(client.send(&["EXPIRETIME", "text"]).await.starts_with(':'));
    assert!(client.send(&["PEXPIRETIME", "text"]).await.starts_with(':'));

    assert_eq!(
        client.send(&["SET", "dump-source", "restored"]).await,
        "+OK\r\n"
    );
    client.write(&["DUMP", "dump-source"]).await;
    let dumped = client.read_reply_bytes().await;
    let payload = bulk_payload(&dumped).to_vec();
    client
        .write_bytes(&[b"RESTORE", b"dump-copy", b"0", &payload])
        .await;
    assert_eq!(client.read_reply().await, "+OK\r\n");
    assert_eq!(
        client.send(&["GET", "dump-copy"]).await,
        "$8\r\nrestored\r\n"
    );

    client.send(&["RPUSH", "list-a", "one"]).await;
    let lmpop = client.send(&["LMPOP", "1", "list-a", "LEFT"]).await;
    assert!(lmpop.contains("list-a") && lmpop.contains("one"), "{lmpop}");
    assert!(!lmpop.contains("{kv:"), "{lmpop}");
    client.send(&["RPUSH", "list-b", "two"]).await;
    let blmpop = client.send(&["BLMPOP", "1", "1", "list-b", "LEFT"]).await;
    assert!(
        blmpop.contains("list-b") && blmpop.contains("two"),
        "{blmpop}"
    );
    assert!(!blmpop.contains("{kv:"), "{blmpop}");
    client.send(&["ZADD", "z-a", "1", "one"]).await;
    let zmpop = client.send(&["ZMPOP", "1", "z-a", "MIN"]).await;
    assert!(zmpop.contains("z-a") && zmpop.contains("one"), "{zmpop}");
    assert!(!zmpop.contains("{kv:"), "{zmpop}");
    client.send(&["ZADD", "z-b", "1", "two"]).await;
    let bzmpop = client.send(&["BZMPOP", "1", "1", "z-b", "MAX"]).await;
    assert!(bzmpop.contains("z-b") && bzmpop.contains("two"), "{bzmpop}");
    assert!(!bzmpop.contains("{kv:"), "{bzmpop}");
    client.send(&["SADD", "set-a", "x", "shared"]).await;
    client.send(&["SADD", "set-b", "y", "shared"]).await;
    assert_eq!(
        client.send(&["SINTERCARD", "2", "set-a", "set-b"]).await,
        ":1\r\n"
    );

    client
        .send(&[
            "DEL",
            "text",
            "dump-source",
            "dump-copy",
            "list-a",
            "list-b",
            "z-a",
            "z-b",
            "set-a",
            "set-b",
        ])
        .await;
    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn pubsub_has_unsolicited_frames_namespaced_channels_and_clean_mode_transitions() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, service, fixtures) = provision(&url).await;
    let mut subscriber = Client::connect(address).await;
    let mut publisher = Client::connect(address).await;
    assert_eq!(
        subscriber.send(&["AUTH", &username, &secret]).await,
        "+OK\r\n"
    );
    assert_eq!(
        publisher.send(&["AUTH", &username, &secret]).await,
        "+OK\r\n"
    );
    assert_eq!(subscriber.send(&["MULTI"]).await, "+OK\r\n");
    assert!(
        subscriber
            .send(&["SUBSCRIBE", "not-queued"])
            .await
            .contains("not allowed in MULTI")
    );
    assert_eq!(subscriber.send(&["DISCARD"]).await, "+OK\r\n");

    // A normal array can coincidentally have the exact shape of a pub/sub delivery. Because it was
    // issued before SUBSCRIBE, it remains an ordinary pending response and must consume its slot.
    publisher
        .send(&[
            "RPUSH",
            "looks-like-message",
            "message",
            "events",
            "payload",
        ])
        .await;
    let transition = subscriber
        .pipeline(&[
            &["LRANGE", "looks-like-message", "0", "-1"],
            &["SUBSCRIBE", "warmup"],
        ])
        .await;
    assert!(transition[0].contains("message") && transition[0].contains("payload"));
    assert!(transition[1].contains("subscribe") && transition[1].contains("warmup"));
    assert!(
        subscriber
            .send(&["UNSUBSCRIBE", "warmup"])
            .await
            .contains("unsubscribe")
    );

    subscriber.write(&["SUBSCRIBE", "events", "other"]).await;
    let first_ack = subscriber.read_reply().await;
    let second_ack = subscriber.read_reply().await;
    assert!(first_ack.contains("\r\nevents\r\n"), "{first_ack}");
    assert!(second_ack.contains("\r\nother\r\n"), "{second_ack}");
    assert!(!first_ack.contains("{kv:") && !second_ack.contains("{kv:"));

    let physical = format!(
        "{{kv:{}}}:events",
        sproutos_tenant_auth::encode_short_id(service)
    );
    assert_eq!(
        publisher.send(&["PUBLISH", "events", &physical]).await,
        ":1\r\n"
    );
    let message = subscriber.read_reply().await;
    assert!(message.contains("\r\nevents\r\n"), "{message}");
    assert!(
        message.contains(&format!("\r\n{physical}\r\n")),
        "payload was rewritten: {message}"
    );

    let refused_scan = subscriber.send(&["SCAN", "0"]).await;
    assert!(refused_scan.contains("subscribed mode"), "{refused_scan}");

    subscriber.write(&["UNSUBSCRIBE"]).await;
    for _ in 0..2 {
        let ack = subscriber.read_reply().await;
        assert!(ack.contains("unsubscribe"), "{ack}");
        assert!(!ack.contains("{kv:"), "{ack}");
    }
    assert_eq!(subscriber.send(&["PING"]).await, "+PONG\r\n");

    subscriber.write(&["PSUBSCRIBE", "news*"]).await;
    let pattern_ack = subscriber.read_reply().await;
    assert!(pattern_ack.contains("\r\nnews*\r\n"), "{pattern_ack}");
    assert_eq!(
        publisher.send(&["PUBLISH", "news1", "hello"]).await,
        ":1\r\n"
    );
    let pattern_message = subscriber.read_reply().await;
    assert!(
        pattern_message.contains("\r\nnews*\r\n"),
        "{pattern_message}"
    );
    assert!(
        pattern_message.contains("\r\nnews1\r\n"),
        "{pattern_message}"
    );
    assert!(!pattern_message.contains("{kv:"), "{pattern_message}");
    subscriber.write(&["PUNSUBSCRIBE", "news*"]).await;
    assert!(subscriber.read_reply().await.contains("punsubscribe"));
    assert_eq!(subscriber.send(&["PING"]).await, "+PONG\r\n");

    // The dynamically granted glob is still an engine boundary, not proxy-only rewriting.
    let identity = sproutos_tenant_auth::TenantIdentity::new(
        fixtures[0],
        sproutos_tenant_auth::ResourceKind::Queue,
        service,
    );
    let acl = valkey_proxy::acl::credentials(b"integration-test-acl-root-key-32-bytes", &identity);
    let mut direct = Client {
        stream: TcpStream::connect(backend()).await.expect("backend"),
    };
    assert_eq!(
        direct.send(&["AUTH", &acl.username, &acl.password]).await,
        "+OK\r\n"
    );
    let foreign = direct.send(&["PSUBSCRIBE", "foreign*"]).await;
    assert!(
        foreign.contains("NOPERM"),
        "foreign pattern reached Valkey: {foreign}"
    );
    let foreign_publish = direct.send(&["PUBLISH", "foreign", "nope"]).await;
    assert!(foreign_publish.contains("NOPERM"), "{foreign_publish}");
    let allowed_pattern = format!(
        "{{kv:{}}}:news*",
        sproutos_tenant_auth::encode_short_id(service)
    );
    let direct_allowed = direct.send(&["PSUBSCRIBE", &allowed_pattern]).await;
    assert!(
        direct_allowed.contains(&allowed_pattern),
        "the engine did not retain the scoped grant: {direct_allowed}"
    );

    publisher.send(&["DEL", "looks-like-message"]).await;

    cleanup(&url, &fixtures).await;
}

fn parse_scan_reply(reply: &str) -> (String, Vec<String>) {
    let mut lines = reply.split("\r\n");
    assert_eq!(lines.next(), Some("*2"), "{reply:?}");
    let cursor_len = lines.next().expect("cursor bulk header");
    assert!(cursor_len.starts_with('$'), "{reply:?}");
    let cursor = lines.next().expect("cursor").to_owned();
    let count = lines
        .next()
        .and_then(|line| line.strip_prefix('*'))
        .and_then(|line| line.parse::<usize>().ok())
        .expect("key array header");
    let mut keys = Vec::with_capacity(count);
    for _ in 0..count {
        let header = lines.next().expect("key bulk header");
        assert!(header.starts_with('$'), "{reply:?}");
        keys.push(lines.next().expect("key").to_owned());
    }
    (cursor, keys)
}

async fn scan_all(client: &mut Client, pattern: Option<&str>) -> Vec<String> {
    let mut cursor = "0".to_owned();
    let mut keys = Vec::new();
    loop {
        let reply = match pattern {
            Some(pattern) => {
                client
                    .send(&["SCAN", &cursor, "MATCH", pattern, "COUNT", "1000"])
                    .await
            }
            None => client.send(&["SCAN", &cursor, "COUNT", "1000"]).await,
        };
        let (next, batch) = parse_scan_reply(&reply);
        keys.extend(batch);
        cursor = next;
        if cursor == "0" {
            return keys;
        }
    }
}

/// Provisions a tenant in the control-plane database and returns its username and secret.
///
/// Written with raw SQL rather than through the TypeScript driver on purpose: this is the Rust side
/// reading rows the TypeScript side writes, and the point is to prove the two agree on the format.
async fn provision(url: &str) -> (String, String, Uuid, Vec<Uuid>) {
    provision_in(url, None).await
}

/// Provisions a tenant, optionally inside an organization that already exists.
async fn provision_in(url: &str, existing_org: Option<Uuid>) -> (String, String, Uuid, Vec<Uuid>) {
    let (client, connection) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .expect("connect to postgres");
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let user_id = Uuid::now_v7();
    let service_id = Uuid::now_v7();
    let mut fixtures = Vec::new();

    let organization_id = match existing_org {
        Some(id) => id,
        None => {
            let organization_id = Uuid::now_v7();
            client
                .execute(
                    "insert into \"user\" (id, email, name) values ($1, $2, 'Proxy Test')",
                    &[&user_id, &format!("proxy-{user_id}@test.invalid")],
                )
                .await
                .expect("insert user");
            client
                .execute(
                    "insert into organization (id, name, slug, kind, owner_user_id)
                     values ($1, 'Proxy Org', $2, 'personal', $3)",
                    &[
                        &organization_id,
                        &format!("proxy-{organization_id}"),
                        &user_id,
                    ],
                )
                .await
                .expect("insert organization");
            fixtures.push(organization_id);
            fixtures.push(user_id);
            organization_id
        }
    };

    let region: Uuid = client
        .query_one("select id from region limit 1", &[])
        .await
        .expect("a seeded region")
        .get(0);

    client
        .execute(
            "insert into backend_service (id, organization_id, region_id, name, kind, status)
             values ($1, $2, $3, 'Proxy Queue', 'valkey', 'active')",
            &[&service_id, &organization_id, &region],
        )
        .await
        .expect("insert backend_service");

    // The username and secret are built here the way `lib/typescript/services/tenant-auth.ts`
    // builds them. If the two encodings ever drift, this test cannot authenticate.
    let identity = sproutos_tenant_auth::TenantIdentity::new(
        organization_id,
        sproutos_tenant_auth::ResourceKind::Queue,
        service_id,
    );
    let username = identity.username();
    let secret = sproutos_tenant_auth::generate_secret();

    client
        .execute(
            "insert into service_credential (id, backend_service_id, username, secret_hash, last_four)
             values ($1, $2, $3, $4, $5)",
            &[
                &Uuid::now_v7(),
                &service_id,
                &username,
                &sproutos_tenant_auth::hash_generated_secret(&secret),
                &&secret[secret.len() - 4..],
            ],
        )
        .await
        .expect("insert service_credential");

    (username, secret, service_id, fixtures)
}

async fn cleanup(url: &str, ids: &[Uuid]) {
    let Ok((client, connection)) = tokio_postgres::connect(url, tokio_postgres::NoTls).await else {
        return;
    };
    tokio::spawn(async move {
        let _ = connection.await;
    });
    for id in ids {
        let _ = client
            .execute("delete from organization where id = $1", &[id])
            .await;
        let _ = client
            .execute("delete from \"user\" where id = $1", &[id])
            .await;
    }
}

/// Starts the proxy with the master queue enabled, so enqueues are reported for dispatch.
async fn start_proxy_with_master(url: &str) -> SocketAddr {
    start(url, MasterQueue::spawn(backend())).await
}

/// Starts the proxy on an ephemeral port and returns its address.
async fn start_proxy(url: &str) -> SocketAddr {
    start(url, MasterQueue::disabled()).await
}

async fn start(url: &str, master: MasterQueue) -> SocketAddr {
    let store = std::sync::Arc::new(CredentialStore::connect(url, 4).expect("credential store"));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("local_addr");
    // A `String`, matching what `serve` now takes. The proxy resolves it per connection, so a
    // DNS name works here exactly as it does in production — which a `SocketAddr` never did.
    let backend = std::sync::Arc::new(backend());
    let provisioner = std::sync::Arc::new(
        AclProvisioner::new(
            backend.as_ref().clone(),
            b"integration-test-acl-root-key-32-bytes".to_vec(),
        )
        .expect("ACL provisioner"),
    );
    provisioner.self_check().await.expect("ACL self-check");
    let master = std::sync::Arc::new(master);

    tokio::spawn(async move {
        loop {
            let Ok((client, _)) = listener.accept().await else {
                return;
            };
            let store = std::sync::Arc::clone(&store);
            let provisioner = std::sync::Arc::clone(&provisioner);
            let master = std::sync::Arc::clone(&master);
            tokio::spawn(async move {
                let _ = valkey_proxy::serve(client, &store, &provisioner, &master).await;
            });
        }
    });

    address
}

/// Reads a key straight from the backend, bypassing the proxy — the only way to see what was
/// actually stored rather than what the proxy chose to show us.
async fn backend_get(key: &str) -> String {
    let mut raw = Client {
        stream: TcpStream::connect(backend()).await.expect("backend"),
    };
    raw.send(&["GET", key]).await
}

#[tokio::test]
async fn two_tenants_cannot_see_each_others_keys() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username_a, secret_a, service_a, fixtures_a) = provision(&url).await;
    let (username_b, secret_b, service_b, fixtures_b) = provision(&url).await;

    let mut a = Client::connect(address).await;
    assert_eq!(a.send(&["AUTH", &username_a, &secret_a]).await, "+OK\r\n");

    let mut b = Client::connect(address).await;
    assert_eq!(b.send(&["AUTH", &username_b, &secret_b]).await, "+OK\r\n");

    // The same key name, written by both tenants, with different values.
    assert_eq!(a.send(&["SET", "shared:key", "from-a"]).await, "+OK\r\n");
    assert_eq!(b.send(&["SET", "shared:key", "from-b"]).await, "+OK\r\n");

    // Neither sees the other's write. This is the whole product requirement.
    assert_eq!(a.send(&["GET", "shared:key"]).await, "$6\r\nfrom-a\r\n");
    assert_eq!(b.send(&["GET", "shared:key"]).await, "$6\r\nfrom-b\r\n");

    // And from outside the proxy: the unprefixed key must not exist at all. A proxy that forwarded
    // one command unnamespaced would still pass the two assertions above, because the tenant that
    // wrote it would read its own value back.
    assert_eq!(backend_get("shared:key").await, "$-1\r\n");

    let prefix_a = format!(
        "{{kv:{}}}:",
        sproutos_tenant_auth::encode_short_id(service_a)
    );
    let prefix_b = format!(
        "{{kv:{}}}:",
        sproutos_tenant_auth::encode_short_id(service_b)
    );
    assert_eq!(
        backend_get(&format!("{prefix_a}shared:key")).await,
        "$6\r\nfrom-a\r\n"
    );
    assert_eq!(
        backend_get(&format!("{prefix_b}shared:key")).await,
        "$6\r\nfrom-b\r\n"
    );

    // Tidy up the tenant's keys, then the fixtures.
    a.send(&["DEL", "shared:key"]).await;
    b.send(&["DEL", "shared:key"]).await;
    cleanup(&url, &fixtures_a).await;
    cleanup(&url, &fixtures_b).await;
}

#[tokio::test]
async fn a_blocking_pop_returns_the_key_the_tenant_asked_for() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;

    let mut client = Client::connect(address).await;
    assert_eq!(client.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    client.send(&["RPUSH", "bull:emails:wait", "job-1"]).await;

    /*
      The leak this test exists for.

      BLPOP echoes the key it popped from, and the key the *server* saw is the namespaced one. Sent
      back byte for byte, the tenant reads `{kv:…}:bull:emails:wait` out of the reply — and BullMQ
      does read it — then sends it as the next command's key, where it is namespaced a second time.
      The queue silently splits in two and jobs stop being delivered.
    */
    let reply = client.send(&["BLPOP", "bull:emails:wait", "0"]).await;
    assert_eq!(reply, "*2\r\n$16\r\nbull:emails:wait\r\n$5\r\njob-1\r\n");
    assert!(
        !reply.contains("{kv:"),
        "the namespace leaked into the reply: {reply}"
    );

    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn a_wrong_secret_is_refused_and_reveals_nothing() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, _secret, _service, fixtures) = provision(&url).await;

    let mut wrong = Client::connect(address).await;
    let refused = wrong.send(&["AUTH", &username, "not-the-secret"]).await;
    assert!(refused.starts_with("-ERR WRONGPASS"), "{refused}");

    // A username that does not exist must be refused identically. Any difference — a distinct
    // message, a distinct error code — is an oracle for enumerating which tenants exist.
    let mut unknown = Client::connect(address).await;
    let missing = unknown
        .send(&[
            "AUTH",
            "kv_00000000000000000000000000.00000000000000000000000000",
            "x",
        ])
        .await;
    assert_eq!(missing, refused);

    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn an_unauthenticated_connection_can_do_nothing() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let mut client = Client::connect(address).await;

    // No AUTH. Nothing must reach the backend — not a read, not a write, and above all not a
    // command that would touch the shared root of the keyspace.
    let reply = client.send(&["GET", "shared:key"]).await;
    assert!(reply.starts_with("-ERR NOAUTH"), "{reply}");
}

#[tokio::test]
async fn a_revoked_credential_stops_working_immediately() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;

    let mut before = Client::connect(address).await;
    assert_eq!(before.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .expect("postgres");
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
        .execute(
            "update service_credential set revoked_at = now() where username = $1",
            &[&username],
        )
        .await
        .expect("revoke");

    // No cache, so no grace period. Rotation exists to recover from a leaked credential, and a
    // leaked credential that keeps working for another few seconds has not been recovered from.
    let mut after = Client::connect(address).await;
    let refused = after.send(&["AUTH", &username, &secret]).await;
    assert!(refused.starts_with("-ERR WRONGPASS"), "{refused}");

    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn a_refused_command_does_not_end_the_connection() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;

    let mut client = Client::connect(address).await;
    assert_eq!(client.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    // KEYS would enumerate every tenant's keyspace. Refused — but the connection has to survive it,
    // or one stray command from a library takes a worker down.
    let refused = client.send(&["KEYS", "*"]).await;
    assert!(refused.starts_with("-ERR"), "{refused}");
    assert_eq!(client.send(&["PING"]).await, "+PONG\r\n");

    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn local_replies_keep_their_place_in_a_pipeline() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;
    let mut client = Client::connect(address).await;
    assert_eq!(client.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    let replies = client
        .pipeline(&[
            &["SET", "ordered", "yes"],
            &["AUTH", "again", "again"],
            &["GET", "ordered"],
        ])
        .await;
    assert_eq!(replies[0], "+OK\r\n");
    assert!(replies[1].contains("AUTH is not allowed"), "{:?}", replies);
    assert_eq!(replies[2], "$3\r\nyes\r\n");

    assert!(
        client
            .send(&["HELLO", "3"])
            .await
            .contains("RESP3 is not supported")
    );
    assert!(
        client
            .send(&["HELLO", "2"])
            .await
            .contains("$5\r\nproto\r\n:2")
    );
    client.send(&["DEL", "ordered"]).await;
    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn a_missing_cached_acl_user_is_reprovisioned_once() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;
    let mut first = Client::connect(address).await;
    assert_eq!(first.send(&["AUTH", &username, &secret]).await, "+OK\r\n");
    assert_eq!(first.send(&["PING"]).await, "+PONG\r\n");

    let mut admin = Client {
        stream: TcpStream::connect(backend()).await.expect("backend"),
    };
    assert_eq!(admin.send(&["ACL", "DELUSER", &username]).await, ":1\r\n");

    let mut recovered = Client::connect(address).await;
    assert_eq!(
        recovered.send(&["AUTH", &username, &secret]).await,
        "+OK\r\n"
    );
    assert_eq!(recovered.send(&["PING"]).await, "+PONG\r\n");
    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn deleting_the_acl_user_closes_a_live_tenant_connection() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;
    let mut tenant = Client::connect(address).await;
    assert_eq!(tenant.send(&["AUTH", &username, &secret]).await, "+OK\r\n");
    assert_eq!(tenant.send(&["PING"]).await, "+PONG\r\n");

    let mut admin = Client {
        stream: TcpStream::connect(backend()).await.expect("backend"),
    };
    assert_eq!(admin.send(&["ACL", "DELUSER", &username]).await, ":1\r\n");

    let mut byte = [0_u8; 1];
    let read = tokio::time::timeout(Duration::from_secs(2), tenant.stream.read(&mut byte))
        .await
        .expect("the proxy kept a revoked tenant session open")
        .expect("read after ACL deletion");
    assert_eq!(
        read, 0,
        "the proxy did not close after its tenant upstream was revoked"
    );
    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn backend_acl_rejects_another_tenants_key_and_admin_commands() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, service, fixtures) = provision(&url).await;
    let mut through_proxy = Client::connect(address).await;
    assert_eq!(
        through_proxy.send(&["AUTH", &username, &secret]).await,
        "+OK\r\n"
    );
    // AUTH is acknowledged after the control-plane check; the first proxied command proves the
    // lazy upstream ACL provisioning has completed before we connect to Valkey directly below.
    assert_eq!(through_proxy.send(&["PING"]).await, "+PONG\r\n");

    let identity = sproutos_tenant_auth::TenantIdentity::new(
        fixtures[0],
        sproutos_tenant_auth::ResourceKind::Queue,
        service,
    );
    let acl = valkey_proxy::acl::credentials(b"integration-test-acl-root-key-32-bytes", &identity);
    let mut direct = Client {
        stream: TcpStream::connect(backend()).await.expect("backend"),
    };
    assert_eq!(
        direct.send(&["AUTH", &acl.username, &acl.password]).await,
        "+OK\r\n"
    );
    let foreign = direct
        .send(&["GET", "{kv:00000000000000000000000000}:secret"])
        .await;
    assert!(foreign.contains("NOPERM"), "{foreign}");
    let administrative = direct.send(&["DBSIZE"]).await;
    assert!(administrative.contains("NOPERM"), "{administrative}");
    let script_scan = direct
        .send(&["EVAL", "return redis.call('SCAN', '0')", "0"])
        .await;
    // Valkey wraps an ACL NOPERM raised inside Lua as "ACL failure in script" rather than keeping
    // the outer error code. The important property is that SCAN did not execute as the tenant.
    assert!(
        script_scan.starts_with("-ERR ACL failure in script")
            && script_scan.contains("no permissions to run the 'scan' command"),
        "{script_scan}"
    );
    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn scan_is_tenant_scoped_unprefixed_and_an_ordering_barrier() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username_a, secret_a, _service_a, fixtures_a) = provision(&url).await;
    let (username_b, secret_b, _service_b, fixtures_b) = provision(&url).await;
    let mut a = Client::connect(address).await;
    let mut b = Client::connect(address).await;
    assert_eq!(a.send(&["AUTH", &username_a, &secret_a]).await, "+OK\r\n");
    assert_eq!(b.send(&["AUTH", &username_b, &secret_b]).await, "+OK\r\n");

    for key in ["apple", "apricot", "banana"] {
        assert_eq!(a.send(&["SET", key, "a"]).await, "+OK\r\n");
    }
    assert_eq!(b.send(&["SET", "foreign-only", "b"]).await, "+OK\r\n");

    let mut all = scan_all(&mut a, None).await;
    all.sort();
    assert_eq!(all, ["apple", "apricot", "banana"]);
    assert!(all.iter().all(|key| !key.contains("{kv:")));

    let mut matched = scan_all(&mut a, Some("ap*")).await;
    matched.sort();
    assert_eq!(matched, ["apple", "apricot"]);

    // Both commands are written in one syscall. The privileged SCAN connection must not overtake
    // the tenant connection's SET, and commands after SCAN must not be forwarded ahead of it.
    let replies = a
        .pipeline(&[
            &["SET", "barrier-visible", "yes"],
            &["SCAN", "0", "MATCH", "barrier-*", "COUNT", "1000"],
            &["GET", "barrier-visible"],
        ])
        .await;
    assert_eq!(replies[0], "+OK\r\n");
    assert_eq!(parse_scan_reply(&replies[1]).1, ["barrier-visible"]);
    assert_eq!(replies[2], "$3\r\nyes\r\n");

    assert_eq!(a.send(&["MULTI"]).await, "+OK\r\n");
    let refused = a.send(&["SCAN", "0"]).await;
    assert!(
        refused.contains("SCAN is not allowed in MULTI"),
        "{refused}"
    );
    assert_eq!(a.send(&["DISCARD"]).await, "+OK\r\n");
    assert_eq!(a.send(&["PING"]).await, "+PONG\r\n");

    a.send(&["DEL", "apple", "apricot", "banana", "barrier-visible"])
        .await;
    b.send(&["DEL", "foreign-only"]).await;
    cleanup(&url, &fixtures_a).await;
    cleanup(&url, &fixtures_b).await;
}

#[tokio::test]
async fn a_non_queue_credential_cannot_enter_the_valkey_proxy() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (_queue_username, _queue_secret, service, fixtures) = provision(&url).await;
    let organization = fixtures[0];
    let identity = sproutos_tenant_auth::TenantIdentity::new(
        organization,
        sproutos_tenant_auth::ResourceKind::Database,
        service,
    );
    let username = identity.username();
    let secret = sproutos_tenant_auth::generate_secret();
    let (database, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    database.execute(
        "insert into service_credential (id, backend_service_id, username, secret_hash, last_four) values ($1, $2, $3, $4, $5)",
        &[&Uuid::now_v7(), &service, &username, &sproutos_tenant_auth::hash_generated_secret(&secret), &&secret[secret.len() - 4..]],
    ).await.unwrap();

    let mut client = Client::connect(address).await;
    assert!(
        client
            .send(&["AUTH", &username, &secret])
            .await
            .starts_with("-ERR WRONGPASS")
    );
    cleanup(&url, &fixtures).await;
}

/// BullMQ passes declared Lua keys in `KEYS` and constructs more keys from `ARGV`. The proxy can
/// rewrite the former but cannot see the latter, so the public prefix must be accepted exactly
/// once and the backend ACL must reject a client that omits it from script-created keys.
#[tokio::test]
async fn the_published_bullmq_prefix_works_in_lua_and_mixed_key_commands() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, service_id, fixtures) = provision(&url).await;
    let prefix = format!(
        "{{kv:{}}}:",
        sproutos_tenant_auth::encode_short_id(service_id)
    );
    let unique = Uuid::now_v7().simple().to_string();
    let bull = format!("{prefix}bull:contract-{unique}");
    let declared = format!("{bull}:wait");
    let constructed = format!("{bull}:meta");
    let bare_script_key = format!("bull:contract-{unique}:unprefixed");
    let celery = format!("celery-{unique}");

    let mut client = Client::connect(address).await;
    assert_eq!(client.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    // A BullMQ-shaped script: KEYS is visible to the proxy, while the second key is used only from
    // ARGV. Both already carry the published prefix and must reach the engine without doubling it.
    let script =
        "redis.call('SET', KEYS[1], 'declared'); return redis.call('SET', ARGV[1], 'constructed')";
    assert_eq!(
        client
            .send(&["EVAL", script, "1", &declared, &constructed])
            .await,
        "+OK\r\n"
    );
    assert_eq!(backend_get(&declared).await, "$8\r\ndeclared\r\n");
    assert_eq!(backend_get(&constructed).await, "$11\r\nconstructed\r\n");
    assert_eq!(
        backend_get(&format!("{prefix}{declared}")).await,
        "$-1\r\n",
        "the published prefix was applied twice"
    );

    // Omitting the prefix from a Lua-constructed ARGV key is refused by Valkey itself. That turns
    // the old shared-root leak into an explicit client error.
    let refused = client
        .send(&[
            "EVAL",
            "return redis.call('SET', ARGV[1], 'forbidden')",
            "1",
            &declared,
            &bare_script_key,
        ])
        .await;
    assert!(
        refused.contains("NOPERM") || refused.contains("ACL failure in script"),
        "{refused}"
    );
    assert_eq!(backend_get(&bare_script_key).await, "$-1\r\n");

    // Published BullMQ keys and ordinary bare Celery keys can share one variadic command during
    // rollout. Only the bare key is prefixed.
    assert_eq!(
        client
            .send(&["MSET", &constructed, "bull", &celery, "celery"])
            .await,
        "+OK\r\n"
    );
    assert_eq!(backend_get(&constructed).await, "$4\r\nbull\r\n");
    assert_eq!(
        backend_get(&format!("{prefix}{celery}")).await,
        "$6\r\ncelery\r\n"
    );

    // A blocking pop echoes whichever key won. Preserve an already-prefixed spelling, but strip
    // the prefix the proxy added to a bare key, even when both forms occur in the same command.
    let published_ready = format!("{bull}:published-ready");
    let bare_empty = format!("bare-empty-{unique}");
    assert_eq!(
        client.send(&["RPUSH", &published_ready, "published"]).await,
        ":1\r\n"
    );
    let published_reply = client
        .send(&["BLPOP", &bare_empty, &published_ready, "1"])
        .await;
    assert!(published_reply.contains(&format!("\r\n{published_ready}\r\n")));

    let published_empty = format!("{bull}:published-empty");
    let bare_ready = format!("bare-ready-{unique}");
    assert_eq!(client.send(&["RPUSH", &bare_ready, "bare"]).await, ":1\r\n");
    let bare_reply = client
        .send(&["BLPOP", &published_empty, &bare_ready, "1"])
        .await;
    assert!(bare_reply.contains(&format!("\r\n{bare_ready}\r\n")));
    assert!(!bare_reply.contains(&format!("\r\n{prefix}{bare_ready}\r\n")));

    client
        .send(&["DEL", &declared, &constructed, &celery])
        .await;
    cleanup(&url, &fixtures).await;
}

/// Two queues owned by the *same* organization.
///
/// The obvious tenancy design is one prefix per customer, and it is wrong: a customer with a queue
/// for emails and a queue for video encoding would find both writing `bull:jobs:wait` into the same
/// place. The prefix is per *resource*, and this is the test that says so.
#[tokio::test]
async fn two_queues_in_one_organization_are_separate() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username_a, secret_a, service_a, fixtures) = provision(&url).await;

    // Same organization, second service.
    let organization_id = {
        let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
            .await
            .expect("postgres");
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let row = client
            .query_one(
                "select organization_id from backend_service where id = $1",
                &[&service_a],
            )
            .await
            .expect("the first service");
        row.get::<_, Uuid>(0)
    };
    let (username_b, secret_b, service_b, _) = provision_in(&url, Some(organization_id)).await;

    assert_ne!(service_a, service_b);

    let mut a = Client::connect(address).await;
    assert_eq!(a.send(&["AUTH", &username_a, &secret_a]).await, "+OK\r\n");
    let mut b = Client::connect(address).await;
    assert_eq!(b.send(&["AUTH", &username_b, &secret_b]).await, "+OK\r\n");

    a.send(&["SET", "bull:jobs:wait", "emails"]).await;
    b.send(&["SET", "bull:jobs:wait", "video"]).await;

    assert_eq!(a.send(&["GET", "bull:jobs:wait"]).await, "$6\r\nemails\r\n");
    assert_eq!(b.send(&["GET", "bull:jobs:wait"]).await, "$5\r\nvideo\r\n");

    a.send(&["DEL", "bull:jobs:wait"]).await;
    b.send(&["DEL", "bull:jobs:wait"]).await;
    cleanup(&url, &fixtures).await;
}

/*
  TASK 20's second half, end to end against a real Valkey.

  > We use a proxy that receives valkey commands and adds it to a master valkey queue such that this
  > proxy consumer continuously receives jobs from all projects and spins up services as needed.

  The unit tests cover which verbs count as an enqueue and how a queue name is read out of a key.
  What they cannot cover is the part that was actually hard: the report reaches the backend on a
  connection of its own, because putting an extra command on the client's connection would leave a
  reply in the stream that nothing is waiting for, and every reply after it would be attributed to
  the wrong request. That is only observable against a server, which is why the last two assertions
  here are about the *client's* replies rather than about the master queue at all.
*/
#[tokio::test]
async fn an_enqueue_is_reported_to_the_master_queue() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    // A clean slate, so what is asserted below is what this test put there.
    let mut raw = Client {
        stream: TcpStream::connect(backend()).await.expect("backend"),
    };
    raw.send(&["DEL", "sproutos:master:wake"]).await;

    let address = start_proxy_with_master(&url).await;
    let (username, secret, service_id, fixtures) = provision(&url).await;
    let published_queue = format!(
        "{{kv:{}}}:bull:emails:wait",
        sproutos_tenant_auth::encode_short_id(service_id)
    );

    let mut client = Client::connect(address).await;
    assert_eq!(client.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    // A BullMQ-shaped scripted enqueue, and a read that must not be mistaken for one. The script is
    // `args[1]`; deriving the queue from that position instead of the declared key silently wakes a
    // queue named after the Lua source.
    assert_eq!(
        client
            .send(&[
                "EVAL",
                "return redis.call('LPUSH', KEYS[1], ARGV[1])",
                "1",
                &published_queue,
                "job-1",
            ])
            .await,
        ":1\r\n"
    );
    client
        .send(&["LRANGE", "bull:reports:wait", "0", "-1"])
        .await;

    // The writer batches for a second before it writes.
    tokio::time::sleep(std::time::Duration::from_millis(1600)).await;

    let members = raw
        .send(&["ZRANGE", "sproutos:master:wake", "0", "-1"])
        .await;

    let expected = format!(
        "{}/emails",
        sproutos_tenant_auth::encode_short_id(service_id)
    );
    assert!(
        members.contains(&expected),
        "expected the enqueued queue in the master set, got {members}"
    );
    assert!(
        !members.contains("reports"),
        "a read must not wake a queue, got {members}"
    );

    /*
      And the client's own replies are still correctly ordered.

      This is the assertion the separate connection exists for. If the master queue's `ZADD` went
      out on this connection, its reply would arrive here and `PING` would return the `ZADD` result.
    */
    assert_eq!(client.send(&["PING"]).await, "+PONG\r\n");
    assert_eq!(client.send(&["LLEN", &published_queue]).await, ":1\r\n");

    raw.send(&["DEL", "sproutos:master:wake"]).await;
    client.send(&["DEL", &published_queue]).await;
    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn a_real_celery_repository_round_trips_a_task() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    /*
      The command-shaped tests above are necessary for exact key assertions, but they are not a
      Celery acceptance test. Celery performs its own connection negotiation, declares bindings,
      publishes a protocol-v2 task, blocks on BRPOP and writes a result through a second
      connection. A missing command or an incorrectly rewritten reply only appears when the real
      client performs that sequence.

      CI installs the pinned requirement before `cargo test`. A developer running only Rust tests
      may omit it; CI may never turn this into a silent skip.
    */
    let python = std::env::var("CELERY_ACCEPTANCE_PYTHON").unwrap_or_else(|_| "python3".into());
    let celery_available = tokio::process::Command::new(&python)
        .args(["-c", "import celery"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false);
    if !celery_available {
        assert!(
            std::env::var("CI").is_err(),
            "Celery is required in CI; install services/valkey-proxy/tests/fixtures/celery-requirements.txt"
        );
        eprintln!("skipping real Celery acceptance: Celery is not installed");
        return;
    }

    let mut raw = Client {
        stream: TcpStream::connect(backend()).await.expect("backend"),
    };
    raw.send(&["DEL", "sproutos:master:wake"]).await;

    let address = start_proxy_with_master(&url).await;
    let (username, secret, service_id, fixtures) = provision(&url).await;
    let fixture = format!(
        "{}/tests/fixtures/celery_repository.py",
        env!("CARGO_MANIFEST_DIR")
    );
    let queue = format!("celery-{}", Uuid::now_v7().simple());
    let common_env = [
        ("VALKEY_ADDRESS", address.to_string()),
        ("VALKEY_USERNAME", username),
        ("VALKEY_SECRET", secret),
        ("CELERY_QUEUE", queue.clone()),
    ];

    let mut worker = tokio::process::Command::new(&python)
        .args([&fixture, "worker"])
        .envs(common_env.iter().cloned())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("start the Celery worker");

    // The worker has to finish its broker negotiation before the producer publishes. A bounded
    // wait keeps this deterministic without turning a startup failure into a hanging test.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let producer = tokio::time::timeout(
        Duration::from_secs(40),
        tokio::process::Command::new(&python)
            .args([&fixture, "produce"])
            .envs(common_env.iter().cloned())
            .output(),
    )
    .await;

    let _ = worker.kill().await;
    let worker_output = worker
        .wait_with_output()
        .await
        .expect("collect worker output");
    let producer_output = producer
        .expect("the Celery result timed out")
        .expect("run the Celery producer");
    assert!(
        producer_output.status.success(),
        "producer failed:\nstdout={}\nstderr={}\nworker stdout={}\nworker stderr={}",
        String::from_utf8_lossy(&producer_output.stdout),
        String::from_utf8_lossy(&producer_output.stderr),
        String::from_utf8_lossy(&worker_output.stdout),
        String::from_utf8_lossy(&worker_output.stderr),
    );
    assert_eq!(
        String::from_utf8_lossy(&producer_output.stdout).trim(),
        "42"
    );

    // SproutOS does not keep the long-running worker above alive in production. The router invokes
    // the repository's Lambda with `queue.drain`, and customer code consumes a bounded batch then
    // returns. Drive that exact repository entry point with a second ordinary Celery publish.
    let enqueue = tokio::process::Command::new(&python)
        .args([&fixture, "enqueue"])
        .envs(common_env.iter().cloned())
        .output()
        .await
        .expect("enqueue the Lambda-drained task");
    assert!(enqueue.status.success(), "enqueue failed: {enqueue:?}");
    let task_id = String::from_utf8_lossy(&enqueue.stdout).trim().to_owned();
    assert!(
        !task_id.is_empty(),
        "the Celery publish returned no task id"
    );

    let drain = tokio::process::Command::new(&python)
        .args([&fixture, "drain"])
        .envs(common_env.iter().cloned())
        .output()
        .await
        .expect("invoke the repository queue.drain handler");
    assert!(
        drain.status.success(),
        "queue.drain handler failed:\nstdout={}\nstderr={}",
        String::from_utf8_lossy(&drain.stdout),
        String::from_utf8_lossy(&drain.stderr)
    );
    assert!(
        String::from_utf8_lossy(&drain.stdout).contains("'processed': 1"),
        "the bounded handler did not consume exactly one task: {}",
        String::from_utf8_lossy(&drain.stdout)
    );

    let result = tokio::process::Command::new(&python)
        .args([&fixture, "result", &task_id])
        .envs(common_env.iter().cloned())
        .output()
        .await
        .expect("read the queue.drain task result");
    assert!(result.status.success(), "result read failed: {result:?}");
    assert_eq!(String::from_utf8_lossy(&result.stdout).trim(), "42");

    // The same live client path must wake the router dispatcher. A successful task alone could
    // still be a worker polling a queue the platform never noticed.
    tokio::time::sleep(Duration::from_millis(1600)).await;
    let members = raw
        .send(&["ZRANGE", "sproutos:master:wake", "0", "-1"])
        .await;
    let expected = format!(
        "{}/{}",
        sproutos_tenant_auth::encode_short_id(service_id),
        queue
    );
    assert!(
        members.contains(&expected),
        "missing Celery wake: {members}"
    );

    raw.send(&["DEL", "sproutos:master:wake"]).await;
    cleanup(&url, &fixtures).await;
}

/*
  Two live credentials for one username, both accepted.

  A worker the platform starts on a customer's behalf needs its own secret: the platform cannot reuse
  the customer's, which is stored as a hash, and until `service_credential.purpose` existed it could
  not issue a second either — one live credential per username was the constraint, and the username
  is derived from the resource so every credential for one service collides.

  This is the property the proxy has to hold up for that to work. There was a `limit 1` in the
  lookup, which meant whichever row came back first was the only secret that could ever authenticate
  — and *which* row that was depended on the plan. A worker would have worked, intermittently.
*/
#[tokio::test]
async fn a_service_may_have_a_tenant_and_a_worker_credential() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, tenant_secret, service_id, fixtures) = provision(&url).await;

    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .expect("postgres");
    tokio::spawn(async move {
        let _ = connection.await;
    });

    // A second credential, same username, different purpose — exactly what `issueWorkerCredential`
    // writes.
    let worker_secret = sproutos_tenant_auth::generate_secret();
    client
        .execute(
            "insert into service_credential
               (id, backend_service_id, username, purpose, secret_hash, last_four)
             values ($1, $2, $3, 'worker', $4, $5)",
            &[
                &Uuid::now_v7(),
                &service_id,
                &username,
                &sproutos_tenant_auth::hash_generated_secret(&worker_secret),
                &&worker_secret[worker_secret.len() - 4..],
            ],
        )
        .await
        .expect("insert worker credential");

    // Both authenticate.
    let mut tenant = Client::connect(address).await;
    assert_eq!(
        tenant.send(&["AUTH", &username, &tenant_secret]).await,
        "+OK\r\n"
    );

    let mut worker = Client::connect(address).await;
    assert_eq!(
        worker.send(&["AUTH", &username, &worker_secret]).await,
        "+OK\r\n"
    );

    // And they land in the same keyspace, which is the point: a worker consumes the queue its
    // tenant fills.
    assert_eq!(
        tenant.send(&["SET", "shared", "from-tenant"]).await,
        "+OK\r\n"
    );
    assert_eq!(
        worker.send(&["GET", "shared"]).await,
        "$11\r\nfrom-tenant\r\n"
    );

    // Revoking the worker's leaves the customer's working. That separation is the whole reason for
    // two credentials rather than one shared secret.
    client
        .execute(
            "update service_credential set revoked_at = now()
             where username = $1 and purpose = 'worker'",
            &[&username],
        )
        .await
        .expect("revoke worker");

    let mut after_worker = Client::connect(address).await;
    let refused = after_worker
        .send(&["AUTH", &username, &worker_secret])
        .await;
    assert!(refused.starts_with("-ERR WRONGPASS"), "{refused}");

    let mut after_tenant = Client::connect(address).await;
    assert_eq!(
        after_tenant
            .send(&["AUTH", &username, &tenant_secret])
            .await,
        "+OK\r\n"
    );

    cleanup(&url, &fixtures).await;
}
