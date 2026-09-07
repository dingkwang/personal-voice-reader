import { errorResponse } from "@/lib/errors";
import { requireOwner } from "@/lib/auth";
import { findDocument } from "@/lib/store";
import { toPublicDocument } from "@/lib/types";
import { latestJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const owner = await requireOwner();
    const { id } = await params;
    const doc = await findDocument(id, owner);
    const publicDoc = toPublicDocument(doc);
    return Response.json(
      { document: { ...publicDoc, originalText: doc.originalText }, job: await latestJob(id, owner) },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
