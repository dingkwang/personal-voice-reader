import { afterEach, expect, it, vi } from "vitest";
import { appOrigin, fishApiKey, validateCloudEnvironment } from "./config";
import { AppError } from "./errors";
import { database } from "./db";
afterEach(() => vi.unstubAllEnvs());
it("never falls back to a JSON data directory without a database", () => {
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("VOICE_READER_DATA_DIR", "/not-used");
  expect(() => database()).toThrow("DATABASE_URL");
});
it("rejects production configuration and cross-environment resource mismatch", () => {
  for (const key of ["DATABASE_URL", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_OWNER_SUB", "AUTH0_AUDIENCE",
    "AUTH0_MCP_CLIENT_ID", "BLOB_READ_WRITE_TOKEN", "DEFAULT_VOICE_ID", "CRON_SECRET", "FISH_API_KEY"]) vi.stubEnv(key, "synthetic");
  vi.stubEnv("AUTH0_SECRET", "0".repeat(64));
  vi.stubEnv("AUTH0_DOMAIN", "synthetic.auth0.com");
  vi.stubEnv("APP_BASE_URL", "https://synthetic.test");
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("RESOURCE_ENV", "preview");
  expect(() => validateCloudEnvironment()).toThrow();
  vi.stubEnv("RESOURCE_ENV", "production");
  expect(() => validateCloudEnvironment()).not.toThrow();
  vi.stubEnv("AUTH0_OWNER_SUB", "");
  expect(() => validateCloudEnvironment()).toThrow();
});
it("accepts a fully configured environment without any Fish credential", () => {
  // Preview/development deliberately run with no Fish key; only generation
  // operations may require it, never global validation or read/status routes.
  for (const key of ["DATABASE_URL", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_OWNER_SUB", "AUTH0_AUDIENCE",
    "AUTH0_MCP_CLIENT_ID", "BLOB_READ_WRITE_TOKEN", "DEFAULT_VOICE_ID", "CRON_SECRET"]) vi.stubEnv(key, "synthetic");
  vi.stubEnv("AUTH0_SECRET", "0".repeat(64));
  vi.stubEnv("AUTH0_DOMAIN", "synthetic.auth0.com");
  vi.stubEnv("APP_BASE_URL", "https://synthetic.test");
  vi.stubEnv("APP_ENV", "preview");
  vi.stubEnv("RESOURCE_ENV", "preview");
  vi.stubEnv("FISH_API_KEY", "");
  vi.stubEnv("FISH_AUDIO_API_KEY", "");
  expect(() => validateCloudEnvironment()).not.toThrow();
});
it("fails Fish operations closed with 503 PROVIDER_NOT_CONFIGURED at the boundary", () => {
  vi.stubEnv("FISH_API_KEY", "");
  vi.stubEnv("FISH_AUDIO_API_KEY", "");
  let caught: unknown;
  try { fishApiKey(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).status).toBe(503);
  expect((caught as AppError).code).toBe("PROVIDER_NOT_CONFIGURED");
  vi.stubEnv("FISH_AUDIO_API_KEY", "synthetic-fallback");
  expect(fishApiKey()).toBe("synthetic-fallback");
  vi.stubEnv("FISH_API_KEY", "synthetic-primary");
  expect(fishApiKey()).toBe("synthetic-primary");
});
it("rejects unsafe origins and non-root base URLs", () => {
  for (const value of ["http://public.test", "https://good.test/path", "https://user:password@good.test"]) {
    vi.stubEnv("APP_BASE_URL", value);
    expect(() => appOrigin()).toThrow();
  }
});
