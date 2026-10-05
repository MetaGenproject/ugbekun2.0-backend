-- Migration: Dynamic Grading Scales & Class Association
-- Target: PostgreSQL (PipeOps Staging & Production)

-- 1. Create table grading_scales
CREATE TABLE IF NOT EXISTS "grading_scales" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "ranges" JSONB NOT NULL DEFAULT '[]',
    "branch_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "grading_scales_pkey" PRIMARY KEY ("id")
);

-- 2. Add grading_scale_id column to class table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'class' AND column_name = 'grading_scale_id'
    ) THEN
        ALTER TABLE "class" ADD COLUMN "grading_scale_id" INTEGER;
    END IF;
END $$;

-- 3. Add Foreign Keys if not exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'grading_scales_branch_id_fkey'
    ) THEN
        ALTER TABLE "grading_scales" 
        ADD CONSTRAINT "grading_scales_branch_id_fkey" 
        FOREIGN KEY ("branch_id") REFERENCES "branches"("id") 
        ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'class_grading_scale_id_fkey'
    ) THEN
        ALTER TABLE "class" 
        ADD CONSTRAINT "class_grading_scale_id_fkey" 
        FOREIGN KEY ("grading_scale_id") REFERENCES "grading_scales"("id") 
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- 4. Create Index
CREATE INDEX IF NOT EXISTS "grading_scales_branch_id_idx" ON "grading_scales"("branch_id");
