-- Dashboard performance indexes (teacher + student portals).
-- Safe to re-run. Only adds indexes; no data is changed.
-- Names follow Prisma's default convention so they match schema.prisma.

-- Teacher dashboard: subject performance (marks by subject + session)
CREATE INDEX IF NOT EXISTS mark_subject_id_session_id_idx ON mark (subject_id, session_id);

-- Teacher dashboard: student counts / roster by class + section + session
CREATE INDEX IF NOT EXISTS enroll_class_id_section_id_session_id_idx ON enroll (class_id, section_id, session_id);

-- Teacher dashboard: pending reviews (submissions joined to homework)
CREATE INDEX IF NOT EXISTS homework_submission_homework_id_idx ON homework_submission (homework_id);

-- Teacher lookups on every teacher page (allocations / subject assignments by teacher)
CREATE INDEX IF NOT EXISTS "teacher_allocations_teacherId_idx" ON teacher_allocations ("teacherId");
CREATE INDEX IF NOT EXISTS subject_assign_teacher_id_idx ON subject_assign (teacher_id);
