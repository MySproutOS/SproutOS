---
slug: background-workers
title: Background workers and open connections
summary: Return after each batch so idle connections do not keep consuming compute.
---

## How work starts

SproutOS invokes your application when a queue has work. Handle the `queue.drain` event, process the supplied batch, and return. The same deployed function can serve HTTP and workflow invocations.

## Return when work is done

Compute is billed in GB-seconds until the handler returns. Close database connections and do not leave a Redis subscribe, blocking read, timer, or worker loop alive. SproutOS invokes the function again when more work arrives.

Use a workflow step for work that must continue later. Split work that cannot finish within one invocation, enqueue the remainder, and return.
