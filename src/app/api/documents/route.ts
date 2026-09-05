import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chunkText, inferTitle } from "@/lib/chunker";
import { AppError, errorResponse } from "@/lib/errors";
import { addDocument } from "@/lib/store";
import { toPublicDocument, type ReaderDocument } from "@/lib/types";

export const runtime = "nodejs";

const documentSchema = z.object({
  title: z.string().trim().max(100).optional(),
  text: z.string().trim().min(1).max(100_000),
});

export async function POST(request: Request) {
  try {
    const parsed = documentSchema.parse(await request.json());
    const chunks = chunkText(parsed.text);
    if (!chunks.length) throw new AppError("没有找到可朗读的文字");

    const documentId = `doc_${randomUUID()}`;
    const document: ReaderDocument = {
      id: documentId,
      title: parsed.title || inferTitle(parsed.text),
      originalText: parsed.text,
      createdAt: new Date().toISOString(),
      segments: chunks.map((text, index) => ({
        id: `seg_${randomUUID()}`,
        documentId,
        index,
        text,
        status: "idle",
        audioHash: null,
        audioUrl: null,
        voiceId: null,
        speed: null,
      })),
    };

    return Response.json(
      { document: toPublicDocument(await addDocument(document)) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
