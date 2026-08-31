---
slug: billing
title: Understand billing
summary: Read service usage, credit, overhead, and queue residency without hidden rounding.
audience: user
category: Billing & limits
order: 2
---

## Usage and credit

Usage is recorded in an append-only ledger and grouped by service. Line items retain sub-cent precision; spendable credit is displayed in cents. SproutOS is prepaid: new work is refused once spendable credit is exhausted, delayed usage is capped at the available credit when posted, and provider-backed work cannot settle past the credit available after its reservation is released.

## Queue residency

Queue residency is queued payload bytes multiplied by how long they remain queued. It is storage over time, not a count of jobs and not ordinary cache usage.

## Object storage

Mutable object storage records write and list requests, read requests, bytes delivered outside AWS, and stored byte-time. Deletes are free. These dimensions have no SproutOS markup.

Spendable credit includes a protected reserve for 48 hours of the latest measured object-storage bytes. When credit reaches that floor, new service requests stop while the funded retention window preserves the stored data. Adding credit clears the cutoff.

## Platform fees

Dimensions without an item-specific override use the standard 12% platform fee. Postgres compute has a 2% fee. Postgres storage, sandbox resources and egress, platform-funded AI, and operational agent duration use 0%; user-funded AI is recorded as externally charged rather than billed again. Payment processing is passed through separately.
