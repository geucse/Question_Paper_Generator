-- Add new roles (COE, validator) and enhanced user identity
-- docs/development/PIVOT_SPEC_V2.md section 2 & 5: New roles and user identity requirements

-- Add new roles to the CHECK constraint
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'hod', 'reviewer', 'teacher', 'coe', 'validator'));

-- Add new identity fields
ALTER TABLE users ADD COLUMN employee_id TEXT;
ALTER TABLE users ADD COLUMN institution_id UUID REFERENCES institutions(id);
ALTER TABLE users ADD COLUMN campus_id UUID REFERENCES campuses(id);

-- Add status field (ACTIVE/INACTIVE) - rename is_active to status for clarity
ALTER TABLE users ADD COLUMN status TEXT;

-- Migrate existing is_active to status
UPDATE users SET status = CASE
  WHEN is_active = true THEN 'ACTIVE'
  ELSE 'INACTIVE'
END;

-- Make status NOT NULL with proper constraint
ALTER TABLE users ALTER COLUMN status SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('ACTIVE', 'INACTIVE'));

-- Keep is_active for backward compatibility during transition
-- It will be removed in a later migration after frontend is updated
-- For now, sync it with status via trigger
CREATE OR REPLACE FUNCTION sync_user_status()
RETURNS TRIGGER AS $$
BEGIN
  NEW.is_active := (NEW.status = 'ACTIVE');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_user_status
  BEFORE INSERT OR UPDATE OF status ON users
  FOR EACH ROW
  EXECUTE FUNCTION sync_user_status();

-- Add unique constraint on employee_id (when set)
CREATE UNIQUE INDEX idx_users_employee_id ON users(employee_id) WHERE employee_id IS NOT NULL;

-- Indexes for new fields
CREATE INDEX idx_users_institution ON users(institution_id) WHERE institution_id IS NOT NULL;
CREATE INDEX idx_users_campus ON users(campus_id) WHERE campus_id IS NOT NULL;
CREATE INDEX idx_users_status ON users(status);

-- Backfill: Assign default institution/campus to existing users
UPDATE users
SET
  institution_id = '00000000-0000-0000-0000-000000000001',
  campus_id = '00000000-0000-0000-0000-000000000002'
WHERE institution_id IS NULL;

-- Make institution_id and campus_id NOT NULL (all users must belong to an institution/campus)
ALTER TABLE users ALTER COLUMN institution_id SET NOT NULL;
ALTER TABLE users ALTER COLUMN campus_id SET NOT NULL;

-- Update user_scopes role constraint to include new roles
ALTER TABLE user_scopes DROP CONSTRAINT user_scopes_role_check;
ALTER TABLE user_scopes ADD CONSTRAINT user_scopes_role_check
  CHECK (role IN ('teacher', 'hod', 'reviewer', 'admin', 'coe', 'validator'));

COMMENT ON COLUMN users.employee_id IS 'Unique employee identifier - use for identity, never email or name';
COMMENT ON COLUMN users.status IS 'User account status: ACTIVE or INACTIVE. Inactive users are kept for historical authorship/audit.';
COMMENT ON COLUMN users.institution_id IS 'Institution this user belongs to (required)';
COMMENT ON COLUMN users.campus_id IS 'Primary campus this user belongs to (required)';
