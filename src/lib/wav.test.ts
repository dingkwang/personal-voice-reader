import { describe, expect, it } from "vitest";
import { encodePcmWav } from "./wav";

describe("encodePcmWav", () => {
  it("writes a mono 24 kHz PCM WAV", async () => {
    const bytes = new Uint8Array(await encodePcmWav(new Float32Array([-1, 0, 1])).arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(24000);
    expect(new DataView(bytes.buffer).getUint16(22, true)).toBe(1);
    expect(bytes.byteLength).toBe(50);
  });
});
