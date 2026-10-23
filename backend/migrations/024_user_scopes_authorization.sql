-- Scope-based authorization for multi-campus access control
-- docs/development/PIVOT_SPEC_V2.md section 4: Role + Scope authorization
-- Campus A data must never appear in Campus B queries.

CREATE TABLE user_scopes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                 TEXT NOT NULL CHECK (role IN ('teacher', 'hod', 'reviewer', 'admin', 'coe', 'validator')),

  -- Hierarchical scope - each level is optional (NULL = no restriction at that level)
  institution_id       UUID REFERENCES institutions(id),
  campus_id            UUID REFERENCES campuses(id),
  college_id           UUID REFERENCES colleges(id),
  department_id        UUID REFERENCES departments(id),
  program_id           UUID REFERENCES programs(id),

  -- Fine-grained scope for specific offerings/subjects
  course_offering_id   UUID REFERENCES course_offerings(id),
  subject_id           UUID REFERENCES subjects(id),

  -- Scope validity period
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from       TIMESTAMPTZ,
  effective_until      TIMESTAMPTZ,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Prevent duplicate scopes
  UNIQUE (user_id, role, campus_id, department_id, program_id, course_offering_id)
);

-- Indexes for fast authorization checks
CREATE INDEX idx_user_scopes_user_active ON user_scopes(user_id, is_active);
CREATE INDEX idx_user_scopes_campus ON user_scopes(campus_id) WHERE campus_id IS NOT NULL;
CREATE INDEX idx_user_scopes_institution ON user_scopes(institution_id) WHERE institution_id IS NOT NULL;
CREATE INDEX idx_user_scopes_role ON user_scopes(role, is_active);

-- Authorization audit log - tracks all authorization decisions
CREATE TABLE authorization_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES users(id),
  action            TEXT NOT NULL,
  resource_type     TEXT NOT NULL,
  resource_id       UUID,
  decision          TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason            TEXT,

  -- Context
  campus_id         UUID,
  department_id     UUID,
  ip_address        TEXT,
  correlation_id    TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_authz_log_user_time ON authorization_log(user_id, created_at DESC);
CREATE INDEX idx_authz_log_decision ON authorization_log(decision, created_at DESC) WHERE decision = 'deny';
CREATE INDEX idx_authz_log_campus ON authorization_log(campus_id, created_at DESC);

-- Helper function: Check if user has required scope for a resource
-- This is called from application code authorize() function
CREATE OR REPLACE FUNCTION user_has_scope(
  p_user_id UUID,
  p_role TEXT,
  p_campus_id UUID DEFAULT NULL,
  p_department_id UUID DEFAULT NULL,
  p_program_id UUID DEFAULT NULL,
  p_course_offering_id UUID DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Check if user has an active scope matching the requirements
  SELECT COUNT(*) INTO v_count
  FROM user_scopes
  WHERE user_id = p_user_id
    AND role = p_role
    AND is_active = true
    AND (effective_from IS NULL OR effective_from <= now())
    AND (effective_until IS NULL OR effective_until > now())
    -- Hierarchical scope matching
    AND (p_campus_id IS NULL OR campus_id IS NULL OR campus_id = p_campus_id)
    AND (p_department_id IS NULL OR department_id IS NULL OR department_id = p_department_id)
    AND (p_program_id IS NULL OR program_id IS NULL OR program_id = p_program_id)
    AND (p_course_offering_id IS NULL OR course_offering_id IS NULL OR course_offering_id = p_course_offering_id);

  RETURN v_count > 0;
END;
$$ LANGUAGE plpgsql STABLE;

-- Backfill: Grant existing users appropriate scopes based on their current role and assignments
-- Teachers get scopes from their teacher_course_assignments
INSERT INTO user_scopes (user_id, role, campus_id, department_id, program_id, course_offering_id, is_active)
SELECT DISTINCT
  tca.teacher_id,
  'teacher',
  p.campus_id,
  p.department_id,
  p.id, -- Use program.id, not course_offering_id for program_id
  tca.course_offering_id,
  tca.is_active
FROM teacher_course_assignments tca
JOIN course_offerings co ON tca.course_offering_id = co.id
JOIN programs p ON co.program_id = p.id
WHERE tca.is_active = true
  AND tca.teacher_id IS NOT NULL
  AND p.id IS NOT NULL
ON CONFLICT DO NOTHING;

-- HODs get department-level scope (one per department they manage)
-- This is a placeholder - actual HOD assignments should come from a separate table
-- For now, we'll create scopes when needed via application logic

-- Admins get institution-level scope (unrestricted)
INSERT INTO user_scopes (user_id, role, institution_id, is_active)
SELECT
  u.id,
  'admin',
  '00000000-0000-0000-0000-000000000001', -- Default institution
  true
FROM users u
WHERE u.role = 'admin'
ON CONFLICT DO NOTHING;

COMMENT ON TABLE user_scopes IS 'Role-based authorization scopes for multi-campus access control. Users can only access resources within their authorized scope.';
COMMENT ON FUNCTION user_has_scope IS 'Check if a user has the required role and scope for a resource. Called by application authorize() function.';
