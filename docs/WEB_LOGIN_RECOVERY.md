# Web login diagnosis and recovery

## Evidence and limits

The reported new-device `LOGIN_FAILED` does not establish a root cause.
The old route caught every thrown error and returned the same owner/configuration
message. Implementation validation was local. Preview deployment verification
is recorded separately below; it does not establish the new-device cause.

Local inspection used Auth0 Next.js SDK **4.29.0** and Next.js **16.3.4** guides:

- SDK `dist/server/auth-client.js`: `handleCallback`, `handleCallbackError`,
  `handleLogin`, `startInteractiveLogin`.
- SDK `dist/errors/oauth-errors.js`, `dist/server/transaction-store.js`,
  `dist/server/cookies.js`.
- Next `dist/docs/01-app/01-getting-started/15-route-handlers.md`,
  `01-app/02-guides/authentication.md`, and
  `01-app/03-api-reference/04-functions/redirect.md`.

SDK state/token failures reach `onCallback`. On successful token processing,
the SDK calls `onCallback` **before** `beforeSessionSaved` and session storage.
The multi-user web implementation now accepts every valid tenant subject.
`beforeSessionSaved` rejects missing or malformed subjects, not other users.
Returning a denial page from a successful `onCallback` alone would not prevent
the SDK from storing that session. MCP keeps its separate exact-owner guard.
See [multi-user web access](MULTI_USER_WEB.md) for enablement and publication gates.

## Failure categories

The web handler displays only fixed application copy. It adds no logging.
It never renders error objects, messages, causes, URLs, authorization codes,
cookies, tokens, subjects, email addresses or other user data.

| Evidence | Page / status |
| --- | --- |
| Dedicated exception for an invalid web subject | Invalid session, 401 |
| SDK `missing_state` or `invalid_state` | Transaction verification incomplete, 400 |
| SDK `authorization_code_grant_request_error`, `authorization_code_grant_error`, `session_expired` | Credential exchange/validation incomplete, 400 |
| SDK `authorization_error` | Authorization incomplete, 400 |
| SDK `discovery_error` or `invalid_configuration` | Login service unavailable, 503 |
| Anything else | Cause unknown, 500 |

Only allowlisted top-level SDK codes are classified. Nested provider
`access_denied` is **not** proof of an app permission failure. Missing configuration
or an unrelated `FORBIDDEN` exception is not proof either.

The SDK maps absent, expired, malformed or undecryptable transaction cookies
to an invalid transaction. That category cannot identify which of those
conditions occurred, nor prove a device/browser setting caused it.

## Manual recovery

- Every failure page offers **重新开始登录** at `/auth/login`.
- Invalid-session recovery also offers **使用其他账号登录** at
  `/auth/login?prompt=login`. The SDK forwards the supported OIDC `prompt=login`
  parameter. The user must explicitly click it; no automatic loop is added.
  This requests reauthentication, not account linking or a
  guarantee about a federated provider's account-picker UI.
- Recovery starts at home. It does not reuse callback parameters.
- Login and successful callback destinations allow only `/` or a bounded
  `/sessions/<id>` path. External URLs, auth/API routes, encoded paths,
  queries and fragments fall back to `/`.
- Web login forwards only this destination and optional `prompt=login`.
  Other OIDC query parameters, including popup mode, are not forwarded.
- Failure HTML is `no-store` and script-free. Its `no-referrer` meta tag and
  `rel="noreferrer"` recovery links prevent callback referrers even when the
  existing global Next header overrides the route header with `same-origin`
  (observed in the isolated production smoke check). No global config changed.
  Links use full navigation without prefetch. Cookie/session handling remains
  in the SDK. Cross-site logout rejection and logout cache clearing remain.

If transaction recovery keeps failing, check that login starts and finishes
in the same browser on the configured app origin with site cookies allowed.
Do not share callback URLs or request/cookie dumps. A maintainer should verify
origin/callback configuration and the relevant environment privately.
Do not change MCP restrictions, clients or secrets based on this category.
No environment variable names or project build settings changed in this fix.

## Reader regeneration copy

Background jobs show the provider and ready/total counts when available.
Queued/running jobs and queued/working items are not called uncertain.
Only uncertain items get the possible-billing warning. Mixed jobs describe
background work and uncertain items separately.

Pending POST, unconfirmed submission recovery and playback preparation have
separate copy. Existing save/settings/billing/idempotency guards are unchanged.
The Replicate limit remains **1,000 provider attempts per user per Los Angeles
calendar day**, resetting at midnight in `America/Los_Angeles`.

## Local checks

```sh
npm test
npm run lint
npm run build
npx playwright test --config playwright.reader.config.ts
```

Unit tests cover the allowlist, sanitized errors, redirect boundaries and
reader guards. SDK tests use synthetic encrypted transactions, locally signed
ID tokens and mocked provider responses to verify tenant-user acceptance,
invalid-subject rejection, state/cookie failures, token failures and `prompt=login`.
These are not live OAuth acceptance tests.

Browser tests render the production failure HTML with synthetic errors.
They mock reader APIs and use synthetic audio. Screenshots cover 1440px and
390px widths, queued/running/uncertain/done states, pending POST/recovery,
playback preparation and login recovery pages.
Evidence is under `.evidence/reader-start/results/`.

### Local validation evidence, 2026-09-14

- Full suite: 172 tests passed, including MCP separation, owner guards,
  regeneration safety and the 1,000-attempt Los Angeles daily quota.
- Final focused rerun: 54 tests passed. Lint passed.
- Fresh credential-free source snapshot: `npm run build` passed with the
  unchanged Next config and default Turbopack build.
- Browser suite: 33 tests passed. The eight login-page cases also passed
  against the production `same-origin` header behavior. Those screenshots
  are in `.evidence/reader-start/production-header-results/`.
- Screenshots reviewed at 1440×1000 and 390×844. Copy wraps within the reader
  controls and login recovery cards. Relevant default and changed states
  are covered.
- Isolated production server: missing state, absent cookie and malformed
  cookie returned safe 400 HTML without automatic redirects. Cross-site
  logout returned 403; anonymous MCP returned 401. A fresh browser verified
  that manual recovery sent no callback referrer. The login destination was
  intercepted before OAuth.

Early checks caught a test-only response typing error and a temporary
dependency symlink rejected by Turbopack. Both were corrected and rerun.
The production smoke check also exposed the existing global referrer-header
precedence. Meta/link protection passed browser verification without changing
global config.

That local validation did not perform live OAuth login, cloud writes, paid
synthesis, real-data migrations, commit, push or deployment.

### Browser fixture discovery

`playwright.config.ts` excludes both `reader-start.spec.ts` and
`login-failure.spec.ts`. Both belong to `playwright.reader.config.ts`.
Use `playwright test --list --reporter=list` with each config to check discovery
without starting either fixture or rerunning tests.
Acceptance check: the main config discovers 13 tests in two files; the reader
config discovers 33 tests in two files, with no overlap. Both config files
pass lint. No test suites were rerun for this exclusion-only correction.

## Preview deployment verification

The subsequent release is authorized only for `feat/audio-regeneration`,
Vercel Preview and the stable alias
`personal-voice-reader-preview-dingkangs-projects.vercel.app`.
Production, merge, paid synthesis and database mutations are excluded.

Deployment checks are separate from the local tests above: READY state and
alias binding, stable health 200, unchanged OAuth resource metadata, anonymous
MCP 401, safe missing-state callback HTML 400, and a fresh login redirect with
`prompt=login` and the stable callback. Redirect destinations are inspected only
in memory; OAuth redirects are not followed and query/state/cookie values are
not printed or saved.

### Verified Preview release, 2026-09-14

- Source commit: `b575013259fbbd738cc8286d36a1e4f52e9e3615`, pushed to
  `feat/audio-regeneration`.
- Deployment: `dpl_59xdWJQfbDzWtN8DSFYbPbYLyWoN`, **READY**, created explicitly
  with the Preview target using the existing authenticated Vercel CLI.
- Deployment URL:
  https://personal-voice-reader-1nvvkcjw5-dingkangs-projects.vercel.app
- Stable alias:
  https://personal-voice-reader-preview-dingkangs-projects.vercel.app
- The alias API confirms the stable alias points to that deployment.
  The deployment metadata matches the source commit.
- Deployment input was an exact committed source snapshot. No local environment
  files, credentials, data or uncommitted files were uploaded.

| Stable Preview check | Observed result |
| --- | --- |
| `/api/health` | 200, expected service health |
| Both OAuth protected-resource metadata paths | 200, resource, issuer and scopes unchanged from the predeployment baseline |
| Anonymous `/api/mcp` | 401 with resource metadata challenge |
| Missing-state `/auth/callback` | 400 HTML, fixed transaction-recovery copy, `no-store`, no automatic redirect |
| Fresh login with explicit reauthentication | 307 to the expected authorization endpoint; prompt, stable callback, fresh transaction and PKCE checks passed |

The unchanged OAuth resource is the stable Preview origin plus `/api/mcp`.
The fresh login destination was inspected only in memory and never followed.
No redirect query, state, cookie or secret values were printed or saved.

The production target remained `dpl_J5FCczYKRiBADSCrWYMYYeotW6KY`.
No production deployment, merge, real OAuth completion, paid synthesis,
database mutation or environment change was performed.
The new-device root cause remains unverified.

The CLI initially rejected `--skip-domain`, which is production-only.
That attempt created no deployment. The successful command retained the
Preview target without that flag. No production flag was used.
This deployment record is a documentation-only follow-up to the deployed
source commit, not a claim that the documentation update was redeployed.
