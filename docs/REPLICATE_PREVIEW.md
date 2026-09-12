# Replicate IndexTTS 2 preview

The web default is the owner's preconfigured reference voice. It uses Replicate
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
Each prediction has a five-minute provider cancellation deadline. Preview permits
six lifetime submitted attempts per owner. This is a smoke-test guard, not a
production quota. Keep total live testing below $5, including direct smoke calls.

Output is downloaded immediately into private Blob. WAV and MP3 retain the correct
extension and MIME. Range requests support seeking. Cache keys include provider,
model version, reference checksum, text and settings. Existing Fish audio remains
playable. MCP keeps its existing Fish default.

The supplied voice is configured by the seed script. General Replicate voice
upload/recording UI and emotion controls are deferred. The Add Voice dialog retains
the existing Fish and separately configured Modal options.

## Verification

Run `npm test`, `npm run lint`, `npm run build`, and `npm run test:browser`.
Automated providers are mocked. Live acceptance requires the owner's Auth0 login,
a fresh reading from Preview, playback, refresh recovery, seeking and cache reuse.
Voice similarity requires the owner's listening review.

The first direct smoke prediction succeeded: 7.59 seconds inference, 132.13 seconds
including startup, and 9.02 seconds WAV output. Signal was present but quiet.
No claim of voice similarity or invoice amount follows from these metrics.

Rollback: choose Fish and select “设为网页默认”. Retain schemas and stored audio.
