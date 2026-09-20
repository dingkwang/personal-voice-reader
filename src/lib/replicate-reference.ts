import { AppError } from "./errors";
import { sha256 } from "./blob";

// Browser uploads are normalized locally. Accept only this bounded canonical
// PCM format, not untrusted WAV headers or a caller-supplied duration.
export function replicateReference(bytes: Buffer) {
  const invalid = () => new AppError("请上传 10–20 秒的单声道 24 kHz PCM16 WAV 录音", 422);
  if (bytes.length < 44 || bytes.length > 960_044 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString("ascii", 8, 16) !== "WAVEfmt " || bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== 24_000 || bytes.readUInt32LE(28) !== 48_000 ||
    bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 ||
    bytes.toString("ascii", 36, 40) !== "data" || bytes.readUInt32LE(40) !== bytes.length - 44 ||
    (bytes.length - 44) % 2 !== 0) throw invalid();
  const seconds = (bytes.length - 44) / 48_000;
  if (seconds < 10 || seconds > 20) throw invalid();
  return { bytes, seconds, hash: sha256(bytes) };
}
