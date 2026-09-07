import { requireOwner } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { readingStatus } from "@/lib/jobs";
export const maxDuration = 60;
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireOwner();
    const { id } = await params;
    let current = await readingStatus(id, owner);
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Short authenticated connections. EventSource reconnects and receives
          // a complete database snapshot, so a lost event never loses progress.
          for (let tick = 0; tick < 20 && !cancelled && !request.signal.aborted; tick++) {
            if (tick) current = await readingStatus(id, owner);
            controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify(current)}\n\n`));
            if (["completed", "attention"].includes(current.status)) break;
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          if (!cancelled) controller.close();
        } catch {
          if (!cancelled) controller.error(new Error("Progress disconnected"));
        }
      },
      cancel() { cancelled = true; },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
  } catch (error) { return errorResponse(error); }
}
