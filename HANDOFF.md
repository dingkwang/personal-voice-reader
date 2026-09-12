# Implementation and cloud handoff, 2026-09-07

## IndexTTS-2.5 web preview — 2026-09-12

The web reader now supports IndexTTS-2.5 through an on-demand Modal L4.
New Index voices use one private 10–60 second reference recording and become
the per-owner web default. Existing Fish voices and saved sessions still work.
`DEFAULT_VOICE_ID` and ChatGPT MCP behavior stay on Fish.

Schema 002 is applied to the isolated Preview database. It stores immutable
job synthesis settings, web preferences, polling leases, and transient Modal
requests. No personal data was imported. Modal is not deployed yet because the
CLI has no authenticated profile. The local `.env` contains only Fish and
Replicate credentials.

Local acceptance passed: 74 Vitest tests, 7 service tests, lint, production
build, and 8 Playwright scenarios. The browser suite covers desktop and mobile
Index generation, refresh recovery, playback, web defaults, and Fish history.
All provider calls in automated tests are mocked.

The Modal service pins the source and model revisions. It uses one L4, zero warm
containers, one concurrent inference, and six lifetime preview requests. This
keeps the first live test bounded. The total live test budget remains $5.

## Current Preview activation — 2026-09-08 UTC

Following the user's missing-Fish-key report while trying to read, Preview now
has the existing local Fish key stored as a Vercel sensitive Secret. The owner’s
existing Dingkang voice (app ID `voice_484c6ca5-8b49-4234-995d-df521cfa61e3`)
was linked into the isolated Preview DB and set as DEFAULT_VOICE_ID. Exact
owner and deployment_identity guards passed. No recordings, article history,
or cached audio were imported; no cloning or synthesis was performed.

Current READY deployment: `dpl_DaDXCg3TnCX2fdHeBuEpXkLDGs83`,
https://personal-voice-reader-1e214igmh-dingkangs-projects.vercel.app . The stable
preview alias now points here. This supersedes the historical no-Fish preview
policy below; generation is now enabled and can consume Fish allowance.
Production/development resources were not changed.

The refreshed `.env.cloud.preview.local` is mode 0600 and contains a Vercel
`[SENSITIVE]` placeholder for FISH_API_KEY, not a usable local credential.
Do not push this placeholder back into Vercel or use it for local synthesis.
`deploy:check` only checks presence; it does not authenticate the provider.
End-to-end user playback and ChatGPT OAuth still require verification.

## Latest correction — 2026-09-08 UTC

The owner completed an interactive login but saw the generic configuration
fallback. The global resource/auth guard incorrectly required a Fish key,
although Preview deliberately has none. This is now fixed: global validation
still checks owner/auth/environment/resource identity; Fish credentials are
checked at TTS, MCP creation, retry, recovery and provider boundaries.

Verification: 65 tests across 12 files passed, including owner document access
without Fish using real config validation, wrong-user/resource denial, and
generation/retry/recovery refusing work before queue mutation. Lint and build
passed. `npm run deploy:check -- --env-file .env.cloud.preview.local` now isolates
the snapshot from local `.env` and reports `ready: true, fishConfigured: false`.
The previous check inherited the local Fish credential and was misleading.

Preview `dpl_AEvRgFhp5Qu3bHEaug9FqG3GZ3iM` is READY and the stable alias points
to it. Actual owner browser verification after this fix is still outstanding;
the user's Chrome was not running during deployment. Production and personal
content remain unchanged.

Post-deployment probe passed: Vercel protection stays active; using a temporary
operator bypass, private APIs/MCP reject anonymous access with 401, health is
200, login redirects to Auth0 with 307, unsigned Workflow routes return 404,
and authorized recovery returns 503 `PROVIDER_NOT_CONFIGURED`. The temporary
bypass was revoked and the original deployment protection confirmed unchanged.

Droid failure diagnosis: CLI 0.213.0 logs show `overage_proactive` switching
GPT-6 Astra and Gemini Flash to `kimi-k3`, followed by HTTP 402 (weekly Droid
Core allowance exhausted, reset reported in four days). Omitting the model
also failed. This is a quota blocker, not a Vitest assertion crash. Stop retries
until the account allowance changes; no credits were purchased. A prior launch
also accidentally used terminal process ID `12080` as a Droid session ID. The
original Droid session is `97ac0c29-9082-4205-8f73-900b80a74c43`; only use actual
Droid `session_id` values for continuation. User explicitly authorized the
primary assistant to finish the repair directly.

## Outcome

Implemented the approved stack and passed local acceptance. **Vercel provisioning
is complete, Auth0 is installed for all three environments, and Preview is now
fully configured: real tenant/client, stable-alias callback registered, exact
`AUTH0_OWNER_SUB` and `AUTH0_MCP_CLIENT_ID` set, custom RS256 API with three
scopes created by the owner, and the guarded migration initialized the real
owner in the empty preview database. Remaining: Dingkang's first interactive
preview login, ChatGPT callback registration and scoped-token test, then the
production equivalents. Production acceptance and personal-data migration stay
gated on real owner auth.**
Vercel CLI 59.11.7 is authenticated as `dingkwang`; the only team is
`dingkangs-projects` (`team_IgBeVss78AY6w5IHVn9CMe89`), on active Hobby.
No upgrade, paid commitment, commit, push, agent delegation, real Fish synthesis,
or voice recloning occurred.

Project: https://vercel.com/dingkangs-projects/personal-voice-reader
(`prj_9FHg5FbFvM92jltVCxv891Kxj6fF`), linked locally by the CLI.

Protected preview:
https://personal-voice-reader-preview-dingkangs-projects.vercel.app

Ready preview deployment: `dpl_AEvRgFhp5Qu3bHEaug9FqG3GZ3iM`,
https://personal-voice-reader-40mcqi97e-dingkangs-projects.vercel.app
(supersedes `dpl_7B8UCS6PL7MpnQPUMpXubUD8cjQA`; fixes the no-Fish login gate)

This is a **fail-closed preview with complete Auth0 configuration**, pending
Dingkang's first interactive owner login to prove the full session path.
The production hostname `personal-voice-reader.vercel.app` is reserved, but no
working production release or production MCP connection is verified.

Existing uncommitted PoC work was incorporated rather than reset. This worker
did not modify `.data` or the original backup. A later preservation check found
additional local data predating cloud provisioning; a separate current backup
was created, as detailed below. The server on port 3000 was not stopped.
Browser fixtures owned port 3108 and shut down afterward.

## Provisioned resources

All six resources belong only to this project, in `iad1`/AWS us-east-1.
Each connection and environment variable targets exactly one environment.
Neon uses Marketplace `free_v3`; Blob access was explicitly verified **Private**.

| Environment | Neon Marketplace resource | Neon project | Private Blob store |
| --- | --- | --- | --- |
| Development | `store_IpD8dATNSPA0kPZX` | `polished-bar-42662880` | `store_Hvs12vCw1KKj8c7T` |
| Preview | `store_PaJqBSY8Ju1lM0mv` | `gentle-fog-99023464` | `store_H7O7TYALqsj2YwFw` |
| Production | `store_xb87vyPNN8pKkwSt` | `muddy-dew-38102961` | `store_Hx682WfGBnWj2xGh` |

Auth0 (free Marketplace plan, installation `icfg_JorZT9IXausUoNnolW8S5HvD`,
terms accepted by the owner in the browser on 2026-09-07):

| Environment | Auth0 resource | Tenant domain | Registered callback (verified) |
| --- | --- | --- | --- |
| Development | `ir_As93FIjFC7isvRqs` | `icfg-jorzt9ixausuonnolw8s5hvd-development.us.auth0.com` | `http://localhost:3000/auth/callback` |
| Preview | `ir_Re7SeIm1StvVUzVl` | `icfg-jorzt9ixausuonnolw8s5hvd-staging.us.auth0.com` | stable alias + deployment URL (verified 302) |
| Production | `ir_cAtINmRdghaAxQj8` | `icfg-jorzt9ixausuonnolw8s5hvd.us.auth0.com` | `https://personal-voice-reader.vercel.app/auth/callback` |

Preview tenant additions made by the owner in the Auth0 Dashboard (2026-09-07),
verified by public authorize probing and the deployed login chain: stable-alias
callback/logout/web-origin on the `voice-note-preview` app (client
`mfl2SMbQeYEDyTgAwVK7CooLIv3HdM8a`); ChatGPT Regular Web App client
`3EeI3RgkslActTjSWGaUZ9SbGPSIhZ5X` (ChatGPT callback URL not yet registered —
must come from ChatGPT's connection setup); custom RS256 API
`voice-note-api-preview` with identifier exactly equal to the preview
`AUTH0_AUDIENCE`, scopes `read:voices`/`create:readings`/`read:readings`, RBAC
and Add Permissions in Access Token enabled; owner user
`auth0|6a9f50b05b8fa1c8cdb4cbb1` with all three permissions directly assigned.
Preview Vercel env now sets `AUTH0_OWNER_SUB` and `AUTH0_MCP_CLIENT_ID` to
these exact values; production remains without them (verified).

A fourth resource, `client-aquamarine-helmet` (`ir_LbzwFHuVIGlEE7ik`), was
created by the owner's browser flow and syncs the inert `PERSONAL_AUDIO_AUTH0_*`
variables (same tenants, unused client). It was left untouched.

Real `AUTH0_DOMAIN`/`AUTH0_CLIENT_ID`/`AUTH0_CLIENT_SECRET`/`AUTH0_SECRET` are
synced per environment; `AUTH0_AUDIENCE` is set to each environment's documented
`/api/mcp` identifier. Neither provisioned client is authorized for the Auth0
Management API (verified via client-credentials denial), so tenant
administration needs the Auth0 Dashboard (access now works for the owner via
Vercel SSO). **Preview is fully configured including `AUTH0_OWNER_SUB` and
`AUTH0_MCP_CLIENT_ID`; those two fields remain unset only in development and
production.**

Resource dashboard links and exact next commands are in `docs/CLOUD_RUNBOOK.md`.
Schema 001 and the matching `deployment_identity` marker were initialized in
each newly created empty database, then checked again over verified TLS.
**No owner was fabricated or initialized.** All owner/content/job tables and
all Blob stores are empty after synthetic acceptance fixture cleanup.

Configured single-target environment entries, including integration variables,
resource identity guards, stable origins, integration-issued `AUTH0_SECRET`
values and distinct `CRON_SECRET`, model and default voice IDs. Existing Fish
credential is encrypted in **Production only**, absent from development,
preview and the ready deployment.

Restricted ignored `.env.cloud.{development,preview,production}.local` files
contain separate snapshots. The CLI-created default `.env.local` was removed
to avoid automatically switching the existing local server to cloud resources.
Original `.env` and `.data` were not modified. Marketplace-installed local skill
files were removed; no global settings were changed.

### First-deployment CLI caveat

The first `vercel deploy --target preview` was automatically classified by
Vercel as production (`dpl_J5FCczYKRiBADSCrWYMYYeotW6KY`). It was immediately
canceled and its final state is **CANCELED**, not READY. No production acceptance
or migration followed. The subsequent deployment was explicitly verified as
**Preview / READY**. `--skip-domain` cannot be used with Preview. Do not mistake
the canceled initial record for a successful production deployment.

## Delivered architecture

- `migrations/001_cloud.sql`, `src/lib/db.ts`, `store.ts`: PostgreSQL persistence
  for voices, documents, segments, cache, historical versions, jobs, request
  aliases, generation claims and uploads. No filesystem runtime fallback.
- `jobs.ts`, `dispatch.ts`, `src/workflows/*`: atomic session/task creation,
  durable idempotency, two persistent owner-wide claim slots, cache reuse,
  progressive readiness, outbox recovery and explicit failed-segment retry.
  Uncertain provider calls are not automatically repeated.
- `blob.ts`, `/api/audio/[segment]`: immutable byte-hash private objects,
  authenticated streaming, valid Range 206 and invalid Range 416, historical
  version URLs, private `no-store` responses.
- `auth.ts`, `/auth/[...path]`, resource discovery: Auth0 encrypted web sessions,
  exact owner subject, separate RS256 MCP JWT verification, issuer/audience/
  expiry/client/scopes, cookie-mutation origin checks and logout cache clearing.
- `/api/mcp`: current MCP SDK Streamable HTTP, stateless JSON transport,
  `list_voices`, `create_reading`, `get_reading_status`, accurate read/write
  annotations and stable absolute session links.
- `/api/uploads`, `uploads.ts`, voice modal: bounded direct private Blob
  upload reservations/tokens, owner/prefix/type/size checks, server-side cloning,
  idempotent clone requests and no arbitrary URL fetching.
- `/sessions/[id]`, `use-reader.ts`, reader UI: deep links, task-based TTS,
  reconnectable SSE, private ready-audio prefetch, retained TXT/history/
  snapshots/playback/seek/unsaved guards and stale-completion isolation.
- `public/sw.js`: static assets only; old private caches deleted on activation.
- `scripts/backup.mjs`, `migrate.ts`, `import-legacy.ts`, `deploy-check.ts`:
  restricted backups, target-aware schema migration, repeatable ID/checksum
  preserving import, and configuration readiness diagnostics.
- `.env.example`, `.vercelignore`, `docs/CLOUD_RUNBOOK.md`: separate environments,
  secret-safe deployment preparation, Auth0/ChatGPT registration, migration,
  rollback and live acceptance instructions.

## Verification

Final gate run completed successfully:

| Check | Result |
| --- | --- |
| `npm test` | **59 passed**, 11 files |
| `npm run lint` | Passed, no warnings |
| `npm run build` | Passed, Next.js 16.3.4 + Workflow compilation |
| `npm run test:browser` | **6 passed**, headless Chrome |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `git diff --check` | Passed |
| `npm run deploy:check` | Earlier local run correctly failed for missing configuration; Auth0 still incomplete |

Additional real-service checks completed 2026-09-07:

- Vercel remote Next.js/TypeScript/Workflow build passed on Node 24, Hobby.
  Workflow compilation reported five steps and one workflow.
- Deployment dry-run verified 72 uploaded files, excluding personal data,
  backups, environment files, evidence, test fixtures and generated Workflow/
  SWC/TypeScript artifacts. `.vercelignore` was tightened for those artifacts.
- Real Neon: eight simultaneous identical calls produced one job; changed
  payload rejected; three competing jobs held exactly two persistent claims;
  committed completion released a slot and restored ready status.
- Real private Blob: anonymous GET **403**, full download checksum,
  closed/suffix/open Range **206**, invalid Range **416**, `private, no-store`.
  A **6 MiB multipart** synthetic upload/download matched SHA-256.
- Synthetic rows and Blob objects were deleted by exact run ownership.
  All three databases and stores were rechecked empty.
- Public preview requests redirect **302** to Vercel login. With a temporary
  operator-only Vercel bypass, health returned **200**, MCP GET/POST **401**
  with OAuth challenge, and private data/generation APIs fail closed with
  no-store headers. Temporary bypasses were revoked; original deployment
  protection is unchanged.
- After Auth0 provisioning (2026-09-07, deployment `dpl_FzWshNQyC3ndiLVoVLrUFwK4Fmm5`):
  `/auth/login` returns **307 to the real Auth0 tenant authorize endpoint** with
  the correct `redirect_uri` and `openid profile` scope; private data/generation
  APIs now return **401** (real session check active, no anonymous access); MCP
  keeps its **401 OAuth challenge**; protected-resource metadata returns **200**
  with the correct resource URL, tenant authorization server and all three
  scopes; tenant JWKS publishes **RS256** keys.
- After owner configuration (2026-09-07, deployment `dpl_7B8UCS6PL7MpnQPUMpXubUD8cjQA`):
  guarded `db:migrate` initialized the exact owner `auth0|6a9f50b05b8fa1c8cdb4cbb1`
  in the preview database (identity row `preview`/`personal-voice-reader`;
  documents/voices/jobs/audio_cache all still **0**; no personal import).
  Stable-alias callback now **registered** (public authorize 302, no mismatch);
  localhost callback correctly **rejected** on the staging tenant. Deployed
  `/auth/login` redirects to the staging tenant with the stable-alias
  `redirect_uri` and the provisioned client ID; the full alias login chain
  reaches Auth0 without callback mismatch. MCP anonymous POST returns **401**
  with `WWW-Authenticate: Bearer resource_metadata=...` pointing at the correct
  metadata URL; both discovery endpoints return the exact audience, tenant
  issuer and three scopes. `/api/jobs/recover` still returns **503
  CONFIGURATION_REQUIRED** in preview by design (no Fish credential in preview)
  and its cron-secret check was not exercised. Temporary operator bypasses were
  created and revoked for each probe; deployment SSO protection unchanged.
- Unsigned Workflow flow/step requests returned **404** on the deployed preview.
  This is not proof of valid queue delivery or signature handling.
- `tsc --noEmit` and `git diff --check` passed. The full 59-test/6-browser suite
  was not repeated because application code did not change.

Resolved verification issues: API batch environment writes returned 400, so
settings were added via secret-safe CLI stdin. The multipart probe initially
passed unsupported `Uint8Array` to the SDK; switching the probe to `Blob` passed.
Early operator checks hit propagation/alias authorization failures; the canonical
deployment passed after a ten-second delay. These did not require app code changes.

Local real-service probe scripts are ignored under `.evidence/cloud/`.

Backend coverage includes concurrency slots, idempotency conflicts and aliases,
outbox recovery, cache reuse, crash/uncertain handling, lost commit acknowledgment,
old-settings isolation, auth scopes/owner/CSRF/JWT claims, Blob streaming/Range,
upload ownership/limits, and repeat import preserving IDs/reference/hash.

Browser coverage at **1440×1000** and **390×844**:

- Unauthenticated API denial and deep-link login return intent.
- Auth0 SDK authorize redirect/PKCE and test-encrypted session cookies.
- Saved history, original text, TXT import and new snapshots.
- First segment playing while later segments are still generating.
- Generation completing after the browser disconnects; restored progress.
- Ready-audio prefetch, no autoplay on reopening, pause/seek/next/previous.
- Unsaved confirmation, stale TTS response isolation and closed voice-dialog
  completion isolation.
- Uncertain-generation warning and explicit retry safety wait.
- Old service-worker private cache removal, SDK logout, cross-site logout
  rejection, and offline/private audio rejection after logout.

Screenshots were opened and visually checked. Evidence is local and ignored:
`.evidence/browser/results.json` and `.evidence/browser/*.png`.
Key files: `1440-first-playable.png`, `390-first-playable.png`,
`1440-playback.png`, `390-playback.png`, `desktop-stale-response-snapshots.png`,
`mobile-voice-modal.png`, `mobile-uncertain-retry.png`.
Screenshots contain synthetic data only.

Test boundaries: PostgreSQL tests use PGlite (PostgreSQL/WASM), with a socket
adapter for browser tests. Browser generation uses the **real local Workflow
SDK**, but **Fish and Blob networking are mocked**. JWT signature tests use
generated keys and a local JWKS resolver. Auth0 login UI/identity is synthetic.
Real Neon contention and Blob multipart/Range checks subsequently passed as
listed above. Vercel queue delivery/signatures, Auth0 code exchange and owner
denial, ChatGPT connection, and physical phone playback remain unverified.

## Preserved data and migration evidence

Original backup: `.backups/legacy-1788758403216`, ignored, directories 0700/files
0600. Its **46 files still match its manifest**, and its 45 MP3s still match the
source. That snapshot contains **9 documents, 74 segments, 2 voices, 45 cache
entries**.

The final source-to-old-backup comparison detected `store.json` drift, timestamp
**2026-09-07T15:16:07.252Z**, before cloud provisioning began at about 16:22Z.
The current source has **10 documents, 87 segments, 2 voices, 56 cache entries**.
One document was added; none of the nine original documents or voices changed.
No source file was restored, overwritten or deleted.

Fresh separate backup: **`.backups/legacy-1788799159944`**, **57 verified files**
(JSON + 56 MP3s), directories 0700/files 0600. This captures the additional local
session while preserving the original backup unchanged. A later recheck on
2026-09-07 verified all 57 source files still match this manifest, with no extra
source files. Use this newer snapshot for migration after a write freeze, or make
another fresh backup if local writes continue. Dingkang's cloned reference is
unchanged, not printed or recreated.

Synthetic import ran twice in tests with identical results and unchanged input;
conflicting metadata fails without overwrite. **Personal data has not been
imported into any cloud account.**

## Exact remaining blockers and next actions

Auth0 terms are accepted, all three free tenant/client resources exist, and
**Preview is fully configured and migrated** (owner row initialized; callback
registration, login redirect, MCP challenge and discovery metadata verified).
Auth0 Dashboard access works for the owner via Vercel SSO. Remaining:

1. **Dingkang's first interactive preview login** (owner-only step): while
   logged into Vercel as `dingkwang` (deployment protection), open
   https://personal-voice-reader-preview-dingkangs-projects.vercel.app/auth/login
   and sign in with the staging Auth0 user (`auth0|6a9f50b05b8fa1c8cdb4cbb1`).
   Expected: session saved, reader loads empty. Any other Auth0 user must get
   403. This is the one check no worker can perform — it needs his real login.
2. **ChatGPT client callback** (staging tenant): register the exact callback
   URL shown by ChatGPT's connection setup on client
   `3EeI3RgkslActTjSWGaUZ9SbGPSIhZ5X`, then connect ChatGPT to
   `https://personal-voice-reader-preview-dingkangs-projects.vercel.app/api/mcp`
   and verify a scoped RS256 token is accepted (`list_voices`). Not yet tested;
   no token has been issued.
3. **Vercel deployment protection vs ChatGPT** (known interoperability issue,
   unresolved): the preview sits behind Vercel SSO login; ChatGPT's server-side
   OAuth client cannot complete a Vercel login, so MCP requests from ChatGPT
   will be redirected to Vercel before reaching the app's 401 challenge.
   Before ChatGPT connectivity, decide deliberately: relax deployment
   protection once Auth0 owner auth is proven, or keep preview protected and
   test ChatGPT only against an adequately protected production. Do not weaken
   auth to work around this.
4. **Production equivalents** after preview owner login passes: production
   tenant custom API + ChatGPT client (exact ChatGPT callback), owner user and
   `AUTH0_OWNER_SUB`/`AUTH0_MCP_CLIENT_ID` for production, guarded `db:migrate`,
   production deploy and owner validation per the runbook gates.
5. Only after real owner protection is proven in production, migrate the
   verified backup, rerun the import, connect ChatGPT to the verified stable
   `/api/mcp`, and use the **one authorized short Fish synthesis** for final
   live acceptance. Preview keeps no Fish credential; preview voice/default
   IDs stay synthetic.

Vercel login is resolved; do not ask the user to log in again. There is still no
The Git remote is `dingkwang/personal-voice-reader`. This branch will be pushed
as the first web-only IndexTTS preview PR.
Do not substitute a public/no-auth deployment or copy personal data into preview.
Do not buy a plan upgrade or change unrelated project settings.

## Limitations for review

- The conservative Hobby-compatible recovery cron is daily. Initial dispatch is
  immediate, but a lost dispatch can wait up to about **24 hours** for automatic
  recovery. The authenticated recovery route can be invoked sooner. A faster
  cron must fit an already-authorized plan; no upgrade was purchased.
- Fish has no established idempotency guarantee here. Ambiguous calls keep
  their slots and require an explicit ten-minute-delayed retry acknowledgment.
  Exactly-once external billing is **not** claimed.
- Private recording uploads are retained; no automatic deletion policy was
  introduced. Review retention before production use.
- Legacy cache-to-segment historical associations were not present in JSON.
  Legacy version resolution is owner-wide; new versions are segment-scoped.
- Real Auth0/Workflow end-to-end acceptance, production deployment/migration and
  post-deployment monitoring remain required. The protected preview and real
  storage checks are not a claim of production readiness.
