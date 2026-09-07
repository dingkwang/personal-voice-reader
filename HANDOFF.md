# Implementation and cloud handoff, 2026-09-07

## Outcome

Implemented the approved stack and passed local acceptance. **Vercel provisioning
and a protected preview build are complete. Auth0 terms acceptance now blocks
login configuration, production acceptance and personal-data migration.**
Vercel CLI 59.11.7 is authenticated as `dingkwang`; the only team is
`dingkangs-projects` (`team_IgBeVss78AY6w5IHVn9CMe89`), on active Hobby.
No upgrade, paid commitment, commit, push, agent delegation, real Fish synthesis,
or voice recloning occurred.

Project: https://vercel.com/dingkangs-projects/personal-voice-reader
(`prj_9FHg5FbFvM92jltVCxv891Kxj6fF`), linked locally by the CLI.

Protected preview:
https://personal-voice-reader-preview-dingkangs-projects.vercel.app

Ready preview deployment: `dpl_AzGSCSZALr5gFfUqUL7fwz5rCz72`,
https://personal-voice-reader-rdhxdhv5k-dingkangs-projects.vercel.app

This is a **build-ready, fail-closed preview**, not a usable authenticated reader.
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

Resource dashboard links and exact next commands are in `docs/CLOUD_RUNBOOK.md`.
Schema 001 and the matching `deployment_identity` marker were initialized in
each newly created empty database, then checked again over verified TLS.
**No owner was fabricated or initialized.** All owner/content/job tables and
all Blob stores are empty after synthetic acceptance fixture cleanup.

Configured 82 single-target environment entries, including integration variables,
resource identity guards, stable origins, distinct `AUTH0_SECRET`/`CRON_SECRET`,
model and default voice IDs. Existing Fish credential is encrypted in
**Production only**, absent from development, preview and the ready deployment.
Auth0 tenant/client/owner/audience fields remain unset, not fake.

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
  with OAuth challenge, and private data/generation APIs **503
  CONFIGURATION_REQUIRED**, with no-store headers. Auth0 login remained denied.
  Temporary bypasses were revoked; original deployment protection is unchanged.
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
session while preserving the original backup unchanged. Use this newer snapshot
for migration after a write freeze, or make another fresh backup if local writes
continue. Dingkang's cloned reference is unchanged, not printed or recreated.

Synthetic import ran twice in tests with identical results and unchanged input;
conflicting metadata fails without overwrite. **Personal data has not been
imported into any cloud account.**

## Exact remaining blockers and next actions

1. **Accept Auth0 Marketplace terms in the browser:**
   https://vercel.com/dingkangs-projects/~/integrations/accept-terms/auth0?source=cli
   The actual free-plan install returned
   `integration_terms_acceptance_required` / `userActionRequired: true`.
   No Auth0 installation or tenant was created. Do not accept a paid plan.
2. Retry the scoped free Auth0 integration command in the runbook. No Auth0
   CLI, standard local Auth0 login/configuration, or Auth0 connector was found.
   Complete any tenant/operator consent, then configure real separate web and
   ChatGPT clients, exact owner subject, RS256 audience and three scopes.
   Six fields remain per target: `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`,
   `AUTH0_CLIENT_SECRET`, `AUTH0_OWNER_SUB`, `AUTH0_AUDIENCE`,
   `AUTH0_MCP_CLIENT_ID`. Enter credentials in Vercel/Auth0, never chat.
3. Rerun the existing guarded `db:migrate` after real auth configuration to
   initialize the actual owner. Preview/default development voice IDs are
   synthetic placeholders; seed synthetic content only after owner configuration.
   No preview Fish credential was copied from production.
4. Validate Auth0 on isolated preview, signed Workflow delivery/recovery and
   scoped MCP OAuth before production. Production still requires lint/tests/
   build and the runbook's owner validation gates.
5. Only after real owner protection is proven, migrate the verified backup,
   rerun the import, connect ChatGPT to the verified stable `/api/mcp`, and use
   the **one authorized short Fish synthesis** for final live acceptance.

Vercel login is resolved; do not ask the user to log in again. There is still no
Git remote, and no commit or push has been requested.
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
