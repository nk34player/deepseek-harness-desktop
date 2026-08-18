# Agent Note: pi-ai forwards the developer-role compat switch

Status: implemented

English | [中文](2026-08-18-pi-ai-forward-supports-developer-role.zh.md)

## Problem

`dsh-llm-pi-ai`'s `compat` profile accepted and forwarded `thinkingFormat` and
`supportsReasoningEffort`, but `supportsDeveloperRole` — a valid pi-ai
`OpenAICompletionsCompat` field telling whether the endpoint accepts OpenAI's
`developer` role (vs the universal `system`) — was dropped. A provider that
rejects `developer` (HTTP 400) received every request with
`role: "developer"` and no way to correct it; a `settings.yaml`
`compat.supportsDeveloperRole: false` was silently discarded.

## Decision

Add `supportsDeveloperRole` to the compat profile: the schema (`config.ts`),
the `PiAiCompatProfile` type, the `resolveModelCompat` forwarding (route
default, per-model wins, installed catalog compat preserved by spread), and
the "only on `openai-completions`" model/route guards. pi-ai then picks
`system` for a provider declaring `false`, so the request carries
`role: "system"`.

## Consequences

- `compat.supportsDeveloperRole` is configurable per route and per model and
  resolves through the same model → route → catalog → URL-detection chain as
  the reasoning switches.
- Regenerated `docs/config-catalog.md` (the generator cross-checks the runtime
  schema against the declared config type, so the added field is validated).

## Verification

`resolveProfiles` forwards the switch (new catalog.spec case); llm-pi-ai
typecheck plus the catalog/config/adapter suites are green (104 tests).
