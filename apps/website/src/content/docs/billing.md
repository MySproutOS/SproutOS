---
slug: billing
title: Understand billing
summary: Read service usage, credit, overhead, and queue residency without hidden rounding.
---

## Usage and credit

Usage is recorded in an append-only ledger and grouped by service. Line items retain sub-cent precision; spendable credit is displayed in cents. A balance cannot be spent below zero.

## Queue residency

Queue residency is queued payload bytes multiplied by how long they remain queued. It is storage over time, not a count of jobs and not ordinary cache usage.

## Platform fees

Sandbox usage, sandbox egress, Postgres storage, and user-funded AI have no added platform percentage. Postgres compute has a 2% platform fee. Payment processing is passed through separately.
