from fastapi import FastAPI, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from core import MODEL, normalize, validate_ids
import ledger


def create_app(spawn):
    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @api.middleware("http")
    async def private_response(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "private, no-store"
        return response

    @api.get("/health")
    def health():
        return {"model": MODEL}

    @api.post("/normalize")
    async def reference(request: Request):
        raw = bytearray()
        async for part in request.stream():
            raw.extend(part)
            if len(raw) > 20 * 1024 * 1024:
                raise HTTPException(413, "Recording too large")
        try:
            data, seconds = await run_in_threadpool(normalize, bytes(raw))
        except Exception:
            raise HTTPException(422, "Use a 10–60 second recording") from None
        return Response(data, media_type="audio/wav", headers={"X-Audio-Seconds": str(seconds)})

    @api.post("/requests/{owner}/{request_id}")
    def submit(owner: str, request_id: str):
        try:
            validate_ids(owner, request_id)
        except ValueError:
            raise HTTPException(422, "Invalid request") from None
        status = ledger.dispatch(owner, request_id, spawn)
        if status is None:
            raise HTTPException(404, "Unknown request")
        return {"status": status}

    @api.get("/requests/{owner}/{request_id}/audio")
    def audio(owner: str, request_id: str):
        try:
            validate_ids(owner, request_id)
        except ValueError:
            raise HTTPException(422, "Invalid request") from None
        data = ledger.read_audio(owner, request_id)
        if not data:
            raise HTTPException(404, "Audio unavailable")
        return Response(data, media_type="audio/mpeg")

    return api
