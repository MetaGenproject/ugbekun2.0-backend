-- Question bank approval + category, and question-group class linkage.
-- Safe to re-run.

ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'APPROVED';
ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS approved_by_id INTEGER;

UPDATE question_bank SET status = 'APPROVED' WHERE status IS NULL OR status = '';

CREATE INDEX IF NOT EXISTS question_bank_status_idx ON question_bank (branch_id, status);

ALTER TABLE question_groups ADD COLUMN IF NOT EXISTS class_id INTEGER;
ALTER TABLE question_groups ADD COLUMN IF NOT EXISTS total_marks DOUBLE PRECISION DEFAULT 100;

CREATE INDEX IF NOT EXISTS question_groups_class_idx ON question_groups (class_id);
