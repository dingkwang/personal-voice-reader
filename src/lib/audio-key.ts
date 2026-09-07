import { sha256 } from "./blob";
// Property order and version retain compatibility with the JSON PoC cache.
export function audioKey(input: { provider: string; providerVoiceId: string | null; text: string; model: string; speed: number }) {
  return sha256(JSON.stringify({ version: 1, ...input }));
}
