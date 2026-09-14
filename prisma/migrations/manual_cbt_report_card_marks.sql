-- CBT scores on the academic mark register + admin correction audit.
-- Safe to re-run.

ALTER TABLE mark ADD COLUMN IF NOT EXISTS cbt_source TEXT;
ALTER TABLE mark ADD COLUMN IF NOT EXISTS cbt_submission_id INTEGER;
ALTER TABLE mark ADD COLUMN IF NOT EXISTS cbt_scale INTEGER;

CREATE INDEX IF NOT EXISTS mark_cbt_submission_idx ON mark (cbt_submission_id);

ALTER TABLE cbt_distributions ADD COLUMN IF NOT EXISTS online_exam_id INTEGER;

CREATE INDEX IF NOT EXISTS cbt_distributions_online_exam_idx
  ON cbt_distributions (online_exam_id);

CREATE TABLE IF NOT EXISTS mark_score_corrections (
  id SERIAL PRIMARY KEY,
  mark_id INTEGER NOT NULL REFERENCES mark(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  actor_user_id INTEGER,
  actor_role TEXT NOT NULL,
  branch_id INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mark_score_corrections_mark_idx ON mark_score_corrections (mark_id);
CREATE INDEX IF NOT EXISTS mark_score_corrections_branch_idx ON mark_score_corrections (branch_id);
