-- 035: runtime fixes found by the first real run against PostgreSQL (seed and smoke test).
-- Migrations 023-031 applied cleanly, but some of their constraints rejected the app's own inserts,
-- because nothing had ever executed them on a real database:
--   1. users.status (025) is NOT NULL without a default, and trg_sync_user_status derived is_active
--      from it, so every INSERT that omitted status failed with "null value in column is_active".
--      This broke the seed and the HOD/admin "create user" route.
--   2. users.institution_id / campus_id (025) and departments/programs hierarchy columns (023) are
--      NOT NULL without defaults, but the user/department/program creation routes don't send them.
--   3. questions.bloom_level (027) only allowed 'Remember', 'Apply', ... while the whole app
--      (routes, bulk upload, canonical_questions, review batches) uses lowercase 'remember', 'apply', ...
--      so a teacher's question with a Bloom level, or a reviewer's Bloom verification, was rejected.
--
-- Written to be safe on databases that already carry other fixes for the same problems
-- (e.g. 032_fix_user_status_and_hierarchy_defaults / 033_fix_bloom_level_case): every step is idempotent.

-- ---------------------------------------------------------------------------
-- 1. users.status <-> users.is_active, kept in sync in both directions
-- ---------------------------------------------------------------------------
-- No column default: the trigger derives status from is_active, so an insert with
-- is_active = FALSE and no status stays inactive (a default of 'ACTIVE' would override it).
ALTER TABLE users ALTER COLUMN status DROP DEFAULT;

CREATE OR REPLACE FUNCTION sync_user_status()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS NULL THEN
      NEW.status := CASE WHEN COALESCE(NEW.is_active, TRUE) THEN 'ACTIVE' ELSE 'INACTIVE' END;
    END IF;
    NEW.is_active := (NEW.status = 'ACTIVE');
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.is_active := (NEW.status = 'ACTIVE');
  ELSIF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    NEW.status := CASE WHEN NEW.is_active THEN 'ACTIVE' ELSE 'INACTIVE' END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_user_status ON users;
CREATE TRIGGER trg_sync_user_status
  BEFORE INSERT OR UPDATE OF status, is_active ON users
  FOR EACH ROW EXECUTE FUNCTION sync_user_status();

-- Rows that drifted while only one column was being updated.
UPDATE users SET status = CASE WHEN is_active THEN 'ACTIVE' ELSE 'INACTIVE' END
WHERE is_active IS NOT NULL AND status IS DISTINCT FROM CASE WHEN is_active THEN 'ACTIVE' ELSE 'INACTIVE' END;

-- ---------------------------------------------------------------------------
-- 2. Hierarchy defaults, derived from the parent row; the default hierarchy from 023 otherwise.
--    Explicit values are never overwritten. Multi-campus deployments should still send them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION default_hierarchy_ids(OUT o_institution UUID, OUT o_campus UUID, OUT o_college UUID) AS $$
BEGIN
  SELECT c.id, c.campus_id, ca.institution_id INTO o_college, o_campus, o_institution
  FROM colleges c JOIN campuses ca ON ca.id = c.campus_id
  ORDER BY (c.id = '00000000-0000-0000-0000-000000000003') DESC, c.created_at
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION fill_department_hierarchy()
RETURNS TRIGGER AS $$
DECLARE d RECORD;
BEGIN
  IF NEW.college_id IS NULL AND NEW.campus_id IS NOT NULL THEN
    SELECT id INTO NEW.college_id FROM colleges WHERE campus_id = NEW.campus_id ORDER BY created_at LIMIT 1;
  END IF;
  IF NEW.college_id IS NULL AND NEW.campus_id IS NULL THEN
    SELECT * INTO d FROM default_hierarchy_ids();
    NEW.college_id := d.o_college;
  END IF;
  IF NEW.college_id IS NOT NULL AND (NEW.campus_id IS NULL OR NEW.institution_id IS NULL) THEN
    SELECT c.campus_id, ca.institution_id INTO d FROM colleges c JOIN campuses ca ON ca.id = c.campus_id WHERE c.id = NEW.college_id;
    NEW.campus_id := COALESCE(NEW.campus_id, d.campus_id);
    NEW.institution_id := COALESCE(NEW.institution_id, d.institution_id);
  END IF;
  IF NEW.campus_id IS NOT NULL AND NEW.institution_id IS NULL THEN
    SELECT institution_id INTO NEW.institution_id FROM campuses WHERE id = NEW.campus_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fill_department_hierarchy ON departments;
CREATE TRIGGER trg_fill_department_hierarchy
  BEFORE INSERT ON departments
  FOR EACH ROW EXECUTE FUNCTION fill_department_hierarchy();

CREATE OR REPLACE FUNCTION fill_program_hierarchy()
RETURNS TRIGGER AS $$
DECLARE d RECORD;
BEGIN
  IF NEW.department_id IS NOT NULL AND (NEW.college_id IS NULL OR NEW.campus_id IS NULL OR NEW.institution_id IS NULL) THEN
    SELECT college_id, campus_id, institution_id INTO d FROM departments WHERE id = NEW.department_id;
    NEW.college_id := COALESCE(NEW.college_id, d.college_id);
    NEW.campus_id := COALESCE(NEW.campus_id, d.campus_id);
    NEW.institution_id := COALESCE(NEW.institution_id, d.institution_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fill_program_hierarchy ON programs;
CREATE TRIGGER trg_fill_program_hierarchy
  BEFORE INSERT ON programs
  FOR EACH ROW EXECUTE FUNCTION fill_program_hierarchy();

CREATE OR REPLACE FUNCTION fill_user_hierarchy()
RETURNS TRIGGER AS $$
DECLARE d RECORD;
BEGIN
  IF NEW.institution_id IS NULL OR NEW.campus_id IS NULL THEN
    IF NEW.department_id IS NOT NULL THEN
      SELECT institution_id, campus_id INTO d FROM departments WHERE id = NEW.department_id;
      NEW.institution_id := COALESCE(NEW.institution_id, d.institution_id);
      NEW.campus_id := COALESCE(NEW.campus_id, d.campus_id);
    END IF;
    IF NEW.institution_id IS NULL OR NEW.campus_id IS NULL THEN
      SELECT * INTO d FROM default_hierarchy_ids();
      NEW.institution_id := COALESCE(NEW.institution_id, d.o_institution);
      NEW.campus_id := COALESCE(NEW.campus_id, d.o_campus);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fill_user_hierarchy ON users;
CREATE TRIGGER trg_fill_user_hierarchy
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION fill_user_hierarchy();

-- ---------------------------------------------------------------------------
-- 3. questions.bloom_level: lowercase, like every other Bloom column and all app code.
-- ---------------------------------------------------------------------------
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'questions'::regclass AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%bloom_level%'
      AND pg_get_constraintdef(con.oid) NOT ILIKE '%submitted_bloom_level%'
  LOOP
    EXECUTE format('ALTER TABLE questions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

UPDATE questions SET bloom_level = lower(bloom_level) WHERE bloom_level IS NOT NULL AND bloom_level <> lower(bloom_level);

ALTER TABLE questions ADD CONSTRAINT questions_bloom_level_check
  CHECK (bloom_level IS NULL OR bloom_level IN ('remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'));
