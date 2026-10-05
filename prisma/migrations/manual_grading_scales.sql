-- Migration: Manual Grading Scales & Class Association
-- Target: MySQL / MariaDB (PipeOps Staging & Production)

CREATE TABLE IF NOT EXISTS `grading_scales` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `code` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `is_default` BOOLEAN NOT NULL DEFAULT FALSE,
  `ranges` JSON NOT NULL,
  `branch_id` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `grading_scales_branch_id_idx` (`branch_id`),
  CONSTRAINT `grading_scales_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Add column to classes if not already present
SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists 
FROM information_schema.COLUMNS 
WHERE TABLE_SCHEMA = DATABASE() 
  AND TABLE_NAME = 'classes' 
  AND COLUMN_NAME = 'grading_scale_id';

SET @stmt = IF(@col_exists = 0, 'ALTER TABLE `classes` ADD COLUMN `grading_scale_id` INT NULL', 'SELECT "Column grading_scale_id already exists in classes"');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add foreign key constraint if not present
SET @fk_exists = 0;
SELECT COUNT(*) INTO @fk_exists 
FROM information_schema.TABLE_CONSTRAINTS 
WHERE CONSTRAINT_SCHEMA = DATABASE() 
  AND TABLE_NAME = 'classes' 
  AND CONSTRAINT_NAME = 'classes_grading_scale_id_fkey';

SET @stmt_fk = IF(@fk_exists = 0, 'ALTER TABLE `classes` ADD CONSTRAINT `classes_grading_scale_id_fkey` FOREIGN KEY (`grading_scale_id`) REFERENCES `grading_scales` (`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT "FK classes_grading_scale_id_fkey already exists"');
PREPARE stmt_fk FROM @stmt_fk;
EXECUTE stmt_fk;
DEALLOCATE PREPARE stmt_fk;
