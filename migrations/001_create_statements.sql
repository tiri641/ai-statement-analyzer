CREATE TABLE statements (
  id uuid PRIMARY KEY,
  owner_id uuid,
  s3_key text NOT NULL UNIQUE,
  target_month date NOT NULL,
  status text NOT NULL,
  processing_started_at timestamptz,
  processing_lease_expires_at timestamptz,
  processing_token uuid,
  processed_at timestamptz,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT statements_status_check
    CHECK (status IN (
      'UPLOAD_PENDING',
      'UPLOADED',
      'QUEUED',
      'PROCESSING',
      'COMPLETED',
      'FAILED'
    ))
);

CREATE INDEX statements_target_month_status_idx
  ON statements (target_month, status);
