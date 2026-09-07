import { appOrigin, issuer } from "@/lib/config";
import { errorResponse } from "@/lib/errors";
export function GET() {
  try {
    return Response.json({ resource: `${appOrigin()}/api/mcp`, authorization_servers: [issuer()],
      scopes_supported: ["read:voices", "create:readings", "read:readings"], bearer_methods_supported: ["header"] },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
  } catch (error) { return errorResponse(error); }
}
