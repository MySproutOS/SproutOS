---
slug: agent-model-providers
title: Configure an AI model provider
summary: Add an organization model credential, understand which coding harness runs, and rotate or revoke it safely.
audience: user
category: Hosted Agent
order: 30
---

The hosted Agent needs either your organization's model access or SproutOS-funded model credit.
Open **Settings → Agent** to manage credentials.

## Choose a credential kind

SproutOS accepts:

- a Claude subscription token;
- an Anthropic API key;
- an OpenAI API key;
- an OpenRouter API key.

Claude subscription and Anthropic credentials run through Claude Code. OpenAI and OpenRouter
credentials run through Codex. The secret is sealed before storage, is isolated to the organization,
and is never shown again. The dashboard keeps only the label, kind, status, and last four
characters needed to identify it.

Adding the first credential selects it when the organization has no Agent configuration. Adding
more credentials does not silently move existing work to a new provider.

## Name and protect credentials

Use labels that identify owner and purpose, such as `Engineering OpenAI` rather than `Key 1`.
Create a dedicated provider credential with an appropriate spend limit. Do not paste the secret
into a project environment variable or repository—the Agent proxy supplies model access without
revealing the raw provider key to the sandbox.

The dashboard can rename a label or revoke a credential. It cannot reveal or replace the stored
secret. To rotate, add the replacement, select it for Agent use, verify a turn, and then revoke the
old credential.

Revoking the selected credential stops new Agent work. SproutOS does not silently fall back to a
platform-funded model and begin charging the organization merely because a credential was revoked.

## Advanced configuration

The authenticated organization Agent configuration API can select `agentCredentialId`, opt into
`useSproutosCredits`, set a model, set a maximum budget in micro-US dollars, and choose the harness
permission mode. These controls are not all exposed in the current dashboard. Use `sprout api get`
to inspect the live configuration before changing it, and change only fields you understand.

Provider billing and SproutOS resource billing are distinct. A bring-your-own provider bills model
tokens to that provider; sandbox duration, databases, storage, and deployments remain SproutOS
resources. See [Understand billing](/docs/billing).
