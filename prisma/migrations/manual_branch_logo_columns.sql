-- Manual migration: add logo columns to `branches`
-- Used when `prisma db push` / migrations haven't been applied yet.

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS "systemLogo" TEXT,
  ADD COLUMN IF NOT EXISTS "textLogo" TEXT,
  ADD COLUMN IF NOT EXISTS "printingLogo" TEXT,
  ADD COLUMN IF NOT EXISTS "reportCardLogo" TEXT;

