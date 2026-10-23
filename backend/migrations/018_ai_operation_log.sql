-- AI operation logging for transparency and debugging
CREATE TABLE IF NOT EXISTS ai_operation_log (
  id BIGSERIAL PRIMARY KEY,
  operation TEXT NOT NULL, -- 'review_question', 'suggest_metadata', 'compare_questions', 'extract_syllabus', 'score_paper'
  entity_type TEXT NOT NULL, -- 'question', 'syllabus', 'paper', etc
  entity_id BIGINT,
  provider TEXT NOT NULL, -- 'anthropic', 'openai', etc
  model TEXT NOT NULL,
  version TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  latency_ms INTEGER,
  confidence DECIMAL(3,2), -- 0.00-1.00
  result_summary JSONB, -- abbreviated result for quick inspection
  user_id UUID REFERENCES users(id),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  correlation_id UUID DEFAULT gen_random_uuid()
);

CREATE INDEX idx_ai_operation_log_entity ON ai_operation_log(entity_type, entity_id);
CREATE INDEX idx_ai_operation_log_timestamp ON ai_operation_log(timestamp DESC);
CREATE INDEX idx_ai_operation_log_user ON ai_operation_log(user_id);
CREATE INDEX idx_ai_operation_log_correlation ON ai_operation_log(correlation_id);
