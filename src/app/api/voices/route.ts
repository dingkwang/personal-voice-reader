import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { getVoiceProvider } from "@/lib/providers";
import { addVoice, readStore } from "@/lib/store";
import type { Voice } from "@/lib/types";

export const runtime = "nodejs";

const linkedVoiceSchema = z.object({
  name: z.string().trim().min(1).max(60),
  provider: z.literal("fish").default("fish"),
  providerVoiceId: z.string().trim().min(6).max(120),
  language: z.string().trim().min(2).max(20).default("zh"),
});

export async function GET() {
  try {
    const voices = (await readStore()).voices.toSorted((a, b) => {
      if (a.source === "default" && b.source !== "default") return 1;
      if (a.source !== "default" && b.source === "default") return -1;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return Response.json({ voices });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const name = String(form.get("name") || "").trim();
      const language = String(form.get("language") || "zh").trim();
      const transcript = String(form.get("transcript") || "").trim();
      const consent = form.get("consent") === "true";
      const audio = form
        .getAll("audio")
        .filter((item): item is File => item instanceof File && item.size > 0);

      if (!name || name.length > 60) {
        throw new AppError("请填写 1–60 个字符的声音名称");
      }
      if (!consent) {
        throw new AppError("请先确认你拥有并获准克隆这个声音", 422, "CONSENT_REQUIRED");
      }
      if (!audio.length) {
        throw new AppError("请选择一段录音");
      }
      if (audio.length > 20) {
        throw new AppError("一次最多上传 20 段录音", 413, "TOO_MANY_FILES");
      }
      if (audio.some((file) => file.size > 20 * 1024 * 1024)) {
        throw new AppError("每段录音不能超过 20 MB", 413, "FILE_TOO_LARGE");
      }
      if (audio.some((file) => file.type && !file.type.startsWith("audio/"))) {
        throw new AppError("请选择音频文件", 415, "UNSUPPORTED_MEDIA_TYPE");
      }

      const cloned = await getVoiceProvider("fish").cloneVoice({
        name,
        audio,
        transcript: audio.length === 1 ? transcript || undefined : undefined,
      });
      const voice: Voice = {
        id: `voice_${randomUUID()}`,
        name,
        provider: "fish",
        providerVoiceId: cloned.providerVoiceId,
        language: language || "zh",
        createdAt: new Date().toISOString(),
        source: "cloned",
      };
      return Response.json({ voice: await addVoice(voice) }, { status: 201 });
    }

    const parsed = linkedVoiceSchema.parse(await request.json());
    const voice: Voice = {
      id: `voice_${randomUUID()}`,
      name: parsed.name,
      provider: parsed.provider,
      providerVoiceId: parsed.providerVoiceId,
      language: parsed.language,
      createdAt: new Date().toISOString(),
      source: "linked",
    };
    return Response.json({ voice: await addVoice(voice) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
