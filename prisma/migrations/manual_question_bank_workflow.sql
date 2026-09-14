-- Additive question-bank / homework classification. Safe to re-run.

ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS session_id INTEGER;
ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS term_name TEXT;
ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS topic TEXT;
ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS difficulty TEXT DEFAULT 'medium';
ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS source_file_name TEXT;
ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS ai_instruction TEXT;
ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS created_by_id INTEGER;
ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS created_by_role TEXT;

CREATE INDEX IF NOT EXISTS question_bank_class_subject_term_idx
  ON question_bank (class_id, subject_id, term_name);

ALTER TABLE homework ADD COLUMN IF NOT EXISTS question_bank_ids JSONB;
ALTER TABLE homework ADD COLUMN IF NOT EXISTS term_name TEXT;
ALTER TABLE homework ADD COLUMN IF NOT EXISTS created_by_id INTEGER;
ALTER TABLE homework ADD COLUMN IF NOT EXISTS created_by_role TEXT;
