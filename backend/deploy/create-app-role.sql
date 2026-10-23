-- Creates a restricted database role for the running application,
-- separate from the schema-owning role migrations run as (spec section
-- 75.5: "app_runtime" vs "migration_admin"). Run this ONCE, by whoever
-- administers the database, after migrations have created the schema —
-- not part of the app's own migration runner, since granting privileges
-- on a fixed set of tables is an infrastructure/DBA action, not a schema
-- change tracked alongside application code.
--
-- Usage:
--   psql -d examportal -f backend/deploy/create-app-role.sql
-- (as a superuser, or as the role that owns the schema)
--
-- Then set APP_DATABASE_URL in .env to use this role instead of the owner
-- role — DATABASE_URL (used by `npm run migrate`) keeps using the owner
-- role, since DDL genuinely needs those privileges. If APP_DATABASE_URL is
-- left unset, the app falls back to DATABASE_URL and everything behaves
-- exactly as before this script existed — this is opt-in hardening, not a
-- breaking change.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'examportal_app') THEN
    CREATE ROLE examportal_app WITH LOGIN PASSWORD 'change-this-password';
  END IF;
END
$$;

-- Only what the running application actually needs: read/write rows,
-- never create/alter/drop tables, never touch other roles, never manage
-- the cluster itself.
GRANT CONNECT ON DATABASE examportal TO examportal_app;
GRANT USAGE ON SCHEMA public TO examportal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO examportal_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO examportal_app;

-- So tables/sequences created by FUTURE migrations (run as the owner role)
-- are automatically usable by the app role too, without re-running this
-- script after every migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO examportal_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO examportal_app;

-- Explicitly confirm what this role can NOT do, for anyone reading this
-- script — no action needed, PostgreSQL denies anything not explicitly
-- granted, this is just documentation of that fact:
--   - Cannot CREATE, ALTER, or DROP tables/schemas/extensions
--   - Cannot CREATE or ALTER other roles
--   - Cannot run ALTER SYSTEM or any cluster-wide administrative command
--   - Cannot DROP or CREATE the database itself
