-- Persist which classes a fee group is allocated to.
-- Safe to re-run.

ALTER TABLE fee_groups ADD COLUMN IF NOT EXISTS class_ids TEXT DEFAULT '[]';

UPDATE fee_groups SET class_ids = '[]' WHERE class_ids IS NULL;
