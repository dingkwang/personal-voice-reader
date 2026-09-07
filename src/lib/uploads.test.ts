import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { cloneUploadedVoice, reserveUpload, uploadPermission } from "./uploads";
import { randomUUID } from "node:crypto";
const mocks = vi.hoisted(() => ({ head: vi.fn(), get: vi.fn(), cloneVoice: vi.fn() }));
vi.mock("@vercel/blob", () => ({ head: mocks.head, get: mocks.get }));
vi.mock("./providers", () => ({ getVoiceProvider: () => ({ cloneVoice: mocks.cloneVoice }) }));
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => {
  fixture = await testDatabase();
  mocks.head.mockReset().mockResolvedValue({ size: 4, contentType: "audio/mpeg" });
  mocks.get.mockReset().mockImplementation(async () => ({ stream: new Response(new Uint8Array([1, 2, 3, 4])).body }));
  mocks.cloneVoice.mockReset().mockResolvedValue({ providerVoiceId: "new-synthetic-reference" });
});
afterEach(async () => fixture.close());
it("limits upload tokens to a reserved private owner prefix, size, type, and lifetime", async () => {
  const upload = await reserveUpload({ size: 4, contentType: "audio/mpeg" }, TEST_OWNER);
  const permission = await uploadPermission(upload.id, upload.pathname, TEST_OWNER);
  expect(permission).toMatchObject({ maximumSizeInBytes: 4, allowedContentTypes: ["audio/mpeg"], allowOverwrite: false });
  await expect(uploadPermission(upload.id, "https://attacker.test/private", TEST_OWNER)).rejects.toMatchObject({ status: 403 });
  await expect(uploadPermission(upload.id, upload.pathname, "other")).rejects.toMatchObject({ status: 403 });
  await fixture.db.query("UPDATE uploads SET expires_at=now()-interval '1 second'");
  await expect(uploadPermission(upload.id, upload.pathname, TEST_OWNER)).rejects.toMatchObject({ status: 403 });
});
it("processes only owned uploads and never repeats a clone request", async () => {
  const upload = await reserveUpload({ size: 4, contentType: "audio/mpeg" }, TEST_OWNER);
  const input = { uploadIds: [upload.id], name: "Synthetic clone", language: "zh", consent: true as const, idempotencyKey: randomUUID() };
  const voice = await cloneUploadedVoice(input, TEST_OWNER);
  expect(await cloneUploadedVoice(input, TEST_OWNER)).toEqual(voice);
  expect(mocks.cloneVoice).toHaveBeenCalledTimes(1);
  expect(mocks.get).toHaveBeenCalledWith(upload.pathname, { access: "private" });
});
it("does not fetch anything for arbitrary unregistered object IDs", async () => {
  await expect(cloneUploadedVoice({ uploadIds: [randomUUID()], name: "Synthetic", consent: true, language: "zh", idempotencyKey: randomUUID() }, TEST_OWNER)).rejects.toMatchObject({ status: 422 });
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.cloneVoice).not.toHaveBeenCalled();
});
