ALTER TABLE statements
  ADD COLUMN content_type text NOT NULL DEFAULT 'image/jpeg',
  ADD COLUMN content_length bigint NOT NULL DEFAULT 1;

ALTER TABLE statements
  ALTER COLUMN content_type DROP DEFAULT,
  ALTER COLUMN content_length DROP DEFAULT;

ALTER TABLE statements
  ADD CONSTRAINT statements_content_type_check
    CHECK (content_type IN ('image/jpeg', 'image/png')),
  ADD CONSTRAINT statements_content_length_check
    CHECK (content_length BETWEEN 1 AND 10485760);
