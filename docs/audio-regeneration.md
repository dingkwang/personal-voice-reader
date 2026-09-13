# Audio regeneration

Open **更多** in the player. Choose **重新生成当前段落** or **重新生成整篇**.
“Current” means the selected playback segment, not the text cursor.
Confirm the scope, saved voice, speed, and new generation charges.
Opening the menu or canceling the confirmation does not submit anything.

Save or restore text/title edits first. Restore any changed voice or speed.
Wait for unfinished requests. Resolve uncertain requests through the existing
explicit retry flow. Regeneration does not bypass uncertain provider attempts.

Playback pauses on submission. Generation continues in the background.
Old audio stays playable and downloadable until each replacement succeeds.
Failure keeps that segment's old version. Completion never starts playback.
Whole WAV export uses an ordered snapshot of the selected playable versions.
During partial success, that snapshot can contain both old and new audio.

## API

`POST /api/documents/[id]/regenerate` requires the owner's browser session and
the existing same-origin CSRF check. Responses use `Cache-Control: no-store`.

```json
{
  "scope": "segment",
  "segmentId": "seg_example",
  "sourceJobId": "job_example",
  "voiceId": "voice_example",
  "speed": 1,
  "idempotencyKey": "a-new-uuid-for-this-confirmation",
  "acknowledgeBilling": true
}
```

Use `scope: "all"` without `segmentId` for whole-document regeneration.
`sourceJobId` is the current task ID returned with the document. It is `null`
only for imported legacy audio without a task. The server resolves synthesis
settings from the source task, or from the saved legacy audio and voice.
The supplied task, voice, and speed are optimistic checks, not overrides.
No document text or reference audio belongs in this request.

The server returns `202` with the durable task's ordered progress.
It returns `409` for stale settings, unfinished/uncertain tasks, or conflicting
idempotency keys. Missing owner-scoped documents/segments return `404`.
Invalid scope or billing acknowledgement returns `422`.
Insufficient Preview capacity returns `422` with `QUOTA_EXCEEDED`, before commit.

## Safety and storage

- Regeneration uses fresh per-task, per-segment cache keys.
- Single-segment tasks copy untouched selected versions as ready items.
  All untouched segments must already have audio for the saved settings.
- Existing `jobs`, `job_requests`, `job_items`, and `audio_versions` persist the
  operation. A `regenerate:` request-hash namespace identifies its progress.
  No migration is required.
- Owner locking serializes source checks, idempotency, quota reservations,
  ordinary enqueue, retries, and provider claims.
- Quota preflight includes used Replicate attempts and distinct uncached queued
  or claimed keys without a submitted attempt. The existing 100-attempt cap,
  two provider slots, and cancellation/uncertainty deadlines are unchanged.
- Old version mappings, cache entries, and audio objects are not deleted.
  Only the still-selected task can update the segment's playable version.
  Superseded failed tasks cannot be retried over newer audio.
- Ordinary playback reuses selected regenerated keys for matching synthesis
  settings rather than restoring base cache keys.
- Client progress preserves ready audio. Changed URLs invalidate old duration
  measurements and preloads. A changed selected version detaches its player.

The browser stores a versioned pending request before submitting. It contains
only operation IDs/settings, never text, credentials, or audio. A lost response
or `5xx` keeps the request. After refresh, **恢复原请求** explicitly resends the
same key. It cannot create another task after the original has committed.
Confirmed success or a definite `4xx` removes the pending request.
Unavailable browser storage prevents a fresh submission.
Do not clear pending browser storage to work around an uncertain submission.

## Isolated verification

```sh
npm test
npm run lint
npm run build
npm run test:browser
```

Unit tests use ephemeral PGlite databases and mocked providers.
Browser tests run the built app on loopback with synthetic Auth0 sessions,
synthetic audio, an ephemeral database, and blocked external provider traffic.
They do not use an owner's real session or spend provider credits.

`tests/browser/regeneration.spec.ts` covers desktop (1440×1000) and mobile
(390×844): menu, disabled states, confirm/cancel, selected segment, background
progress, old playback, loop, WAV export, refresh, version switching,
lost-response recovery, and errors. Screenshots go to `.evidence/browser/`.
Native confirmation wording and accept/cancel are asserted through Playwright's
dialog events; native dialogs are not included in page screenshots.
