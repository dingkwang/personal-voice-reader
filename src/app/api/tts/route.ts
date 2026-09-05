import { z } from "zod";
import { errorResponse } from "@/lib/errors";
import { generateSegmentAudio } from "@/lib/tts-service";

export const runtime = "nodejs";
export const maxDuration = 120;

const synthesisSchema = z.object({
  segmentId: z.string().min(5).max(100),
  voiceId: z.string().min(5).max(100),
  speed: z.number().min(0.5).max(2).default(1),
});

export async function POST(request: Request) {
  try {
    const parsed = synthesisSchema.parse(await request.json());
    const result = await generateSegmentAudio(parsed);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
