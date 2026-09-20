import { test, expect } from "@playwright/test";
import { AuthorizationCodeGrantRequestError, InvalidStateError } from "@auth0/nextjs-auth0/errors";
import { loginFailureResponse, InvalidWebSession } from "../../src/lib/web-login";

// Render the production failure response with synthetic failures only.
// No real auth routes, provider redirects, browser profiles or credentials.
for (const width of [1440, 390]) {
  for (const [kind, error, title] of [
    ["session", new InvalidWebSession(), "登录凭据无效"],
    ["transaction", new InvalidStateError(), "登录验证未完成"],
    ["token", new AuthorizationCodeGrantRequestError(), "登录凭据验证未完成"],
    ["unknown", new Error("synthetic-private-payload"), "登录未完成"],
  ] as const) {
    test(`${kind} login failure and manual recovery at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const response = loginFailureResponse(error);
      const body = await response.text();
      const requests: string[] = [];
      let recoveryReferrer: string | undefined;
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== "http://127.0.0.1:3118") return route.abort();
        requests.push(url.pathname + url.search);
        if (url.pathname === "/auth/callback") return route.fulfill({
          // Next's existing global header wins over the route header in the
          // production build. Meta + rel=noreferrer must protect recovery too.
          status: response.status, headers: { ...Object.fromEntries(response.headers), "referrer-policy": "same-origin" }, body,
        });
        if (url.pathname === "/auth/login") {
          recoveryReferrer = request.headers().referer;
          return route.fulfill({ contentType: "text/html", body: "<h1>Synthetic login restart</h1>" });
        }
        return route.abort();
      });
      await page.goto("/auth/callback?code=synthetic-private-payload&returnTo=https://evil.test");
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
      await expect(page.getByRole("link", { name: "重新开始登录" })).toHaveAttribute("href", "/auth/login");
      await expect(page.locator("body")).not.toContainText("synthetic-private-payload");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(requests).toHaveLength(1);
      await page.screenshot({ path: testInfo.outputPath(`${kind}-${width}.png`), fullPage: true });
      if (kind === "session") {
        await expect(page.getByRole("link", { name: "使用其他账号登录" })).toHaveAttribute("href", "/auth/login?prompt=login");
        await page.getByRole("link", { name: "使用其他账号登录" }).click();
        await expect(page).toHaveURL("http://127.0.0.1:3118/auth/login?prompt=login");
      } else {
        await expect(page.getByRole("link", { name: "使用其他账号登录" })).toHaveCount(0);
        await page.getByRole("link", { name: "重新开始登录" }).click();
        await expect(page).toHaveURL("http://127.0.0.1:3118/auth/login");
      }
      await expect(page.getByRole("heading", { name: "Synthetic login restart" })).toBeVisible();
      expect(recoveryReferrer).toBeUndefined();
      expect(requests).toHaveLength(2);
    });
  }
}
