import { after } from "next/server";
import { requireOwner } from "@/lib/auth";
import { providerReady } from "@/lib/tts-config";
import { findVoice } from "@/lib/store";
import { errorResponse } from "@/lib/errors";
import { queueSchema, queueDocument, readingStatus } from "@/lib/jobs";
import { dispatchJob } from "@/lib/dispatch";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const owner = await requireOwner(request);
    const input = queueSchema.parse(await request.json());
    providerReady((await findVoice(input.voiceId, owner)).provider);
    const queued = await queueDocument(input, owner);
    after(() => dispatchJob(queued.jobId, owner));
    return Response.json({ job: await readingStatus(queued.jobId, owner) }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
