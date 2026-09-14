import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: ["reader-start.spec.ts", "login-failure.spec.ts"],
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  outputDir: ".evidence/reader-start/results",
  use: {
    baseURL: "http://127.0.0.1:3118",
    serviceWorkers: "block",
    launchOptions: { executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/reader-browser-server.mjs",
    url: "http://127.0.0.1:3118",
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
