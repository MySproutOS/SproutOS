---
slug: hand-back-the-data
title: Hand back the data, still charge for the app
summary: Holding everyone's rows is a liability you were taught to call a moat.
audience: For developers
kind: Worked example
date: 2026-09-01
---

The standard advice is that your users' data is your defensibility. Keep enough of it, for long
enough, and leaving becomes expensive — so they stay.

It works. It is also the reason nobody trusts consumer software, and the reason a better product
than yours has to be _considerably_ better before anyone will move.

## What you are actually holding

A breach of your servers is a breach of their history. A subject access request is an engineering
week. A storage bill that grows with every signup, forever, whether or not that account ever comes
back. None of that is a moat; it is custody, and custody is a cost.

## The other arrangement

Sign people in with SproutOS and write into the user's own database. You get the app; they get the
rows.

- Their history is theirs, so leaving is a copy rather than a project.
- Your storage stops tracking your signup count.
- You still charge for the product, because the product is what they were paying for.

## "But then they can leave"

Yes. That is the point, and it cuts both ways: every user of every competitor can also arrive,
bringing five years of history with them, and start on day one with a product that already knows
them.

Retention propped up by an export button nobody can use is not retention. It is a number that looks
like retention until something better is one click away.

## What it takes

Authorization Code with PKCE, and one extra scope. If you have integrated an OAuth provider before,
there is exactly one new idea — the database scope — and the user can decline it and still sign in.
