# IndexTTS-2.5 preview service

The Vercel page queues work. Modal runs one L4 on demand. Fish remains available.
ChatGPT MCP defaults and production settings are unchanged.

## Setup

1. Run `uv sync --project services/indextts --frozen`.
2. Log in with `modal token new --profile voice-reader-preview`.
3. Apply schema 002 to the isolated preview database:
   `npm run db:migrate -- --env-file .env.cloud.preview.local`.
4. Create the Modal secret `voice-reader-indextts-preview`. Set:
   `INDEXTTS_DATABASE_URL` to the preview database, `INDEXTTS_ENV=preview`,
   and `INDEXTTS_REQUEST_LIMIT=6`. Use the Modal dashboard or secret-safe stdin.
   Never pass credentials as command arguments or commit them.
5. From this directory, run `uv run modal deploy app.py --profile voice-reader-preview`.
   The image pins upstream code, weights, and auxiliary models. CPU builds download
   weights once. GPU containers load them from the image; no warm pool is reserved.
6. Create a Modal Proxy Token. Set preview-only Vercel secrets `INDEXTTS_URL`,
   `MODAL_PROXY_KEY`, and `MODAL_PROXY_SECRET`. The URL is the deployed `web` URL.
   Do not copy Vercel `[SENSITIVE]` placeholders into any service.
7. Deploy a Vercel preview. Verify its target is Preview. Keep deployment protection.
8. Upload the owner's original 10–60 second recording using the existing private
   upload flow. Select IndexTTS-2.5. Saving sets the web default. Existing Fish IDs
   cannot be reused as reference recordings. Do not substitute synthesized audio.

The service rejects anonymous HTTP requests using Modal proxy authentication.
Only Vercel sends the proxy credentials. The Modal secret targets one environment.
A database identity check rejects another project or environment.

## Behavior

- `GET /health` returns the exact model revision.
- `POST /normalize` validates audio and returns mono 22.05 kHz PCM WAV.
- `POST /requests/{ownerHash}/{attempt}` atomically claims a durable request.
  Repeated calls return its state. Text and recordings stay out of URLs and logs.
- `GET /requests/{ownerHash}/{attempt}/audio` returns private MP3 when ready.
- The GPU receives opaque IDs. It reads the private request from Neon.
- A lost spawn acknowledgment never triggers another spawn. It can leave an
  uncertain request. Explicit retry is available after the claim expires.
- Each GPU call has a 600-second limit. Requests expire after 25 minutes;
  Vercel reserves the owner slot for at most 30 minutes. Two owner slots remain.
- The first release uses natural reference emotion. No emotion panel or Qwen model.
- Page speed `1.5` maps to `duration_factor=1/1.5`.

Original and normalized reference recordings remain in private Blob storage.
Neon holds temporary request text, reference bytes, and MP3 results. Text/reference
bytes are cleared on terminal completion. Calls also clear transient data older
than 24 hours. This cleanup is lazy: idle services retain it until the next call.
Request tombstones remain for deduplication. Final audio stays in private Blob.
There is no automatic recording deletion policy.

## Cost and live acceptance

Start with one L4, no warm pool, one inference at a time, and six lifetime requests.
This is a conservative smoke-test cap, not a production quota or billing guarantee.
Keep total new live test spend below $5, before credits. Do not upgrade plans.
Do not raise the request cap until measured runtime and costs have been reviewed.
Model download, CPU work, cold starts, storage, and idle scale-down time also matter.
No fixed cost per audio minute is claimed.

Verify anonymous denial, then one cold and one warm short reading with the supplied
reference. Check desktop/mobile playback, seek, refresh recovery, and cache reuse.
Record deployment IDs, model revision, GPU runtime, latency, and observed charges.
Mocked tests do not prove voice quality or real GPU compatibility.

## Tests and rollback

Run `npm test`, `npm run test:service`, `npm run lint`, `npm run build`, and
`npm run test:browser`. Service tests use an isolated PostgreSQL socket and ffmpeg.
They mock the model, not the request ledger. No GPU or cloud credentials are used.

To roll back, choose a Fish voice and click “设为网页默认”. Retain schema 002 and
all audio. Stop new Modal work after active requests settle; do not delete data.
`DEFAULT_VOICE_ID` still controls MCP. The page stores its default in
`reader_preferences`; opening history restores that session's saved voice.

Sources: [IndexTTS](https://github.com/index-tts/index-tts),
[model card](https://huggingface.co/IndexTeam/IndexTTS-2.5),
[Modal timeouts](https://modal.com/docs/guide/webhook-timeouts),
[Modal authentication](https://modal.com/docs/guide/webhook-proxy-auth).
