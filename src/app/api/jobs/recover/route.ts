import { timingSafeEqual } from "node:crypto";
import { recoverDispatches } from "@/lib/dispatch";
import { required, validateCloudEnvironment, validateResourceIdentity } from "@/lib/config";
import { AppError, errorResponse } from "@/lib/errors";
export async function GET(request: Request) {
  try {
    validateCloudEnvironment();
    const expected = Buffer.from(`Bearer ${required("CRON_SECRET")}`);
    const actual = Buffer.from(request.headers.get("authorization") || "");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new AppError("未授权", 401);
    await validateResourceIdentity();
    return Response.json({ checked: await recoverDispatches() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
