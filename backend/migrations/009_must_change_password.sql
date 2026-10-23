-- Accounts created by an admin/HOD (see academic.js's new POST /users) get a
-- system-generated temporary password. must_change_password forces that
-- temp password to be changed before the account can do anything else —
-- enforced server-side in middleware.js's requireAuth, not just as a
-- frontend nag, so it can't be bypassed by skipping a UI step.
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
