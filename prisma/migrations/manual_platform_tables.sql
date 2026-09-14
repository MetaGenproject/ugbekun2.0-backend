-- Global superadmin platform config. Additive only — do not drop existing columns.

CREATE TABLE IF NOT EXISTS platform_settings (
  id INTEGER PRIMARY KEY,
  myeduride_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  myeduride_api_url TEXT,
  myeduride_api_key TEXT,
  myeduride_webhook_secret TEXT,
  payments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  paystack_public_key TEXT,
  paystack_secret_key TEXT,
  flutterwave_public_key TEXT,
  flutterwave_secret_key TEXT,
  sms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  sms_provider TEXT NOT NULL DEFAULT 'webhook',
  sms_sender_id TEXT,
  sms_api_key TEXT,
  sms_webhook_url TEXT,
  email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  smtp_host TEXT,
  smtp_port INTEGER,
  smtp_user TEXT,
  smtp_pass TEXT,
  smtp_from TEXT,
  ose_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ose_api_key TEXT,
  ose_model TEXT NOT NULL DEFAULT 'deepseek-chat',
  ose_temperature TEXT NOT NULL DEFAULT '0.7',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

INSERT INTO platform_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_api_keys (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_last_four TEXT NOT NULL,
  scopes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS platform_webhooks (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  event_types TEXT NOT NULL DEFAULT 'platform.updated',
  secret TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS system_backups (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  payload JSONB,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_audit_logs (
  id SERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  details TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS system_audit_logs_created_at_idx ON system_audit_logs (created_at);
