"""Durable dispatch. A lost spawn acknowledgment never triggers another spawn."""
import os
import psycopg
from psycopg.rows import dict_row


def connection():
    conn = psycopg.connect(os.environ["INDEXTTS_DATABASE_URL"], connect_timeout=10, row_factory=dict_row)
    with conn.cursor() as cursor:
        cursor.execute("SELECT project,environment FROM deployment_identity")
        rows = cursor.fetchall()
    if rows != [{"project": "personal-voice-reader", "environment": os.environ["INDEXTTS_ENV"]}]:
        conn.close()
        raise RuntimeError("Database identity mismatch")
    return conn


def dispatch(owner, request_id, spawn):
    with connection() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(557322)")
        conn.execute("UPDATE indextts_requests SET status='uncertain',payload='{}',reference=NULL WHERE deadline<now() AND status IN ('pending','dispatching','queued','running')")
        # Drop transient data after a day. Keep request tombstones for idempotency.
        conn.execute("UPDATE indextts_requests SET output=NULL,reference=NULL,payload='{}',status=CASE WHEN status='ready' THEN 'collected' ELSE status END WHERE created_at<now()-interval '1 day'")
        row = conn.execute("SELECT status FROM indextts_requests WHERE owner=%s AND id=%s FOR UPDATE", (owner, request_id)).fetchone()
        if row is None:
            return None
        if row["status"] != "pending":
            return row["status"]
        count = conn.execute("SELECT count(*) AS count FROM indextts_requests WHERE status!='pending'").fetchone()["count"]
        # A conservative live-test guard. Raise only after measuring costs.
        if count >= int(os.environ.get("INDEXTTS_REQUEST_LIMIT", "6")):
            conn.execute("UPDATE indextts_requests SET status='error',payload='{}',reference=NULL WHERE owner=%s AND id=%s", (owner, request_id))
            return "error"
        conn.execute("UPDATE indextts_requests SET status='dispatching' WHERE owner=%s AND id=%s", (owner, request_id))
    # Commit before spawn. A crash here is intentionally uncertain, not resubmitted.
    try:
        spawn(owner, request_id)
    except Exception:
        return "dispatching"
    with connection() as conn:
        conn.execute("UPDATE indextts_requests SET status='queued' WHERE owner=%s AND id=%s AND status='dispatching'", (owner, request_id))
    return "queued"


def claim(owner, request_id):
    with connection() as conn:
        # Leave ten minutes to finish before the durable deadline.
        return conn.execute("""UPDATE indextts_requests SET status='running'
            WHERE owner=%s AND id=%s AND status IN ('dispatching','queued')
            AND deadline>now()+interval '10 minutes' RETURNING payload,reference""", (owner, request_id)).fetchone()


def finish(owner, request_id, output=None):
    with connection() as conn:
        conn.execute("""UPDATE indextts_requests SET status=%s,output=%s,payload='{}',reference=NULL
            WHERE owner=%s AND id=%s AND status='running' AND deadline>now()""",
            ("ready" if output else "error", output, owner, request_id))


def read_audio(owner, request_id):
    with connection() as conn:
        row = conn.execute("SELECT output FROM indextts_requests WHERE owner=%s AND id=%s AND status='ready'", (owner, request_id)).fetchone()
        return bytes(row["output"]) if row and row["output"] else None
