# Replicate IndexTTS 2 preview

The original owner's web default remains their preconfigured reference voice.
Other users start empty and upload their own voice. This multi-user implementation
is local, not a verified deployment. See [web access](MULTI_USER_WEB.md).
Replicate uses
`lucataco/indextts-2`, pinned to
`b219b0f22f95fd97cb2c8e3bbea6827a450a7fff05674c996d83171d70b3f685`.
This is IndexTTS 2, not 2.5. Modal is not required or deployed.

## Setup

- Store `REPLICATE_API_KEY` as a Preview-only Vercel Secret.
- Apply schema 003 with `npm run db:migrate -- --env-file .env.cloud.preview.local`.
- Convert an authorized recording locally to 10–20 seconds of mono 24 kHz PCM16 WAV.
- Run `npx tsx scripts/seed-replicate.ts .env.cloud.preview.local <wav-path>`.
  This checks the Preview database identity, stores a private immutable reference,
  and idempotently sets the owner's web default. The original recording stays local.
- Deploy Preview and point its existing stable alias at the READY deployment.

## Behavior

The page uses natural reference emotion and 1× speed. Each text chunk becomes one
prediction. Reference bytes go from private Blob to Replicate as a Data URI.
Provider credentials, reference paths, prediction inputs and logs stay out of
browser responses and application logs. Replicate receives the text and voice
recording to perform inference; its own retention rules apply.

Creation is reserved in PostgreSQL before the paid POST. Its returned prediction
ID is persisted. Poll failures retry that ID. A lost creation reply is uncertain
and never automatically resubmitted. Owner claims expire after 30 minutes.
Each prediction has a five-minute provider cancellation deadline.
See [audio regeneration](audio-regeneration.md) for explicit regeneration,
billing confirmation, version preservation, and request recovery.
Keep total live testing below $5, including direct smoke calls.

Output is downloaded immediately into private Blob. WAV and MP3 retain the correct
extension and MIME. Range requests support seeking. Cache keys include provider,
model version, reference checksum, text and settings. Existing Fish audio remains
playable. MCP keeps its existing Fish default.

The supplied original voice was configured by the seed script. New users use the
Add Voice dialog to upload or record a 10–20 second reference. It is normalized
in-browser and validated server-side, with no paid synthesis on save. Emotion
controls remain deferred. Fish and separately configured Modal options remain.

## Daily quota

The user approved **1000 Replicate attempts per user per calendar day** in
`America/Los_Angeles`, replacing the lifetime 100-attempt guard.
The quota resets at local midnight, including 23-hour and 25-hour DST days.
Both preflight and paid submission enforce it under the owner lock.

Usage counts `replicate_requests.created_at` from local midnight (inclusive)
to the next local midnight (exclusive). Each row is durably reserved just before
the paid POST. All statuses count, including failed, submitting, and uncertain
attempts. A crash after reservation still consumes a slot for safety.
Polling and cache hits do not start new attempts. No schema change is needed.

Enqueue, regeneration, and explicit retry also reserve distinct uncached queued
or working keys without a submitted attempt, even when queued on a previous day.
Previously submitted attempts are not new reservations after midnight.
Reset does not clear uncertain calls, release owner claims, or resubmit anything.
Submission rechecks the current day; preflight does not guarantee a future slot.

## Verification

Run `npm test`, `npm run lint`, `npm run build`, and `npm run test:browser`.
Automated providers are mocked. Live acceptance requires the owner's Auth0 login,
a fresh reading from Preview, playback, refresh recovery, seeking and cache reuse.
Voice similarity requires the owner's listening review.

The first direct smoke prediction succeeded: 7.59 seconds inference, 132.13 seconds
including startup, and 9.02 seconds WAV output. Signal was present but quiet.
No claim of voice similarity or invoice amount follows from these metrics.

Rollback: choose Fish and select “设为网页默认”. Retain schemas and stored audio.
