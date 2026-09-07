-- Phase 3: calendar event kinds, register unlock metadata, attendance audit trail.

ALTER TABLE event ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'EVENT';

ALTER TABLE attendance_registers ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMPTZ;
ALTER TABLE attendance_registers ADD COLUMN IF NOT EXISTS unlocked_by_user_id INTEGER;
ALTER TABLE attendance_registers ADD COLUMN IF NOT EXISTS unlocked_reason TEXT;

CREATE TABLE IF NOT EXISTS attendance_audits (
  id SERIAL PRIMARY KEY,
  register_id INTEGER NOT NULL,
  attendance_id INTEGER,
  student_id INTEGER,
  action VARCHAR(20) NOT NULL,
  from_code VARCHAR(20),
  to_code VARCHAR(20),
  actor_user_id INTEGER,
  reason TEXT,
  branch_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS attendance_audits_register_idx ON attendance_audits (register_id);
CREATE INDEX IF NOT EXISTS attendance_audits_branch_created_idx ON attendance_audits (branch_id, created_at);

DO $$ BEGIN
  ALTER TABLE attendance_audits
    ADD CONSTRAINT attendance_audits_register_id_fkey
    FOREIGN KEY (register_id) REFERENCES attendance_registers(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE attendance_audits
    ADD CONSTRAINT attendance_audits_branch_id_fkey
    FOREIGN KEY (branch_id) REFERENCES branches(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
