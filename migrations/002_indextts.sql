ALTER TABLE jobs ADD COLUMN IF NOT EXISTS synthesis jsonb;
UPDATE jobs j SET synthesis=jsonb_build_object('provider',v.data->'provider','model',j.model,'providerVoiceId',v.data->'providerVoiceId')
  FROM voices v WHERE j.owner=v.owner AND j.voice_id=v.id AND j.synthesis IS NULL;
ALTER TABLE generation_claims ADD COLUMN IF NOT EXISTS poll_after timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS reader_preferences (
  owner text PRIMARY KEY REFERENCES owners(id), web_voice_id text NOT NULL,
  FOREIGN KEY(owner,web_voice_id) REFERENCES voices(owner,id)
);
-- A private, temporary handoff between Vercel and Modal. Never returned to browsers.
CREATE TABLE IF NOT EXISTS indextts_requests (
  owner text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
  reference bytea, output bytea,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatching','queued','running','ready','error','uncertain','collected')),
  created_at timestamptz NOT NULL DEFAULT now(), deadline timestamptz NOT NULL DEFAULT now()+interval '25 minutes',
  PRIMARY KEY(owner,id)
);
