import { test, expect, type BrowserContext } from "@playwright/test";
import { generateSessionCookie } from "@auth0/nextjs-auth0/testing";
import { readFile } from "node:fs/promises";
import { encodePcmWav } from "../../src/lib/wav";

const base = "http://127.0.0.1:3108";
async function login(context: BrowserContext, sub: string) {
  const secret = await readFile(".evidence/browser/test-secret", "utf8");
  const value = await generateSessionCookie({ user: { sub, name: "Synthetic" },
    tokenSet: { accessToken: "synthetic", expiresAt: Math.floor(Date.now() / 1000) + 3600, scope: "openid profile" },
  }, { secret });
  await context.addCookies([{ name: "__session", value, url: base, httpOnly: true, sameSite: "Lax" }]);
}

for (const width of [1440, 390]) {
  test(`Google user starts empty, uploads own voice, reads/downloads and cannot access another account at ${width}px`, async ({ page, context, browser }) => {
    test.setTimeout(120_000);
    const owner = await browser.newContext({ baseURL: base });
    try {
      await login(owner, "auth0|synthetic-browser");
      const saved = await owner.request.post("/api/documents", { headers: { Origin: base },
        data: { title: `Legacy private ${width}`, text: "原账号的合成私密文章。" } });
      const legacy = (await saved.json()).document;
      await login(context, `google-oauth2|browser-new-${width}`);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.goto("/");
      await expect(page.locator(".history-item")).toHaveCount(0);
      await expect(page.getByText("还没有声音。点击「添加」上传自己的录音。")).toBeVisible();
      await expect(page.locator(".private-chip")).toHaveText("我的私密会话");
      await expect(page.locator("#voice")).toHaveValue("");
      await page.screenshot({ path: `.evidence/browser/${width}-multi-user-empty.png`, fullPage: true });
      await page.getByRole("button", { name: "添加声音", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "语音服务" })).toHaveValue("replicate");
      await page.screenshot({ path: `.evidence/browser/${width}-multi-user-upload.png`, fullPage: true });
      await page.getByRole("combobox", { name: "语音服务" }).selectOption("fish");
      await expect(page.getByLabel("Fish Voice ID")).toHaveCount(0);
      await page.getByRole("combobox", { name: "语音服务" }).selectOption("replicate");
      await page.getByLabel("声音名称").fill("我的合成录音");
      // No external browser traffic. Only the Blob transport is simulated;
      // reservation, signed token permission and voice registration use real routes.
      let uploadedBytes = 0;
      await page.route("https://vercel.com/api/blob**", async (route) => {
        const req = route.request(), headers = req.headers();
        const pathname = new URL(req.url()).searchParams.get("pathname");
        const action = headers["x-mpu-action"];
        const body = action === "create" ? { uploadId: "synthetic-upload", key: pathname }
          : action === "upload" ? { etag: "synthetic-part" }
          : { pathname, url: `https://synthetic.private.blob.vercel-storage.com/${pathname}`,
            downloadUrl: `https://synthetic.private.blob.vercel-storage.com/${pathname}`, contentType: "audio/wav" };
        if (action === "upload") uploadedBytes += req.postDataBuffer()?.length || 0;
        await route.fulfill({ status: 200, json: body, headers: { "Access-Control-Allow-Origin": base } });
      });
      const wav = Buffer.from(await encodePcmWav(new Float32Array(24_000 * 12)).arrayBuffer());
      await page.locator(".file-pill input").setInputFiles({ name: "synthetic.wav", mimeType: "audio/wav", buffer: wav });
      await page.getByRole("button", { name: "保存声音", exact: true }).click();
      await expect(page.getByText("请确认你拥有并获准克隆这个声音")).toBeVisible();
      await page.screenshot({ path: `.evidence/browser/${width}-multi-user-consent-error.png`, fullPage: true });
      await page.locator(".consent-row input").check();
      let arrived!: () => void, release!: () => void;
      const registering = new Promise<void>((resolve) => { arrived = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      await page.route("**/api/voices", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch();
        arrived();
        await hold;
        await route.fulfill({ response });
      });
      await page.getByRole("button", { name: "保存声音", exact: true }).click();
      await registering;
      await expect(page.getByRole("button", { name: "正在创建…" })).toBeDisabled();
      await page.screenshot({ path: `.evidence/browser/${width}-multi-user-upload-loading.png`, fullPage: true });
      release();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15000 });
      expect(uploadedBytes).toBe(wav.length);
      const voice = await (await context.request.get("/api/voices")).json();
      expect(voice.voices).toHaveLength(1);
      expect(voice.voices[0].provider).toBe("replicate");
      expect(voice.defaultVoiceId).toBe(voice.voices[0].id);
      await page.getByRole("textbox", { name: "文章标题" }).fill(`我的合成阅读 ${width}`);
      await page.getByRole("textbox", { name: "要朗读的文字" }).fill(`新账号 ${width} 的合成文章。`);
      await page.locator(".primary-read-button").click();
      await expect(page.locator(".job-progress")).toContainText("音频已就绪", { timeout: 45000 });
      await page.getByRole("button", { name: "暂停", exact: true }).click();
      const id = page.url().split("/").at(-1)!;
      const detail = await (await context.request.get(`/api/documents/${id}`)).json();
      await page.screenshot({ path: `.evidence/browser/${width}-multi-user-ready.png`, fullPage: true });
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "下载整篇 WAV" }).click();
      expect((await download).suggestedFilename()).toMatch(/\.wav$/);
      const before = (await (await context.request.get("/api/documents")).json()).documents;
      const deny = [
        await context.request.get(`/api/documents/${legacy.id}`),
        await owner.request.get(`/api/documents/${id}`),
        await owner.request.get(`/api/jobs/${detail.job.id}`),
        await owner.request.get(`/api/jobs/${detail.job.id}/events`),
        await owner.request.get(detail.document.segments[0].audioUrl),
        await owner.request.patch("/api/voices", { headers: { Origin: base }, data: { voiceId: voice.defaultVoiceId } }),
      ];
      for (const response of deny) expect(response.status()).toBe(404);
      expect((await (await context.request.get("/api/documents")).json()).documents).toEqual(before);
      expect((await owner.request.get(`/api/documents/${legacy.id}`)).status()).toBe(200);
      expect((await context.request.get("/api/mcp")).status()).toBe(401); // Web cookie is not MCP OAuth.
      await page.goto(`/sessions/${legacy.id}`);
      await expect(page.getByRole("alert").filter({ hasText: "这条会话加载失败" })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "要朗读的文字" })).toHaveValue("");
      await page.screenshot({ path: `.evidence/browser/${width}-multi-user-denied.png`, fullPage: true });
    } finally { await owner.close(); }
  });
}
