-- Previously only a bare hash was stored, which made this table
-- write-only in practice — nobody could see what a matched "previous year
-- question" actually said, in the management UI or in the duplicate
-- warning shown to a teacher. Adding the real text fixes both.
ALTER TABLE previous_year_papers ADD COLUMN question_text TEXT;
ALTER TABLE previous_year_papers ADD COLUMN added_by UUID REFERENCES users(id);
ALTER TABLE previous_year_papers ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
