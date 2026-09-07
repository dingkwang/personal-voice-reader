import { expect, it, vi } from "vitest";
import { putAudio, sha256, streamAudio } from "./blob";
const mocks = vi.hoisted(() => ({ put: vi.fn(), head: vi.fn(), get: vi.fn() }));
vi.mock("@vercel/blob", () => mocks);
it("uses byte-content hashes, private immutable paths and safe repeated PUTs", async () => {
  const bytes = new Uint8Array([1, 2]).buffer;
  mocks.put.mockResolvedValueOnce({});
  const one = await putAudio("owner", bytes);
  expect(one.objectHash).toBe(sha256(new Uint8Array(bytes)));
  expect(mocks.put).toHaveBeenCalledWith(one.pathname, bytes, expect.objectContaining({ access: "private", allowOverwrite: false, addRandomSuffix: false }));
  mocks.put.mockRejectedValueOnce(new Error("Already exists"));
  mocks.head.mockResolvedValueOnce({ size: 2, contentType: "audio/mpeg" });
  expect(await putAudio("owner", bytes)).toEqual(one);
});
it("does not mislabel an ignored upstream Range as 206", async () => {
  const cancel = vi.fn();
  mocks.get.mockResolvedValueOnce({ stream: new ReadableStream({ cancel }), headers: new Headers() });
  await expect(streamAudio(new Request("https://example.test/audio", { headers: { Range: "bytes=1-2" } }),
    { pathname: "audio/test", size: 4, object_hash: "a".repeat(64) })).rejects.toMatchObject({ status: 502 });
  expect(cancel).toHaveBeenCalled();
});
