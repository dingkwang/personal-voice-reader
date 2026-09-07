import { requireOwner } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { documentSchema, makeDocument } from "@/lib/documents";
import { addDocument, listDocuments } from "@/lib/store";
import { toDocumentSummary, toPublicDocument } from "@/lib/types";
export const runtime = "nodejs";
export async function GET() {
  try {
    const owner = await requireOwner();
    return Response.json({ documents: (await listDocuments(owner)).map(toDocumentSummary) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const owner = await requireOwner(request);
    const parsed = documentSchema.parse(await request.json());
    return Response.json({ document: toPublicDocument(await addDocument(makeDocument(parsed), owner)) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
