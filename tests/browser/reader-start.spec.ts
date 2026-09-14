import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { JobStatus, PublicDocument, Voice } from "../../src/lib/types";

const base = "http://127.0.0.1:3118";
const voices: Voice[] = [
  { id: "voice_fish", name: "合成 Fish", provider: "fish" },
  { id: "voice_index", name: "合成 Index", provider: "indextts" },
  { id: "voice_replicate", name: "合成 Replicate", provider: "replicate" },
].map((voice) => ({ ...voice, provider: voice.provider as Voice["provider"], providerVoiceId: null,
  language: "zh", source: "linked", createdAt: "2026-09-13T00:00:00Z" }));

function savedDocument(id = "doc_saved", speed = 1.2): PublicDocument & { originalText: string } {
  const originalText = "第一段合成测试文字。\n\n第二段合成测试文字。";
  return {
    id, title: "合成已保存会话", originalText, characterCount: originalText.length, createdAt: "2026-09-13T00:00:00Z",
    segments: originalText.split("\n\n").map((text, index) => ({
      id: `${id}_${index}`, documentId: id, index, text, status: "ready" as const,
      audioHash: `old-${index}`, audioUrl: `/api/audio/${id}_${index}?v=old`,
      voiceId: "voice_fish", speed,
    })),
  };
}

function jobFor(document: PublicDocument, voiceId = "voice_fish", speed = 1.2,
  status: JobStatus["status"] = "completed", id = "job_saved"): JobStatus {
  return {
    id, document_id: document.id, voice_id: voiceId, speed, model: "synthetic", status, run_id: null,
    url: `/sessions/${document.id}`,
    items: document.segments.map((segment) => ({
      segment_id: segment.id, status: status === "completed" ? "ready" : "queued", error: null,
      audioUrl: status === "completed" ? `/api/audio/${segment.id}?v=${voiceId === "voice_fish" ? "old" : id}` : null,
    })),
  };
}

// Real HTMLAudioElement playback with a generated PCM WAV, never paid synthesis.
function syntheticWav() {
  const frames = 24_000 * 30;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24); bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(100 * Math.sin(i * 2 * Math.PI * 440 / 24_000)), 44 + i * 2);
  return bytes;
}

async function fixture(page: Page, options: { cached?: boolean; error?: string; savedJob?: boolean; itemError?: "error" | "uncertain"; initialJob?: JobStatus } = {}) {
  const document = savedDocument();
  const posts: { documentId: string; voiceId: string; speed: number; idempotencyKey: string }[] = [];
  const saves: { text: string; title: string }[] = [];
  const unexpected: string[] = [];
  let currentJob = options.initialJob || jobFor(document);
  const documents = new Map([[document.id, document]]);
  const details = new Map([[document.id, { document, job: options.savedJob === false ? null : currentJob }]]);
  const wav = syntheticWav();
  await page.addInitScript(() => {
    const Original = window.Audio;
    const elements: HTMLAudioElement[] = [];
    Object.assign(window, { __qaAudio: elements });
    window.Audio = class extends Original {
      constructor(src?: string) { super(src); elements.push(this); }
    };
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) { unexpected.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/voices") return route.fulfill({ json: { voices, defaultVoiceId: "voice_fish" } });
    if (url.pathname === "/api/documents") {
      if (request.method() === "POST") {
        const input = request.postDataJSON();
        saves.push(input);
        const saved = savedDocument(`doc_snapshot_${saves.length}`);
        saved.title = input.title;
        saved.originalText = input.text;
        saved.characterCount = input.text.length;
        saved.segments = input.text.split("\n\n").map((text: string, index: number) => ({
          ...saved.segments[0], text, index, id: `${saved.id}_${index}`,
          status: "idle", audioHash: null, audioUrl: null, voiceId: null, speed: null,
        }));
        documents.set(saved.id, saved);
        details.set(saved.id, { document: saved, job: null });
        return route.fulfill({ json: { document: saved } });
      }
      return route.fulfill({ json: { documents: [...documents.values()].map((item) => ({
        ...item, preview: item.originalText, segmentCount: item.segments.length,
      })) } });
    }
    if (details.has(url.pathname.split("/").at(-1)!)) {
      return route.fulfill({ json: details.get(url.pathname.split("/").at(-1)!) });
    }
    if (url.pathname === "/api/tts") {
      const input = request.postDataJSON();
      posts.push(input);
      if (options.error) return route.fulfill({ status: 503, json: { error: options.error } });
      currentJob = jobFor(documents.get(input.documentId)!, input.voiceId, input.speed, options.cached ? "completed" : "queued", "job_selected");
      return route.fulfill({ status: 202, json: { job: currentJob } });
    }
    if (url.pathname.endsWith("/events")) {
      return route.fulfill({ contentType: "text/event-stream", body: `event: progress\ndata: ${JSON.stringify(currentJob)}\n\n` });
    }
    if (url.pathname === "/api/jobs/job_selected") {
      currentJob = jobFor(documents.get(currentJob.document_id)!, currentJob.voice_id, currentJob.speed, "completed", currentJob.id);
      if (options.itemError) {
        currentJob.status = "attention";
        currentJob.items[0] = { ...currentJob.items[0], status: options.itemError, audioUrl: null,
          error: options.itemError === "error" ? "IndexTTS 生成失败，请重试" : "生成结果不确定，可能已计费。请确认后重试。" };
      }
      return route.fulfill({ json: { job: currentJob } });
    }
    if (url.pathname.startsWith("/api/audio/")) {
      return route.fulfill({ contentType: "audio/wav", body: wav });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: "Unmocked API" } });
  });
  await page.goto(`/sessions/${document.id}`);
  await expect(page.getByRole("textbox", { name: "文章标题" })).toHaveValue(document.title);
  await expect(page.getByRole("combobox", { name: "朗读声音" })).toHaveValue("voice_fish");
  return { document, documents, details, posts, saves, unexpected,
    setJob(next: JobStatus) { currentJob = next; } };
}

async function playingSource(page: Page) {
  return page.evaluate(() => (window as unknown as { __qaAudio: HTMLAudioElement[] }).__qaAudio
    .findLast((audio) => !audio.paused)?.getAttribute("src"));
}

for (const width of [1440, 390]) {
  for (const [voiceId, speed] of [["voice_index", 1.2], ["voice_replicate", 1]] as const) {
    test(`saved voice change then Start plays selected ${voiceId} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const state = await fixture(page);
      await page.screenshot({ path: testInfo.outputPath("saved-default.png"), fullPage: true });
      await page.getByRole("combobox", { name: "朗读声音" }).selectOption(voiceId);
      await expect(page.locator("#speed")).toHaveValue(String(speed));
      await expect(page.getByRole("button", { name: "重新生成整篇", exact: true })).toBeDisabled();
      await expect(page.locator("#regeneration-reason")).toContainText("使用当前设置请点击「开始朗读」");
      await page.screenshot({ path: testInfo.outputPath("voice-changed.png"), fullPage: true });
      await page.getByRole("button", { name: "开始朗读", exact: true }).click();
      await expect.poll(() => state.posts.length).toBe(1);
      await expect(page.getByRole("button", { name: "正在准备音频…", exact: true })).toBeDisabled();
      await page.screenshot({ path: testInfo.outputPath("selected-preparing.png"), fullPage: true });
      expect(state.posts[0]).toMatchObject({ documentId: state.document.id, voiceId, speed });
      expect(state.saves).toHaveLength(0);
      await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
      expect(await playingSource(page)).toBe("/api/audio/doc_saved_0?v=job_selected");
      await expect.poll(() => page.locator(".time-control input").inputValue()).not.toBe("0");
      await page.screenshot({ path: testInfo.outputPath("selected-playing.png"), fullPage: true });
      expect(state.unexpected).toEqual([]);
    });
  }
}

test("cached selected voice also plays on the first Start", async ({ page }) => {
  const state = await fixture(page, { cached: true, savedJob: false });
  await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_index");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
  expect(await playingSource(page)).toBe("/api/audio/doc_saved_0?v=job_selected");
  expect(state.posts).toHaveLength(1);
});

test("Start displays the actual provider rejection, not only regeneration guidance", async ({ page }, testInfo) => {
  const state = await fixture(page, { error: "IndexTTS 尚未配置，请先完成服务设置" });
  await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_index");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "IndexTTS 尚未配置" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始朗读", exact: true })).toBeEnabled();
  expect(state.posts).toHaveLength(1);
  expect(await playingSource(page)).toBeUndefined();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.screenshot({ path: testInfo.outputPath(`${width}-provider-error.png`), fullPage: true });
  }
});

for (const itemError of ["error", "uncertain"] as const) {
  test(`selected voice ${itemError} is visible and Start does not create another paid request`, async ({ page }) => {
    const state = await fixture(page, { itemError });
    await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_index");
    await page.getByRole("button", { name: "开始朗读", exact: true }).click();
    await expect(page.getByRole("button", { name: "重试第 1 段" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: itemError === "error" ? "IndexTTS 生成失败" : "可能已计费" })).toBeVisible();
    await page.getByRole("button", { name: "开始朗读", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: itemError === "error" ? "IndexTTS 生成失败" : "可能已计费" })).toBeVisible();
    expect(state.posts).toHaveLength(1);
    expect(await playingSource(page)).toBeUndefined();
  });
}

test("first Start saves a new snapshot and does not inherit the original job", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("textbox", { name: "文章标题" }).fill("合成新快照");
  // Returning to saved settings while dirty used to reattach the original subscription.
  const voice = page.getByRole("combobox", { name: "朗读声音" });
  await voice.selectOption("voice_index");
  await voice.selectOption("voice_fish");
  await expect(page.locator(".job-progress")).toHaveCount(0);
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page).toHaveURL(`${base}/sessions/doc_snapshot_1`);
  await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
  expect(state.saves).toEqual([{ title: "合成新快照", text: state.document.originalText }]);
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]).toMatchObject({ documentId: "doc_snapshot_1", voiceId: "voice_fish", speed: 1.2 });
  expect(await playingSource(page)).toContain("/api/audio/doc_snapshot_1_0");
  expect(state.documents.get("doc_saved")).toEqual(savedDocument());
  await expect(page.locator(".history-item")).toHaveCount(2);
});

test("a fresh draft saves and plays on its first Start", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page.getByRole("textbox", { name: "文章标题" }).fill("全新合成会话");
  await page.getByRole("textbox", { name: "要朗读的文字" }).fill("全新合成文字。");
  await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_replicate");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
  expect(state.saves).toHaveLength(1);
  expect(state.posts[0]).toMatchObject({ documentId: "doc_snapshot_1", voiceId: "voice_replicate", speed: 1 });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("settings changes during save cancel the old Start, but the next Start uses the new voice", async ({ page }) => {
  const state = await fixture(page);
  const arrived = deferred(), release = deferred();
  await page.route("**/api/documents", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    arrived.resolve();
    await release.promise;
    await route.fallback();
  });
  await page.getByRole("textbox", { name: "文章标题" }).fill("保存中切换声音");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await arrived.promise;
  await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_replicate");
  release.resolve();
  await expect(page).toHaveURL(`${base}/sessions/doc_snapshot_1`);
  expect(state.posts).toHaveLength(0);
  expect(await playingSource(page)).toBeUndefined();
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
  expect(state.saves).toHaveLength(1);
  expect(state.posts[0]).toMatchObject({ voiceId: "voice_replicate", speed: 1 });
});

test("save errors remain visible and do not submit synthesis or discard the draft", async ({ page }) => {
  const state = await fixture(page);
  await page.route("**/api/documents", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 500, json: { error: "合成保存失败" } }) : route.fallback());
  await page.getByRole("textbox", { name: "文章标题" }).fill("保留合成草稿");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "合成保存失败" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "文章标题" })).toHaveValue("保留合成草稿");
  expect(state.posts).toHaveLength(0);
  expect(state.documents.get("doc_saved")).toEqual(savedDocument());
});

for (const change of ["voice", "session"] as const) {
  test(`late TTS response cannot overwrite a changed ${change}`, async ({ page }) => {
    const state = await fixture(page);
    const arrived = deferred(), release = deferred(), delivered = deferred();
    await page.route("**/api/tts", async (route) => {
      const input = route.request().postDataJSON();
      if (input.voiceId !== "voice_index") return route.fallback();
      arrived.resolve();
      await release.promise;
      await route.fulfill({ status: 202, json: { job: jobFor(state.document, "voice_index", 1.2, "completed", "job_late") } });
      delivered.resolve();
    });
    await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_index");
    await page.getByRole("button", { name: "开始朗读", exact: true }).click();
    await arrived.promise;
    if (change === "voice") {
      await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_replicate");
      await page.getByRole("button", { name: "开始朗读", exact: true }).click();
      await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
    } else {
      await page.getByRole("button", { name: "新建会话", exact: true }).click();
      await page.getByRole("textbox", { name: "要朗读的文字" }).fill("新的合成草稿");
    }
    release.resolve();
    await delivered.promise;
    await page.waitForTimeout(100);
    if (change === "voice") {
      await expect(page.getByRole("combobox", { name: "朗读声音" })).toHaveValue("voice_replicate");
      expect(await playingSource(page)).toBe("/api/audio/doc_saved_0?v=job_selected");
    } else {
      await expect(page.getByRole("textbox", { name: "要朗读的文字" })).toHaveValue("新的合成草稿");
      expect(await playingSource(page)).toBeUndefined();
      await expect(page.locator(".job-progress")).toHaveCount(0);
    }
  });
}

test("rapid segment selection shares one job and only plays the last segment", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_index");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await page.locator(".segment").nth(1).click();
  await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
  expect(await playingSource(page)).toBe("/api/audio/doc_saved_1?v=job_selected");
  expect(state.posts).toHaveLength(1);
  await page.getByRole("button", { name: "暂停朗读", exact: true }).click();
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  expect(state.posts).toHaveLength(1);
  await page.getByRole("checkbox", { name: "整篇循环" }).check();
  await page.evaluate(() => (window as unknown as { __qaAudio: HTMLAudioElement[] }).__qaAudio
    .findLast((audio) => !audio.paused)?.dispatchEvent(new Event("ended")));
  await expect(page.locator(".segment.active .segment-number")).toHaveText("01");
  await expect.poll(() => playingSource(page)).toBe("/api/audio/doc_saved_0?v=job_selected");
});

async function controlledEvents(page: Page) {
  await page.addInitScript(() => {
    const events: EventSource[] = [];
    Object.assign(window, { __qaEvents: events, EventSource: class extends EventTarget {
      constructor(readonly url: string) { super(); events.push(this as unknown as EventSource); }
      close() {}
    } });
  });
}

async function progress(page: Page, job: JobStatus) {
  await page.evaluate((job) => {
    const events = (window as unknown as { __qaEvents: EventSource[] }).__qaEvents;
    // Include closed streams to exercise already-queued, stale callbacks.
    for (const event of events.filter((event) => event.url === `/api/jobs/${job.id}/events`)) {
      event.dispatchEvent(new MessageEvent("progress", { data: JSON.stringify(job) }));
    }
  }, job);
}

async function downloadWav(page: Page) {
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载整篇 WAV" }).click();
  const download = await downloading;
  const bytes = await readFile((await download.path())!);
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.length).toBeGreaterThan(44);
}

for (const result of ["ready", "error"] as const) {
  test(`regeneration ${result} retains old audio, explicit confirmation and no autoplay`, async ({ page }) => {
    await controlledEvents(page);
    const state = await fixture(page);
    const posts: Record<string, unknown>[] = [];
    const source = jobFor(state.document);
    const regenerated = { ...jobFor(state.document, "voice_fish", 1.2, "queued", "job_regenerated"), regeneration: true };
    regenerated.items[1] = source.items[1];
    await page.route("**/regenerate", async (route) => {
      posts.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, json: { job: regenerated } });
    });
    await page.getByRole("button", { name: "开始朗读", exact: true }).click();
    await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
    const single = page.getByRole("button", { name: "重新生成当前段落", exact: true });
    page.once("dialog", (dialog) => dialog.dismiss());
    await single.click();
    expect(posts).toHaveLength(0);
    expect(await playingSource(page)).toBe("/api/audio/doc_saved_0?v=old");
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("新的费用");
      expect(dialog.message()).toContain("不会自动播放");
      await dialog.accept();
    });
    await single.click();
    await expect(page.locator(".job-progress")).toContainText("重新生成");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ scope: "segment", segmentId: "doc_saved_0", sourceJobId: "job_saved",
      voiceId: "voice_fish", speed: 1.2, acknowledgeBilling: true });
    await expect(single).toBeDisabled();
    expect(await playingSource(page)).toBeUndefined();
    await expect(page.locator(".segment-state.ready")).toHaveCount(2);
    await downloadWav(page);
    // Refresh while regeneration runs must restore old playable versions.
    state.details.set(state.document.id, { document: state.document, job: regenerated });
    await page.reload();
    await expect(page.locator(".job-progress")).toContainText("重新生成");
    expect(await playingSource(page)).toBeUndefined();
    await page.getByRole("button", { name: "开始朗读", exact: true }).click();
    await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
    expect(await playingSource(page)).toBe("/api/audio/doc_saved_0?v=old");
    const completed: JobStatus = { ...regenerated, status: result === "ready" ? "completed" : "attention",
      items: [{ ...regenerated.items[0], status: result, audioUrl: result === "ready" ? "/api/audio/doc_saved_0?v=regenerated" : null,
        error: result === "error" ? "IndexTTS 生成失败，请重试" : null }, source.items[1]] };
    await progress(page, completed);
    if (result === "ready") {
      await expect(page.getByRole("button", { name: "开始朗读", exact: true })).toBeVisible();
      expect(await playingSource(page)).toBeUndefined();
      // A queued callback from the closed subscription cannot reselect old progress.
      await progress(page, regenerated);
      await expect(page.locator(".job-progress")).toContainText("音频已就绪");
    } else {
      await expect(page.getByRole("button", { name: "重试第 1 段" })).toBeVisible();
      expect(await playingSource(page)).toBe("/api/audio/doc_saved_0?v=old");
      await page.getByRole("button", { name: "暂停朗读", exact: true }).click();
    }
    await page.getByRole("button", { name: "开始朗读", exact: true }).click();
    await expect.poll(() => playingSource(page)).toBe(`/api/audio/doc_saved_0?v=${result === "ready" ? "regenerated" : "old"}`);
    expect(state.posts).toHaveLength(0);
    await downloadWav(page);
    expect(state.unexpected).toEqual([]);
  });
}

test("lost regeneration response recovers the same persisted request after reload", async ({ page }) => {
  await controlledEvents(page);
  const state = await fixture(page);
  const posts: Record<string, unknown>[] = [];
  const regenerated = { ...jobFor(state.document, "voice_fish", 1.2, "queued", "job_recovered"), regeneration: true };
  await page.route("**/regenerate", async (route) => {
    posts.push(route.request().postDataJSON());
    if (posts.length === 1) return route.abort("failed");
    return route.fulfill({ status: 202, json: { job: regenerated } });
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "重新生成整篇", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复原请求" })).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name: "恢复原请求" }).click();
  await expect(page.getByRole("button", { name: "恢复原请求" })).toHaveCount(0);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[0].scope).toBe("all");
  expect(posts[0].segmentId).toBeUndefined();
  expect(await playingSource(page)).toBeUndefined();
  expect(state.posts).toHaveLength(0);
});

test("old polling and SSE cannot adopt into a newer voice selection", async ({ page }) => {
  await controlledEvents(page);
  const state = await fixture(page);
  const arrived = deferred(), release = deferred(), delivered = deferred();
  const old = jobFor(state.document, "voice_index", 1.2, "completed", "job_selected");
  await page.route("**/api/jobs/job_selected", async (route) => {
    arrived.resolve();
    await release.promise;
    await route.fulfill({ json: { job: old } });
    delivered.resolve();
  });
  await page.route("**/api/tts", (route) => route.request().postDataJSON().voiceId === "voice_fish"
    ? route.fulfill({ status: 202, json: { job: jobFor(state.document, "voice_fish", 1.2, "completed", "job_fish") } })
    : route.fallback());
  await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_index");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await arrived.promise;
  await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_fish");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
  const selected = await playingSource(page);
  release.resolve();
  await delivered.promise;
  await progress(page, old);
  expect(await playingSource(page)).toBe(selected);
  await expect(page.getByRole("combobox", { name: "朗读声音" })).toHaveValue("voice_fish");
  await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
});

test("a slow poll cannot overwrite newer SSE completion for the same job", async ({ page }) => {
  await controlledEvents(page);
  const state = await fixture(page);
  const arrived = deferred(), release = deferred();
  await page.route("**/api/jobs/job_selected", async (route) => {
    arrived.resolve();
    await release.promise;
    await route.fulfill({ json: { job: jobFor(state.document, "voice_index", 1.2, "queued", "job_selected") } });
  });
  await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_index");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await arrived.promise;
  await progress(page, jobFor(state.document, "voice_index", 1.2, "completed", "job_selected"));
  await expect(page.locator(".job-progress")).toContainText("音频已就绪");
  release.resolve();
  await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
  await expect(page.locator(".job-progress")).toContainText("音频已就绪");
  expect(state.posts).toHaveLength(1);
  expect(await playingSource(page)).toBe("/api/audio/doc_saved_0?v=job_selected");
});

test("playback rejection and media errors are visible and retryable", async ({ page }) => {
  await fixture(page, { cached: true });
  await page.evaluate(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      HTMLMediaElement.prototype.play = play;
      return Promise.reject(new Error("合成浏览器播放被阻止"));
    };
  });
  await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_index");
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "合成浏览器播放被阻止" })).toBeVisible();
  await page.getByRole("button", { name: "开始朗读", exact: true }).click();
  await expect(page.getByRole("button", { name: "暂停朗读", exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "合成浏览器播放被阻止" })).toHaveCount(0);
  await page.evaluate(() => {
    const audio = (window as unknown as { __qaAudio: HTMLAudioElement[] }).__qaAudio.findLast((audio) => !audio.paused)!;
    audio.pause();
    audio.dispatchEvent(new Event("error"));
  });
  await expect(page.getByRole("alert").filter({ hasText: "音频无法播放，请重试" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始朗读", exact: true })).toBeEnabled();
});

for (const width of [1440, 390]) {
  test(`regeneration copy separates queued, running, uncertain and done at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await controlledEvents(page);
    const queued = jobFor(savedDocument(), "voice_fish", 1.2, "queued");
    const state = await fixture(page, { initialJob: queued });
    const reason = page.locator("#regeneration-reason");
    const button = page.getByRole("button", { name: "重新生成整篇", exact: true });
    await expect(button).toBeDisabled();
    await expect(reason).toContainText("后台生成中（Fish Audio · 已就绪 0/2）");
    await expect(reason).not.toContainText("不确定");
    await page.screenshot({ path: testInfo.outputPath("queued.png"), fullPage: true });

    const running: JobStatus = { ...queued, status: "running",
      items: [{ ...queued.items[0], status: "ready" }, { ...queued.items[1], status: "working" }] };
    await progress(page, running);
    await expect(reason).toContainText("已就绪 1/2");
    await expect(reason).not.toContainText("不确定");
    await page.screenshot({ path: testInfo.outputPath("running.png"), fullPage: true });

    await progress(page, { ...running, status: "attention",
      items: [running.items[0], { ...running.items[1], status: "uncertain", error: "合成测试：结果不确定" }] });
    await expect(reason).toContainText("部分段落生成结果不确定，可能已计费");
    await expect(reason).not.toContainText("后台生成中");
    await expect(button).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("uncertain.png"), fullPage: true });

    state.details.set(state.document.id, { document: state.document, job: jobFor(state.document) });
    await page.reload();
    await expect(button).toBeEnabled();
    await expect(reason).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("done.png"), fullPage: true });
    expect(state.posts).toHaveLength(0);
    expect(state.unexpected).toEqual([]);
  });

  test(`regeneration copy separates pending POST, recovery and playback preparation at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const state = await fixture(page);
    const arrived = deferred(), release = deferred();
    await page.route("**/regenerate", async (route) => {
      arrived.resolve();
      await release.promise;
      await route.abort("failed");
    });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "重新生成整篇", exact: true }).click();
    await arrived.promise;
    await expect(page.locator("#regeneration-reason")).toContainText("正在提交重新生成请求");
    await page.screenshot({ path: testInfo.outputPath("pending-post.png"), fullPage: true });
    release.resolve();
    await expect(page.locator("#regeneration-reason")).toContainText("请恢复原请求");
    await page.screenshot({ path: testInfo.outputPath("post-recovery.png"), fullPage: true });

    // Discard only this synthetic test's pending request to isolate playback copy.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole("button", { name: "重新生成整篇", exact: true })).toBeEnabled();
    await page.evaluate(() => { HTMLMediaElement.prototype.play = () => new Promise(() => {}); });
    await page.getByRole("button", { name: "开始朗读", exact: true }).click();
    await expect(page.locator("#regeneration-reason")).toContainText("正在准备播放音频");
    await expect(page.locator("#regeneration-reason")).not.toContainText("不确定");
    await page.screenshot({ path: testInfo.outputPath("playback-preparation.png"), fullPage: true });
    expect(state.posts).toHaveLength(0);
    expect(state.unexpected).toEqual([]);
  });
}
