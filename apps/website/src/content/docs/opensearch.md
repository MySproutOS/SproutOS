---
slug: opensearch
title: Use OpenSearch
summary: Attach tenant-scoped search and keep index names, credentials, and application data isolated.
audience: user
category: Backend services
order: 13
---

OpenSearch provides full-text and structured search. Create the **Elasticsearch** service kind in
the dashboard; the connection variable and common client vocabulary use Elasticsearch naming,
while the managed engine is OpenSearch.

## Connect with the injected endpoint

An attached service supplies `ELASTICSEARCH_URL`. The SproutOS search proxy authenticates the
tenant and scopes index names before forwarding requests. Do not bypass that endpoint or store an
upstream cluster credential in the application.

The connection URI is shown when the service is created or rotated. If it is lost, rotate it and
update every consumer. Do not log request authorization headers or include the URI in source.

## Design indexes as application state

Search data is independent from a deployment. A code rollback does not restore an earlier index.
Keep source records in Postgres or another durable system when you need to rebuild the index, make
index mappings compatible across rolling releases, and use versioned index names plus an alias for
large schema changes.

Use object storage rather than search indexes for large file bodies, and index only the fields
needed for retrieval.
