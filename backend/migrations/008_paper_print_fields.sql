-- A real exam paper header needs a duration and general instructions —
-- these were missing from the original exam_papers table because nothing
-- before this rendered a printable document; the question-selection logic
-- never needed them.
ALTER TABLE exam_papers ADD COLUMN duration_minutes INTEGER;
ALTER TABLE exam_papers ADD COLUMN instructions TEXT;
