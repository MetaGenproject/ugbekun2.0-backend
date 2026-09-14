import crypto from 'crypto';
import prisma from './prisma';
import { resetEmailRuntime } from './emailService';
import { resetDeepseekClient } from './aiClient';

export type PlatformSettingRecord = Awaited<ReturnType<typeof prisma.platformSetting.findFirst>>;

function maskSecret(value?: string | null) {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export function hashApiKey(raw: string) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateApiKey() {
  const raw = `ugk_${crypto.randomBytes(24).toString('hex')}`;
  return {
    raw,
    prefix: raw.slice(0, 8),
    lastFour: raw.slice(-4),
    hash: hashApiKey(raw),
  };
}

function envSeed() {
  return {
    myedurideEnabled: Boolean(process.env.MYEDURIDE_API_URL),
    myedurideApiUrl: process.env.MYEDURIDE_API_URL || null,
    myedurideApiKey: process.env.MYEDURIDE_API_KEY || null,
    paymentsEnabled: Boolean(process.env.PAYSTACK_SECRET_KEY || process.env.FLUTTERWAVE_SECRET_KEY),
    paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || null,
    paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || null,
    flutterwavePublicKey: process.env.FLUTTERWAVE_PUBLIC_KEY || null,
    flutterwaveSecretKey: process.env.FLUTTERWAVE_SECRET_KEY || null,
    smsEnabled: Boolean(process.env.SMS_WEBHOOK_URL),
    smsProvider: 'webhook',
    smsApiKey: process.env.SMS_WEBHOOK_TOKEN || null,
    smsWebhookUrl: process.env.SMS_WEBHOOK_URL || null,
    emailEnabled: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
    smtpHost: process.env.SMTP_HOST || null,
    smtpPort: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465,
    smtpUser: process.env.SMTP_USER || null,
    smtpPass: process.env.SMTP_PASS || null,
    smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || null,
    oseEnabled: Boolean(process.env.DEEPSEEK_API_KEY),
    oseApiKey: process.env.DEEPSEEK_API_KEY || null,
    oseModel: process.env.OSE_MODEL || 'deepseek-chat',
    oseTemperature: process.env.OSE_TEMPERATURE || '0.7',
  };
}

async function createDefaultSettings() {
  return prisma.platformSetting.create({
    data: {
      id: 1,
      ...envSeed(),
    },
  });
}

export async function getPlatformSettingsRecord() {
  const existing = await prisma.platformSetting.findFirst();
  if (!existing) {
    try {
      return await createDefaultSettings();
    } catch {
      return prisma.platformSetting.findFirst();
    }
  }

  const neverConfigured = !existing.smtpHost && !existing.oseApiKey && !existing.smsWebhookUrl && !existing.updatedAt;
  if (neverConfigured) {
    return prisma.platformSetting.update({
      where: { id: existing.id },
      data: envSeed(),
    });
  }

  return existing;
}

export function applyPlatformRuntime(settings: NonNullable<PlatformSettingRecord>) {
  if (settings.smtpHost) process.env.SMTP_HOST = settings.smtpHost;
  if (settings.smtpPort) process.env.SMTP_PORT = String(settings.smtpPort);
  if (settings.smtpUser) process.env.SMTP_USER = settings.smtpUser;
  if (settings.smtpPass) process.env.SMTP_PASS = settings.smtpPass;
  if (settings.smtpFrom) process.env.SMTP_FROM = settings.smtpFrom;
  process.env.EMAIL_ENABLED = settings.emailEnabled ? 'true' : 'false';

  if (settings.smsWebhookUrl) process.env.SMS_WEBHOOK_URL = settings.smsWebhookUrl;
  if (settings.smsApiKey) process.env.SMS_WEBHOOK_TOKEN = settings.smsApiKey;
  process.env.SMS_ENABLED = settings.smsEnabled ? 'true' : 'false';

  if (settings.oseApiKey) process.env.DEEPSEEK_API_KEY = settings.oseApiKey;
  process.env.OSE_ENABLED = settings.oseEnabled ? 'true' : 'false';
  if (settings.oseModel) process.env.OSE_MODEL = settings.oseModel;
  if (settings.oseTemperature) process.env.OSE_TEMPERATURE = settings.oseTemperature;

  if (settings.myedurideApiUrl) process.env.MYEDURIDE_API_URL = settings.myedurideApiUrl;
  if (settings.myedurideApiKey) process.env.MYEDURIDE_API_KEY = settings.myedurideApiKey;
  if (settings.myedurideWebhookSecret) process.env.MYEDURIDE_WEBHOOK_SECRET = settings.myedurideWebhookSecret;
  process.env.MYEDURIDE_ENABLED = settings.myedurideEnabled ? 'true' : 'false';

  if (settings.paystackSecretKey) process.env.PAYSTACK_SECRET_KEY = settings.paystackSecretKey;
  if (settings.paystackPublicKey) process.env.PAYSTACK_PUBLIC_KEY = settings.paystackPublicKey;
  if (settings.flutterwaveSecretKey) process.env.FLUTTERWAVE_SECRET_KEY = settings.flutterwaveSecretKey;
  if (settings.flutterwavePublicKey) process.env.FLUTTERWAVE_PUBLIC_KEY = settings.flutterwavePublicKey;
  process.env.PAYMENTS_ENABLED = settings.paymentsEnabled ? 'true' : 'false';

  resetEmailRuntime();
  resetDeepseekClient();
}

export async function bootstrapPlatformSettings() {
  const settings = await getPlatformSettingsRecord();
  if (settings) applyPlatformRuntime(settings);
  return settings;
}

export function publicPlatformSettings(settings: NonNullable<PlatformSettingRecord>) {
  return {
    id: settings.id,
    myedurideEnabled: settings.myedurideEnabled,
    myedurideApiUrl: settings.myedurideApiUrl || '',
    myedurideApiKeyMasked: maskSecret(settings.myedurideApiKey),
    myedurideWebhookSecretMasked: maskSecret(settings.myedurideWebhookSecret),
    paymentsEnabled: settings.paymentsEnabled,
    paystackPublicKey: settings.paystackPublicKey || '',
    paystackSecretKeyMasked: maskSecret(settings.paystackSecretKey),
    flutterwavePublicKey: settings.flutterwavePublicKey || '',
    flutterwaveSecretKeyMasked: maskSecret(settings.flutterwaveSecretKey),
    smsEnabled: settings.smsEnabled,
    smsProvider: settings.smsProvider,
    smsSenderId: settings.smsSenderId || '',
    smsApiKeyMasked: maskSecret(settings.smsApiKey),
    smsWebhookUrl: settings.smsWebhookUrl || '',
    emailEnabled: settings.emailEnabled,
    smtpHost: settings.smtpHost || '',
    smtpPort: settings.smtpPort || 465,
    smtpUser: settings.smtpUser || '',
    smtpPassMasked: maskSecret(settings.smtpPass),
    smtpFrom: settings.smtpFrom || '',
    oseEnabled: settings.oseEnabled,
    oseApiKeyMasked: maskSecret(settings.oseApiKey),
    oseModel: settings.oseModel,
    oseTemperature: settings.oseTemperature,
    updatedAt: settings.updatedAt,
  };
}

export async function writeAuditLog(entry: {
  actor?: string;
  actorId?: number | null;
  action: string;
  entity?: string;
  details?: string;
  ipAddress?: string | null;
}) {
  try {
    await prisma.systemAuditLog.create({
      data: {
        actor: entry.actor || 'system',
        actorId: entry.actorId || null,
        action: entry.action,
        entity: entry.entity || null,
        details: entry.details || null,
        ipAddress: entry.ipAddress || null,
      },
    });
  } catch (error) {
    console.warn('[AUDIT] Failed to write log:', error);
  }
}

export async function dispatchPlatformWebhooks(eventType: string, payload: Record<string, unknown>) {
  try {
    const hooks = await prisma.platformWebhook.findMany({ where: { active: true } });
    await Promise.all(
      hooks
        .filter((hook) => !hook.eventTypes || hook.eventTypes.split(',').map((v) => v.trim()).includes(eventType) || hook.eventTypes.includes('*'))
        .map(async (hook) => {
          try {
            await fetch(hook.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(hook.secret ? { 'X-Ugbekun-Secret': hook.secret } : {}),
              },
              body: JSON.stringify({ event: eventType, payload, sentAt: new Date().toISOString() }),
            });
          } catch (error: any) {
            console.warn(`[WEBHOOK] ${hook.name} failed:`, error?.message || error);
          }
        })
    );
  } catch (error) {
    console.warn('[WEBHOOK] dispatch failed:', error);
  }
}

export function getPaymentGatewayConfig() {
  const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';
  const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY || '';
  return {
    enabled:
      process.env.PAYMENTS_ENABLED !== 'false' && Boolean(paystackSecretKey || flutterwaveSecretKey),
    provider: paystackSecretKey ? 'paystack' : flutterwaveSecretKey ? 'flutterwave' : null,
    paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
    paystackSecretKey,
    flutterwavePublicKey: process.env.FLUTTERWAVE_PUBLIC_KEY || '',
    flutterwaveSecretKey,
  };
}

export function isOseEnabled() {
  return process.env.OSE_ENABLED !== 'false';
}
