// Test-only Node preload. Never imported by application code or deployed.
import { readFile, appendFile } from "node:fs/promises";
import { MockAgent, setGlobalDispatcher } from "undici";
if (process.env.VERCEL || !process.env.BROWSER_TEST_AUDIO || !process.env.BROWSER_TEST_LOG) throw new Error("Isolated browser harness only");
const original = globalThis.fetch;
const indexRequests = new Map();
const mp3 = await readFile(process.env.BROWSER_TEST_AUDIO);
const network = new MockAgent();
network.disableNetConnect();
network.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/);
network.get("https://vercel.com").intercept({ path: /\/api\/blob.*/, method: "PUT" }).reply((options) => {
  const url = new URL(options.path, "https://vercel.com");
  const pathname = url.searchParams.get("pathname") || url.pathname.replace("/api/blob/", "");
  return { statusCode: 200, data: JSON.stringify({ pathname, url: `https://synthetic.private.blob.vercel-storage.com/${pathname}`,
    downloadUrl: `https://synthetic.private.blob.vercel-storage.com/${pathname}?download=1`,
    contentType: "audio/mpeg", contentDisposition: "attachment", etag: '"synthetic"' }),
  responseOptions: { headers: { "Content-Type": "application/json" } } };
}).persist();
network.get("https://synthetic.private.blob.vercel-storage.com").intercept({ path: /.*/, method: "GET" }).reply((options) => {
  if (options.path.startsWith("/references/")) {
    const data = Buffer.from("RIFF0000WAVEsynthetic-reference");
    return { statusCode: 200, data, responseOptions: { headers: { "Content-Type": "audio/wav", "Content-Length": String(data.length) } } };
  }
  const headers = new Headers(options.headers);
  const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") || "");
  const body = match ? mp3.subarray(Number(match[1]), Number(match[2]) + 1) : mp3;
  return { statusCode: match ? 206 : 200, data: body, responseOptions: { headers: {
    "Content-Type": "audio/mpeg", "Content-Length": String(body.length), ETag: '"synthetic"',
    ...(match ? { "Content-Range": `bytes ${match[1]}-${match[2]}/${mp3.length}` } : {}),
  } } };
}).persist();
setGlobalDispatcher(network);
globalThis.fetch = async function(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "synthetic.modal.run") {
    const headers = new Headers(init?.headers);
    if (headers.get("Modal-Key") !== "synthetic-key" || headers.get("Modal-Secret") !== "synthetic-secret") return new Response(null, { status: 401 });
    if (url.pathname.endsWith("/audio")) return new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } });
    const first = indexRequests.get(url.pathname);
    if (!first) {
      indexRequests.set(url.pathname, Date.now());
      await appendFile(process.env.BROWSER_TEST_LOG, "mock-indextts-start\n");
      return Response.json({ status: "queued" });
    }
    return Response.json({ status: Date.now() - first > 5500 ? "ready" : "running" });
  }
  if (url.hostname === "api.fish.audio") {
    if (url.pathname !== "/v1/tts") throw new Error("Clone calls forbidden in automated tests");
    await appendFile(process.env.BROWSER_TEST_LOG, "mock-fish\n");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (String(init?.body || "").includes("[[synthetic-failure]]")) throw new Error("Synthetic provider timeout");
    return new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } });
  }
  if (url.hostname.endsWith(".private.blob.vercel-storage.com") && url.pathname.startsWith("/references/")) {
    return new Response("RIFF0000WAVEsynthetic-reference", { headers: { "Content-Type": "audio/wav" } });
  }
  if (url.hostname.endsWith(".private.blob.vercel-storage.com")) {
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") || "");
    const body = match ? mp3.subarray(Number(match[1]), Number(match[2]) + 1) : mp3;
    return new Response(body, { status: match ? 206 : 200, headers: {
      "Content-Type": "audio/mpeg", "Content-Length": String(body.length), ETag: '"synthetic"',
      ...(match ? { "Content-Range": `bytes ${match[1]}-${match[2]}/${mp3.length}` } : {}),
    } });
  }
  if (url.hostname === "blob.vercel-storage.com") {
    const pathname = url.searchParams.get("pathname") || url.pathname.slice(1);
    return Response.json({ pathname, url: `https://synthetic.private.blob.vercel-storage.com/${pathname}`,
      downloadUrl: `https://synthetic.private.blob.vercel-storage.com/${pathname}?download=1`,
      contentType: "audio/mpeg", contentDisposition: "attachment", etag: '"synthetic"' });
  }
  if (url.hostname === "synthetic.auth0.com" && url.pathname === "/.well-known/openid-configuration") {
    return Response.json({ issuer: "https://synthetic.auth0.com/", authorization_endpoint: "https://synthetic.auth0.com/authorize",
      token_endpoint: "https://synthetic.auth0.com/oauth/token", jwks_uri: "https://synthetic.auth0.com/.well-known/jwks.json",
      end_session_endpoint: "https://synthetic.auth0.com/oidc/logout", response_types_supported: ["code"],
      subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
  }
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("External network forbidden in browser tests");
  return original(input, init);
};
