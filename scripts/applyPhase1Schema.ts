import 'dotenv/config';
import prisma from '../lib/prisma';

const STATEMENTS = [
  // 1. CLASS: Comment-based flag (Uses Scores? Yes / No)
  `ALTER TABLE class ADD COLUMN IF NOT EXISTS uses_scores BOOLEAN NOT NULL DEFAULT TRUE`,

  // 2. EXAM: Stage 1 Exam Master fields
  `ALTER TABLE exam ADD COLUMN IF NOT EXISTS exam_category VARCHAR(20) NOT NULL DEFAULT 'CBT'`,
  `ALTER TABLE exam ADD COLUMN IF NOT EXISTS cbt_total_marks DOUBLE PRECISION`,
  `ALTER TABLE exam ADD COLUMN IF NOT EXISTS total_question_count INTEGER`,
  `ALTER TABLE exam ADD COLUMN IF NOT EXISTS manual_marks_breakdown JSONB`,

  // 3. EVALUATION MATRIX: Granular columns
  `CREATE TABLE IF NOT EXISTS evaluation_matrix_columns (
    id SERIAL PRIMARY KEY,
    matrix_id INTEGER NOT NULL,
    column_key VARCHAR(50) NOT NULL,
    column_label VARCHAR(100) NOT NULL,
    max_marks DOUBLE PRECISION NOT NULL,
    pass_marks DOUBLE PRECISION NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS evaluation_matrix_columns_matrix_id_idx ON evaluation_matrix_columns(matrix_id)`,
  `DO $$ BEGIN
    ALTER TABLE evaluation_matrix_columns
      ADD CONSTRAINT evaluation_matrix_columns_matrix_id_fkey
      FOREIGN KEY (matrix_id) REFERENCES evaluation_matrices(id) ON DELETE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,

  // 4. EVALUATION MATRIX ITEM MAPPINGS: Component rollups (CBT + Manual Theory)
  `CREATE TABLE IF NOT EXISTS evaluation_matrix_item_mappings (
    id SERIAL PRIMARY KEY,
    column_id INTEGER NOT NULL,
    component_name VARCHAR(100) NOT NULL,
    component_type VARCHAR(20) NOT NULL DEFAULT 'CBT',
    weight_marks DOUBLE PRECISION NOT NULL,
    exam_master_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS evaluation_matrix_item_mappings_column_id_idx ON evaluation_matrix_item_mappings(column_id)`,
  `CREATE INDEX IF NOT EXISTS evaluation_matrix_item_mappings_exam_master_id_idx ON evaluation_matrix_item_mappings(exam_master_id)`,
  `DO $$ BEGIN
    ALTER TABLE evaluation_matrix_item_mappings
      ADD CONSTRAINT evaluation_matrix_item_mappings_column_id_fkey
      FOREIGN KEY (column_id) REFERENCES evaluation_matrix_columns(id) ON DELETE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
  `DO $$ BEGIN
    ALTER TABLE evaluation_matrix_item_mappings
      ADD CONSTRAINT evaluation_matrix_item_mappings_exam_master_id_fkey
      FOREIGN KEY (exam_master_id) REFERENCES exam(id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,

  // 5. SUBJECT COMMENT ASSESSMENTS: Qualitative Early Years (ECD / Montessori)
  `CREATE TABLE IF NOT EXISTS subject_comment_assessments (
    id SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    term_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    comment TEXT NOT NULL,
    rating INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS subject_comment_assessments_unique_idx 
    ON subject_comment_assessments(student_id, subject_id, term_id, session_id)`,
  `CREATE INDEX IF NOT EXISTS subject_comment_assessments_class_term_session_idx 
    ON subject_comment_assessments(class_id, term_id, session_id)`,
  `CREATE INDEX IF NOT EXISTS subject_comment_assessments_branch_id_idx 
    ON subject_comment_assessments(branch_id)`,
  `DO $$ BEGIN
    ALTER TABLE subject_comment_assessments
      ADD CONSTRAINT subject_comment_assessments_student_id_fkey
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
  `DO $$ BEGIN
    ALTER TABLE subject_comment_assessments
      ADD CONSTRAINT subject_comment_assessments_subject_id_fkey
      FOREIGN KEY (subject_id) REFERENCES subject(id) ON DELETE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
  `DO $$ BEGIN
    ALTER TABLE subject_comment_assessments
      ADD CONSTRAINT subject_comment_assessments_class_id_fkey
      FOREIGN KEY (class_id) REFERENCES class(id) ON DELETE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
  `DO $$ BEGIN
    ALTER TABLE subject_comment_assessments
      ADD CONSTRAINT subject_comment_assessments_branch_id_fkey
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,

  // 6. CLASS REPORT CARD PUBLICATION: Granular stage releases
  `ALTER TABLE class_report_card_publication ADD COLUMN IF NOT EXISTS term_id INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE class_report_card_publication ADD COLUMN IF NOT EXISTS release_ca1 BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE class_report_card_publication ADD COLUMN IF NOT EXISTS release_ca2 BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE class_report_card_publication ADD COLUMN IF NOT EXISTS release_exam BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE class_report_card_publication ADD COLUMN IF NOT EXISTS release_full BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE INDEX IF NOT EXISTS class_report_card_publication_stage_lookup_idx 
    ON class_report_card_publication(class_id, session_id, term_id)`
];

async function main() {
  console.log('[Phase 1 Migration] Applying database schema extensions...');
  for (const sql of STATEMENTS) {
    await prisma.$executeRawUnsafe(sql);
  }
  console.log('[Phase 1 Migration] Successfully applied:');
  console.log(' - class.uses_scores (Boolean)');
  console.log(' - exam.exam_category, exam.cbt_total_marks, exam.total_question_count, exam.manual_marks_breakdown');
  console.log(' - evaluation_matrix_columns & evaluation_matrix_item_mappings tables');
  console.log(' - subject_comment_assessments table');
  console.log(' - class_report_card_publication multi-stage release columns');
}

main()
  .catch((error) => {
    console.error('[Phase 1 Migration] Failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
