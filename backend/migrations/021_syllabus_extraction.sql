-- Syllabus extraction and change detection
CREATE TABLE IF NOT EXISTS syllabus_extraction_jobs (
  id BIGSERIAL PRIMARY KEY,
  syllabus_version_id UUID NOT NULL REFERENCES syllabus_versions(id) ON DELETE CASCADE,
  job_id TEXT UNIQUE, -- BullMQ job ID
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL, -- 'pdf', 'docx'
  extraction_method TEXT, -- 'text', 'ocr'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'extracting', 'extracted', 'verifying', 'failed'
  extracted_text TEXT,
  extracted_data JSONB, -- structured COs, units, topics
  confidence_score DECIMAL(3,2),
  requires_verification BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_syllabus_extraction_jobs_version ON syllabus_extraction_jobs(syllabus_version_id);
CREATE INDEX idx_syllabus_extraction_jobs_status ON syllabus_extraction_jobs(status);

-- Syllabus change detection between versions
CREATE TABLE IF NOT EXISTS syllabus_changes (
  id BIGSERIAL PRIMARY KEY,
  old_version_id UUID REFERENCES syllabus_versions(id) ON DELETE CASCADE,
  new_version_id UUID NOT NULL REFERENCES syllabus_versions(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL, -- 'ADDED', 'REMOVED', 'MODIFIED', 'RENAMED', 'POTENTIAL_MAPPING'
  entity_type TEXT NOT NULL, -- 'course_outcome', 'unit', 'topic'
  entity_id TEXT, -- CO code, unit number, or topic name
  old_value JSONB,
  new_value JSONB,
  mapping_confidence DECIMAL(3,2), -- for POTENTIAL_MAPPING type
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed BOOLEAN DEFAULT FALSE,
  review_decision TEXT, -- 'accept', 'reject', 'manual_review'
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX idx_syllabus_changes_versions ON syllabus_changes(old_version_id, new_version_id);
CREATE INDEX idx_syllabus_changes_type ON syllabus_changes(change_type, reviewed);

-- Questions affected by syllabus changes
CREATE TABLE IF NOT EXISTS affected_questions (
  id BIGSERIAL PRIMARY KEY,
  syllabus_change_id BIGINT NOT NULL REFERENCES syllabus_changes(id) ON DELETE CASCADE,
  canonical_question_id UUID NOT NULL REFERENCES canonical_questions(id) ON DELETE CASCADE,
  impact_type TEXT NOT NULL, -- 'no_longer_valid', 'needs_review', 'needs_remapping'
  original_status TEXT NOT NULL,
  new_status TEXT NOT NULL DEFAULT 'pending', -- reset to pending for review
  notified BOOLEAN DEFAULT FALSE,
  reviewed BOOLEAN DEFAULT FALSE,
  review_outcome TEXT, -- 'still_valid', 'needs_update', 'deprecated'
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX idx_affected_questions_change ON affected_questions(syllabus_change_id);
CREATE INDEX idx_affected_questions_question ON affected_questions(canonical_question_id);
CREATE INDEX idx_affected_questions_reviewed ON affected_questions(reviewed, notified);

-- Legacy topic mapping for historical questions
CREATE TABLE IF NOT EXISTS legacy_topics (
  id BIGSERIAL PRIMARY KEY,
  course_offering_id UUID NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  topic_name TEXT NOT NULL,
  unit_number INTEGER,
  marked_legacy_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  marked_legacy_by UUID REFERENCES users(id),
  reason TEXT,
  exclude_from_new_papers BOOLEAN DEFAULT TRUE,
  questions_count INTEGER DEFAULT 0
);

CREATE INDEX idx_legacy_topics_offering ON legacy_topics(course_offering_id);
CREATE UNIQUE INDEX idx_legacy_topics_unique ON legacy_topics(course_offering_id, topic_name);
