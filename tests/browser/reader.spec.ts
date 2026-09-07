import { test, expect, type BrowserContext } from "@playwright/test";
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
test("unauthenticated APIs fail closed and deep-link login preserves return intent", async ({ page, context }) => {
  for (const route of ["/api/documents", "/api/voices", "/api/audio/unknown", "/api/jobs/unknown", "/api/mcp"]) {
    const response = await context.request.get(route);
    expect(response.status()).toBe(401);
  }
  const authorize = await context.request.get("/auth/login?returnTo=%2Fsessions%2Fdoc_synthetic", { maxRedirects: 0 });
  expect(authorize.status()).toBe(307);
  const location = new URL(authorize.headers().location);
  expect(location.origin).toBe("https://synthetic.auth0.com");
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  await page.route("**/auth/login**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Mock Auth0 login</h1>" }));
  const deepLink = await context.request.get("/sessions/doc_synthetic", { maxRedirects: 0 });
  expect(deepLink.status()).toBe(307);
  expect(deepLink.headers().location).toBe("/auth/login?returnTo=%2Fsessions%2Fdoc_synthetic");
  await page.goto(deepLink.headers().location);
  await expect(page.getByRole("heading", { name: "Mock Auth0 login" })).toBeVisible();
  await page.screenshot({ path: ".evidence/browser/desktop-auth-return.png" });
});
for (const width of [1440, 390]) {
  test(`saved history, durable progress, playback and logout at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await login(context);
    await page.goto("/api/health");
    await page.evaluate(async () => {
      const legacy = await caches.open("voice-note-v2-sessions");
      await legacy.put("/api/audio/old-private", new Response("synthetic old audio"));
    });
    await page.addInitScript(() => {
      const original = window.Audio;
      const elements: HTMLAudioElement[] = [];
      Object.assign(window, { __qaAudio: elements });
      window.Audio = class extends original {
        constructor(src?: string) { super(src); elements.push(this); }
      };
    });
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "文章标题" })).toBeVisible();
    await page.screenshot({ path: `.evidence/browser/${width}-default.png`, fullPage: true });
    const title = page.getByRole("textbox", { name: "文章标题" });
    const text = page.getByRole("textbox", { name: "要朗读的文字" });
    await title.fill(`合成验收 ${width}`);
    await text.fill(`这是${width}像素验收的第一段。只使用合成文字和合成音频。\n\n这是${width}像素验收的第二段，用来测试下一段、上一段和后台生成。\n\n这是${width}像素验收的第三段，生成后可重新打开会话继续听。`);
    await page.getByRole("button", { name: "保存会话", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "会话已保存" })).toBeVisible();
    const url = page.url();
    expect(url).toContain("/sessions/doc_");
    await page.locator(".primary-read-button").click();
    await expect(page.getByRole("status").filter({ hasText: "后台生成中" })).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: `.evidence/browser/${width}-queued.png`, fullPage: true });
    await expect(page.getByRole("button", { name: "暂停", exact: true })).toBeVisible({ timeout: 20000 });
    const firstPlayable = await (await context.request.get(`/api/documents/${url.split("/").at(-1)}`)).json();
    expect(firstPlayable.job.items.filter((item: { status: string }) => item.status === "ready").length).toBeGreaterThan(0);
    expect(firstPlayable.job.items.some((item: { status: string }) => item.status !== "ready")).toBe(true);
    await page.screenshot({ path: `.evidence/browser/${width}-first-playable.png`, fullPage: true });
    // Disconnect browser while Workflow owns generation, then reconnect by URL.
    await page.goto("about:blank");
    await page.goto(url);
    await expect(title).toHaveValue(`合成验收 ${width}`);
    await expect(page.getByRole("status").filter({ hasText: "音频已就绪" })).toBeVisible({ timeout: 45000 });
    await expect(page.locator(".segment")).toHaveCount(3);
    const playbackState = await page.evaluate(() => {
      const elements = (window as unknown as { __qaAudio: HTMLAudioElement[] }).__qaAudio;
      return { allPaused: elements.every((audio) => audio.paused), prefetch: elements.some((audio) => audio.preload === "auto" && audio.src.includes("/api/audio/")) };
    });
    expect(playbackState.allPaused).toBe(true);
    expect(playbackState.prefetch).toBe(true);
    await page.locator(".primary-read-button").click();
    await expect(page.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.getByRole("button", { name: "下一段", exact: true }).click();
    await expect(page.locator(".now-playing")).toContainText("第 2 段");
    await page.getByRole("button", { name: "上一段", exact: true }).click();
    await expect(page.locator(".now-playing")).toContainText("第 1 段");
    const seek = page.locator(".time-control input");
    await expect(seek).toBeEnabled();
    await seek.fill("2");
    await page.screenshot({ path: `.evidence/browser/${width}-playback.png`, fullPage: true });
    await page.getByRole("button", { name: "新建会话", exact: true }).click();
    await text.fill("未保存的合成草稿");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator(".history-item").filter({ hasText: `合成验收 ${width}` }).click();
    await expect(text).toHaveValue("未保存的合成草稿");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator(".history-item").filter({ hasText: `合成验收 ${width}` }).click();
    await expect(title).toHaveValue(`合成验收 ${width}`);
    const sessionId = url.split("/").at(-1);
    const body = await (await context.request.get(`/api/documents/${sessionId}`)).json();
    const audioUrl = body.document.segments[0].audioUrl;
    const range = await context.request.get(audioUrl, { headers: { Range: "bytes=1-20" } });
    expect(range.status()).toBe(206);
    expect((await range.body()).length).toBe(20);
    expect(range.headers()["cache-control"]).toContain("no-store");
    // The real service worker must store only static assets.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if ((await caches.keys()).includes("voice-note-v2-sessions")) throw new Error("Old cache not removed");
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        if ((await cache.keys()).some((request) => !new URL(request.url).pathname.startsWith("/_next/static/"))) throw new Error("Private cache entry");
      }
    });
    const crossSiteLogout = await context.request.get("/auth/logout", { maxRedirects: 0, headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(crossSiteLogout.status()).toBe(403);
    const logout = await context.request.get("/auth/logout", { maxRedirects: 0 });
    expect(logout.status()).toBe(307);
    expect(logout.headers()["clear-site-data"]).toContain("storage");
    expect((await context.request.get(audioUrl)).status()).toBe(401);
    await context.setOffline(true);
    const offline = await page.evaluate(async (url) => {
      try { return (await fetch(url)).status; } catch { return 0; }
    }, audioUrl);
    expect(offline).toBe(0);
    await context.setOffline(false);
  });
}

test("TXT snapshots and late task responses cannot replace a new session", async ({ page, context }) => {
  await login(context);
  await page.goto("/");
  const text = page.getByRole("textbox", { name: "要朗读的文字" });
  const title = page.getByRole("textbox", { name: "文章标题" });
  await page.getByRole("button", { name: "上传 TXT" }).setInputFiles({
    name: "synthetic-import.txt", mimeType: "text/plain", buffer: Buffer.from("这是一段 TXT 合成验收。"),
  });
  await expect(title).toHaveValue("synthetic-import");
  await page.getByRole("button", { name: "保存会话", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "会话已保存" })).toBeVisible();
  const oldUrl = page.url();
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let arrived: () => void = () => {};
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route("**/api/tts", async (route) => {
    const response = await route.fetch();
    arrived();
    await hold;
    await route.fulfill({ response });
  });
  await page.locator(".primary-read-button").click();
  await arrival;
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await title.fill("新的合成快照");
  await text.fill("切换会话后，不接收旧生成结果。");
  await page.getByRole("button", { name: "保存会话", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "会话已保存" })).toBeVisible();
  const newUrl = page.url();
  expect(newUrl).not.toBe(oldUrl);
  release();
  await page.waitForTimeout(3500);
  await expect(title).toHaveValue("新的合成快照");
  await expect(page.locator(".primary-read-button")).toHaveText("开始朗读");
  expect(page.url()).toBe(newUrl);
  await title.fill("修改后的合成快照");
  await page.getByRole("button", { name: "保存会话", exact: true }).click();
  await expect(page).not.toHaveURL(newUrl);
  await expect(page.locator(".history-item").filter({ hasText: "新的合成快照" })).toHaveCount(1);
  await page.screenshot({ path: ".evidence/browser/desktop-stale-response-snapshots.png", fullPage: true });
  await page.getByRole("button", { name: "添加声音", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: ".evidence/browser/desktop-voice-modal.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".evidence/browser/mobile-voice-modal.png", fullPage: true });
});

test("uncertain generation exposes explicit retry without another provider request", async ({ page, context }) => {
  await login(context);
  await page.goto("/");
  await page.getByRole("textbox", { name: "文章标题" }).fill("合成失败状态");
  await page.getByRole("textbox", { name: "要朗读的文字" }).fill("[[synthetic-failure]] 此请求模拟超时，不调用真实服务。");
  await page.locator(".primary-read-button").click();
  await expect(page.getByRole("button", { name: "重试第 1 段" })).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: ".evidence/browser/desktop-uncertain-retry.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".evidence/browser/mobile-uncertain-retry.png", fullPage: true });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "重试第 1 段" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "请等待十分钟" })).toBeVisible();
});

test("closing a voice dialog isolates its late completion", async ({ page, context }) => {
  await login(context);
  await page.goto("/");
  await page.getByRole("button", { name: "添加声音", exact: true }).click();
  await page.getByLabel("声音名称").fill("合成迟到声音");
  await page.getByLabel("Fish Voice ID").fill("synthetic-reference-2");
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let arrived: () => void = () => {};
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route("**/api/voices", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    arrived();
    await hold;
    await route.fulfill({ json: { voice: { id: "voice_late", name: "合成迟到声音", provider: "fish",
      providerVoiceId: "synthetic-reference-2", language: "zh", source: "linked", createdAt: "2026-09-06T00:00:00Z" } } });
  });
  await page.getByRole("button", { name: "保存声音" }).click();
  await arrival;
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("textbox", { name: "要朗读的文字" }).fill("保留新的合成草稿");
  release();
  await page.waitForTimeout(200);
  await expect(page.getByRole("combobox", { name: "朗读声音" })).toHaveValue("voice_browser");
  await expect(page.getByRole("textbox", { name: "要朗读的文字" })).toHaveValue("保留新的合成草稿");
});
