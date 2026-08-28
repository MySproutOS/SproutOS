"""A real Celery repository entry point used by the proxy acceptance test.

This is intentionally ordinary customer code: the same module is imported by a long-running
Celery worker and by the producer.  The Rust test supplies the tenant broker URL through the
environment, just as SproutOS injects ``REDIS_URL`` into a deployed repository.
"""

from __future__ import annotations

import os
import socket
import sys
from urllib.parse import quote

from celery import Celery


BROKER_URL = os.environ.get("REDIS_URL") or (
    "redis://"
    + quote(os.environ["VALKEY_USERNAME"], safe="")
    + ":"
    + quote(os.environ["VALKEY_SECRET"], safe="")
    + "@"
    + os.environ["VALKEY_ADDRESS"]
    + "/0"
)
QUEUE = os.environ.get("CELERY_QUEUE", "celery")

app = Celery("sproutos_acceptance", broker=BROKER_URL, backend=BROKER_URL)
app.conf.update(
    accept_content=["json"],
    result_accept_content=["json"],
    task_default_queue=QUEUE,
    task_serializer="json",
    result_serializer="json",
)


@app.task(name="sproutos.acceptance.add")
def add(left: int, right: int) -> int:
    return left + right


def handler(event: dict[str, object], _context: object = None) -> dict[str, int]:
    """Drain a bounded Celery batch from a SproutOS queue invocation.

    A normal ``celery worker`` waits forever and is the wrong process model for Lambda. SproutOS
    wakes the repository's function when the proxy sees a publish, so the handler consumes only the
    advertised batch and returns. Messages remain Celery protocol-v2 messages produced by ordinary
    ``delay``/``send_task`` calls.
    """

    envelope = event.get("sproutos")
    if not isinstance(envelope, dict) or envelope.get("kind") != "queue.drain":
        raise ValueError("expected a SproutOS queue.drain event")
    max_jobs = min(max(int(envelope.get("maxJobs", 1)), 1), 100)
    processed = 0

    def execute(body: object, message: object) -> None:
        nonlocal processed
        headers = getattr(message, "headers", {})
        task_name = headers.get("task")
        task_id = headers.get("id")
        if not isinstance(task_name, str) or not isinstance(task_id, str):
            message.reject(requeue=False)
            raise ValueError("Celery protocol-v2 task headers are missing")
        if not isinstance(body, list) or len(body) < 2:
            message.reject(requeue=False)
            raise ValueError("Celery protocol-v2 task body is malformed")

        result = app.tasks[task_name].apply(args=body[0], kwargs=body[1], task_id=task_id)
        app.backend.store_result(task_id, result.result, result.state)
        message.ack()
        processed += 1

    with app.connection_for_read() as connection:
        consumer = app.amqp.TaskConsumer(
            connection,
            queues=[app.amqp.queues[QUEUE]],
            accept=["json"],
        )
        consumer.register_callback(execute)
        with consumer:
            while processed < max_jobs:
                try:
                    connection.drain_events(timeout=0.25)
                except socket.timeout:
                    break

    return {"processed": processed}


def main() -> None:
    mode = sys.argv[1]
    if mode == "worker":
        app.worker_main(
            argv=[
                "worker",
                "--pool=solo",
                "--concurrency=1",
                "--loglevel=WARNING",
                "--without-gossip",
                "--without-mingle",
                "--without-heartbeat",
                "--queues",
                QUEUE,
            ]
        )
        return
    if mode == "produce":
        result = add.delay(20, 22)
        print(result.get(timeout=30), flush=True)
        return
    if mode == "enqueue":
        print(add.delay(20, 22).id, flush=True)
        return
    if mode == "drain":
        print(
            handler(
                {
                    "sproutos": {
                        "kind": "queue.drain",
                        "queue": QUEUE,
                        "maxJobs": 25,
                    }
                }
            ),
            flush=True,
        )
        return
    if mode == "result":
        print(app.AsyncResult(sys.argv[2]).get(timeout=30), flush=True)
        return
    raise SystemExit(f"unknown mode: {mode}")


if __name__ == "__main__":
    main()
