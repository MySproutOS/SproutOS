# `@utils/cookies`

One function, and the reason it is a package.

`cookieDomain()` decides the `Domain` attribute of the session cookie. The website sets that cookie;
the API reads it and clears it; they run on different hosts. If the two disagree about `Domain` — by
one of the copies being edited and the other not — the cookie set by one is invisible to the other,
and "sign out" silently does nothing. So there is one copy, in a package both import.

## Why not derive it

The obvious derivation, `"." + new URL(NEXT_PUBLIC_HOST_URL).hostname`, is correct only when the
website sits on the apex. Put it on `app.example.com` and the cookie is scoped to
`.app.example.com`, which `api.example.com` is not under: every authenticated request arrives
without a cookie and the app looks signed out. Getting the _registrable_ domain instead needs the
Public Suffix List — `example.co.uk` and `example.com` differ by a rule no amount of string
manipulation encodes.

So `SESSION_COOKIE_DOMAIN` is the mechanism, and the derivation is a convenience for the apex case.
Any deployment where the website is on a subdomain must set it.

## Environment

| Variable                | Effect                                                                     |
| ----------------------- | -------------------------------------------------------------------------- |
| `SESSION_COOKIE_DOMAIN` | Used verbatim when set. `.example.com` for a website on `app.example.com`. |
| `NEXT_PUBLIC_HOST_URL`  | Fallback. Yields `.<host>`; `undefined` for `localhost` and `127.0.0.1`.   |

`env` is passed in rather than read from `process.env` inside, because `packages/db` loads the
repo-root `.env` through dotenv when it is first imported — which happens _after_ several modules
that want this value are evaluated. A parameter makes the read happen at call time, where the
variables exist.
