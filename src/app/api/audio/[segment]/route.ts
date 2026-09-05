import { readFile, stat } from "node:fs/promises";
import { errorResponse } from "@/lib/errors";
import { findSegment, getAudioPath } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: RouteContext<"/api/audio/[segment]">,
) {
  try {
    const { segment: segmentId } = await context.params;
    const { segment } = await findSegment(segmentId);
    if (!segment.audioHash) {
      return Response.json(
        { error: "这个段落的音频尚未生成", code: "AUDIO_NOT_READY" },
        { status: 404 },
      );
    }

    const filePath = getAudioPath(segment.audioHash);
    const fileSize = (await stat(filePath)).size;
    const range = request.headers.get("range");
    const commonHeaders = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "audio/mpeg",
      ETag: `"${segment.audioHash}"`,
    };

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) return new Response(null, { status: 416 });
      const isSuffix = !match[1] && Boolean(match[2]);
      const suffixLength = isSuffix ? Math.min(Number(match[2]), fileSize) : 0;
      const start = isSuffix ? fileSize - suffixLength : Number(match[1] || 0);
      const end = isSuffix
        ? fileSize - 1
        : match[2]
          ? Math.min(Number(match[2]), fileSize - 1)
          : fileSize - 1;
      if (start > end || start >= fileSize) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${fileSize}` },
        });
      }
      const fullAudio = await readFile(filePath);
      const chunk = fullAudio.subarray(start, end + 1);
      return new Response(chunk, {
        status: 206,
        headers: {
          ...commonHeaders,
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        },
      });
    }

    const audio = await readFile(filePath);
    return new Response(audio, {
      headers: { ...commonHeaders, "Content-Length": String(fileSize) },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
