-- Additive lesson-note workflow fields. Safe to re-run.

DO $$ BEGIN
  ALTER TYPE "LessonPlanStatus" ADD VALUE 'PENDING_APPROVAL';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "LessonPlanStatus" ADD VALUE 'APPROVED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "LessonPlanStatus" ADD VALUE 'REVISION';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS entry_behavior TEXT;
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS ai_instruction TEXT;
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS source_material TEXT;
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS source_file_name TEXT;
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS sub_topic TEXT;
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS duration TEXT;
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS week_no TEXT;
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS reviewer_note TEXT;
