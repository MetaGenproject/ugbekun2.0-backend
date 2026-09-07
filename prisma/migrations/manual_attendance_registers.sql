-- Phase 1 attendance registers: header table, Lagos date normalize, dedupe, backfill, unique keys.
-- Safe to re-run. Apply before relying on prisma.attendanceRegister.

CREATE TABLE IF NOT EXISTS attendance_registers (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL,
  section_id INTEGER NOT NULL,
  register_date DATE NOT NULL,
  session_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  taken_by_teacher_id INTEGER,
  submitted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_registers_day_unique
  ON attendance_registers (branch_id, session_id, class_id, section_id, register_date);

CREATE INDEX IF NOT EXISTS attendance_registers_branch_date_idx
  ON attendance_registers (branch_id, register_date);

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS register_id INTEGER;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS marked_by_teacher_id INTEGER;

-- Store each row as UTC midnight of its Africa/Lagos calendar date.
UPDATE attendance
SET attendance_date = (((attendance_date AT TIME ZONE 'Africa/Lagos')::date)::timestamp AT TIME ZONE 'UTC')
WHERE attendance_date IS NOT NULL;

-- Keep the newest row per student + session + branch + school day.
DELETE FROM attendance a
USING attendance b
WHERE a.student_id = b.student_id
  AND a.session_id = b.session_id
  AND a.branch_id = b.branch_id
  AND a.attendance_date = b.attendance_date
  AND a.id < b.id;

INSERT INTO attendance_registers (
  class_id,
  section_id,
  register_date,
  session_id,
  branch_id,
  status,
  version,
  submitted_at,
  created_at
)
SELECT DISTINCT
  a.class_id,
  a.section_id,
  (a.attendance_date AT TIME ZONE 'UTC')::date,
  a.session_id,
  a.branch_id,
  'SUBMITTED',
  1,
  NOW(),
  NOW()
FROM attendance a
INNER JOIN branches b ON b.id = a.branch_id
INNER JOIN class c ON c.id = a.class_id
INNER JOIN section s ON s.id = a.section_id
ON CONFLICT (branch_id, session_id, class_id, section_id, register_date) DO NOTHING;

UPDATE attendance a
SET register_id = r.id
FROM attendance_registers r
WHERE a.register_id IS NULL
  AND a.class_id = r.class_id
  AND a.section_id = r.section_id
  AND a.session_id = r.session_id
  AND a.branch_id = r.branch_id
  AND (a.attendance_date AT TIME ZONE 'UTC')::date = r.register_date;

DO $$ BEGIN
  ALTER TABLE attendance_registers
    ADD CONSTRAINT attendance_registers_class_id_fkey
    FOREIGN KEY (class_id) REFERENCES class(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE attendance_registers
    ADD CONSTRAINT attendance_registers_section_id_fkey
    FOREIGN KEY (section_id) REFERENCES section(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE attendance_registers
    ADD CONSTRAINT attendance_registers_branch_id_fkey
    FOREIGN KEY (branch_id) REFERENCES branches(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE attendance_registers
    ADD CONSTRAINT attendance_registers_taken_by_teacher_id_fkey
    FOREIGN KEY (taken_by_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE attendance
    ADD CONSTRAINT attendance_register_id_fkey
    FOREIGN KEY (register_id) REFERENCES attendance_registers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE attendance
    ADD CONSTRAINT attendance_marked_by_teacher_id_fkey
    FOREIGN KEY (marked_by_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS attendance_register_student_key
  ON attendance (register_id, student_id);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_student_session_branch_date_key
  ON attendance (student_id, session_id, branch_id, attendance_date);

CREATE INDEX IF NOT EXISTS attendance_register_id_idx ON attendance (register_id);
CREATE INDEX IF NOT EXISTS attendance_branch_session_idx ON attendance (branch_id, session_id);
