# Multi-user web acceptance, 2026-09-19

## Result

Implemented locally. Root reviewed the scope and authorized commit, push and
Preview publication after the legacy-recovery regression was fixed. **No live
acceptance is claimed.** No live sign-in, cloud configuration change, paid
provider call or real database migration was performed. Tests used synthetic
data, ephemeral PGlite databases and mocked provider/Blob transport.

## Acceptance matrix

| Requirement | Evidence |
| --- | --- |
| Google and other valid tenant subjects accepted; original database subject retained | Real installed Auth0 SDK callback tests with locally signed ID tokens and encrypted transactions. Original owner, Google and another database user get sessions. |
| Issuer/session/security checks retained | SDK tests reject wrong issuer, audience, expiry, nonce and invalid state/cookies. Missing or malformed subjects and anonymous access are denied. CSRF and resource-identity tests pass. No identity linking. |
| Pages and document reads/writes use session owner | Two-user API tests, including forged body `owner`; real local production pages show only each account's history. Foreign deep links show an error and no foreign text. |
| Voices/defaults/uploads isolated | New account reads are empty and do not create a tenant. Each account registers its own Replicate reference with the same idempotency key independently. Foreign uploads, preferences and voice IDs are rejected before Blob/provider calls. |
| No inherited private/default voice | Only the original subject retains its existing default and Fish ID linking. Another user's default is null until an owned voice is selected/uploaded. |
| Audio and downloads isolated; original data retained | Bidirectional denial for current, full-version and short-version audio. Foreign Blob paths fail before reading Blob. Original legacy audio still resolves. Browser tests download the new user's WAV and deny the same audio to another user. |
| Jobs, status, SSE, retry and regeneration isolated | Bidirectional route tests deny foreign jobs, segments, voices and single/all regeneration. Database snapshots remain identical; no deferred dispatch, Blob reads/writes or provider calls occur. |
| Cache and idempotency isolation | Same text/provider cache keys and request keys under two owners create separate jobs, objects and provider work. Regeneration browser recovery uses an owner-namespaced v2 local-storage key. The original owner can migrate a v1 record only after ownership verification; v2 wins, the original key is retained while uncertain, and instrumented other-user/foreign-document runs touch no v1 key. |
| Multi-owner recovery, bounded/fair processing | Twelve-owner recovery test, including ten older jobs for one unavailable provider. At most ten checks per invocation, first turns before second turns, correct owner/job arguments and advancing leases. Concurrent recovery deduplication still passes. |
| Workflow authorization unchanged | No Workflow routing/configuration or cron credential changes. Invalid owner/job pairs do nothing before locks or writes. Browser production harness completes actual local workflows for both subject types. Hosted signature/delivery validation remains a deployment gate. |
| 1,000 attempts per user per LA day | Quota SQL and constant unchanged. Concurrent final-slot tests independently cap two users at 1,000. Reset permits one user's new attempt while another remains capped. Existing failure, uncertainty, cache, queue-reservation, DST and midnight-lock tests pass. |
| MCP owner-only scope unchanged | Signed non-owner OAuth token rejected; original owner/client/scopes remain required. MCP route tests pass. Browser cookies remain unauthorized for MCP. No MCP implementation or metadata edits. |
| Relevant web copy and setup documentation | Generic personal-reader wording, empty voice guidance, per-user quota wording and private upload copy. `MULTI_USER_WEB.md` documents social enablement, unchanged database login, custom Google OAuth client requirements and pending operator checks. |

## Commands and results

Run from the repository root:

| Command | Result | Local evidence |
| --- | --- | --- |
| `npm test` | **213 passed**, 24 files | `.evidence/multi-user/unit.log` |
| `npm run lint` | Passed | `.evidence/multi-user/lint.log` |
| `npx tsc --noEmit --incremental false` | Passed | `.evidence/multi-user/types.log` |
| `npm run build` | Passed, Next 16.3.4; 5 steps / 1 workflow | `.evidence/multi-user/build.log` |
| `npm run test:browser` | **15 passed**, local production server | `.evidence/multi-user/browser.log` |
| `npx playwright test --config playwright.reader.config.ts` | **33 passed**, isolated UI server | `.evidence/multi-user/browser-ui.log` |
| Focused legacy/v2 recovery browser run after Root's regression feedback | **10 passed**, both viewports | `.evidence/reader-start/results/` |
| Focused tenant/documents route run after Root's regression feedback | **19 passed** | Local terminal output |
| `npm run lint` and `npx tsc --noEmit --incremental false` | Passed after the regression fix | Local terminal output |
| Final `npm run build` | Passed, Next 16.3.4; 5 steps / 1 workflow | Local terminal output |
| `git diff --check` | Passed | Working-tree diff |

Earlier runs caught stale owner-only expectations, a missing synthetic MCP
configuration field, recovery-count expectations, one test response typing
issue, and a browser assertion expecting API rather than UI error copy.
All were corrected and rerun. No unresolved local check failures remain.

## Screenshot review

Reviewed Chrome screenshots at **1440×1000** and **390×844**. They cover the empty
reader, expanded upload dialog, consent error, saving state, ready private
reading/download controls, denied foreign deep link and the recovered uncertain
request state. Copy wraps inside the controls and dialogs. Existing
reader/regeneration/login screenshots also pass.

New screenshots: `.evidence/browser/{1440,390}-multi-user-*.png`.
Legacy recovery screenshots: `.evidence/reader-start/results/*/legacy-recovery-{1440,390}.png`.
Login and reader-state screenshots: `.evidence/reader-start/results/`.
These are synthetic local screenshots, not live Google login evidence.

## Diff guide

- Auth/session and fixed failure copy: `src/lib/auth.ts`, `web-login.ts`.
- Required owner arguments and safe workflow claims: `store.ts`, `jobs.ts`,
  `dispatch.ts`, `src/workflows/steps.ts`.
- Owned voices/uploads/audio: `web-voices.ts`, `reference-voices.ts`,
  `replicate-reference.ts`, voices and audio routes.
- Reader copy, local reference conversion and owner-namespaced client recovery:
  `src/components/`.
- New two-user and PCM tests; updated existing tests now pass explicit owners.
  No dependencies, schema files, Vercel configuration or MCP implementation changed.

Full review patch, including new files:
`.evidence/multi-user/implementation.patch`.
Evidence stays local and ignored.

## Remaining gates and limitations

1. Verify the existing Google connection is enabled for the correct Auth0 web
   application and no tenant Action blocks non-owner users. Keep database login.
2. Production needs a dedicated Google OAuth client, proper consent/publishing
   setup and the Auth0 connection's exact Google callback. No configuration
   success is claimed.
3. Verify intended users can reach Preview under its current deployment
   protection. Do not relax protection as part of this task.
4. After authorized publication, verify live Google/database login, private Blob
   transport, hosted Workflow authorization/delivery and multi-instance Neon
   locking. PGlite tests cannot establish hosted concurrency or configuration.
5. Provider credentials, reference quality, live synthesis and voice similarity
   remain untested here. No microphone permission or real recording was used;
   the synthetic upload path was exercised.

The unchanged daily cron can take multiple days to drain a large missed-dispatch
backlog. Per-user quotas are not a global cost cap. No new billing or aggregate
budget system was introduced.
