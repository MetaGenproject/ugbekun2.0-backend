import 'dotenv/config';
import { backfillAttendanceRegisters } from '../lib/attendanceRegisterService';
import prisma from '../lib/prisma';

const DDL = [
  `CREATE TABLE IF NOT EXISTS attendance_registers (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS attendance_registers_day_unique
    ON attendance_registers (branch_id, session_id, class_id, section_id, register_date)`,
  `CREATE INDEX IF NOT EXISTS attendance_registers_branch_date_idx
    ON attendance_registers (branch_id, register_date)`,
  `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS register_id INTEGER`,
  `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS marked_by_teacher_id INTEGER`,
];

const CONSTRAINTS = [
  `DO $$ BEGIN
    ALTER TABLE attendance_registers
      ADD CONSTRAINT attendance_registers_class_id_fkey
      FOREIGN KEY (class_id) REFERENCES class(id);
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE attendance_registers
      ADD CONSTRAINT attendance_registers_section_id_fkey
      FOREIGN KEY (section_id) REFERENCES section(id);
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE attendance_registers
      ADD CONSTRAINT attendance_registers_branch_id_fkey
      FOREIGN KEY (branch_id) REFERENCES branches(id);
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE attendance_registers
      ADD CONSTRAINT attendance_registers_taken_by_teacher_id_fkey
      FOREIGN KEY (taken_by_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE attendance
      ADD CONSTRAINT attendance_register_id_fkey
      FOREIGN KEY (register_id) REFERENCES attendance_registers(id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE attendance
      ADD CONSTRAINT attendance_marked_by_teacher_id_fkey
      FOREIGN KEY (marked_by_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS attendance_register_student_key ON attendance (register_id, student_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS attendance_student_session_branch_date_key
    ON attendance (student_id, session_id, branch_id, attendance_date)`,
  `CREATE INDEX IF NOT EXISTS attendance_register_id_idx ON attendance (register_id)`,
  `CREATE INDEX IF NOT EXISTS attendance_branch_session_idx ON attendance (branch_id, session_id)`,
];

async function main() {
  console.log('[attendance-register] Applying schema…');
  for (const sql of DDL) {
    await prisma.$executeRawUnsafe(sql);
  }

  console.log('[attendance-register] Backfilling registers from attendance rows…');
  await backfillAttendanceRegisters(prisma);

  console.log('[attendance-register] Adding constraints…');
  for (const sql of CONSTRAINTS) {
    await prisma.$executeRawUnsafe(sql);
  }

  const [registers] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT COUNT(*)::bigint AS count FROM attendance_registers'
  );
  const [unlinked] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT COUNT(*)::bigint AS count FROM attendance WHERE register_id IS NULL'
  );

  console.log(
    `[attendance-register] Done. registers=${registers?.count ?? '?'} unlinked attendance rows=${unlinked?.count ?? '?'}`
  );
}

main()
  .catch((error) => {
    console.error('[attendance-register] Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });
