---
slug: health-data-you-can-join
title: The question three health apps can't answer
summary: Not because the data is missing — because it is in three companies.
audience: For people
kind: Worked example
date: 2026-09-01
---

You run with one app, sleep with a ring, and live out of a work calendar. Each of the three is
good. Each shows you a chart of itself.

And the question you actually have — _am I falling behind because I am training badly, or because
March has been brutal?_ — needs all three at once.

## Why nobody ships this feature

Your fitness app could answer it, if it had your sleep and your calendar. It does not, and it never
will: the data belongs to two competitors, and no amount of product roadmap fixes that.

So the answer today is three exports, three schemas, and an afternoon in a spreadsheet. Most people
do it once, never again, and go back to guessing.

## What changes when the database is yours

If those apps write into a database you own, the question stops being an integration and becomes a
join.

```sql
select week
from   runs
join   sleep    using (week)
join   calendar using (week)
where  sleep.hours_median < 7
  and  calendar.meeting_hours > 30
```

Nobody had to build that. No vendor had to agree to it. It works because all three sets of rows are
sitting in one place that belongs to the person who generated them.

The answer is either reassuring or actionable. Both beat a fourth chart.

## Why this is only possible cheaply

A database per person is a sane idea only if a database costs cents. Priced like an always-on
instance, one per user is a business nobody can run — which is why the companies best placed to
offer you this are the least able to.

That is the whole reason the argument is available to us: everything here suspends when nothing is
happening, and a personal database is idle nearly all of the time.
