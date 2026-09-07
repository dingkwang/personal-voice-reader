// Standalone browser acceptance check. Never points at the user's server/store.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/check-sessions.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const output = await mkdtemp(path.join(os.tmpdir(), "voice-reader-acceptance-"));
const dataDir = path.join(output, "data");
await mkdir(path.join(dataDir, "audio"), { recursive: true });
const hash = "a".repeat(64);
const audioFile = path.join(dataDir, "audio", `${hash}.mp3`);
execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
  "-filter:a", "volume=0.02", "-codec:a", "libmp3lame", audioFile]);
const mp3 = await readFile(audioFile);
const voices = [
  { id: "voice_qa_clone", name: "测试克隆声音", provider: "fish", providerVoiceId: null, language: "zh", source: "cloned", createdAt: "2026-09-06T00:00:00Z" },
  { id: "voice_qa_default", name: "测试默认声音", provider: "fish", providerVoiceId: null, language: "zh", source: "default", createdAt: "2026-09-06T00:00:00Z" },
];
function fixture(id, title, paragraphs, ready, date, speed = 1.2) {
  return {
    id, title, originalText: paragraphs.join("\n\n"), createdAt: date,
    segments: paragraphs.map((text, index) => ({
      id: `seg_${id}_${index}`, documentId: id, index, text,
      status: ready ? "ready" : "idle", audioHash: ready ? hash : null,
      audioUrl: ready ? `/api/audio/seg_${id}_${index}?v=${hash.slice(0, 12)}` : null,
      voiceId: ready ? voices[0].id : null, speed: ready ? speed : null,
    })),
  };
}
const a = fixture("doc_qa_a", "周末阅读 · 已有音频", [
  "这是用于验收的第一段。选择历史会话会恢复原文和标题，但不会自动播放。",
  "这是第二段。可以暂停、继续、切换上一段和下一段，也可以重新播放已有音频。",
], true, "2026-09-06T08:00:00Z");
const b = fixture("doc_qa_b", "待生成的会话", ["这段文字尚未生成语音，用于验证延迟响应不会串到其他会话。"], false, "2026-09-05T08:00:00Z");
await writeFile(path.join(dataDir, "store.json"), JSON.stringify({ voices, documents: [a, b], audioCache: { [hash]: hash } }));

const port = 3107;
const base = `http://127.0.0.1:${port}`;
// Do not adopt or terminate an existing listener.
try {
  await fetch(base);
  throw new Error(`Test port ${port} is already occupied`);
} catch (error) {
  if (!error.cause) throw error;
}
const log = createWriteStream(path.join(output, "server.log"));
const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root, env: { ...process.env, VOICE_READER_DATA_DIR: dataDir, FISH_API_KEY: "", FISH_AUDIO_API_KEY: "", FISH_DEFAULT_VOICE_ID: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(log);
server.stderr.pipe(log);
let browser;
const checks = [];
const screenshots = [];
try {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 100 || server.exitCode !== null) throw new Error("Test server did not start");
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await context.addInitScript(() => {
    window.__qaAudio = [];
    const OriginalAudio = window.Audio;
    window.Audio = function (...args) {
      const audio = new OriginalAudio(...args);
      window.__qaAudio.push(audio);
      return audio;
    };
  });
  const history = page.locator(".history-item");
  const title = page.getByRole("textbox", { name: "文章标题" });
  const text = page.getByRole("textbox", { name: "要朗读的文字" });
  const save = page.getByRole("button", { name: "保存会话", exact: true });
  const read = page.locator(".primary-read-button");
  const newSession = page.getByRole("button", { name: "新建会话", exact: true });
  const choose = async (name) => history.filter({ hasText: name }).click();
  const waitFor = async (predicate, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await predicate()) return;
      await page.waitForTimeout(50);
    }
    throw new Error(message);
  };
  const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
  const shot = async (name) => {
    const filename = `${name}.png`;
    await page.screenshot({ path: path.join(output, filename), fullPage: true });
    screenshots.push(filename);
  };
  const documentCount = async () => (await (await fetch(`${base}/api/documents`)).json()).documents.length;
  const noAudio = async () => assert.equal(await page.evaluate(() => window.__qaAudio.filter((audio) => !audio.paused).length), 0);
  let ttsCalls = 0;
  let delayTts = false;
  let heldTts = [];
  await context.route("**/api/tts", async (route) => {
    ttsCalls++;
    const payload = route.request().postDataJSON();
    const store = JSON.parse(await readFile(path.join(dataDir, "store.json"), "utf8"));
    const segment = store.documents.flatMap((document) => document.segments).find((item) => item.id === payload.segmentId);
    assert.ok(segment);
    const finish = () => route.fulfill({ json: { segment: {
      ...segment, status: "ready", voiceId: payload.voiceId, speed: payload.speed,
      audioHash: hash, audioUrl: `/qa-audio/${segment.id}?speed=${payload.speed}`,
    }, cached: false } });
    if (delayTts) heldTts.push(finish);
    else await finish();
  });
  await context.route("**/qa-audio/**", (route) => route.fulfill({ contentType: "audio/mpeg", body: mp3 }));
  await page.goto(base);
  await waitFor(async () => (await history.count()) === 2, "existing history did not load");
  await shot("desktop-default");
  await choose(a.title);
  await waitFor(async () => (await title.inputValue()) === a.title, "session A did not load");
  assert.equal(await text.inputValue(), a.originalText);
  assert.equal(await page.locator("#voice").inputValue(), voices[0].id);
  assert.equal(await page.locator("#speed").inputValue(), "1.2");
  assert.equal(await page.locator(".segment").count(), 2);
  assert.equal(await history.filter({ hasText: a.title }).getAttribute("aria-current"), "true");
  assert.equal(ttsCalls, 0);
  await noAudio();
  await shot("desktop-history-selected");
  check("history loads, selection restores original text/title/segments/settings without autoplay");

  await read.click();
  await waitFor(async () => (await read.innerText()).includes("暂停朗读"), "saved audio did not play");
  assert.equal(ttsCalls, 0);
  await read.click();
  await noAudio();
  await read.click();
  await page.getByRole("button", { name: "下一段", exact: true }).click();
  await waitFor(async () => (await page.locator(".segment.active .segment-number").innerText()) === "02", "next failed");
  await page.getByRole("button", { name: "上一段", exact: true }).click();
  await waitFor(async () => (await page.locator(".segment.active .segment-number").innerText()) === "01", "previous failed");
  await waitFor(async () => (await read.innerText()).includes("暂停朗读"), "previous audio failed");
  await page.evaluate(() => window.__qaAudio.at(-1).dispatchEvent(new Event("ended")));
  await waitFor(async () => (await page.locator(".segment.active .segment-number").innerText()) === "02", "automatic next failed");
  await choose(b.title);
  await waitFor(async () => (await title.inputValue()) === b.title, "switch B failed");
  await noAudio();
  assert.equal(await documentCount(), 2);
  check("cached read, pause/resume, previous/next/auto-next, no duplicates, old audio stops on switch");

  await newSession.click();
  assert.equal(await text.inputValue(), "");
  assert.equal(await title.inputValue(), "");
  await title.fill("新保存的会话");
  await text.fill("只保存这篇文字，不生成语音。\n\n内部换行保持不变。");
  const beforeSaveTts = ttsCalls;
  let releaseSave;
  let saveRequests = 0;
  await context.route("**/api/documents", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    saveRequests++;
    await new Promise((resolve) => { releaseSave = resolve; });
    await route.continue();
  });
  await save.click();
  await waitFor(async () => Boolean(releaseSave), "save not intercepted");
  assert.ok(await text.isDisabled());
  assert.ok(await title.isDisabled());
  assert.ok(await newSession.isDisabled());
  assert.ok(await save.isDisabled());
  await save.evaluate((button) => { button.click(); button.click(); });
  await shot("desktop-saving");
  releaseSave();
  await waitFor(async () => (await page.locator(".session-toolbar").innerText()).includes("会话已保存"), "save did not finish");
  assert.equal(saveRequests, 1);
  assert.equal(ttsCalls, beforeSaveTts);
  assert.equal(await documentCount(), 3);
  await context.unroute("**/api/documents");
  assert.ok(await save.isDisabled());
  await shot("desktop-new-saved");
  check("new clears editor; save-only, editor/navigation lock and duplicate-save prevention");

  await page.reload();
  await waitFor(async () => (await history.count()) === 3, "refresh persistence failed");
  await choose("新保存的会话");
  await waitFor(async () => (await title.inputValue()) === "新保存的会话", "saved selection failed");
  assert.equal(await text.inputValue(), "只保存这篇文字，不生成语音。\n\n内部换行保持不变。");
  await read.click();
  await waitFor(async () => (await read.innerText()).includes("暂停朗读"), "saved session read failed");
  assert.equal(await documentCount(), 3);
  await read.click();
  await title.fill("另存标题快照");
  page.once("dialog", (dialog) => dialog.dismiss());
  await choose(a.title);
  assert.equal(await title.inputValue(), "另存标题快照");
  await save.click();
  await waitFor(async () => (await documentCount()) === 4 && await save.isDisabled(), "edited snapshot not saved");
  await choose("新保存的会话");
  await waitFor(async () => (await title.inputValue()) === "新保存的会话", "old snapshot not retained");
  await text.fill("未保存的修改稿");
  page.once("dialog", (dialog) => dialog.accept());
  await newSession.click();
  assert.equal(await text.inputValue(), "");
  await text.fill("未保存的新稿");
  page.once("dialog", (dialog) => dialog.dismiss());
  await newSession.click();
  assert.equal(await text.inputValue(), "未保存的新稿");
  page.once("dialog", (dialog) => dialog.accept());
  await newSession.click();
  check("refresh persistence, saved read dedupe, title snapshot preservation, new/edited draft protection");

  await page.getByLabel("上传 TXT", { exact: true }).setInputFiles({
    name: "导入文章.txt", mimeType: "text/plain", buffer: Buffer.from("\ufeff导入的正文。\n\n第二段。"),
  });
  await waitFor(async () => (await text.inputValue()) === "导入的正文。\n\n第二段。", "TXT import failed");
  assert.equal(await title.inputValue(), "导入文章");
  await read.click();
  await waitFor(async () => (await read.innerText()).includes("暂停朗读"), "auto-save read failed");
  assert.equal(await documentCount(), 5);
  await page.getByRole("button", { name: "添加声音", exact: true }).click();
  assert.ok(await page.getByRole("dialog").isVisible());
  await shot("desktop-voice-modal");
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await newSession.click();
  await noAudio();
  check("TXT import, read auto-save and voice-clone modal retained; new stops audio");

  let releaseDetail;
  await context.route(`**/api/documents/${a.id}`, async (route) => {
    await new Promise((resolve) => { releaseDetail = resolve; });
    await route.continue();
  });
  await choose(a.title);
  await waitFor(async () => Boolean(releaseDetail), "detail not held");
  assert.ok(await text.isDisabled());
  await shot("desktop-detail-loading");
  await choose(b.title);
  await waitFor(async () => (await title.inputValue()) === b.title, "newer detail not loaded");
  releaseDetail();
  await page.waitForTimeout(200);
  assert.equal(await title.inputValue(), b.title);
  await context.unroute(`**/api/documents/${a.id}`);
  check("late detail GET cannot replace a newer session");

  delayTts = true;
  await read.click();
  await waitFor(async () => heldTts.length === 1, "TTS not held");
  await choose(a.title);
  await waitFor(async () => (await title.inputValue()) === a.title, "TTS switch failed");
  await heldTts.shift()();
  await page.waitForTimeout(200);
  assert.equal(await title.inputValue(), a.title);
  assert.equal(await page.locator(".segment").count(), 2);
  await noAudio();
  await choose(b.title);
  await waitFor(async () => (await title.inputValue()) === b.title, "B reload failed");
  await read.click();
  await waitFor(async () => heldTts.length === 1, "old speed TTS not held");
  await page.locator("#speed").fill("1.4");
  await read.click();
  await waitFor(async () => heldTts.length === 2, "new speed TTS not held");
  await heldTts.shift()();
  await page.waitForTimeout(100);
  assert.ok(await read.isDisabled());
  assert.ok((await read.innerText()).includes("正在准备"));
  await heldTts.shift()();
  await waitFor(async () => (await read.innerText()).includes("暂停朗读"), "new speed did not play");
  assert.equal(await page.locator("#speed").inputValue(), "1.4");
  await page.locator("#voice").selectOption(voices[1].id);
  await noAudio();
  await read.click();
  await waitFor(async () => heldTts.length === 1, "voice TTS not held");
  await newSession.click();
  await heldTts.shift()();
  await page.waitForTimeout(100);
  await noAudio();
  assert.equal(await text.inputValue(), "");
  delayTts = false;
  check("stale TTS cannot mutate another session, autoplay, or clear newer busy state; settings/new cancel immediately");

  // Delay the real play promise while allowing its media element to exist.
  await choose(a.title);
  await waitFor(async () => (await title.inputValue()) === a.title, "A play race failed");
  await page.evaluate(() => {
    const original = HTMLMediaElement.prototype.play;
    window.__qaOriginalPlay = original;
    HTMLMediaElement.prototype.play = function () {
      return new Promise((resolve, reject) => {
        original.call(this).then(() => { window.__qaFinishPlay = resolve; }, reject);
      });
    };
  });
  await read.click();
  await page.waitForFunction(() => Boolean(window.__qaFinishPlay));
  await choose(b.title);
  await waitFor(async () => (await title.inputValue()) === b.title, "play race switch failed");
  await page.evaluate(() => {
    window.__qaFinishPlay();
    HTMLMediaElement.prototype.play = window.__qaOriginalPlay;
  });
  await page.waitForTimeout(100);
  await noAudio();
  assert.ok((await read.innerText()).includes("开始朗读"));
  check("late audio.play completion does not restart or update the next session");

  await context.route(`**/api/documents/${a.id}`, (route) => route.fulfill({ status: 503, json: { error: "test unavailable" } }));
  await choose(a.title);
  await page.getByRole("button", { name: "重试打开" }).waitFor();
  assert.equal(await title.inputValue(), b.title);
  await shot("desktop-detail-error");
  await context.unroute(`**/api/documents/${a.id}`);
  await page.getByRole("button", { name: "重试打开" }).click();
  await waitFor(async () => (await title.inputValue()) === a.title, "detail retry failed");
  await context.route("**/api/documents", (route) => route.fulfill({ status: 503, json: { error: "test unavailable" } }));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("button", { name: "重试列表" }).waitFor();
  await shot("desktop-history-error");
  await context.unroute("**/api/documents");
  await page.getByRole("button", { name: "重试列表" }).click();
  await waitFor(async () => !(await page.getByRole("button", { name: "重试列表" }).count()), "history retry failed");
  check("detail/list error and independent retry states");

  await page.setViewportSize({ width: 390, height: 844 });
  await choose(a.title);
  await waitFor(async () => !(await text.isDisabled()), "mobile session not ready");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("mobile-history-selected");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await read.click();
  await waitFor(async () => (await read.innerText()).includes("暂停朗读"), "mobile play failed");
  assert.ok(await page.getByRole("button", { name: "下一段", exact: true }).isVisible());
  await shot("mobile-playing");
  await newSession.click();
  await shot("mobile-new");
  await title.fill("手机保存验收");
  await text.fill("这是手机上的独立会话。保存后仍可以从历史列表找回。");
  await save.click();
  await waitFor(async () => await save.isDisabled() && !(await text.isDisabled()), "mobile save failed");
  await shot("mobile-saved");
  await page.reload();
  await choose("手机保存验收");
  await waitFor(async () => (await title.inputValue()) === "手机保存验收", "mobile refresh persistence failed");
  await shot("mobile-refreshed");
  await page.getByRole("button", { name: "添加声音", exact: true }).click();
  await shot("mobile-voice-modal");
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  let releaseMobileList;
  await context.route("**/api/documents", async (route) => {
    await new Promise((resolve) => { releaseMobileList = resolve; });
    await route.fulfill({ status: 503, json: { error: "test unavailable" } });
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await waitFor(async () => Boolean(releaseMobileList), "list not held");
  await shot("mobile-history-loading");
  releaseMobileList();
  await page.getByRole("button", { name: "重试列表" }).waitFor();
  await shot("mobile-history-error");
  await context.unroute("**/api/documents");
  await page.getByRole("button", { name: "重试列表" }).click();
  await waitFor(async () => !(await page.getByRole("button", { name: "重试列表" }).count()), "mobile list retry failed");
  let releaseMobileDetail;
  await context.route(`**/api/documents/${a.id}`, async (route) => {
    await new Promise((resolve) => { releaseMobileDetail = resolve; });
    await route.fulfill({ status: 503, json: { error: "test unavailable" } });
  });
  await choose(a.title);
  await waitFor(async () => Boolean(releaseMobileDetail), "mobile detail not held");
  await shot("mobile-detail-loading");
  releaseMobileDetail();
  await page.getByRole("button", { name: "重试打开" }).waitFor();
  await shot("mobile-detail-error");
  await context.unroute(`**/api/documents/${a.id}`);
  await page.getByRole("button", { name: "重试打开" }).click();
  await waitFor(async () => (await title.inputValue()) === a.title, "mobile detail retry failed");
  await newSession.click();
  await text.fill("手机上正在保存的会话。");
  await context.route("**/api/documents", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise((resolve) => { releaseSave = resolve; });
    await route.continue();
  });
  releaseSave = undefined;
  await save.click();
  await waitFor(async () => Boolean(releaseSave), "mobile save not held");
  await shot("mobile-saving");
  releaseSave();
  await waitFor(async () => await save.isDisabled() && !(await text.isDisabled()), "mobile save failed");
  await context.unroute("**/api/documents");
  await context.route("**/api/documents", (route) => route.fulfill({ json: { documents: [] } }));
  await newSession.click();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByText("还没有会话。", { exact: false }).waitFor();
  await shot("mobile-history-empty");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot("desktop-history-empty");
  let releaseDesktopList;
  await context.unroute("**/api/documents");
  await context.route("**/api/documents", async (route) => {
    await new Promise((resolve) => { releaseDesktopList = resolve; });
    await route.continue();
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await waitFor(async () => Boolean(releaseDesktopList), "desktop list not held");
  await shot("desktop-history-loading");
  releaseDesktopList();
  await waitFor(async () => (await history.count()) > 0, "desktop list did not return");
  await context.unroute("**/api/documents");
  assert.deepEqual(pageErrors, []);
  check("390x844 mobile layout, visible transport, save/refresh persistence, modal and empty state; no page errors");
  await writeFile(path.join(output, "report.json"), JSON.stringify({
    result: "PASS", checks, screenshots, viewports: ["1440x1000", "390x844"],
    ttsCalls, providerCalls: 0, store: dataDir, browser: await browser.version(),
  }, null, 2));
  console.log(`EVIDENCE ${output}`);
} catch (error) {
  console.error(`FAIL evidence directory: ${output}`);
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  log.end();
}
