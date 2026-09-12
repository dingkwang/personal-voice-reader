CREATE TABLE IF NOT EXISTS replicate_requests (
  owner text NOT NULL REFERENCES owners(id), attempt text NOT NULL,
  prediction_id text, status text NOT NULL DEFAULT 'submitting'
    CHECK(status IN ('submitting','polling','ready','error','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline timestamptz NOT NULL DEFAULT now()+interval '25 minutes',
  PRIMARY KEY(owner,attempt)
);
