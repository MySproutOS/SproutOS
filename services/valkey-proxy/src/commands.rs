//! Which arguments of a command are keys.
//!
//! This is the security boundary. A key the proxy fails to namespace is a key in the shared root
//! of the keyspace, which every tenant can reach — so the default for an unrecognised command is
//! **refuse**, not forward. An allowlist that is missing a command produces a support ticket; a
//! blocklist that is missing one produces a cross-tenant read.

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
    /// The last argument is a timeout, not a key: `BLPOP key... timeout`.
    RangeExceptLast { first: usize, step: usize },
}

/// The commands a tenant may send, and where their keys are.
///
/// BullMQ and Celery are the clients that matter, and between them they use most of this list.
/// Deliberately absent, and refused: `SELECT` (tenancy is the prefix, not the database), `FLUSHALL`
/// and `FLUSHDB` (one tenant erasing a shared instance), `CONFIG`, `SHUTDOWN`, `DEBUG`, `SCRIPT`,
/// `CLIENT`, `CLUSTER`, `ACL`, `REPLICAOF`, and `KEYS` — which scans the whole keyspace and would
/// walk straight through the namespacing.
pub fn key_spec(verb: &str) -> Option<KeySpec> {
    use KeySpec::{Fixed, None as NoKeys, Numkeys, Range, RangeExceptLast};

    Some(match verb {
        // Connection and no-key commands.
        "PING" | "ECHO" | "QUIT" | "HELLO" | "AUTH" => NoKeys,

        // Strings.
        "GET" | "GETDEL" | "GETEX" | "INCR" | "DECR" | "STRLEN" | "TTL" | "PTTL" | "PERSIST"
        | "TYPE" | "DUMP" => Fixed { first: 1, count: 1 },
        "SET" | "SETNX" | "SETEX" | "PSETEX" | "GETSET" | "APPEND" | "INCRBY" | "DECRBY"
        | "INCRBYFLOAT" | "EXPIRE" | "PEXPIRE" | "EXPIREAT" | "PEXPIREAT" => {
            Fixed { first: 1, count: 1 }
        }
        "MGET" | "DEL" | "UNLINK" | "EXISTS" | "TOUCH" | "WATCH" => Range { first: 1, step: 1 },
        "MSET" | "MSETNX" => Range { first: 1, step: 2 },
        "RENAME" | "RENAMENX" | "COPY" | "SMOVE" => Fixed { first: 1, count: 2 },

        // Hashes — Celery and BullMQ both keep job data in these.
        "HGET" | "HSET" | "HDEL" | "HGETALL" | "HKEYS" | "HVALS" | "HLEN" | "HEXISTS"
        | "HINCRBY" | "HINCRBYFLOAT" | "HMGET" | "HMSET" | "HSETNX" | "HRANDFIELD" | "HSCAN" => {
            Fixed { first: 1, count: 1 }
        }

        // Lists — Celery's default broker is a list.
        "LPUSH" | "RPUSH" | "LPUSHX" | "RPUSHX" | "LPOP" | "RPOP" | "LLEN" | "LRANGE" | "LREM"
        | "LSET" | "LTRIM" | "LINSERT" | "LINDEX" | "LPOS" => Fixed { first: 1, count: 1 },
        "RPOPLPUSH" | "LMOVE" => Fixed { first: 1, count: 2 },
        // The trailing timeout is not a key, and namespacing it would send `0` as a key name.
        "BLPOP" | "BRPOP" => RangeExceptLast { first: 1, step: 1 },
        "BRPOPLPUSH" | "BLMOVE" => Fixed { first: 1, count: 2 },

        // Sets.
        "SADD" | "SREM" | "SMEMBERS" | "SISMEMBER" | "SMISMEMBER" | "SCARD" | "SPOP"
        | "SRANDMEMBER" | "SSCAN" => Fixed { first: 1, count: 1 },
        "SINTER" | "SUNION" | "SDIFF" => Range { first: 1, step: 1 },

        // Sorted sets — BullMQ's delayed and prioritised queues.
        "ZADD" | "ZREM" | "ZSCORE" | "ZCARD" | "ZCOUNT" | "ZRANGE" | "ZREVRANGE"
        | "ZRANGEBYSCORE" | "ZREVRANGEBYSCORE" | "ZRANGEBYLEX" | "ZRANK" | "ZREVRANK"
        | "ZINCRBY" | "ZREMRANGEBYSCORE" | "ZREMRANGEBYRANK" | "ZREMRANGEBYLEX" | "ZSCAN"
        | "ZPOPMIN" | "ZPOPMAX" | "ZRANDMEMBER" => Fixed { first: 1, count: 1 },
        "BZPOPMIN" | "BZPOPMAX" => RangeExceptLast { first: 1, step: 1 },

        // Streams.
        "XADD" | "XLEN" | "XRANGE" | "XREVRANGE" | "XDEL" | "XTRIM" | "XACK" | "XPENDING"
        | "XCLAIM" | "XAUTOCLAIM" | "XINFO" | "XGROUP" | "XSETID" => Fixed { first: 1, count: 1 },

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

/// Rewrites a command's keys, returning the argument indices that were namespaced.
///
/// Returns `Err` describing why a command was refused. The caller turns that into a RESP error the
/// tenant can act on — "unknown or disallowed command" rather than a dropped connection.
pub fn namespace_command(args: &mut [Vec<u8>], prefix: &[u8]) -> Result<Vec<usize>, &'static str> {
    let verb = args
        .first()
        .map(|arg| String::from_utf8_lossy(arg).to_uppercase())
        .unwrap_or_default();

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
    };

    for index in &indices {
        args[*index] = crate::keyspace::namespace(prefix, &args[*index]);
    }

    Ok(indices)
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
            "SCRIPT",
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
}
