import { sha256 } from "./blob";
// Property order and version retain compatibility with the JSON PoC cache.
export function audioKey(input: { provider: string; providerVoiceId: string | null; text: string; model: string; speed: number }) {
  return sha256(JSON.stringify({ version: 1, ...input }));
}

// JSONB changes key order. New provider keys must survive a database round-trip.
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
