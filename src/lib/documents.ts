import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chunkText, inferTitle } from "./chunker";
import { AppError } from "./errors";
import type { ReaderDocument } from "./types";

export const documentSchema = z.object({
  title: z.string().trim().max(100).optional(),
  text: z.string().trim().min(1).max(100_000),
});
export function makeDocument(input: z.infer<typeof documentSchema>): ReaderDocument {
  const chunks = chunkText(input.text);
  if (!chunks.length) throw new AppError("没有找到可朗读的文字");
  const id = `doc_${randomUUID()}`;
  return {
    id, title: input.title || inferTitle(input.text), originalText: input.text, createdAt: new Date().toISOString(),
    segments: chunks.map((text, index) => ({
      id: `seg_${randomUUID()}`, documentId: id, index, text, status: "idle",
      audioHash: null, audioUrl: null, voiceId: null, speed: null,
    })),
  };
}
