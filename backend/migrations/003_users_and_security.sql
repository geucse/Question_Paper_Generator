-- Roles: teacher, reviewer, hod, admin.
-- ("superuser" from the old schema is renamed to "admin" to match the
-- role names used throughout the rest of the platform and its workflows.
-- "reviewer" is new: a dedicated grader/checker role, distinct from HOD,
-- who course questions get assigned to before they ever reach the HOD.)
--
-- department_id scopes HOD and reviewer visibility to one department.
-- Admin's department_id is NULL — admin is department-agnostic by design.
-- Teachers are NOT scoped by a single department/subject column anymore;
-- their actual subject access comes from teacher_course_assignments
-- (migration 004), because one teacher can teach multiple course offerings
-- across semesters/sessions.
CREATE TABLE users (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  TEXT UNIQUE NOT NULL,
  password_hash          TEXT NOT NULL,
  role                   TEXT NOT NULL CHECK (role IN ('admin','hod','reviewer','teacher')),
  department_id          UUID REFERENCES departments(id),
  full_name              TEXT,
  totp_secret            TEXT,
  totp_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  access_start           TIMESTAMPTZ NOT NULL DEFAULT now(),
  access_deadline        TIMESTAMPTZ,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_otp_user_purpose ON otp_codes(user_id, purpose, created_at DESC);

-- Tamper-evident hash-chained audit log — unchanged design from the SQLite
-- version, just native Postgres types (BIGSERIAL id, JSONB details).
CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email   TEXT,
  action       TEXT NOT NULL,
  entity_id    TEXT,
  details      TEXT,             -- canonical JSON string; hashed exactly as stored
  ip_address   TEXT,
  prev_hash    TEXT,
  entry_hash   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_id);

CREATE TABLE blocked_ips (
  ip            TEXT PRIMARY KEY,
  reason        TEXT,
  blocked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  auto_blocked  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE suspicious_activity (
  id             BIGSERIAL PRIMARY KEY,
  ip             TEXT,
  activity_type  TEXT NOT NULL,
  details        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_suspicious_ip_type ON suspicious_activity(ip, activity_type, created_at);

CREATE TABLE system_state (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE step_up_auth_log (
  id           BIGSERIAL PRIMARY KEY,
  hod_id       UUID REFERENCES users(id),
  admin_id     UUID REFERENCES users(id),
  action       TEXT NOT NULL,
  entity_id    TEXT,
  success      BOOLEAN NOT NULL,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_step_up_created ON step_up_auth_log(created_at DESC);
