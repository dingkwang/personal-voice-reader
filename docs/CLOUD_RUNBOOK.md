# Voice Note cloud runbook

## Status and architecture

Updated **2026-09-07**. Vercel login is verified as `dingkwang`, with one personal
team, `dingkangs-projects`, on active Hobby. The app is linked, three free Neon
Marketplace databases and three private Blob stores are provisioned, and the
protected preview build is READY. **Auth0 installation is blocked by required
browser terms acceptance. No owner login, working production release or personal
data migration is verified.** A passing build is not authenticated acceptance.

- Project: https://vercel.com/dingkangs-projects/personal-voice-reader
- Project ID: `prj_9FHg5FbFvM92jltVCxv891Kxj6fF`
- Team ID: `team_IgBeVss78AY6w5IHVn9CMe89`
- Stable protected preview:
  https://personal-voice-reader-preview-dingkangs-projects.vercel.app
- Ready preview deployment:
  https://personal-voice-reader-rdhxdhv5k-dingkangs-projects.vercel.app
  (`dpl_AzGSCSZALr5gFfUqUL7fwz5rCz72`)
- Reserved production origin: `https://personal-voice-reader.vercel.app`,
  **not a verified live production release**.
- Environment settings:
  https://vercel.com/dingkangs-projects/personal-voice-reader/settings/environment-variables

The preview remains behind Vercel login. An operator check confirmed health 200,
MCP anonymous 401/OAuth challenge, and private data/generation APIs fail closed
with 503 for missing Auth0 configuration. No production Fish credential is in
Preview. Temporary operator protection tokens used for checks were revoked.

Next.js hosts the private reader and stateless MCP Streamable HTTP endpoint.
Auth0 web sessions and separately validated Auth0 OAuth JWTs map to the exact
`AUTH0_OWNER_SUB`. PostgreSQL stores voices, documents, segments, audio versions,
cache entries, jobs, request aliases, generation claims and upload reservations.
The `pg` driver connects to Neon through its pooled TLS connection string.
Vercel Workflow executes two lanes; database row locks and two claim slots enforce
the owner-wide limit across instances. Only opaque IDs enter workflow arguments
and results. Provider text, credentials, audio and raw errors are not logged.

Audio objects use their byte SHA-256 as immutable private Blob paths. Cache keys
retain the PoC's version/provider/reference/model/speed/text dimensions. API
version URLs retain the cache key, including old 12-character URLs. Legacy cache
entries cannot be associated with historical segments precisely because the PoC
did not record those associations; only the configured owner can resolve them.
New versions require an explicit segment-to-cache association.

Private responses use `no-store`, even historical audio, to prevent logout bypass.
Only fingerprinted Next.js static assets are stored by the service worker.
Activation deletes old app-shell/audio caches. No offline private playback.

## Required human authorization, exact current blocker

Vercel authentication and app/storage provisioning are complete. Do not repeat
`vercel login`, recreate resources, or use an unrelated project.

The actual Auth0 install attempt selected **Free**, but returned
`integration_terms_acceptance_required` and `userActionRequired: true`.
The owner must review and accept terms at:

https://vercel.com/dingkangs-projects/~/integrations/accept-terms/auth0?source=cli

The CLI supplied these policy links:
https://vercel.com/legal/integration-marketplace-end-users-addendum,
https://www.okta.com/privacy-policy/, and https://okta.com/legal.
No Auth0 tenant/client or paid subscription was created by the blocked attempt.

After browser acceptance, the worker can retry:

```sh
vercel integration add auth0 --name voice-note-preview --plan free \
  -m localhost=http://localhost:3000 -m pathCallback=/auth/callback \
  --environment preview --no-env-pull --scope dingkangs-projects --non-interactive
```

Check the created resource and its exact environment connection. Complete any
Auth0 tenant/operator consent the provider requires. Continue only on the free
plan. No Auth0 CLI, standard local Auth0 configuration, or Auth0 connector was
found; Vercel Marketplace is the available provisioning path.

Per environment, the remaining real fields are `AUTH0_DOMAIN`,
`AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_OWNER_SUB`, `AUTH0_AUDIENCE`,
and `AUTH0_MCP_CLIENT_ID`. The exact ChatGPT callback URL must come from its
connection setup. Never invent a subject, audience/client registration or secret.
Fresh `AUTH0_SECRET` and `CRON_SECRET` are already configured separately.

Never paste credentials in an issue, chat, Git, CLI argument, screenshot or log.
Use Vercel environment settings or a restricted ignored environment file.
Existing `.env` contains the Fish credential; do not overwrite or print it.

## Isolated resources and bootstrap

These **three separate** resource sets already exist:

| Vercel target | APP_ENV / RESOURCE_ENV | Neon | private Blob | Auth0 |
| --- | --- | --- | --- | --- |
| Development | development | isolated DB | isolated store | dev clients/secret |
| Preview | preview | isolated DB | isolated store | preview clients/secret |
| Production | production | owner DB | owner store | production clients/secret |

Install **Neon from Vercel Marketplace**, not retired standalone Vercel Postgres.
Connect each database/store only to its matching environment. Do not leave
Production + Preview jointly selected in Marketplace/Blob connection dialogs.
Use empty databases, not branches copied from personal production data.

Current resources, all in `iad1`/AWS us-east-1, connected only to their matching
target:

| Target | Neon Marketplace dashboard | Neon project ID | Private Blob dashboard |
| --- | --- | --- | --- |
| Development | [voice-note-development](https://vercel.com/dingkangs-projects/~/stores/integration/store_IpD8dATNSPA0kPZX) | `polished-bar-42662880` | [store_Hvs12vCw1KKj8c7T](https://vercel.com/dingkangs-projects/~/stores/blob/store_Hvs12vCw1KKj8c7T) |
| Preview | [voice-note-preview](https://vercel.com/dingkangs-projects/~/stores/integration/store_PaJqBSY8Ju1lM0mv) | `gentle-fog-99023464` | [store_H7O7TYALqsj2YwFw](https://vercel.com/dingkangs-projects/~/stores/blob/store_H7O7TYALqsj2YwFw) |
| Production | [voice-note-production](https://vercel.com/dingkangs-projects/~/stores/integration/store_xb87vyPNN8pKkwSt) | `muddy-dew-38102961` | [store_Hx682WfGBnWj2xGh](https://vercel.com/dingkangs-projects/~/stores/blob/store_Hx682WfGBnWj2xGh) |

Neon installation: `icfg_QGRIPrzDYp4I8l0pWiLE5DBH`, selected plan `free_v3`;
all three resources report Free. Blob stores explicitly report Private.
No existing unrelated Neon database or Blob store was reused.

Set the variables in `.env.example` in the matching Vercel target. Set
`EXPECTED_DATABASE_HOST` to the exact hostname in that target's Neon connection
string and `EXPECTED_BLOB_STORE_ID` to its private store ID. `APP_BASE_URL` must
be the exact stable HTTPS origin, never an incoming Host header.

These guards, origins, integration credentials, default voice IDs and distinct
session/cron secrets are already configured: **82 entries, each single-target**.
All credential variables are encrypted. The original Fish key is in Production
only. Development and Preview deliberately have no Fish key, so live provider
generation remains disabled there. Do not copy the production key into Preview.

Separate ignored 0600 snapshots are
`.env.cloud.development.local`, `.env.cloud.preview.local`, and
`.env.cloud.production.local`. Pull only to the matching file when refreshing;
do not source a target into another target or overwrite the original `.env`.
The CLI-created default `.env.local` was removed after provisioning so the
existing local server does not automatically use cloud database credentials.

For a clean local environment containing the intended target credentials:

```sh
npm ci
npm run deploy:check
npm run db:migrate
```

`db:migrate` refuses a nonempty unmarked database and checks the app/environment
marker on repeat runs. It creates the owner row but does not import personal data.
Application authorization checks this marker before private operations.
Runtime does not create a JSON store or fall back to filesystem storage.

Current schema status: schema 001 plus the matching `deployment_identity` exists
in each new database. Bootstrap verified the exact new Neon project/hostname,
refused unrelated unmarked databases, and used `sslmode=verify-full`. It created
**no owner**. All owner/content/job tables are empty. Once genuine Auth0 fields
are configured, run the normal `db:migrate` to initialize the actual owner.

Real-service evidence: preview Neon passed concurrent idempotency (eight calls,
one job), conflict rejection, two persistent claims across three jobs and slot
release after completion. Private Blob passed unauthenticated 403, byte hashes,
closed/suffix/open 206 ranges, invalid 416, and a 6 MiB multipart round trip.
Only synthetic temporary fixtures were used; they were removed by exact run
ownership. All three Blob stores and databases were rechecked empty afterward.
Probe scripts live locally under ignored `.evidence/cloud/`.

Use a stable protected preview alias and register its exact Auth0 callback.
Seed only synthetic document/voice metadata and generated test audio. The
repeatable synthetic browser harness (`npm run test:browser`) is the reference
fixture; never copy `.data` into a preview or a test fixture.

The Blob direct-upload handler issues a ten-minute token for one reserved owner
path, exact MIME type, maximum file size, and no overwrite. Limit: 20 files,
20 MB per file and 100 MB outstanding per owner. Clone processing is bounded
and server-side. Uploaded recording objects are private and retained; review
retention manually before adding a scheduled cleanup policy. An uncertain clone
must be checked in Fish and linked by reference ID, not blindly recloned.

## Auth0 web application

For each environment:

1. Create an Auth0 **Regular Web Application**, named for Voice Note + environment.
2. Enable Authorization Code flow. The SDK manages PKCE, transaction state,
   encrypted HttpOnly SameSite cookies and callback validation.
3. Allowed Callback URL: `https://<stable-host>/auth/callback`.
4. Allowed Logout URL: `https://<stable-host>`.
5. Allowed Web Origin: `https://<stable-host>`.
6. For local development only, register the exact localhost origin/callback too.
   Do not use wildcard production callbacks.
7. Set `AUTH0_DOMAIN` to the tenant hostname without `https://`.
   Set `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, and a fresh 32-byte hexadecimal
   `AUTH0_SECRET`. Keep different secrets and clients per environment.
8. Find Dingkang in Auth0 Users and set his exact `user_id` as `AUTH0_OWNER_SUB`.
   Email/name matching is intentionally not supported.
9. Disable public sign-up if the tenant permits it. The app still rejects all
   other subjects before saving a session and on every private route.

Web scopes are `openid profile`. Sessions expire after twelve hours and do not
roll. `/auth/access-token` is disabled. An unauthenticated deep link redirects
through `/auth/login?returnTo=/sessions/<id>` and the SDK returns there.
Mutations require an exact same-origin `Origin` header. A web session cookie
is **not** accepted as MCP OAuth.

## Auth0 API and manually registered ChatGPT OAuth client

1. Create a custom API with identifier
   `https://<stable-production-host>/api/mcp` and **RS256** signing.
2. Define `read:voices`, `create:readings`, and `read:readings` permissions.
   Grant them only to Dingkang. If using RBAC, ensure requested permissions are
   included in the token's `scope`, not only a `permissions` array.
3. Set `AUTH0_AUDIENCE` to this API identifier. For a tenant dedicated to this
   one MCP API, set it as the tenant's Default Audience so generic OAuth clients
   receive the intended access-token audience. In a shared tenant, configure
   the client/MCP resource-to-audience mapping in Auth0 rather than changing the
   tenant default for unrelated applications. Verify the actual access token.
4. Manually register a **separate** Regular Web Application for ChatGPT, using
   Authorization Code with PKCE. Use the exact callback URL displayed by
   ChatGPT's connection setup. Register only that URL; do not guess it.
5. Supply this client's ID/secret to ChatGPT's static OAuth credentials fields.
   Put its ID in `AUTH0_MCP_CLIENT_ID`. Its secret belongs in ChatGPT/Auth0,
   not in the Voice Note web client configuration.
6. If enabling refresh tokens, enable refresh-token rotation and grant
   `offline_access` intentionally. It is not required for the basic connection.

Discovery:

- Resource metadata:
  `https://<stable-host>/.well-known/oauth-protected-resource/api/mcp`
- Root metadata alias: `/.well-known/oauth-protected-resource`
- Auth0 discovery: `https://<tenant>/.well-known/openid-configuration`
- Auth0 OAuth issuer: `https://<tenant>/`
- The API responds with `WWW-Authenticate` pointing to resource metadata.

JWT verification checks signature, RS256, issuer, audience, `exp`, `iat`,
the exact owner `sub`, the registered MCP client's `azp`, and tool scopes.
No anonymous initialize/tool listing, no dynamic registration, and no shared
public bearer playback links.

## Deployment gates

```sh
npm test
npm run lint
npm run build
npm run test:browser
npm audit --omit=dev
```

Then use `vercel link --project personal-voice-reader --scope <chosen-team> -y`
and `vercel deploy --scope <chosen-team> -y --no-wait` for **preview first**.
Inspect the returned deployment. Do not upload environment files, data, backups,
test secrets or evidence (`.vercelignore` excludes them).

This repository is already linked. For subsequent deploys use
`--scope dingkangs-projects --target preview`. Check the API's returned target
immediately; `null` means Preview. The first CLI deployment was unexpectedly
forced to Production despite `--target preview`. It was canceled immediately:
`dpl_J5FCczYKRiBADSCrWYMYYeotW6KY`, final state **CANCELED**.
The next deployment is Preview / READY. Do not promote the canceled record.
`--skip-domain` is production-only and is not a Preview workaround.

The ready remote build used default Node 24 on Hobby and compiled five Workflow
steps plus one workflow. Public unsigned flow/step POST probes returned 404.
That does **not** establish valid queue delivery or signature enforcement.
Auth0/Workflow end-to-end acceptance is still required.

The upload dry-run excludes `.data`, backups, all `.env*`, local evidence,
test fixtures, downloaded skills, SWC/TypeScript cache files and generated
Workflow routes. Workflow routes are regenerated during the cloud build.

Verify anonymous rejection on every private API, wrong-owner denial, web login,
OAuth tool scopes, CSRF, private Blob access, Range 206/416, Workflow progress
after closing the browser, retry and recovery, on isolated preview resources.
Verify generated Workflow endpoints reject unsigned external invocations.
Local tests cannot establish Vercel's queue authentication or Neon concurrency.

Only then deploy production with production resource variables using
`vercel deploy --prod --scope <chosen-team> -y --no-wait`. Verify the stable
`vercel.app` URL before importing personal data. Keep deployment protections;
do not disable team-wide protection. ChatGPT must be able to reach discovery and
the OAuth-protected MCP route on the production hostname. If plan or protection
settings prevent that, stop and resolve the precise project-level policy.

The checked-in cron runs daily, compatible with Hobby limits without a paid
upgrade. Initial dispatch happens after the response; if dispatch is lost,
the persistent outbox survives. Daily cron can recover it, so the fallback
latency can approach **24 hours**. An operator can invoke
`GET /api/jobs/recover` using the cron credential (in an Authorization header,
never query string). If an existing paid allowance permits faster scheduling,
set an approved minute-level schedule, do not buy an upgrade.

Workflows pin running code to a deployment. Failed/cancelled runs are restarted
through database claims. A lost `start()` acknowledgment can cause duplicate
workflow runs, not duplicate completed cache writes. There is **no exactly-once
claim for Fish side effects**. Any ambiguous provider/storage completion is
quarantined and keeps its slot. Retry requires explicit billing acknowledgment
and a ten-minute safety wait. The provider may still have billed the first call.

## Production data migration

The current source is backed up in **`.backups/legacy-1788799159944`**:
**57 verified files**, JSON plus 56 MP3s; **10 documents, 87 segments, 2 voices,
56 cache entries**. Dingkang's existing cloned reference remains unchanged.
The original `.backups/legacy-1788758403216` remains unchanged and verified:
46 files, 9 documents, 74 segments, 2 voices and 45 cache entries.

The older snapshot no longer matches the whole source because `store.json`
already gained one document before provisioning (`2026-09-07T15:16:07.252Z`).
The original nine documents, both voices and 45 audio files were unchanged.
Do not restore the older JSON over the newer local session.
Set production `DEFAULT_VOICE_ID` to the existing local ID, not the Fish reference:
`voice_484c6ca5-8b49-4234-995d-df521cfa61e3`.

Before a fresh migration, make a new backup if the PoC has received new writes:

```sh
npm run data:backup
```

The backup copies without deleting originals, refuses symlinks, uses directory
mode 0700/file mode 0600 and verifies before/after checksums. Do not run a cutover
while the earlier PoC is still accepting changes. Agree on a write freeze first;
this worker has not stopped the server on port 3000.

1. Prove owner web login and wrong-owner/anonymous denial on production.
2. Put a synthetic small private Blob under `migration-check/<random-probe-id>`.
   Confirm the exact expected store and that unauthenticated Blob GET is denied.
3. Supply restricted process variables: `LEGACY_BACKUP_DIR` (the backup's `data`
   subdirectory), `OWNER_VERIFIED_BASE_URL`, `MIGRATION_OWNER_ACCESS_TOKEN`
   (Dingkang's MCP OAuth access token with `read:voices`), `MIGRATION_PROBE_ID`.
4. Run `npm run data:import`. It checks the app/database/environment identity,
   anonymous route denial, actual owner OAuth, the private store probe, source
   checksums, stable IDs and downloaded Blob byte checksums.
5. Run it **again**. Counts and checksums must match. It inserts missing objects
   only, rejects conflicting metadata and never overwrites the original `.data`.
6. Compare 10 documents / 87 segments / 2 voices / 56 cached objects for the
   current snapshot, plus exact original IDs and version links. Additional newly-created
   cloud data may increase total counts; imported counts remain identical.

After migration/auth/deployment verification, exactly **one short Fish synthesis**
is authorized for live acceptance. Reuse its idempotency key, verify its private
playback link, and stop. Do not reclone Dingkang or generate a whole personal
article as a smoke test. No paid Fish call has been made by this implementation.

## ChatGPT connection after verified deployment

The production hostname is reserved but not accepted for use yet. Do not connect
ChatGPT to the fail-closed preview or the canceled production attempt. After a
verified production release, the intended MCP URL is
`https://personal-voice-reader.vercel.app/api/mcp`; verify it before connecting.

1. ChatGPT web: Settings → Security and login → Developer mode.
2. Open ChatGPT Plugins, plus button, create a developer-mode connection.
3. URL: `https://<stable-host>/api/mcp`; authentication: OAuth, with the manually
   registered ChatGPT client credentials above. Do not choose No Authentication.
4. Sign in as Dingkang and approve the three scopes.
5. Confirm tools: `list_voices`, `create_reading`, `get_reading_status`.
6. Ask: “请用声笺把这段最终中文保存并朗读，返回链接。”
   Approve the create tool's write action. The returned link opens the private
   phone-friendly reader; there is no embedded ChatGPT player.
7. Repeat the same tool payload/idempotency key and confirm the same job/session.

## Rollback

- Stop new generation requests, preserve the database and Blob objects.
- Revert to a previously **authenticated cloud** deployment, never deploy the
  old unauthenticated filesystem PoC publicly.
- Keep additive schema tables and immutable audio versions. No down migration
  or automatic data deletion is included.
- For local rollback, run the old PoC against its untouched `.data` only on a
  trusted local interface. The verified backup is a second recovery copy.
- Reconcile uncertain Fish requests manually; never bulk-retry them.
- Watch errors/queue lag/Blob failures for 10–30 minutes after cutover. Do not
  log text, provider responses, access tokens or recording URLs.

Primary sources rechecked 2026-09-06: Vercel MCP, Marketplace Postgres,
Workflows and Blob SDK docs; installed Workflow/Auth0 SDK docs; Auth0 MCP client
registration; OpenAI Developer Mode and Connect ChatGPT documentation.
