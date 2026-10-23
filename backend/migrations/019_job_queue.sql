-- Job queue state tracking for background operations
CREATE TABLE IF NOT EXISTS job_queue (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE, -- BullMQ job ID
  job_type TEXT NOT NULL, -- 'extract_syllabus', 'generate_embeddings', 'generate_pdf', 'scan_duplicate'
  entity_type TEXT,
  entity_id BIGINT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'active', 'completed', 'failed', 'delayed'
  priority INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  data JSONB, -- job input parameters
  result JSONB, -- job output
  error_message TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  correlation_id UUID DEFAULT gen_random_uuid()
);

CREATE INDEX idx_job_queue_status ON job_queue(status, created_at);
CREATE INDEX idx_job_queue_type ON job_queue(job_type);
CREATE INDEX idx_job_queue_entity ON job_queue(entity_type, entity_id);
CREATE INDEX idx_job_queue_user ON job_queue(created_by);
CREATE INDEX idx_job_queue_correlation ON job_queue(correlation_id);

-- Job queue notifications for completion
CREATE TABLE IF NOT EXISTS job_notifications (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES job_queue(job_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL, -- 'success', 'failure'
  message TEXT NOT NULL,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_notifications_user ON job_notifications(user_id, read, created_at DESC);
