import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 90_000,
  reporter: [["list"], ["json", { outputFile: ".evidence/browser/results.json" }]],
  outputDir: ".evidence/browser/results",
  use: {
    baseURL: "http://127.0.0.1:3108",
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/browser-server.mjs",
    url: "http://127.0.0.1:3108/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
