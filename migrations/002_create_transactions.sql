CREATE TABLE transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  statement_id uuid NOT NULL,
  line_number integer NOT NULL,
  transaction_date date NOT NULL,
  merchant_raw text NOT NULL,
  merchant_name text NOT NULL,
  amount bigint NOT NULL,
  category text NOT NULL,
  subcategory text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT transactions_statement_fk
    FOREIGN KEY (statement_id)
    REFERENCES statements (id)
    ON DELETE CASCADE,
  CONSTRAINT transactions_statement_line_unique
    UNIQUE (statement_id, line_number),
  CONSTRAINT transactions_line_number_check
    CHECK (line_number > 0),
  CONSTRAINT transactions_amount_check
    CHECK (amount <> 0)
);

CREATE INDEX transactions_date_idx
  ON transactions (transaction_date);

CREATE INDEX transactions_merchant_name_idx
  ON transactions (merchant_name);

CREATE INDEX transactions_category_idx
  ON transactions (category);
