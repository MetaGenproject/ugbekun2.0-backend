-- Run after prisma db push fails or for manual Supabase migration.
-- Fused with legacy: branches = schools, users role=2 = branch admin (login_credential).

ALTER TABLE branches ADD COLUMN IF NOT EXISTS admin_name TEXT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS admin_gender TEXT;

CREATE TABLE IF NOT EXISTS subscription_plans (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  price_monthly DECIMAL(18,2) NOT NULL,
  duration_months INT NOT NULL DEFAULT 3,
  total_cost DECIMAL(18,2) NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'NGN',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS branch_subscriptions (
  id SERIAL PRIMARY KEY,
  branch_id INT NOT NULL REFERENCES branches(id),
  plan_id INT NOT NULL REFERENCES subscription_plans(id),
  start_date TIMESTAMPTZ NOT NULL,
  expiry_date TIMESTAMPTZ NOT NULL,
  total_cost DECIMAL(18,2) NOT NULL,
  payment_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  message TEXT,
  terms_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
