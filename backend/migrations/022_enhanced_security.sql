-- Enhanced security controls and monitoring

-- Request correlation and tracing
CREATE TABLE IF NOT EXISTS request_log (
  id BIGSERIAL PRIMARY KEY,
  correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  ip_address INET,
  user_agent TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_request_log_correlation ON request_log(correlation_id);
CREATE INDEX idx_request_log_user ON request_log(user_id, timestamp DESC);
CREATE INDEX idx_request_log_timestamp ON request_log(timestamp DESC);
CREATE INDEX idx_request_log_ip ON request_log(ip_address, timestamp DESC);

-- Idempotency keys for critical operations
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id BIGSERIAL PRIMARY KEY,
  key UUID NOT NULL UNIQUE,
  operation TEXT NOT NULL, -- 'submit_question', 'approve_paper', 'lock_paper', etc
  user_id UUID NOT NULL REFERENCES users(id),
  request_hash TEXT NOT NULL, -- hash of request body
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_idempotency_keys_key ON idempotency_keys(key);
CREATE INDEX idx_idempotency_keys_expires ON idempotency_keys(expires_at);

-- Cleanup expired idempotency keys (run via cron/scheduled job)
-- DELETE FROM idempotency_keys WHERE expires_at < NOW();

-- Query performance monitoring
CREATE TABLE IF NOT EXISTS slow_query_log (
  id BIGSERIAL PRIMARY KEY,
  query_text TEXT NOT NULL,
  execution_time_ms INTEGER NOT NULL,
  user_id UUID REFERENCES users(id),
  endpoint TEXT,
  correlation_id UUID,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_slow_query_log_timestamp ON slow_query_log(timestamp DESC);
CREATE INDEX idx_slow_query_log_execution ON slow_query_log(execution_time_ms DESC);
