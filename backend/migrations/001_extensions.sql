-- Core extensions this platform relies on.
-- pgcrypto: gen_random_uuid() for all primary keys.
-- vector (pgvector): embedding columns for semantic duplicate/similarity
-- detection across the question bank (used starting in the reviewer-workflow
-- migration; enabled here so every later migration can assume it exists).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
