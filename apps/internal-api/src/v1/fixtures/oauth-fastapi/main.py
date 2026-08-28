import os

from fastapi import FastAPI
from redis.asyncio import Redis


app = FastAPI()
database = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)


@app.get("/visits")
async def visits() -> dict[str, int]:
    """One database-backed endpoint, deliberately small enough for an acceptance fixture."""
    return {"visits": await database.incr("visits")}
