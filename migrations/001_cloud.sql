CREATE TABLE IF NOT EXISTS deployment_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  environment text NOT NULL,
  project text NOT NULL
);
CREATE TABLE IF NOT EXISTS owners (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS voices (
  owner text NOT NULL REFERENCES owners(id), id text NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(owner,id)
);
CREATE TABLE IF NOT EXISTS documents (
  owner text NOT NULL REFERENCES owners(id), id text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL, PRIMARY KEY(owner,id)
);
CREATE INDEX IF NOT EXISTS documents_recent ON documents(owner,created_at DESC);
CREATE TABLE IF NOT EXISTS segments (
  owner text NOT NULL, id text NOT NULL, document_id text NOT NULL,
  position integer NOT NULL, data jsonb NOT NULL, desired_job text,
  PRIMARY KEY(owner,id), FOREIGN KEY(owner,document_id) REFERENCES documents(owner,id)
);
CREATE INDEX IF NOT EXISTS segments_document ON segments(owner,document_id,position);
CREATE TABLE IF NOT EXISTS audio_cache (
  owner text NOT NULL REFERENCES owners(id), key text NOT NULL CHECK(key ~ '^[a-f0-9]{64}$'),
  object_hash text NOT NULL CHECK(object_hash ~ '^[a-f0-9]{64}$'),
  pathname text NOT NULL, size integer NOT NULL CHECK(size>0),
  legacy boolean NOT NULL DEFAULT false, PRIMARY KEY(owner,key)
);
CREATE TABLE IF NOT EXISTS audio_versions (
  owner text NOT NULL, segment_id text NOT NULL, key text NOT NULL,
  PRIMARY KEY(owner,segment_id,key),
  FOREIGN KEY(owner,segment_id) REFERENCES segments(owner,id),
  FOREIGN KEY(owner,key) REFERENCES audio_cache(owner,key)
);
CREATE TABLE IF NOT EXISTS jobs (
  owner text NOT NULL, id text NOT NULL, document_id text NOT NULL,
  idempotency_key text NOT NULL, request_hash text NOT NULL,
  voice_id text NOT NULL, speed double precision NOT NULL, model text NOT NULL,
  status text NOT NULL DEFAULT 'queued', created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), dispatch_after timestamptz NOT NULL DEFAULT now(),
  run_id text, PRIMARY KEY(owner,id), UNIQUE(owner,idempotency_key),
  FOREIGN KEY(owner,document_id) REFERENCES documents(owner,id),
  FOREIGN KEY(owner,voice_id) REFERENCES voices(owner,id)
);
CREATE INDEX IF NOT EXISTS jobs_recovery ON jobs(status,dispatch_after);
CREATE TABLE IF NOT EXISTS job_requests (
  owner text NOT NULL, key text NOT NULL, request_hash text NOT NULL, job_id text NOT NULL,
  PRIMARY KEY(owner,key), FOREIGN KEY(owner,job_id) REFERENCES jobs(owner,id)
);
CREATE TABLE IF NOT EXISTS job_items (
  owner text NOT NULL, job_id text NOT NULL, segment_id text NOT NULL, position integer NOT NULL,
  key text NOT NULL, status text NOT NULL DEFAULT 'queued', attempt text, error text,
  PRIMARY KEY(owner,job_id,segment_id),
  FOREIGN KEY(owner,job_id) REFERENCES jobs(owner,id),
  FOREIGN KEY(owner,segment_id) REFERENCES segments(owner,id)
);
-- Two occupied slots, including uncertain requests, are the hard owner limit.
CREATE TABLE IF NOT EXISTS generation_claims (
  owner text NOT NULL REFERENCES owners(id), slot integer NOT NULL CHECK(slot IN (1,2)),
  key text NOT NULL, job_id text NOT NULL, segment_id text NOT NULL, attempt text NOT NULL,
  expires_at timestamptz NOT NULL, PRIMARY KEY(owner,slot), UNIQUE(owner,key),
  FOREIGN KEY(owner,job_id) REFERENCES jobs(owner,id)
);
CREATE TABLE IF NOT EXISTS uploads (
  owner text NOT NULL REFERENCES owners(id), id text NOT NULL, pathname text NOT NULL UNIQUE,
  content_type text NOT NULL, size integer NOT NULL CHECK(size>0 AND size<=20971520),
  expires_at timestamptz NOT NULL, used boolean NOT NULL DEFAULT false,
  PRIMARY KEY(owner,id)
);
CREATE TABLE IF NOT EXISTS clone_requests (
  owner text NOT NULL REFERENCES owners(id), id text NOT NULL, request_hash text NOT NULL,
  status text NOT NULL, voice_id text, PRIMARY KEY(owner,id)
);
