import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { PRESET_VOICE_ID, ensurePresetVoice } from "./preset-voice";
import { webVoices, setWebVoice } from "./web-voices";
import { addDocument, addVoice, findDocument, findVoice } from "./store";
import { queueDocument, readingStatus } from "./jobs";
import { makeDocument } from "./documents";
import type { Voice } from "./types";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const newUser = "google-oauth2|synthetic-new-user";
const anotherUser = "google-oauth2|synthetic-another-user";

beforeEach(async () => {
  fixture = await testDatabase();
  vi.stubEnv("AUTH0_OWNER_SUB", TEST_OWNER);
  vi.stubEnv("DEFAULT_VOICE_ID", "voice_test");
  vi.stubEnv("APP_BASE_URL", "http://localhost:3108");
  vi.stubEnv("FISH_API_KEY", "synthetic-fish-key");
});

afterEach(async () => {
  await fixture.close();
  vi.unstubAllEnvs();
});

it("new user gets exactly approved default preset voice", async () => {
  const result = await webVoices(newUser);
  expect(result.defaultVoiceId).toBe(PRESET_VOICE_ID);
  expect(result.canLinkFishVoice).toBe(false);
  expect(result.voices).toHaveLength(1);

  const voice = result.voices[0];
  expect(voice.id).toBe(PRESET_VOICE_ID);
  expect(voice.name).toBe("御女茉莉");
  expect(voice.provider).toBe("fish");
  expect(voice.providerVoiceId).toBe("6ce7ea8ada884bf3889fa7c7fb206691");
  expect(voice.language).toBe("zh");
  expect(voice.source).toBe("default");
  expect(voice.available).toBe(true);

  // Row is persisted in database for this owner
  const { rows } = await fixture.db.query<{ id: string; owner: string }>(
    "SELECT id, owner FROM voices WHERE owner=$1 AND id=$2",
    [newUser, PRESET_VOICE_ID]
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].owner).toBe(newUser);
  expect(rows[0].id).toBe(PRESET_VOICE_ID);
});

it("handles concurrent and repeated provisioning idempotently", async () => {
  // 10 concurrent calls to ensurePresetVoice and webVoices
  const calls = Array.from({ length: 10 }, (_, i) =>
    i % 2 === 0 ? ensurePresetVoice(newUser) : webVoices(newUser)
  );
  await expect(Promise.all(calls)).resolves.toBeDefined();

  // Exactly 1 voice row and 1 owner row persisted
  const voiceRows = await fixture.db.query(
    "SELECT * FROM voices WHERE owner=$1 AND id=$2",
    [newUser, PRESET_VOICE_ID]
  );
  expect(voiceRows.rows).toHaveLength(1);

  const ownerRows = await fixture.db.query(
    "SELECT * FROM owners WHERE id=$1",
    [newUser]
  );
  expect(ownerRows.rows).toHaveLength(1);

  // Subsequent repeated calls also succeed idempotently
  await ensurePresetVoice(newUser);
  const repeated = await webVoices(newUser);
  expect(repeated.defaultVoiceId).toBe(PRESET_VOICE_ID);
  expect(repeated.voices).toHaveLength(1);
});

it("preserves explicit saved user default preferences and reading audio", async () => {
  // Provision preset voice
  await webVoices(newUser);

  // Add another custom voice for the user
  const customVoice: Voice = {
    id: "voice_custom",
    name: "我的专属声音",
    provider: "fish",
    providerVoiceId: "custom-ref-id",
    language: "zh",
    createdAt: "2026-09-19T00:00:00Z",
    source: "linked",
  };
  await addVoice(customVoice, newUser);

  // Explicitly set saved preference to custom voice
  await setWebVoice(newUser, customVoice.id);

  // Saved user default wins
  const preferred = await webVoices(newUser);
  expect(preferred.defaultVoiceId).toBe(customVoice.id);

  // Switch preference to the approved preset
  await setWebVoice(newUser, PRESET_VOICE_ID);
  const switched = await webVoices(newUser);
  expect(switched.defaultVoiceId).toBe(PRESET_VOICE_ID);

  // Document and segment audio created with earlier voice remain intact
  const doc = await addDocument(
    makeDocument({ text: "保留已生成的音频段落测试", title: "测试文章" }),
    newUser
  );
  const segment = doc.segments[0];
  await fixture.db.query(
    "UPDATE segments SET data=jsonb_set(data, '{voiceId}', $3::jsonb) WHERE owner=$1 AND id=$2",
    [newUser, segment.id, JSON.stringify(customVoice.id)]
  );
  const reloaded = await findDocument(doc.id, newUser);
  expect(reloaded.segments[0].voiceId).toBe(customVoice.id);
});

it("enforces tenant isolation and does not share original owner private voices", async () => {
  // Legacy owner has private voice_test
  const legacyVoice = await findVoice("voice_test", TEST_OWNER);
  expect(legacyVoice.id).toBe("voice_test");

  // New user only sees approved preset, not legacy owner's private voice
  const userA = await webVoices(newUser);
  expect(userA.voices.map((v) => v.id)).toEqual([PRESET_VOICE_ID]);
  expect(userA.voices.some((v) => v.id === "voice_test")).toBe(false);

  // New user cannot query legacy owner's voice
  await expect(findVoice("voice_test", newUser)).rejects.toMatchObject({
    status: 404,
  });

  // Another user also only has their own scoped preset
  const userB = await webVoices(anotherUser);
  expect(userB.voices.map((v) => v.id)).toEqual([PRESET_VOICE_ID]);

  // Voice rows are strictly owner-scoped
  const rows = await fixture.db.query<{ owner: string; id: string }>(
    "SELECT owner, id FROM voices WHERE id=$1",
    [PRESET_VOICE_ID]
  );
  expect(rows.rows).toHaveLength(2);
  expect(new Set(rows.rows.map((r) => r.owner))).toEqual(new Set([newUser, anotherUser]));
});

it("resolves new voice for queueDocument and creates job successfully", async () => {
  const doc = await addDocument(
    makeDocument({ text: "使用御女茉莉排队朗读测试。", title: "排队测试" }),
    newUser
  );

  // Queue with the new approved preset voice
  const queued = await queueDocument(
    {
      documentId: doc.id,
      voiceId: PRESET_VOICE_ID,
      speed: 1,
      idempotencyKey: "queue-preset-voice-idempotency",
    },
    newUser
  );

  expect(queued.jobId).toBeDefined();
  expect(queued.documentId).toBe(doc.id);

  // Job was persisted with the preset voice and foreign key succeeded
  const status = await readingStatus(queued.jobId, newUser);
  expect(status.voice_id).toBe(PRESET_VOICE_ID);
  expect(status.status).toBe("queued");

  const jobRow = await fixture.db.query<{ synthesis: Record<string, unknown> }>(
    "SELECT synthesis FROM jobs WHERE owner=$1 AND id=$2",
    [newUser, queued.jobId]
  );
  expect(jobRow.rows[0].synthesis).toMatchObject({
    provider: "fish",
    providerVoiceId: "6ce7ea8ada884bf3889fa7c7fb206691",
  });
});
