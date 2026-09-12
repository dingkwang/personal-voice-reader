const END_MARK = /[。！？!?；;：:.]$/;
// Keep decimal numbers intact while treating ordinary English full stops as ends.
const SENTENCE_PATTERN = /[^。！？!?；;：:\n.]+(?:[。！？!?；;：:]|(?<!\d)\.(?!\d))?|\n+/g;

export type ChunkOptions = {
  targetLength?: number;
  maxLength?: number;
};

function hardSplit(text: string, maxLength: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();

  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength + 1);
    const candidates = [
      window.lastIndexOf("，"),
      window.lastIndexOf(","),
      window.lastIndexOf(" "),
    ];
    const best = Math.max(...candidates);
    const cut = best >= Math.floor(maxLength * 0.55) ? best + 1 : maxLength;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

export function chunkText(
  input: string,
  { targetLength = 800, maxLength = 1200 }: ChunkOptions = {},
): string[] {
  if (targetLength < 1 || maxLength < targetLength) {
    throw new Error("Invalid chunk length configuration");
  }

  const normalized = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) return [];
  const paragraphs = normalized.split(/\n\s*\n/);
  if (paragraphs.length > 1) return paragraphs.flatMap((paragraph) => chunkText(paragraph, { targetLength, maxLength }));

  // Protect decimal points while using the same sentence scanner for English.
  const protectedText = normalized.replace(/(\d)\.(\d)/g, "$1\uE000$2");
  const units = (protectedText.match(SENTENCE_PATTERN) ?? [protectedText])
    .map((part) => part.replace(/\uE000/g, ".").trim())
    .filter(Boolean)
    .flatMap((part) => hardSplit(part, maxLength));

  const chunks: string[] = [];
  let current = "";

  for (const unit of units) {
    const separator = current && !END_MARK.test(current) ? " " : "";
    const candidate = `${current}${separator}${unit}`;

    if (current && candidate.length > targetLength) {
      chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);

  if (
    chunks.length > 1 &&
    chunks.at(-1)!.length < 60 &&
    chunks.at(-2)!.length + chunks.at(-1)!.length <= maxLength
  ) {
    const tail = chunks.pop()!;
    chunks[chunks.length - 1] = `${chunks.at(-1)} ${tail}`;
  }

  return chunks;
}

export function inferTitle(text: string): string {
  const firstLine = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) return "未命名文章";
  return firstLine.length > 34 ? `${firstLine.slice(0, 34)}…` : firstLine;
}
