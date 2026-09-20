import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { AppError, errorResponse } from "@/lib/errors";
import { ownerSubject } from "@/lib/config";
import { addVoice } from "@/lib/store";
import { cloneSchema, cloneUploadedVoice } from "@/lib/uploads";
import { webVoices, setWebVoice } from "@/lib/web-voices";
import { referenceVoiceSchema, registerReferenceVoice } from "@/lib/reference-voices";
import type { Voice } from "@/lib/types";
export const runtime = "nodejs";
export const maxDuration = 300;
const linkedVoiceSchema = z.object({
  name: z.string().trim().min(1).max(60), provider: z.literal("fish").default("fish"),
  providerVoiceId: z.string().trim().min(6).max(120), language: z.string().trim().min(2).max(20).default("zh"),
});
export async function GET() {
  try {
    const owner = await requireOwner();
    return Response.json(await webVoices(owner), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const owner = await requireOwner(request);
    const body = await request.json();
    if (body.provider === "indextts" || body.provider === "replicate") {
      const voice = await registerReferenceVoice(referenceVoiceSchema.parse(body), owner);
      const { reference: _reference, ...publicVoice } = voice;
      void _reference;
      return Response.json({ voice: publicVoice }, { status: 201, headers: { "Cache-Control": "no-store" } });
    }
    if ("uploadIds" in body) return Response.json({ voice: await cloneUploadedVoice(cloneSchema.parse(body), owner) }, { status: 201, headers: { "Cache-Control": "no-store" } });
    // A shared Fish API credential cannot prove another user's ownership of an
    // arbitrary provider ID. Preserve the legacy owner's linking path only.
    if (owner !== ownerSubject()) throw new AppError("请上传自己的参考录音，不支持连接其他账号的声音", 403, "VOICE_LINK_FORBIDDEN");
    const parsed = linkedVoiceSchema.parse(body);
    const voice: Voice = { id: `voice_${randomUUID()}`, ...parsed, createdAt: new Date().toISOString(), source: "linked" };
    return Response.json({ voice: await addVoice(voice, owner) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const owner = await requireOwner(request);
    const { voiceId } = z.object({ voiceId: z.string().min(5).max(120) }).parse(await request.json());
    await setWebVoice(owner, voiceId);
    return Response.json(await webVoices(owner), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
