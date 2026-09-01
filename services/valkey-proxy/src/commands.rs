//! Which arguments of a command are keys.
//!
//! This is the proxy's first boundary; the per-tenant Valkey ACL is the engine-enforced backstop.
//! A key the proxy fails to namespace would target the shared root, where the ACL must refuse it,
//! so the default for an unrecognised command is still **refuse**, not forward. A missing allowlist
//! entry produces a support ticket; a missing blocklist entry asks the engine to catch our bug.

/// Where the keys are in a command's argument list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySpec {
    /// No keys: `PING`, `ECHO`.
    None,
    /// Keys run from `first` to the end, every `step` arguments.
    ///
    /// `step` is 2 for `MSET key value key value`, 1 for `DEL key key key`.
    Range { first: usize, step: usize },
    /// Exactly `count` keys starting at `first`, and the rest are arguments.
    Fixed { first: usize, count: usize },
    /// `EVAL script numkeys key... arg...` — the count is in the command itself.
    Numkeys { count_at: usize },
    /// A destination key precedes a declared source-key count.
    NumkeysWithDestination { count_at: usize },
    /// The last argument is a timeout, not a key: `BLPOP key... timeout`.
    RangeExceptLast { first: usize, step: usize },
    /// `XREAD [options] STREAMS key... id...` — keys occupy the first half after `STREAMS`.
    Streams,
}

/// Commands which can reach the tenant upstream. The ACL provisioner grants exactly these.
pub const FORWARDED_COMMANDS: &[&str] = &[
    "PING",
    "ECHO",
    "QUIT",
    "GET",
    "GETDEL",
    "GETEX",
    "GETRANGE",
    "INCR",
    "DECR",
    "STRLEN",
    "TTL",
    "PTTL",
    "PERSIST",
    "TYPE",
    "DUMP",
    "BITCOUNT",
    "BITPOS",
    "GETBIT",
    "SETBIT",
    "BITFIELD",
    "BITFIELD_RO",
    "BITOP",
    "EXPIRETIME",
    "PEXPIRETIME",
    "SET",
    "SETNX",
    "SETEX",
    "PSETEX",
    "GETSET",
    "APPEND",
    "SETRANGE",
    "RESTORE",
    "INCRBY",
    "DECRBY",
    "INCRBYFLOAT",
    "EXPIRE",
    "PEXPIRE",
    "EXPIREAT",
    "PEXPIREAT",
    "MGET",
    "DEL",
    "UNLINK",
    "EXISTS",
    "TOUCH",
    "WATCH",
    "MSET",
    "MSETNX",
    "RENAME",
    "RENAMENX",
    "COPY",
    "SMOVE",
    "LCS",
    "HGET",
    "HSET",
    "HDEL",
    "HGETALL",
    "HKEYS",
    "HVALS",
    "HLEN",
    "HEXISTS",
    "HINCRBY",
    "HINCRBYFLOAT",
    "HMGET",
    "HMSET",
    "HSETNX",
    "HRANDFIELD",
    "HSCAN",
    "HSTRLEN",
    "LPUSH",
    "RPUSH",
    "LPUSHX",
    "RPUSHX",
    "LPOP",
    "RPOP",
    "LLEN",
    "LRANGE",
    "LREM",
    "LSET",
    "LTRIM",
    "LINSERT",
    "LINDEX",
    "LPOS",
    "RPOPLPUSH",
    "LMOVE",
    "BLPOP",
    "BRPOP",
    "BRPOPLPUSH",
    "BLMOVE",
    "LMPOP",
    "BLMPOP",
    "SADD",
    "SREM",
    "SMEMBERS",
    "SISMEMBER",
    "SMISMEMBER",
    "SCARD",
    "SPOP",
    "SRANDMEMBER",
    "SSCAN",
    "SINTER",
    "SUNION",
    "SDIFF",
    "SINTERCARD",
    "SINTERSTORE",
    "SUNIONSTORE",
    "SDIFFSTORE",
    "ZADD",
    "ZREM",
    "ZSCORE",
    "ZCARD",
    "ZCOUNT",
    "ZLEXCOUNT",
    "ZRANGE",
    "ZREVRANGE",
    "ZRANGEBYSCORE",
    "ZREVRANGEBYSCORE",
    "ZRANGEBYLEX",
    "ZRANK",
    "ZREVRANK",
    "ZINCRBY",
    "ZREMRANGEBYSCORE",
    "ZREMRANGEBYRANK",
    "ZREMRANGEBYLEX",
    "ZSCAN",
    "ZPOPMIN",
    "ZPOPMAX",
    "ZRANDMEMBER",
    "ZMSCORE",
    "ZDIFF",
    "ZINTER",
    "ZUNION",
    "ZINTERCARD",
    "ZDIFFSTORE",
    "ZINTERSTORE",
    "ZUNIONSTORE",
    "ZRANGESTORE",
    "BZPOPMIN",
    "BZPOPMAX",
    "ZMPOP",
    "BZMPOP",
    "GEOADD",
    "GEODIST",
    "GEOHASH",
    "GEOPOS",
    "GEORADIUS",
    "GEORADIUS_RO",
    "GEORADIUSBYMEMBER",
    "GEORADIUSBYMEMBER_RO",
    "GEOSEARCH",
    "GEOSEARCHSTORE",
    "PFADD",
    "PFCOUNT",
    "PFMERGE",
    "XADD",
    "XLEN",
    "XRANGE",
    "XREVRANGE",
    "XDEL",
    "XTRIM",
    "XACK",
    "XPENDING",
    "XCLAIM",
    "XAUTOCLAIM",
    "XINFO",
    "XGROUP",
    "XSETID",
    "XREAD",
    "XREADGROUP",
    "PUBLISH",
    "SUBSCRIBE",
    "PSUBSCRIBE",
    "UNSUBSCRIBE",
    "PUNSUBSCRIBE",
    "SPUBLISH",
    "SSUBSCRIBE",
    "SUNSUBSCRIBE",
    "EVAL",
    "EVALSHA",
    "EVAL_RO",
    "EVALSHA_RO",
    "FCALL",
    "FCALL_RO",
    "MULTI",
    "EXEC",
    "DISCARD",
    "UNWATCH",
];

/// Narrow administrative subcommands required by supported clients.
///
/// A real Celery worker uses redis-py's `Script` helper for its visibility-timeout mutex. It first
/// tries `EVALSHA` and, on `NOSCRIPT`, loads the source with `SCRIPT LOAD`. Loading a script does
/// not execute it or touch a key. Execution still goes through `EVALSHA`, where both the proxy and
/// the upstream ACL constrain every declared and script-discovered key to this tenant.
///
/// Granting the whole `SCRIPT` command would also grant `FLUSH` and `KILL`, allowing one tenant to
/// disrupt every other tenant on the shared server. Keep these as full `COMMAND|SUBCOMMAND` ACL
/// tokens and validate the exact wire shape below.
pub const FORWARDED_SUBCOMMANDS: &[&str] = &["SCRIPT|LOAD"];

/// The commands a tenant may send, and where their keys are.
///
/// BullMQ and Celery are the clients that matter, and between them they use most of this list.
/// Deliberately absent, and refused: `SELECT` (tenancy is the prefix, not the database), `FLUSHALL`
/// and `FLUSHDB` (one tenant erasing a shared instance), `CONFIG`, `SHUTDOWN`, `DEBUG`, `SCRIPT`,
/// `CLIENT`, `CLUSTER`, `ACL`, `REPLICAOF`, and `KEYS` — which scans the whole keyspace and would
/// walk straight through the namespacing.
pub fn key_spec(verb: &str) -> Option<KeySpec> {
    use KeySpec::{
        Fixed, None as NoKeys, Numkeys, NumkeysWithDestination, Range, RangeExceptLast, Streams,
    };

    // The same list is installed into each tenant's upstream ACL. Keeping it authoritative here
    // prevents a command from being admitted by the proxy but rejected only after reaching Valkey.
    if !FORWARDED_COMMANDS.contains(&verb) {
        return None;
    }

    Some(match verb {
        // Connection and no-key commands.
        "PING" | "ECHO" | "QUIT" => NoKeys,

        // Strings.
        "GET" | "GETDEL" | "GETEX" | "GETRANGE" | "INCR" | "DECR" | "STRLEN" | "TTL" | "PTTL"
        | "PERSIST" | "TYPE" | "DUMP" | "BITCOUNT" | "BITPOS" | "GETBIT" | "SETBIT"
        | "BITFIELD" | "BITFIELD_RO" | "EXPIRETIME" | "PEXPIRETIME" => Fixed { first: 1, count: 1 },
        "BITOP" => Range { first: 2, step: 1 },
        "SET" | "SETNX" | "SETEX" | "PSETEX" | "GETSET" | "APPEND" | "INCRBY" | "DECRBY"
        | "INCRBYFLOAT" | "EXPIRE" | "PEXPIRE" | "EXPIREAT" | "PEXPIREAT" | "SETRANGE"
        | "RESTORE" => Fixed { first: 1, count: 1 },
        "MGET" | "DEL" | "UNLINK" | "EXISTS" | "TOUCH" | "WATCH" => Range { first: 1, step: 1 },
        "MSET" | "MSETNX" => Range { first: 1, step: 2 },
        "RENAME" | "RENAMENX" | "COPY" | "SMOVE" | "LCS" => Fixed { first: 1, count: 2 },

        // Hashes — Celery and BullMQ both keep job data in these.
        "HGET" | "HSET" | "HDEL" | "HGETALL" | "HKEYS" | "HVALS" | "HLEN" | "HEXISTS"
        | "HINCRBY" | "HINCRBYFLOAT" | "HMGET" | "HMSET" | "HSETNX" | "HRANDFIELD" | "HSCAN"
        | "HSTRLEN" => Fixed { first: 1, count: 1 },

        // Lists — Celery's default broker is a list.
        "LPUSH" | "RPUSH" | "LPUSHX" | "RPUSHX" | "LPOP" | "RPOP" | "LLEN" | "LRANGE" | "LREM"
        | "LSET" | "LTRIM" | "LINSERT" | "LINDEX" | "LPOS" => Fixed { first: 1, count: 1 },
        "RPOPLPUSH" | "LMOVE" => Fixed { first: 1, count: 2 },
        // The trailing timeout is not a key, and namespacing it would send `0` as a key name.
        "BLPOP" | "BRPOP" => RangeExceptLast { first: 1, step: 1 },
        "BRPOPLPUSH" | "BLMOVE" => Fixed { first: 1, count: 2 },
        "LMPOP" => Numkeys { count_at: 1 },
        "BLMPOP" => Numkeys { count_at: 2 },

        // Sets.
        "SADD" | "SREM" | "SMEMBERS" | "SISMEMBER" | "SMISMEMBER" | "SCARD" | "SPOP"
        | "SRANDMEMBER" | "SSCAN" => Fixed { first: 1, count: 1 },
        "SINTER" | "SUNION" | "SDIFF" => Range { first: 1, step: 1 },
        "SINTERCARD" => Numkeys { count_at: 1 },
        "SINTERSTORE" | "SUNIONSTORE" | "SDIFFSTORE" => Range { first: 1, step: 1 },

        // Sorted sets — BullMQ's delayed and prioritised queues.
        "ZADD" | "ZREM" | "ZSCORE" | "ZCARD" | "ZCOUNT" | "ZLEXCOUNT" | "ZRANGE" | "ZREVRANGE"
        | "ZRANGEBYSCORE" | "ZREVRANGEBYSCORE" | "ZRANGEBYLEX" | "ZRANK" | "ZREVRANK"
        | "ZINCRBY" | "ZREMRANGEBYSCORE" | "ZREMRANGEBYRANK" | "ZREMRANGEBYLEX" | "ZSCAN"
        | "ZPOPMIN" | "ZPOPMAX" | "ZRANDMEMBER" | "ZMSCORE" => Fixed { first: 1, count: 1 },
        "ZDIFF" | "ZINTER" | "ZUNION" | "ZINTERCARD" => Numkeys { count_at: 1 },
        "ZDIFFSTORE" | "ZINTERSTORE" | "ZUNIONSTORE" => NumkeysWithDestination { count_at: 2 },
        "ZRANGESTORE" => Fixed { first: 1, count: 2 },
        "BZPOPMIN" | "BZPOPMAX" => RangeExceptLast { first: 1, step: 1 },
        "ZMPOP" => Numkeys { count_at: 1 },
        "BZMPOP" => Numkeys { count_at: 2 },

        // Geospatial indexes are sorted sets. STORE variants have a destination and source key.
        "GEOADD"
        | "GEODIST"
        | "GEOHASH"
        | "GEOPOS"
        | "GEORADIUS"
        | "GEORADIUS_RO"
        | "GEORADIUSBYMEMBER"
        | "GEORADIUSBYMEMBER_RO"
        | "GEOSEARCH" => Fixed { first: 1, count: 1 },
        "GEOSEARCHSTORE" => Fixed { first: 1, count: 2 },

        // HyperLogLog values are strings; their merges still name every source and destination.
        "PFADD" => Fixed { first: 1, count: 1 },
        "PFCOUNT" | "PFMERGE" => Range { first: 1, step: 1 },

        // Streams.
        "XADD" | "XLEN" | "XRANGE" | "XREVRANGE" | "XDEL" | "XTRIM" | "XACK" | "XPENDING"
        | "XCLAIM" | "XAUTOCLAIM" | "XSETID" => Fixed { first: 1, count: 1 },
        "XINFO" | "XGROUP" => Fixed { first: 2, count: 1 },
        "XREAD" | "XREADGROUP" => Streams,

        // Channels use the same namespace and are independently constrained by the ACL's `&` rule.
        "PUBLISH" | "SPUBLISH" => Fixed { first: 1, count: 1 },
        "SUBSCRIBE" | "PSUBSCRIBE" | "UNSUBSCRIBE" | "PUNSUBSCRIBE" | "SSUBSCRIBE"
        | "SUNSUBSCRIBE" => Range { first: 1, step: 1 },

        // Scripting. BullMQ is almost entirely EVALSHA, so this is the important one.
        "EVAL" | "EVALSHA" | "EVAL_RO" | "EVALSHA_RO" | "FCALL" | "FCALL_RO" => {
            Numkeys { count_at: 2 }
        }

        // Transactions. MULTI/EXEC hold no keys themselves; the commands inside are namespaced as
        // they arrive, because this proxy terminates the connection and sees every one.
        "MULTI" | "EXEC" | "DISCARD" | "UNWATCH" => NoKeys,

        _ => return Option::None,
    })
}

/// What happened to one key argument while a command was namespaced.
///
/// Commands such as `BLPOP` echo the selected key in their reply. The caller needs this per-key
/// decision when a command mixes an already-prefixed BullMQ key with a bare Celery key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NamespacedKey {
    pub index: usize,
    pub added_prefix: bool,
}

/// Rewrites a command's keys, returning the per-argument namespacing decisions.
///
/// Returns `Err` describing why a command was refused. The caller turns that into a RESP error the
/// tenant can act on — "unknown or disallowed command" rather than a dropped connection.
pub fn namespace_command(
    args: &mut [Vec<u8>],
    prefix: &[u8],
) -> Result<Vec<NamespacedKey>, &'static str> {
    let verb = args
        .first()
        .map(|arg| String::from_utf8_lossy(arg).to_uppercase())
        .unwrap_or_default();

    if verb == "SCRIPT" {
        let is_load = args.len() == 3
            && args
                .get(1)
                .is_some_and(|arg| arg.eq_ignore_ascii_case(b"LOAD"));
        return if is_load {
            Ok(Vec::new())
        } else {
            Err("unknown or disallowed command")
        };
    }

    let Some(spec) = key_spec(&verb) else {
        return Err("unknown or disallowed command");
    };

    let indices: Vec<usize> = match spec {
        KeySpec::None => Vec::new(),
        KeySpec::Range { first, step } => (first..args.len()).step_by(step).collect(),
        KeySpec::RangeExceptLast { first, step } => {
            if args.len() <= first + 1 {
                return Err("wrong number of arguments");
            }
            (first..args.len() - 1).step_by(step).collect()
        }
        KeySpec::Fixed { first, count } => {
            if args.len() < first + count {
                return Err("wrong number of arguments");
            }
            (first..first + count).collect()
        }
        KeySpec::Numkeys { count_at } => {
            let raw = args.get(count_at).ok_or("wrong number of arguments")?;
            let text = std::str::from_utf8(raw).map_err(|_| "numkeys is not a number")?;
            let count: usize = text.parse().map_err(|_| "numkeys is not a number")?;
            // A script claiming more keys than it sent would otherwise namespace arguments — or
            // panic. Both are worse than refusing.
            if args.len() < count_at + 1 + count {
                return Err("numkeys is larger than the arguments given");
            }
            (count_at + 1..count_at + 1 + count).collect()
        }
        KeySpec::NumkeysWithDestination { count_at } => {
            let raw = args.get(count_at).ok_or("wrong number of arguments")?;
            let text = std::str::from_utf8(raw).map_err(|_| "numkeys is not a number")?;
            let count: usize = text.parse().map_err(|_| "numkeys is not a number")?;
            if args.len() < count_at + 1 + count {
                return Err("numkeys is larger than the arguments given");
            }
            let mut indices = Vec::with_capacity(count + 1);
            indices.push(1);
            indices.extend(count_at + 1..count_at + 1 + count);
            indices
        }
        KeySpec::Streams => {
            let grouped = args[0].eq_ignore_ascii_case(b"XREADGROUP");
            let mut streams_at = if grouped {
                if args
                    .get(1)
                    .is_none_or(|arg| !arg.eq_ignore_ascii_case(b"GROUP"))
                    || args.len() < 4
                {
                    return Err("XREADGROUP requires GROUP, group, and consumer");
                }
                4
            } else {
                1
            };
            loop {
                let option = args
                    .get(streams_at)
                    .ok_or("XREAD requires a STREAMS section")?;
                if option.eq_ignore_ascii_case(b"STREAMS") {
                    break;
                }
                if option.eq_ignore_ascii_case(b"COUNT") || option.eq_ignore_ascii_case(b"BLOCK") {
                    if args.get(streams_at + 1).is_none() {
                        return Err("XREAD option requires a value");
                    }
                    streams_at += 2;
                } else if grouped && option.eq_ignore_ascii_case(b"NOACK") {
                    streams_at += 1;
                } else {
                    return Err("unknown XREAD option before STREAMS");
                }
            }
            let remaining = args.len().saturating_sub(streams_at + 1);
            if remaining == 0 || !remaining.is_multiple_of(2) {
                return Err("XREAD STREAMS needs the same number of keys and ids");
            }
            let count = remaining / 2;
            (streams_at + 1..streams_at + 1 + count).collect()
        }
    };

    Ok(indices
        .into_iter()
        .map(|index| {
            let (key, added_prefix) = crate::keyspace::namespace_once(prefix, &args[index]);
            args[index] = key;
            NamespacedKey {
                index,
                added_prefix,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREFIX: &[u8] = b"{kv:01hb}:";

    fn command(parts: &[&str]) -> Vec<Vec<u8>> {
        parts.iter().map(|p| p.as_bytes().to_vec()).collect()
    }

    fn namespaced(parts: &[&str]) -> Result<Vec<String>, &'static str> {
        let mut args = command(parts);
        namespace_command(&mut args, PREFIX)?;
        Ok(args
            .iter()
            .map(|a| String::from_utf8_lossy(a).into_owned())
            .collect())
    }

    /// The default is refuse, not forward. A key this proxy fails to namespace sits in the shared
    /// root of the keyspace, where every other tenant can reach it.
    #[test]
    fn an_unknown_command_is_refused() {
        assert!(namespaced(&["MINE_BITCOIN", "please"]).is_err());
    }

    /// Each of these is a way for one tenant to reach past its own namespace, or to take the
    /// instance down for everyone on it.
    #[test]
    fn dangerous_commands_are_refused() {
        for verb in [
            "SELECT",
            "FLUSHALL",
            "FLUSHDB",
            "KEYS",
            "SCAN",
            "CONFIG",
            "SHUTDOWN",
            "DEBUG",
            "CLIENT",
            "CLUSTER",
            "ACL",
            "REPLICAOF",
            "SLAVEOF",
            "MONITOR",
            "SWAPDB",
            "MIGRATE",
            "RANDOMKEY",
        ] {
            assert!(
                namespaced(&[verb, "0"]).is_err(),
                "{verb} should be refused"
            );
        }
        for command in [
            ["SCRIPT", "FLUSH"].as_slice(),
            ["SCRIPT", "KILL"].as_slice(),
            ["SCRIPT", "EXISTS", "abc"].as_slice(),
        ] {
            assert!(
                namespaced(command).is_err(),
                "{command:?} should be refused"
            );
        }
    }

    #[test]
    fn celery_may_load_but_not_administer_scripts() {
        let command = namespaced(&["SCRIPT", "LOAD", "return redis.call('GET', KEYS[1])"])
            .expect("SCRIPT LOAD is safe before execution");
        assert_eq!(
            command,
            ["SCRIPT", "LOAD", "return redis.call('GET', KEYS[1])"]
        );
        assert!(namespaced(&["SCRIPT", "LOAD"]).is_err());
    }

    #[test]
    fn the_verb_is_case_insensitive() {
        // redis-cli sends lowercase; BullMQ's Lua sends uppercase. Matching raw bytes would let
        // `get` past a check looking for `GET` — and past the command table entirely.
        assert_eq!(namespaced(&["get", "jobs"]).unwrap()[1], "{kv:01hb}:jobs");
        assert_eq!(namespaced(&["GeT", "jobs"]).unwrap()[1], "{kv:01hb}:jobs");
    }

    #[test]
    fn a_single_key_command_namespaces_only_the_key() {
        // The value must not be touched: it is the caller's data, and prefixing it corrupts it.
        let out = namespaced(&["SET", "jobs", "payload"]).unwrap();
        assert_eq!(out, vec!["SET", "{kv:01hb}:jobs", "payload"]);
    }

    #[test]
    fn a_command_can_mix_published_and_bare_keys() {
        let mut args = command(&["MGET", "{kv:01hb}:bull:emails:wait", "celery"]);
        let decisions = namespace_command(&mut args, PREFIX).unwrap();

        assert_eq!(
            args.iter()
                .map(|arg| String::from_utf8_lossy(arg).into_owned())
                .collect::<Vec<_>>(),
            ["MGET", "{kv:01hb}:bull:emails:wait", "{kv:01hb}:celery"]
        );
        assert_eq!(
            decisions,
            [
                NamespacedKey {
                    index: 1,
                    added_prefix: false
                },
                NamespacedKey {
                    index: 2,
                    added_prefix: true
                }
            ]
        );
    }

    #[test]
    fn variadic_commands_namespace_every_key() {
        let out = namespaced(&["DEL", "a", "b", "c"]).unwrap();
        assert_eq!(out[1..], ["{kv:01hb}:a", "{kv:01hb}:b", "{kv:01hb}:c"]);
    }

    #[test]
    fn mset_namespaces_keys_and_leaves_values_alone() {
        // step 2. Getting this wrong prefixes the values, which is silent data corruption rather
        // than an error anyone would notice.
        let out = namespaced(&["MSET", "a", "1", "b", "2"]).unwrap();
        assert_eq!(out[1..], ["{kv:01hb}:a", "1", "{kv:01hb}:b", "2"]);
    }

    #[test]
    fn a_blocking_pops_timeout_is_not_a_key() {
        // BLPOP key... timeout. Namespacing the timeout sends `{kv:01hb}:0` as a key name, and the
        // command either errors or blocks forever on a key nobody writes.
        let out = namespaced(&["BLPOP", "jobs", "other", "0"]).unwrap();
        assert_eq!(out[1..], ["{kv:01hb}:jobs", "{kv:01hb}:other", "0"]);
    }

    #[test]
    fn eval_reads_numkeys_and_leaves_arguments_alone() {
        // BullMQ is almost entirely EVALSHA, so this is the path that matters most.
        let out = namespaced(&["EVALSHA", "abc123", "2", "wait", "active", "job-1", "5"]).unwrap();
        assert_eq!(
            out,
            vec![
                "EVALSHA",
                "abc123",
                "2",
                "{kv:01hb}:wait",
                "{kv:01hb}:active",
                "job-1",
                "5"
            ]
        );
    }

    #[test]
    fn eval_with_no_keys_touches_nothing() {
        let out = namespaced(&["EVAL", "return 1", "0", "arg"]).unwrap();
        assert_eq!(out, vec!["EVAL", "return 1", "0", "arg"]);
    }

    /// A script claiming more keys than it sent would namespace arguments, or index past the end.
    #[test]
    fn eval_refuses_a_numkeys_larger_than_the_arguments() {
        assert!(namespaced(&["EVAL", "script", "5", "one"]).is_err());
        assert!(namespaced(&["EVAL", "script", "not-a-number", "one"]).is_err());
    }

    #[test]
    fn a_command_missing_its_key_is_refused_rather_than_panicking() {
        assert!(namespaced(&["GET"]).is_err());
        assert!(namespaced(&["RENAME", "only-one"]).is_err());
        assert!(namespaced(&["BLPOP", "0"]).is_err());
    }

    #[test]
    fn keys_are_binary_safe() {
        // Valkey keys are bytes. A proxy that assumed UTF-8 would mangle a key, and BullMQ stores
        // serialized payloads that are not text.
        let mut args = vec![b"GET".to_vec(), vec![0xff, 0x00, 0xfe]];
        namespace_command(&mut args, PREFIX).unwrap();
        assert_eq!(args[1], [PREFIX, &[0xff, 0x00, 0xfe]].concat());
    }

    #[test]
    fn no_key_commands_are_left_untouched() {
        assert_eq!(namespaced(&["PING"]).unwrap(), vec!["PING"]);
        assert_eq!(namespaced(&["MULTI"]).unwrap(), vec!["MULTI"]);
    }

    #[test]
    fn acl_allowlist_and_proxy_allowlist_do_not_diverge() {
        for command in FORWARDED_COMMANDS {
            assert!(
                key_spec(command).is_some(),
                "ACL grants a refused command: {command}"
            );
        }
        assert!(key_spec("AUTH").is_none());
        assert!(key_spec("HELLO").is_none());
    }

    #[test]
    fn stream_metadata_commands_namespace_the_key_not_the_subcommand() {
        assert_eq!(
            namespaced(&["XINFO", "STREAM", "jobs"]).unwrap(),
            ["XINFO", "STREAM", "{kv:01hb}:jobs"]
        );
        assert_eq!(
            namespaced(&["XGROUP", "CREATE", "jobs", "$", "MKSTREAM"]).unwrap(),
            ["XGROUP", "CREATE", "{kv:01hb}:jobs", "$", "MKSTREAM"]
        );
    }

    #[test]
    fn xread_namespaces_only_the_keys_before_the_id_half() {
        assert_eq!(
            namespaced(&["XREAD", "COUNT", "2", "STREAMS", "one", "two", "$", "0"]).unwrap(),
            [
                "XREAD",
                "COUNT",
                "2",
                "STREAMS",
                "{kv:01hb}:one",
                "{kv:01hb}:two",
                "$",
                "0"
            ]
        );
        assert_eq!(
            namespaced(&[
                "XREADGROUP",
                "GROUP",
                "STREAMS",
                "consumer",
                "NOACK",
                "STREAMS",
                "one",
                ">",
            ])
            .unwrap(),
            [
                "XREADGROUP",
                "GROUP",
                "STREAMS",
                "consumer",
                "NOACK",
                "STREAMS",
                "{kv:01hb}:one",
                ">",
            ]
        );
        assert!(namespaced(&["XREAD", "STREAMS", "one", "two", "0"]).is_err());
    }

    #[test]
    fn numkeys_management_commands_touch_only_declared_keys() {
        for parts in [
            &["LMPOP", "2", "a", "b", "LEFT", "COUNT", "1"][..],
            &["BLMPOP", "1", "2", "a", "b", "RIGHT"][..],
            &["ZMPOP", "2", "a", "b", "MIN"][..],
            &["BZMPOP", "1", "2", "a", "b", "MAX"][..],
            &["SINTERCARD", "2", "a", "b", "LIMIT", "1"][..],
        ] {
            let out = namespaced(parts).unwrap();
            assert!(out.iter().any(|arg| arg == "{kv:01hb}:a"), "{out:?}");
            assert!(out.iter().any(|arg| arg == "{kv:01hb}:b"), "{out:?}");
            assert!(!out.iter().any(|arg| arg == "{kv:01hb}:LEFT"), "{out:?}");
        }
    }

    #[test]
    fn broad_data_type_commands_rewrite_every_key_and_no_values() {
        assert_eq!(
            namespaced(&["BITOP", "AND", "out", "one", "two"]).unwrap(),
            [
                "BITOP",
                "AND",
                "{kv:01hb}:out",
                "{kv:01hb}:one",
                "{kv:01hb}:two"
            ]
        );
        assert_eq!(
            namespaced(&[
                "GEOSEARCHSTORE",
                "nearby",
                "places",
                "FROMLONLAT",
                "0",
                "0",
                "BYRADIUS",
                "5",
                "km",
            ])
            .unwrap(),
            [
                "GEOSEARCHSTORE",
                "{kv:01hb}:nearby",
                "{kv:01hb}:places",
                "FROMLONLAT",
                "0",
                "0",
                "BYRADIUS",
                "5",
                "km"
            ]
        );
        assert_eq!(
            namespaced(&["PFMERGE", "all", "a", "b"]).unwrap(),
            ["PFMERGE", "{kv:01hb}:all", "{kv:01hb}:a", "{kv:01hb}:b"]
        );
    }

    #[test]
    fn sorted_set_store_commands_rewrite_destination_and_declared_sources_only() {
        assert_eq!(
            namespaced(&["ZINTERSTORE", "out", "2", "one", "two", "WEIGHTS", "2", "3",]).unwrap(),
            [
                "ZINTERSTORE",
                "{kv:01hb}:out",
                "2",
                "{kv:01hb}:one",
                "{kv:01hb}:two",
                "WEIGHTS",
                "2",
                "3"
            ]
        );
        assert!(namespaced(&["ZINTERSTORE", "out", "2", "one"]).is_err());
    }
}

/// Does this verb *add work* to a queue?
///
/// The master queue (`master.rs`) reports "this queue has jobs" so a dispatcher can start a worker.
/// The question is not whether a command writes — a worker acknowledging a job writes constantly and
/// waking on that would mean a queue never looks idle. It is whether a command can put something in
/// for a worker to pick up.
///
/// `EVAL`/`EVALSHA` are here because **BullMQ is almost entirely Lua**: `Queue.add` is a script, and
/// a rule that only knew about `LPUSH` would see approximately none of BullMQ's real traffic. The
/// cost of that breadth is that a script which only reads also wakes a queue, which starts a worker
/// that finds nothing and scales back down. The opposite mistake — a queue with jobs and no worker
/// — is a customer's job that never runs.
///
/// Do not add bookkeeping writes merely because they mutate Valkey. Celery declares Kombu bindings
/// with `SADD` and tracks unacknowledged deliveries with `ZADD`; treating those as publishes made
/// every Lambda drain enqueue another drain, so one job fanned out into an invocation loop. Celery
/// publishes with a list push. BullMQ's sorted-set and hash writes happen inside its Lua command,
/// which is already covered here.
///
/// `EVAL_RO`, `EVALSHA_RO` and `FCALL_RO` are excluded: the server itself refuses writes from them,
/// so they cannot enqueue anything.
pub fn adds_work(verb: &str, first_key: &[u8], prefix: &[u8]) -> bool {
    match verb {
        // Celery and direct list/stream producers publish with these commands.
        "LPUSH" | "RPUSH" | "LPUSHX" | "RPUSHX" | "XADD" => true,
        // BullMQ scripts use the published `bull:<queue>:...` key family. Kombu also uses Lua for
        // visibility-timeout bookkeeping (`unacked_mutex`); accepting every script made that lock
        // look like a queue and recursively woke another Lambda drain.
        "EVAL" | "EVALSHA" | "FCALL" => first_key
            .strip_prefix(prefix)
            .unwrap_or(first_key)
            .starts_with(b"bull:"),
        _ => false,
    }
}

/// The queue a key belongs to, from the key as the *tenant* wrote it.
///
/// BullMQ lays its keys out as `bull:<queue>:<what>` — `bull:emails:wait`, `bull:emails:id`,
/// `bull:emails:1`. Celery's default broker is a plain list named for the queue. Both are covered by
/// the same rule: strip a known broker prefix if there is one, then take the segment before the next
/// colon.
///
/// BullMQ sends the published tenant prefix itself, while Celery sends a bare key. Strip this
/// tenant's exact prefix once before interpreting either layout. A foreign prefix is not stripped.
pub fn queue_of(key: &[u8], prefix: &[u8]) -> Option<String> {
    let key = key.strip_prefix(prefix).unwrap_or(key);
    let key = std::str::from_utf8(key).ok()?;

    // BullMQ's own prefix. The public `BULLMQ_PREFIX` contract fixes this portion of the layout;
    // see `valkeyKeyPrefix` in `@lib/services`.
    let rest = key.strip_prefix("bull:").unwrap_or(key);

    let name = match rest.split_once(':') {
        Some((name, _)) => name,
        // A key with no colon is the whole queue: Celery's `celery`, or a plain list.
        None => rest,
    };

    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

#[cfg(test)]
mod master_queue_tests {
    use super::*;

    const PREFIX: &[u8] = b"{kv:01hb}:";

    #[test]
    fn bullmq_key_layouts_name_their_queue() {
        assert_eq!(
            queue_of(b"{kv:01hb}:bull:emails:wait", PREFIX).as_deref(),
            Some("emails")
        );
        assert_eq!(
            queue_of(b"{kv:01hb}:bull:emails:id", PREFIX).as_deref(),
            Some("emails")
        );
        assert_eq!(
            queue_of(b"bull:emails:1", PREFIX).as_deref(),
            Some("emails")
        );
        assert_eq!(
            queue_of(b"{kv:01hb}:bull:media-transcode:delayed", PREFIX).as_deref(),
            Some("media-transcode")
        );
    }

    #[test]
    fn a_plain_list_is_its_own_queue() {
        // Celery's default.
        assert_eq!(queue_of(b"celery", PREFIX).as_deref(), Some("celery"));
    }

    #[test]
    fn a_key_that_names_nothing_is_not_a_queue() {
        assert_eq!(queue_of(b"", PREFIX), None);
        assert_eq!(queue_of(b"{kv:01hb}:bull:", PREFIX), None);
    }

    /// Invalid UTF-8 is a legal Valkey key. It is not a queue name a dispatcher can use, and it must
    /// not panic on the way to finding that out.
    #[test]
    fn a_binary_key_is_not_a_queue() {
        assert_eq!(queue_of(&[0xff, 0x00, 0xfe], PREFIX), None);
    }

    #[test]
    fn only_verbs_that_can_enqueue_wake_a_queue() {
        for verb in ["LPUSH", "RPUSH", "XADD"] {
            assert!(
                adds_work(verb, b"celery", PREFIX),
                "{verb} should wake a queue"
            );
        }
        for verb in ["EVALSHA", "EVAL", "FCALL"] {
            assert!(
                adds_work(verb, b"{kv:01hb}:bull:emails:wait", PREFIX),
                "BullMQ {verb} should wake a queue"
            );
            assert!(
                !adds_work(verb, b"{kv:01hb}:unacked_mutex", PREFIX),
                "Kombu bookkeeping {verb} must not wake a queue"
            );
        }
        // Reads, and the binding/unacknowledged/acknowledgement traffic a running worker produces.
        for verb in [
            "GET",
            "LRANGE",
            "BRPOPLPUSH",
            "BZPOPMIN",
            "LPOP",
            "ZREM",
            "HGET",
            "XACK",
            "SADD",
            "ZADD",
            "LMOVE",
            "RPOPLPUSH",
            "DEL",
            "EVALSHA_RO",
            "EVAL_RO",
            "FCALL_RO",
        ] {
            assert!(
                !adds_work(verb, b"celery", PREFIX),
                "{verb} should not wake a queue"
            );
        }
    }
}
