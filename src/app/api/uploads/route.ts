import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireOwner } from "@/lib/auth";
import { AppError, errorResponse } from "@/lib/errors";
import { reserveUpload, uploadPermission, uploadSchema } from "@/lib/uploads";
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (body.type === "blob.upload-completed") {
      // No data is trusted from a callback; SDK verifies its signature. Content
      // is read only after a separate owner-authenticated clone request.
      return Response.json(await handleUpload({
        request, body: body as HandleUploadBody,
        onBeforeGenerateToken: async () => { throw new AppError("未授权", 401); },
        onUploadCompleted: async () => {},
      }), { headers: { "Cache-Control": "no-store" } });
    }
    const owner = await requireOwner(request);
    if (body.type === "blob.generate-client-token") {
      const result = await handleUpload({
        request, body: body as HandleUploadBody,
        onBeforeGenerateToken: async (pathname, clientPayload) => uploadPermission(clientPayload || "", pathname, owner),
      });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(await reserveUpload(uploadSchema.parse(body), owner), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
