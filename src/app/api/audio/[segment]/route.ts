import { requireOwner } from "@/lib/auth";
import { AppError, errorResponse } from "@/lib/errors";
import { database } from "@/lib/db";
import { findSegment } from "@/lib/store";
import { streamAudio } from "@/lib/blob";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ segment: string }> }) {
  try {
    const owner = await requireOwner();
    const { segment: id } = await context.params;
    const { segment } = await findSegment(id, owner);
    const version = new URL(request.url).searchParams.get("v");
    if (version && !/^(?:[a-f0-9]{12}|[a-f0-9]{64})$/.test(version)) throw new AppError("找不到这个版本的音频", 404);
    const key = version || segment.audioHash;
    if (!key) throw new AppError("音频尚未生成", 404, "AUDIO_NOT_READY");
    const { rows } = await database().query<{ pathname: string; size: number; object_hash: string }>(
      `SELECT c.pathname,c.size,c.object_hash FROM audio_cache c
       WHERE c.owner=$1 AND c.key LIKE $2 AND
       (c.legacy OR EXISTS(SELECT 1 FROM audio_versions v WHERE v.owner=c.owner AND v.key=c.key AND v.segment_id=$3))`,
      [owner, `${key}%`, id]);
    if (rows.length !== 1) throw new AppError("找不到这个版本的音频", 404, "AUDIO_VERSION_NOT_FOUND");
    return await streamAudio(request, rows[0]);
  } catch (error) { return errorResponse(error); }
}
