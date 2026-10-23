-- JWTs were previously a single 8h bearer token with no way to invalidate
-- one early — logging out, changing password, or an admin needing to force
-- a compromised session dead all did nothing until the token's natural
-- expiry. token_version is a standard, lightweight revocation technique:
-- every JWT is minted with the user's CURRENT token_version baked in as a
-- claim; every request compares that claim against the user's row. Bumping
-- token_version instantly invalidates every previously-issued token for
-- that user, with no separate session/refresh-token store required.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
