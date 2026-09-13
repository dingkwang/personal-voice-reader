import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { generateSessionCookie } from "@auth0/nextjs-auth0/testing";
import { readFile } from "node:fs/promises";

const base = "http://127.0.0.1:3108";
async function login(context: BrowserContext) {
  const secret = await readFile(".evidence/browser/test-secret", "utf8");
  const value = await generateSessionCookie({
    user: { sub: "auth0|synthetic-browser", name: "Synthetic" },
    tokenSet: { accessToken: "synthetic-test-only", expiresAt: Math.floor(Date.now() / 1000) + 3600, scope: "openid profile" },
  }, { secret });
  await context.addCookies([{ name: "__session", value, url: base, httpOnly: true, sameSite: "Lax" }]);
}
async function providerCount() {
  try { return (await readFile(".evidence/browser/provider-mock.log", "utf8")).split("\n").filter((line) => line === "mock-replicate-start").length; }
  catch { return 0; }
}
async function setup(page: Page, context: BrowserContext, name: string, failure = false) {
  await login(context);
  await page.addInitScript(() => {
    const Original = window.Audio;
    const elements: HTMLAudioElement[] = [];
    Object.assign(window, { __qaAudio: elements });
    window.Audio = class extends Original {
      constructor(src?: string) { super(src); elements.push(this); }
    };
  });
  const created = await context.request.post("/api/documents", { headers: { Origin: base }, data: {
    title: name, text: `${name} 第一段。\n\n${name} 第二段${failure ? " [[synthetic-regeneration-failure]]" : ""}。\n\n${name} 第三段。`,
  } });
  const document = (await created.json()).document;
  const queued = await context.request.post("/api/tts", { headers: { Origin: base }, data: {
    documentId: document.id, voiceId: "voice_replicate_browser", speed: 1, idempotencyKey: `source-${name}`,
  } });
  expect(queued.status()).toBe(202);
  await page.goto(`/sessions/${document.id}`);
  await expect(page.locator(".job-progress")).toContainText("音频已就绪", { timeout: 45000 });
  const snapshot = await (await context.request.get(`/api/documents/${document.id}`)).json();
  return { id: document.id as string, snapshot };
}
async function allPaused(page: Page) {
  return page.evaluate(() => (window as unknown as { __qaAudio: HTMLAudioElement[] }).__qaAudio.every((audio) => audio.paused));
}
async function download(page: Page) {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载整篇 WAV" }).click();
  const file = await event;
  expect(file.suggestedFilename()).toMatch(/\.wav$/);
  const bytes = await readFile((await file.path())!);
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.length).toBeGreaterThan(44);
}

for (const width of [1440, 390]) {
  test(`regeneration menu, selected segment, old playback, refresh and lost-response recovery at ${width}px`, async ({ page, context }) => {
    test.setTimeout(150000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const source = await setup(page, context, `重新生成合成验收${width}`);
    const before = source.snapshot.document.segments.map((item: { audioUrl: string }) => item.audioUrl);
    const initialCount = await providerCount();
    const posts: Record<string, unknown>[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/regenerate") && request.method() === "POST") posts.push(request.postDataJSON());
    });
    await page.screenshot({ path: `.evidence/browser/${width}-regeneration-default.png`, fullPage: true });
    const single = page.getByRole("button", { name: "重新生成当前段落", exact: true });
    const whole = page.getByRole("button", { name: "重新生成整篇", exact: true });
    await expect(single).toBeVisible();
    await expect(whole).toBeVisible();
    const singleBox = await single.boundingBox();
    const wholeBox = await whole.boundingBox();
    expect(wholeBox!.x - singleBox!.x - singleBox!.width).toBeGreaterThanOrEqual(32);
    await expect(single).toBeEnabled();
    await page.screenshot({ path: `.evidence/browser/${width}-regeneration-menu.png`, fullPage: true });
    expect(posts).toHaveLength(0);
    const title = page.getByRole("textbox", { name: "文章标题" });
    await title.fill("未保存标题");
    await expect(single).toBeDisabled();
    await expect(page.locator("#regeneration-reason")).toContainText("未保存");
    await title.fill(source.snapshot.document.title);
    await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_browser");
    await expect(single).toBeDisabled();
    await expect(page.locator("#regeneration-reason")).toContainText("设置不同");
    await page.screenshot({ path: `.evidence/browser/${width}-regeneration-disabled.png`, fullPage: true });
    await page.getByRole("combobox", { name: "朗读声音" }).selectOption("voice_replicate_browser");
    await page.locator(".segment").nth(1).click();
    await expect(page.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("第 2 段");
      expect(dialog.message()).toContain("新的费用");
      expect(dialog.message()).toContain("Replicate 合成验收声音");
      await dialog.dismiss();
    });
    await single.click();
    expect(posts).toHaveLength(0);
    expect(await allPaused(page)).toBe(false);
    page.once("dialog", (dialog) => dialog.accept());
    await single.click();
    await expect(page.locator(".job-progress")).toContainText("重新生成");
    await expect(single).toBeDisabled();
    expect(await allPaused(page)).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].segmentId).toBe(source.snapshot.document.segments[1].id);
    const during = await (await context.request.get(`/api/documents/${source.id}`)).json();
    expect(during.document.segments.map((item: { audioUrl: string }) => item.audioUrl)).toEqual(before);
    expect(during.job.items.map((item: { status: string }) => item.status)).toEqual(["ready", expect.stringMatching(/queued|working/), "ready"]);
    await page.screenshot({ path: `.evidence/browser/${width}-regeneration-progress.png`, fullPage: true });
    await download(page);
    // Refresh during generation must preserve old ready audio and never autoplay.
    await page.reload();
    await expect(page.locator(".segment-state.ready")).toHaveCount(3);
    expect(await allPaused(page)).toBe(true);
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await expect(page.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "整篇循环" }).check();
    await page.locator(".segment").nth(2).click();
    await expect(page.locator(".segment.active .segment-number")).toHaveText("03");
    await page.evaluate(() => {
      const audio = (window as unknown as { __qaAudio: HTMLAudioElement[] }).__qaAudio.findLast((audio) => !audio.paused);
      audio?.dispatchEvent(new Event("ended"));
    });
    await expect(page.locator(".segment.active .segment-number")).toHaveText("01");
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(page.locator(".job-progress")).toContainText("音频已就绪", { timeout: 40000 });
    expect(await allPaused(page)).toBe(true);
    expect(await providerCount()).toBe(initialCount + 1);
    const updated = await (await context.request.get(`/api/documents/${source.id}`)).json();
    const urls = updated.document.segments.map((item: { audioUrl: string }) => item.audioUrl);
    expect(urls[0]).toBe(before[0]); expect(urls[2]).toBe(before[2]); expect(urls[1]).not.toBe(before[1]);
    // Playback keeps the regenerated key, including its metadata and preloads.
    await page.locator(".segment").nth(1).click();
    await expect(page.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __qaAudio: HTMLAudioElement[] }).__qaAudio.findLast((audio) => !audio.paused)?.getAttribute("src"))).toBe(urls[1]);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.screenshot({ path: `.evidence/browser/${width}-regeneration-success.png`, fullPage: true });
    // Lose an accepted POST response, reload, then explicitly recover the same key.
    let lose = true;
    await page.route("**/regenerate", async (route) => {
      const response = await route.fetch();
      if (lose) { lose = false; await route.abort("failed"); }
      else await route.fulfill({ response });
    });
    page.once("dialog", (dialog) => { expect(dialog.message()).toContain("共 3 段"); return dialog.accept(); });
    await whole.click();
    await expect(page.getByRole("button", { name: "恢复原请求" })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("button", { name: "恢复原请求" })).toBeVisible();
    await page.screenshot({ path: `.evidence/browser/${width}-regeneration-recovery.png`, fullPage: true });
    await page.getByRole("button", { name: "恢复原请求" }).click();
    await expect(page.getByRole("button", { name: "恢复原请求" })).toHaveCount(0);
    expect(posts).toHaveLength(3);
    expect(posts[2]).toEqual(posts[1]);
    await expect(page.locator(".job-progress")).toContainText("音频已就绪", { timeout: 45000 });
    expect(await providerCount()).toBe(initialCount + 4);
    expect(await allPaused(page)).toBe(true);
    const final = await (await context.request.get(`/api/documents/${source.id}`)).json();
    expect(final.job.items.map((item: { segment_id: string }) => item.segment_id)).toEqual(source.snapshot.job.items.map((item: { segment_id: string }) => item.segment_id));
    expect(final.document.segments.every((item: { audioUrl: string }, i: number) => item.audioUrl !== urls[i])).toBe(true);
    for (const url of before) expect((await context.request.get(url)).status()).toBe(200);
    await download(page);
  });
}

test("failed regeneration preserves refreshed playback/download and rejects CSRF or changed settings", async ({ page, context }) => {
  const source = await setup(page, context, "失败重新生成合成验收", true);
  const before = source.snapshot.document.segments.map((item: { audioUrl: string }) => item.audioUrl);
  const payload = { scope: "segment", segmentId: source.snapshot.document.segments[1].id,
    sourceJobId: source.snapshot.job.id, voiceId: "voice_replicate_browser", speed: 1,
    idempotencyKey: "browser-regeneration-failure", acknowledgeBilling: true };
  const url = `/api/documents/${source.id}/regenerate`;
  expect((await context.request.post(url, { data: payload })).status()).toBe(403);
  expect((await context.request.post(url, { headers: { Origin: base }, data: { ...payload, speed: 1.1 } })).status()).toBe(409);
  expect((await context.request.post(url, { headers: { Origin: base }, data: { ...payload, segmentId: "other-segment" } })).status()).toBe(404);
  const start = await context.request.post(url, { headers: { Origin: base }, data: payload });
  expect(start.status()).toBe(202);
  await page.reload();
  await expect(page.getByRole("button", { name: "重试第 2 段" })).toBeVisible({ timeout: 30000 });
  await page.reload();
  await expect(page.locator(".segment-state.ready")).toHaveCount(3);
  expect((await (await context.request.get(`/api/documents/${source.id}`)).json()).document.segments.map((item: { audioUrl: string }) => item.audioUrl)).toEqual(before);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.screenshot({ path: `.evidence/browser/${width}-regeneration-error.png`, fullPage: true });
  }
  await page.locator(".segment").nth(1).click();
  await expect(page.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await download(page);
});
