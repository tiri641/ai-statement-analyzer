ALTER TABLE statements
  ADD CONSTRAINT statements_failure_code_check
    CHECK (
      failure_code IS NULL
      OR failure_code IN (
        'SOURCE_OBJECT_NOT_FOUND',
        'SOURCE_OBJECT_INVALID',
        'UNSUPPORTED_IMAGE',
        'INVALID_OCR_RESPONSE',
        'OCR_NON_RETRYABLE',
        'PROCESSING_FAILED'
      )
    ),
  ADD CONSTRAINT statements_failure_message_length_check
    CHECK (
      failure_message IS NULL
      OR char_length(failure_message) BETWEEN 1 AND 500
    );
