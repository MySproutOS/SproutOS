---
slug: oauth-applications
title: Build a SproutOS OAuth application
summary: Authorization Code with PKCE, optional database access, tokens, and revocation.
audience: developer
category: Application integrations
order: 40
---

## Register and redirect

Register an OAuth client in SproutOS and add exact HTTPS redirect URIs. Public clients must use Authorization Code with PKCE (`S256`) and must never ship a client secret.

Send users to the authorization endpoint with `client_id`, `redirect_uri`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`, `state`, and the scopes you need. Validate `state` before exchanging the returned code.

## Ask only for needed access

Database creation uses `database:create` and spends the user's SproutOS credit. When the authorization request includes `intent=create_personal_database`, consent explains the expected billing. The user may omit that optional permission and still sign in to your application. Pressing Cancel stops authorization.

A grant may include database creation even when the account has no credit. The creation request itself returns HTTP 402 until credit is available.

## Tokens and credentials

Exchange the code with its original `code_verifier`. Send access tokens as `Authorization: Bearer …`. Refresh tokens are rotated; replace the stored refresh token after every successful refresh.

Database credentials belong to the OAuth grant that created them. Rotating an application credential does not rotate the user's credential or another application's credential. Connection URIs are returned once and cannot be revealed later.

## Revocation

Users can revoke your grant from settings. Revocation stops new API calls and revokes credentials owned by that grant. Resources the user chooses to keep remain theirs.
