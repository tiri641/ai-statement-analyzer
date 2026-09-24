CREATE TABLE monthly_insights (
  target_month date PRIMARY KEY,
  analytics_version text NOT NULL,
  model_id text NOT NULL,
  prompt_version text NOT NULL,
  insights jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT monthly_insights_target_month_check
    CHECK (target_month = date_trunc('month', target_month)::date),
  CONSTRAINT monthly_insights_analytics_version_check
    CHECK (char_length(analytics_version) BETWEEN 1 AND 200),
  CONSTRAINT monthly_insights_model_id_check
    CHECK (char_length(model_id) BETWEEN 1 AND 255),
  CONSTRAINT monthly_insights_prompt_version_check
    CHECK (char_length(prompt_version) BETWEEN 1 AND 100),
  CONSTRAINT monthly_insights_json_object_check
    CHECK (jsonb_typeof(insights) = 'object')
);
