import os
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI
from mangum import Mangum


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool = await asyncpg.create_pool(os.environ["DATABASE_URL"])
    async with pool.acquire() as connection:
        await connection.execute(
            """
            create table if not exists visit_counter (
                id integer primary key,
                visits bigint not null
            )
            """
        )
    app.state.database = pool
    try:
        yield
    finally:
        await pool.close()


app = FastAPI(lifespan=lifespan)


@app.get("/visits")
async def visits() -> dict[str, int]:
    """One database-backed endpoint, deliberately small enough for an acceptance fixture."""
    async with app.state.database.acquire() as connection:
        count = await connection.fetchval(
            """
            insert into visit_counter (id, visits)
            values (1, 1)
            on conflict (id) do update
            set visits = visit_counter.visits + 1
            returning visits
            """
        )
    return {"visits": count}


# The same fixture runs in a local/Daytona container through Uvicorn and in SproutOS production
# through Lambda's native Python handler. Keeping both entry points on one app makes the live
# acceptance exercise the same code that the deterministic container check does.
handler = Mangum(app, lifespan="auto")
