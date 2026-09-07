import { after } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { readingStatus, retrySegment } from "@/lib/jobs";
import { dispatchJob } from "@/lib/dispatch";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireOwner();
    const { id } = await params;
    const job = await readingStatus(id, owner);
    return Response.json({ job }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireOwner(request);
    const { id } = await params;
    const input = z.object({ segmentId: z.string().min(5).max(100), acknowledgeBilling: z.literal(true) }).parse(await request.json());
    await retrySegment(id, input.segmentId, input.acknowledgeBilling, owner);
    after(() => dispatchJob(id, owner));
    return Response.json({ job: await readingStatus(id, owner) }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
