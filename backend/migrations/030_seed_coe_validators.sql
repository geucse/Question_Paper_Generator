-- Seed data for COE and Validator users
-- Creates test users with proper roles, scopes, and campus assignments

-- Insert COE user
INSERT INTO users (
  id, email, password_hash, role, full_name,
  employee_id, institution_id, campus_id, status,
  is_active, totp_enabled
) VALUES (
  '10000000-0000-0000-0000-000000000001',
  'coe@test.edu',
  '$argon2id$v=19$m=65536,t=3,p=4$salt$hash', -- password: test123
  'coe',
  'Chief of Examinations',
  'EMP-COE-001',
  '00000000-0000-0000-0000-000000000001', -- Default institution
  '00000000-0000-0000-0000-000000000002', -- Default campus
  'ACTIVE',
  true,
  false
) ON CONFLICT (id) DO UPDATE SET
  role = EXCLUDED.role,
  status = EXCLUDED.status;

-- Insert 4 Validator users
INSERT INTO users (
  id, email, password_hash, role, full_name,
  employee_id, institution_id, campus_id, status,
  is_active
) VALUES
(
  '20000000-0000-0000-0000-000000000001',
  'validator1@test.edu',
  '$argon2id$v=19$m=65536,t=3,p=4$salt$hash',
  'validator',
  'Validator One',
  'EMP-VAL-001',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  'ACTIVE',
  true
),
(
  '20000000-0000-0000-0000-000000000002',
  'validator2@test.edu',
  '$argon2id$v=19$m=65536,t=3,p=4$salt$hash',
  'validator',
  'Validator Two',
  'EMP-VAL-002',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  'ACTIVE',
  true
),
(
  '20000000-0000-0000-0000-000000000003',
  'validator3@test.edu',
  '$argon2id$v=19$m=65536,t=3,p=4$salt$hash',
  'validator',
  'Validator Three',
  'EMP-VAL-003',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  'ACTIVE',
  true
),
(
  '20000000-0000-0000-0000-000000000004',
  'validator4@test.edu',
  '$argon2id$v=19$m=65536,t=3,p=4$salt$hash',
  'validator',
  'Validator Four',
  'EMP-VAL-004',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  'ACTIVE',
  true
)
ON CONFLICT (id) DO UPDATE SET
  role = EXCLUDED.role,
  status = EXCLUDED.status;

-- Grant COE scope (institution-level access for examination creation)
INSERT INTO user_scopes (
  user_id, role, institution_id, campus_id, is_active
) VALUES (
  '10000000-0000-0000-0000-000000000001',
  'coe',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  true
) ON CONFLICT DO NOTHING;

-- Grant validator scopes (campus-level access for paper validation)
INSERT INTO user_scopes (
  user_id, role, campus_id, is_active
)
SELECT
  id,
  'validator',
  '00000000-0000-0000-0000-000000000002',
  true
FROM users
WHERE role = 'validator'
ON CONFLICT DO NOTHING;

-- Update existing admin/teacher/hod/reviewer users to have proper institution/campus
UPDATE users
SET
  institution_id = COALESCE(institution_id, '00000000-0000-0000-0000-000000000001'),
  campus_id = COALESCE(campus_id, '00000000-0000-0000-0000-000000000002'),
  status = CASE WHEN is_active THEN 'ACTIVE' ELSE 'INACTIVE' END
WHERE institution_id IS NULL OR status IS NULL;

COMMENT ON TABLE users IS 'Users now include COE and validator roles. All users must have institution_id, campus_id, and status.';
