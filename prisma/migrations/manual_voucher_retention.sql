-- Voucher list, corrections, and record retention.
-- Safe to re-run. Does not delete existing vouchers.

ALTER TABLE voucher_heads ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
UPDATE voucher_heads SET active = true WHERE active IS NULL;

ALTER TABLE office_transactions ADD COLUMN IF NOT EXISTS original_amount DECIMAL(18, 2);
ALTER TABLE office_transactions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'POSTED';
ALTER TABLE office_transactions ADD COLUMN IF NOT EXISTS amendment_note TEXT;
ALTER TABLE office_transactions ADD COLUMN IF NOT EXISTS amended_at TIMESTAMP;
ALTER TABLE office_transactions ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP;
ALTER TABLE office_transactions ADD COLUMN IF NOT EXISTS void_reason TEXT;

UPDATE office_transactions SET status = 'POSTED' WHERE status IS NULL OR status = '';

CREATE INDEX IF NOT EXISTS office_transactions_status_idx ON office_transactions (branch_id, status);
