import { expect, it } from "vitest";
import { encodePcmWav } from "./wav";
import { replicateReference } from "./replicate-reference";

it.each([10, 12, 20])("accepts canonical bounded PCM at %s seconds without a provider", async (seconds) => {
  const bytes = Buffer.from(await encodePcmWav(new Float32Array(24_000 * seconds)).arrayBuffer());
  expect(replicateReference(bytes)).toMatchObject({ bytes, seconds });
});
it.each([0, 9, 21])("rejects out-of-bounds duration: %s", async (seconds) => {
  const bytes = Buffer.from(await encodePcmWav(new Float32Array(24_000 * seconds)).arrayBuffer());
  expect(() => replicateReference(bytes)).toThrow();
});
it.each([0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40])("rejects tampered PCM headers at byte %s", async (offset) => {
  const bytes = Buffer.from(await encodePcmWav(new Float32Array(24_000 * 12)).arrayBuffer());
  bytes[offset] ^= 255;
  expect(() => replicateReference(bytes)).toThrow();
});
