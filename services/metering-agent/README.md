# `metering-agent`

A DaemonSet that samples cgroup v2 on every node and posts what each tenant consumed. This is the
only path by which CPU and memory become money, so the bar is different from the rest of the
platform: a bug here is a wrong invoice, and wrong invoices are found by customers.

## Why the layout is what it is

| File | Runs where | Tested where |
| --- | --- | --- |
| `cgroup.rs` | anywhere | anywhere — parsing and arithmetic, pure |
| `sampler.rs` | anywhere | anywhere — readings in, events out, no clock |
| `ingest.rs` | anywhere | anywhere — buffering and signing |
| `fs.rs` | Linux | anywhere — a temp directory is indistinguishable from `/sys/fs/cgroup` to `read_to_string` |
| `main.rs` | Linux | not tested; it is the loop and the configuration |

The reads need Linux. The subtraction does not, and the subtraction is where a bug costs somebody
money — so it takes its inputs as values and is tested against fixtures that are byte-for-byte what
the kernel writes.

## The four expensive bugs

Each is verified by introducing it and watching a test go red, because "we handle restarts" is the
kind of claim that is true until somebody simplifies a `checked_sub` into a `saturating_sub`.

**Billing the first sighting.** `cpu.stat` is cumulative from the cgroup's creation. A first reading
treated as a delta charges for everything the pod did before this agent started — which a previous
agent already billed. First sighting records a baseline and bills nothing.

**A non-deterministic idempotency key.** The ingest route dedupes on `external_id`. Send a batch,
lose the response, retry — with a random or counter-based id the tenant pays twice for that
interval. It is derived from the cgroup, the dimension and the timestamp. This bug only appears when
a response is lost, which is to say never in testing and eventually in production.

**Clamping a counter that went backwards.** A restart resets the counter. `saturating_sub` silently
drops the interval; taking the absolute value bills the pod's whole lifetime again. Neither is
acceptable for a number somebody pays, so the pair is refused, the agent re-baselines, and at most
one interval is lost.

**Taking the last memory reading instead of the average.** From point samples the honest average is
the trapezoid. Using `current` bills a pod that allocated a gigabyte just before the sample as
though it held it all interval — a systematic overcharge on every bursty workload.

## One node, several projects

TASK 24's actual requirement, and the reason attribution is a map rather than a field. A sampler
that took one node for one tenant would be most wrong on the densest nodes, which are exactly the
ones the cost thesis depends on. There is a test for two projects on one node billed separately.

Attribution comes from the pod's own labels, not from the API server. A per-node, per-second call
asking who owns each pod is the design that takes an API server down at scale.

## Failure handling

Failed batches are held, oldest first, capped at 10,000 events — roughly an hour of a busy node.
When the cap is exceeded the **oldest** are dropped and counted, and the count is logged. An
unbounded queue on a node under memory pressure is an OOM kill, which loses everything instead of a
slice; a silent drop is worse than a crash, because the loss is invisible at both ends.

A refused batch is held too, not discarded. A 4xx means a signing bug or schema drift, and the
events are still real money — holding them makes the fix a deploy rather than a reconciliation, and
the idempotency keys make redelivery safe.

## Not built

- **Pod discovery.** `main.rs` reads an empty label map, so the agent runs and bills nothing. The
  kubelet's pod-resources socket is the intended source and needs mounts the DaemonSet does not have
  yet. Said plainly here rather than faked with a placeholder that looks like it works.
- **The DaemonSet manifest itself**, the downward-API `NODE_NAME`, the cgroup and pod-resources
  mounts, and the IRSA role.
- **Dimensions beyond CPU and memory.** Egress bytes, requests and WebSocket-seconds are in
  `metering-proto` and are counted elsewhere or not at all — `site_egress_byte` in particular needs
  a source this agent does not have.
- **Anything on a non-Linux node.** cgroup v1 nodes produce no readings rather than wrong ones.
