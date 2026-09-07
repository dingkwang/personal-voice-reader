import { AppError } from "./errors";

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new AppError(`服务配置缺失：${name}`, 503, "CONFIGURATION_REQUIRED");
  return value;
}

export function ownerSubject() {
  return required("AUTH0_OWNER_SUB");
}

export function appOrigin() {
  const url = new URL(required("APP_BASE_URL"));
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && !process.env.VERCEL))) {
    throw new AppError("APP_BASE_URL 必须是安全的站点地址", 503, "INVALID_CONFIGURATION");
  }
  return url.origin;
}

export function issuer() {
  const domain = required("AUTH0_DOMAIN");
  if (!/^[a-zA-Z0-9.-]+$/.test(domain)) throw new AppError("AUTH0_DOMAIN 格式错误", 503);
  return `https://${domain}/`;
}

export function validateCloudEnvironment() {
  for (const name of ["DATABASE_URL", "APP_ENV", "RESOURCE_ENV", "AUTH0_OWNER_SUB",
    "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET",
    "AUTH0_AUDIENCE", "AUTH0_MCP_CLIENT_ID", "BLOB_READ_WRITE_TOKEN",
    "DEFAULT_VOICE_ID", "CRON_SECRET"]) required(name);
  appOrigin();
  issuer();
  if (!process.env.FISH_API_KEY && !process.env.FISH_AUDIO_API_KEY) required("FISH_API_KEY");
  if (!/^[a-f0-9]{64}$/i.test(required("AUTH0_SECRET")) ||
    process.env.APP_ENV !== process.env.RESOURCE_ENV ||
    (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== process.env.APP_ENV)) {
    throw new AppError("环境隔离配置不匹配", 503, "INVALID_CONFIGURATION");
  }
  if (process.env.VERCEL && process.env.TEST_MODE) throw new AppError("线上禁止测试模式", 503);
}

export async function validateResourceIdentity() {
  validateCloudEnvironment();
  const { database } = await import("./db");
  const { rows } = await database().query<{ project: string; environment: string }>("SELECT project,environment FROM deployment_identity");
  if (rows.length !== 1 || rows[0].project !== "personal-voice-reader" || rows[0].environment !== required("APP_ENV")) {
    throw new AppError("资源环境不匹配", 503, "RESOURCE_MISMATCH");
  }
}
