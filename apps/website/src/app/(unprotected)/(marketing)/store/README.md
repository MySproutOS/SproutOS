# The store, server-rendered

`/store` and `/store/[slug]` for a visitor who has never signed in.

## Why these pages exist at all

The dashboard SPA already has a store. These are the _same URLs_, rendered a second time.

`apps/website/src/proxy.ts` lists both paths in `SHARED_ROUTES`: with no valid session cookie the
Next.js page below renders; with one, the request is rewritten to the dashboard SPA. One URL, two
renderers, decided by the cookie.

That split is the whole point. A store listing is a page you send someone — a link in a message, a
result in a search engine, a card in a chat preview. A client-rendered listing is an empty document
with a script tag, which is nothing to send and nothing to index. So the logged-out half is
server-rendered, and the logged-in half stays in the SPA where forking, credits, and the rest of
the session-shaped UI already live.

The practical consequence for anything added here: **it has to work with JavaScript off.** The
filters are a `<form method="get">` and a row of links, not `onChange` handlers, because a crawler
that cannot submit a form sees an unfiltered catalogue and a person on a slow connection sees a
working one.

## Reading straight from the database

These pages call the DAOs directly rather than the API at `/v1/store/*`.

The route handler and the page run in the same process, so going through HTTP would be a loopback
request, a second JSON serialization, and a second round of validation to produce data the page
could have selected itself. The API version of these queries still exists — the SPA needs it — and
both sides go through the same `fetchStoreListing` DAO, so the moderation rule that keeps
unpublished markdown out of a response lives in one place and applies to both.

## What is deliberately not here

**Ranked pagination.** `featuredQuery` is capped and unpaginated. The cursor in
`apps/internal-api/src/utils/pagination.ts` carries a UUID anchor and pairs it with `WHERE id <
anchor`, which describes an id ordering and nothing else — a rank ordering cannot be walked with
it. The catalogue is therefore ordered by id (UUIDv7, so newest first) and the rail is a fixed
three.

**An opaque cursor.** The catalogue's "More apps" link carries `?cursor=<listing id>`, a plain
UUID, rather than the base64 token the API uses. These URLs get shared and crawled; a legible one
is worth more here than a uniform one, and `parseStoreQuery` refuses anything that is not a UUID
before it reaches a `WHERE` clause.

**A markdown sanitizer.** `_components/markdown.tsx` does not install `rehype-raw`, so
react-markdown never turns raw HTML into elements — an embedded `<script>` in a listing body is
inert text. Listing bodies are community-submitted and a published listing has been _moderated_,
which is not the same as sanitized. Adding `rehype-raw` later would silently turn this page into a
stored-XSS sink.

**A count.** No `SELECT count(*)`. The page fetches `PAGE_SIZE + 1` rows and infers "there is a
next page" from the extra one.

## The fork button

`Fork this app` sends someone to `/login?next=/store/<slug>`, and the callback returns them
here instead of to `/dashboard` — landing on an empty dashboard loses the app they clicked.

The return path is validated by `sanitizeReturnTo` in `apps/website/src/lib/return-to.ts` on the
way in _and_ on the way out, because its output becomes a `Location` header on a URL anyone can
craft. `return-to.test.ts` covers the bypasses that a naive `startsWith("/")` check lets through.

## Files

| Path                            | Role                                                                |
| ------------------------------- | ------------------------------------------------------------------- |
| `page.tsx`                      | The catalogue: filters, optional featured rail, keyset-paged grid   |
| `[slug]/page.tsx`               | One listing, with `generateMetadata` for the share card             |
| `query.ts`                      | The URL _is_ the page state. Parsing, validation, and link building |
| `_components/store-filters.tsx` | GET form and category/tag links — no client component               |
| `_components/listing-card.tsx`  | One card, shared by the rail and the grid                           |
| `_components/markdown.tsx`      | Listing bodies, with raw HTML deliberately unrendered               |
