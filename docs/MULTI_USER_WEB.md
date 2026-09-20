# Multi-user web access

## Scope

Web login accepts valid users of the configured Auth0 tenant, including its
existing Google connection. The SDK still validates issuer, signature, audience,
state, nonce, transaction cookies and session lifetime. Every web resource uses
the verified session `sub` as its immutable owner. Same-origin CSRF checks and
environment/database identity checks remain.

The original database-connection user keeps the same subject and data.
There is no migration, sharing or email-based linking. Signing in through Google
with the same email creates a separate reader, not access to the old reader.
Keep the database connection enabled so the original user can still sign in.

**MCP remains owner-only.** Its subject must still equal `AUTH0_OWNER_SUB`.
Its issuer, RS256 signature, audience, registered client, expiry and scopes
remain enforced. Web cookies cannot authorize MCP. Its default voice and
OAuth registrations are unchanged.

## Reader and voice ownership

- New users start with no documents. The approved built-in preset voice (御女茉莉, Fish ID `6ce7ea8ada884bf3889fa7c7fb206691`) is provisioned per authenticated owner as the default fallback. Explicit saved user default preferences win.
- Users can upload or record a 10–20 second Replicate reference. The browser
  converts it to mono 24 kHz PCM16 WAV. The server validates the format, duration,
  reserved upload, size and owner before saving a private reference.
  Saving this reference does not call a synthesis or normalization provider.
- Replicate voice uploads set only that user's web default. Modal's existing
  10–60 second upload path and Fish cloning remain separate provider operations.
- Arbitrary Fish Voice ID linking remains restricted to the original owner.
  The shared provider credential cannot prove another user's ownership of an ID.
- Documents, segments, job status/SSE, retries, regeneration and audio versions
  are owner-scoped. Downloads fetch the same authenticated audio endpoints.
  Blob paths include an owner hash; reference paths stay server-side.
- Legacy audio resolution remains available to the original owner. New audio
  needs a segment/version association. No existing IDs or paths are rewritten.
- Private responses remain `no-store`. No shared server content cache or offline
  private playback was added. Regeneration recovery keys in local storage use an
  owner namespace. The authenticated original owner may recover an old
  unnamespaced record only after the ownership-checked document response enables
  it. Existing owner-namespaced records always win. Recovery copies the raw old
  request forward without changing its idempotency key and keeps both copies
  until a definite response. Other users never read, replace or delete old keys.
  Malformed records and storage failures conservatively block fresh billing.

## Quota, keys and recovery

The approved limit is **1,000 Replicate provider attempts per user per Los Angeles
calendar day**, not a shared site budget. Failed and uncertain attempts count.
Polling, playback and cache hits do not. A reserved attempt still counts if its
process crashes before the provider POST, preventing ambiguous resubmission.

The existing quota SQL and limit are unchanged. Both preflight reservations and
submission checks hold the user's database row lock. Submission uses the clock
after acquiring that lock. LA midnight, including DST days, resets usage without
clearing uncertain claims or resubmitting old predictions. Total provider spend
can grow with the number of users. No billing system or aggregate limit is added.

Database keys include owner for cache entries, idempotency aliases, claims,
uploads, voice requests and provider attempts. Identical content keys are safe
because lookups and uniqueness include owner. Reference/audio objects have
separate owner paths even when their bytes match.

Recovery considers all owners. Each invocation checks at most ten due jobs,
sequentially, taking each owner's first turn before second turns. Oldest due
dispatch times determine priority. An atomic two-minute dispatch lease advances
even if a provider is unavailable, so failing or busy owners do not permanently
starve others. `checked` counts inspected leases, not successful workflow starts.
Concurrent invocations retain the existing lease/claim deduplication.

Workflow arguments carry the persisted owner/job pair. Invalid pairs return
before locks, tenant creation or other recovery writes. Resource validation,
Workflow runtime authorization and cron bearer authorization remain required.
No public recovery bypass was added. Per-user two-claim and ten-job limits remain.
The unchanged daily cron can mean multi-day recovery of a large backlog.
Do not change its schedule or plan without separate approval.

## Auth0 enablement and production requirements

These are **remaining operator checks**, not verified configuration results.
This implementation did not inspect or mutate live tenant settings.

1. In the correct environment's Auth0 tenant, enable the existing
   `google-oauth2` social connection for the existing **web** application.
   Keep the original database connection enabled. Do not enable new MCP users
   or change the ChatGPT client as part of this web change.
2. Check tenant Actions, connection restrictions and sign-up policy. Any
   owner-only login Action would still reject new users before the app runs.
   Do not introduce account linking, email matching or subject rewriting.
3. Keep the exact web callback (`<APP_BASE_URL>/auth/callback`), logout URL and
   web origin registered. Keep Preview and Production tenants and credentials
   separate. No application environment-variable names changed.
4. Production Google login needs a dedicated Google OAuth web client, not
   Auth0 development keys. Configure the Google consent screen, authorized
   domains, required publishing/test-user status and any required verification.
   Put that client's ID/secret in the matching Auth0 Google connection.
   Register the **Auth0 connection's displayed callback** in Google, usually
   `https://<tenant-or-custom-domain>/login/callback`, not the app's
   `/auth/callback`. Follow the dashboard's custom-domain instructions.
   Never put this secret in browser code or `NEXT_PUBLIC_*`.
5. Verify both Google and the original database login interactively after an
   authorized Preview publication. Confirm two empty/independent accounts and
   unchanged original data. Live sign-in was intentionally not run here.

Existing environment validation still requires the original `AUTH0_OWNER_SUB`,
`DEFAULT_VOICE_ID`, MCP fields, environment markers and isolated resources.
They preserve legacy/MCP behavior, not a web user allowlist. A usable
`REPLICATE_API_KEY` and private Blob configuration are needed for the upload and
generation routes. Provider presence is not proof of successful live generation.

## Publication gate

Root reviewed the diff and local acceptance evidence, requested the
legacy-recovery correction, then authorized commit, push and the existing
Preview publication workflow. Do not change Auth0/Google/Vercel settings, run
real database migrations or paid synthesis under this implementation request.

Still unverified remotely: social enablement, Google custom-client readiness,
Preview protection/access for intended users, actual Google/database sign-in,
Neon multi-instance contention, Blob transport and signed Workflow delivery.
Keep all protections until separately authorized checks establish readiness.
Rollback must retain all users' data, even if an older deployment denies their
login. No down migration or account deletion is needed.
