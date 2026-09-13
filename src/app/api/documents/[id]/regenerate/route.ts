import { after } from "next/server";
import { requireOwner } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { regenerateSchema, regenerateDocument, readingStatus } from "@/lib/jobs";
import { dispatchJob } from "@/lib/dispatch";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireOwner(request);
    const { id } = await params;
    const input = regenerateSchema.parse(await request.json());
    const queued = await regenerateDocument(id, input, owner);
    after(() => dispatchJob(queued.jobId, owner));
    return Response.json({ job: await readingStatus(queued.jobId, owner) },
      { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
