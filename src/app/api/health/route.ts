export function GET() {
  return Response.json({ service: "voice-note", status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
