DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM statements) THEN
    RAISE EXCEPTION
      '003_add_upload_metadata requires statements to be empty because upload metadata cannot be inferred';
  END IF;
END
$$;

ALTER TABLE statements
  ADD COLUMN content_type text NOT NULL,
  ADD COLUMN content_length bigint NOT NULL;

ALTER TABLE statements
  ADD CONSTRAINT statements_content_type_check
    CHECK (content_type IN ('image/jpeg', 'image/png')),
  ADD CONSTRAINT statements_content_length_check
    CHECK (content_length BETWEEN 1 AND 10485760);
