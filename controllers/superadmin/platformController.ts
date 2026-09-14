import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import {
  applyPlatformRuntime,
  dispatchPlatformWebhooks,
  generateApiKey,
  getPlatformSettingsRecord,
  publicPlatformSettings,
  writeAuditLog,
} from '../../lib/platformRuntime';

function actorFrom(req: Request) {
  const user: any = req.user || {};
  return {
    actor: String(user.username || 'superadmin'),
    actorId: Number(req.userId || user.sub || user.id || 0) || null,
    ipAddress: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') || null,
  };
}

function pickString(body: any, key: string) {
  if (body[key] === undefined || body[key] === null) return undefined;
  const value = String(body[key]).trim();
  return value;
}

/**
 * GET /api/superadmin/platform
 */
export async function getPlatformConfig(req: Request, res: Response): Promise<Response | void> {
  try {
    const settings = await getPlatformSettingsRecord();
    if (!settings) {
      return res.status(500).json({ success: false, message: 'Unable to load platform settings.' });
    }
    const [apiKeys, webhooks, backups, auditLogs] = await Promise.all([
      prisma.platformApiKey.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.platformWebhook.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.systemBackup.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.systemAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
    ]);

    return res.json({
      success: true,
      settings: publicPlatformSettings(settings),
      apiKeys: apiKeys.map((key) => ({
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        keyLastFour: key.keyLastFour,
        scopes: key.scopes,
        active: key.active,
        lastUsedAt: key.lastUsedAt,
        createdAt: key.createdAt,
      })),
      webhooks,
      backups: backups.map((backup) => ({
        id: backup.id,
        label: backup.label,
        status: backup.status,
        notes: backup.notes,
        createdBy: backup.createdBy,
        createdAt: backup.createdAt,
      })),
      auditLogs,
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Get platform config error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load platform settings.' });
  }
}

/**
 * PUT /api/superadmin/platform
 */
export async function updatePlatformConfig(req: Request, res: Response): Promise<Response | void> {
  try {
    const body = req.body || {};
    const current = await getPlatformSettingsRecord();
    if (!current) {
      return res.status(500).json({ success: false, message: 'Unable to load platform settings.' });
    }

    const data: any = {};
    const boolKeys = ['myedurideEnabled', 'paymentsEnabled', 'smsEnabled', 'emailEnabled', 'oseEnabled'];
    boolKeys.forEach((key) => {
      if (body[key] !== undefined) data[key] = Boolean(body[key]);
    });

    const stringKeys = [
      'myedurideApiUrl',
      'smsProvider',
      'smsSenderId',
      'smsWebhookUrl',
      'smtpHost',
      'smtpUser',
      'smtpFrom',
      'oseModel',
      'oseTemperature',
      'paystackPublicKey',
      'flutterwavePublicKey',
    ];
    stringKeys.forEach((key) => {
      const value = pickString(body, key);
      if (value !== undefined) data[key] = value || null;
    });

    const secretKeys = [
      'myedurideApiKey',
      'myedurideWebhookSecret',
      'paystackSecretKey',
      'flutterwaveSecretKey',
      'smsApiKey',
      'smtpPass',
      'oseApiKey',
    ];
    secretKeys.forEach((key) => {
      const value = pickString(body, key);
      if (value && !value.includes('••••')) data[key] = value;
    });

    if (body.smtpPort !== undefined) {
      const port = Number(body.smtpPort);
      data.smtpPort = Number.isFinite(port) ? port : current.smtpPort;
    }

    const updated = await prisma.platformSetting.upsert({
      where: { id: 1 },
      create: { id: 1, ...data },
      update: data,
    });

    applyPlatformRuntime(updated);
    const meta = actorFrom(req);
    await writeAuditLog({
      ...meta,
      action: 'UPDATE',
      entity: 'platform_settings',
      details: `Updated global platform settings (${Object.keys(data).join(', ') || 'no fields'})`,
    });
    dispatchPlatformWebhooks('platform.updated', { fields: Object.keys(data) }).catch(() => null);

    return res.json({
      success: true,
      message: 'Global platform settings saved.',
      settings: publicPlatformSettings(updated),
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Update platform config error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to save platform settings.' });
  }
}

export async function createPlatformApiKey(req: Request, res: Response): Promise<Response | void> {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: 'API key name is required.' });
    const generated = generateApiKey();
    const record = await prisma.platformApiKey.create({
      data: {
        name,
        keyPrefix: generated.prefix,
        keyHash: generated.hash,
        keyLastFour: generated.lastFour,
        scopes: String(req.body?.scopes || 'read,write'),
        active: true,
      },
    });
    const meta = actorFrom(req);
    await writeAuditLog({ ...meta, action: 'CREATE', entity: 'platform_api_key', details: `Created API key ${name}` });
    return res.status(201).json({
      success: true,
      message: 'API key created. Copy it now; it will not be shown again.',
      apiKey: generated.raw,
      record: {
        id: record.id,
        name: record.name,
        keyPrefix: record.keyPrefix,
        keyLastFour: record.keyLastFour,
        scopes: record.scopes,
        active: record.active,
        createdAt: record.createdAt,
      },
    });
  } catch (error: any) {
    console.error('[SUPERADMIN] Create API key error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create API key.' });
  }
}

export async function updatePlatformApiKey(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.platformApiKey.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'API key not found.' });
    const updated = await prisma.platformApiKey.update({
      where: { id },
      data: {
        name: req.body?.name ? String(req.body.name).trim() : existing.name,
        scopes: req.body?.scopes !== undefined ? String(req.body.scopes) : existing.scopes,
        active: req.body?.active !== undefined ? Boolean(req.body.active) : existing.active,
      },
    });
    const meta = actorFrom(req);
    await writeAuditLog({ ...meta, action: 'UPDATE', entity: 'platform_api_key', details: `Updated API key ${updated.name}` });
    return res.json({ success: true, message: 'API key updated.', record: updated });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to update API key.' });
  }
}

export async function deletePlatformApiKey(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.platformApiKey.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'API key not found.' });
    await prisma.platformApiKey.delete({ where: { id } });
    const meta = actorFrom(req);
    await writeAuditLog({ ...meta, action: 'DELETE', entity: 'platform_api_key', details: `Deleted API key ${existing.name}` });
    return res.json({ success: true, message: 'API key deleted.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete API key.' });
  }
}

export async function createPlatformWebhook(req: Request, res: Response): Promise<Response | void> {
  try {
    const name = String(req.body?.name || '').trim();
    const url = String(req.body?.url || '').trim();
    if (!name || !url) return res.status(400).json({ success: false, message: 'Webhook name and URL are required.' });
    const record = await prisma.platformWebhook.create({
      data: {
        name,
        url,
        eventTypes: String(req.body?.eventTypes || 'platform.updated'),
        secret: req.body?.secret ? String(req.body.secret) : null,
        active: req.body?.active !== false,
      },
    });
    const meta = actorFrom(req);
    await writeAuditLog({ ...meta, action: 'CREATE', entity: 'platform_webhook', details: `Created webhook ${name}` });
    return res.status(201).json({ success: true, message: 'Webhook created.', webhook: record });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to create webhook.' });
  }
}

export async function updatePlatformWebhook(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.platformWebhook.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Webhook not found.' });
    const updated = await prisma.platformWebhook.update({
      where: { id },
      data: {
        name: req.body?.name ? String(req.body.name).trim() : existing.name,
        url: req.body?.url ? String(req.body.url).trim() : existing.url,
        eventTypes: req.body?.eventTypes !== undefined ? String(req.body.eventTypes) : existing.eventTypes,
        secret: req.body?.secret !== undefined ? (String(req.body.secret) || null) : existing.secret,
        active: req.body?.active !== undefined ? Boolean(req.body.active) : existing.active,
      },
    });
    const meta = actorFrom(req);
    await writeAuditLog({ ...meta, action: 'UPDATE', entity: 'platform_webhook', details: `Updated webhook ${updated.name}` });
    return res.json({ success: true, message: 'Webhook updated.', webhook: updated });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to update webhook.' });
  }
}

export async function deletePlatformWebhook(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.platformWebhook.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Webhook not found.' });
    await prisma.platformWebhook.delete({ where: { id } });
    const meta = actorFrom(req);
    await writeAuditLog({ ...meta, action: 'DELETE', entity: 'platform_webhook', details: `Deleted webhook ${existing.name}` });
    return res.json({ success: true, message: 'Webhook deleted.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete webhook.' });
  }
}

export async function createSystemBackup(req: Request, res: Response): Promise<Response | void> {
  try {
    const settings = await getPlatformSettingsRecord();
    const [apiKeys, webhooks] = await Promise.all([
      prisma.platformApiKey.findMany(),
      prisma.platformWebhook.findMany(),
    ]);
    const label = String(req.body?.label || `Backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
    const record = await prisma.systemBackup.create({
      data: {
        label,
        status: 'COMPLETED',
        payload: {
          settings,
          apiKeys,
          webhooks,
        } as any,
        notes: 'JSON snapshot of global platform settings, API keys, and webhooks.',
        createdBy: Number(req.userId || 0) || null,
      },
    });
    const meta = actorFrom(req);
    await writeAuditLog({ ...meta, action: 'CREATE', entity: 'system_backup', details: `Created backup ${label}` });
    return res.status(201).json({
      success: true,
      message: 'Platform backup created.',
      backup: {
        id: record.id,
        label: record.label,
        status: record.status,
        notes: record.notes,
        createdAt: record.createdAt,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to create backup.' });
  }
}

export async function restoreSystemBackup(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const backup = await prisma.systemBackup.findUnique({ where: { id } });
    if (!backup?.payload) return res.status(404).json({ success: false, message: 'Backup not found.' });
    const payload: any = backup.payload;
    if (payload.settings) {
      const { id: _id, createdAt: _c, updatedAt: _u, ...settingsData } = payload.settings;
      const updated = await prisma.platformSetting.upsert({
        where: { id: 1 },
        create: { id: 1, ...settingsData },
        update: settingsData,
      });
      applyPlatformRuntime(updated);
    }
    if (Array.isArray(payload.webhooks)) {
      await prisma.platformWebhook.deleteMany();
      if (payload.webhooks.length) {
        await prisma.platformWebhook.createMany({
          data: payload.webhooks.map((hook: any) => ({
            name: hook.name,
            url: hook.url,
            eventTypes: hook.eventTypes || 'platform.updated',
            secret: hook.secret || null,
            active: hook.active !== false,
          })),
        });
      }
    }
    if (Array.isArray(payload.apiKeys)) {
      await prisma.platformApiKey.deleteMany();
      if (payload.apiKeys.length) {
        await prisma.platformApiKey.createMany({
          data: payload.apiKeys
            .filter((key: any) => key.keyHash)
            .map((key: any) => ({
              name: key.name,
              keyPrefix: key.keyPrefix,
              keyHash: key.keyHash,
              keyLastFour: key.keyLastFour,
              scopes: key.scopes || null,
              active: key.active !== false,
            })),
        });
      }
    }
    const meta = actorFrom(req);
    await writeAuditLog({ ...meta, action: 'RESTORE', entity: 'system_backup', details: `Restored backup ${backup.label}` });
    return res.json({ success: true, message: 'Backup restored into global platform settings.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to restore backup.' });
  }
}

export async function deleteSystemBackup(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.systemBackup.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Backup not found.' });
    await prisma.systemBackup.delete({ where: { id } });
    const meta = actorFrom(req);
    await writeAuditLog({ ...meta, action: 'DELETE', entity: 'system_backup', details: `Deleted backup ${existing.label}` });
    return res.json({ success: true, message: 'Backup deleted.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete backup.' });
  }
}

export async function deleteAuditLog(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.systemAuditLog.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Audit log not found.' });
    await prisma.systemAuditLog.delete({ where: { id } });
    return res.json({ success: true, message: 'Audit log deleted.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to delete audit log.' });
  }
}

export async function clearAuditLogs(_req: Request, res: Response): Promise<Response | void> {
  try {
    await prisma.systemAuditLog.deleteMany();
    return res.json({ success: true, message: 'Audit logs cleared.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to clear audit logs.' });
  }
}

export async function testPlatformWebhook(req: Request, res: Response): Promise<Response | void> {
  try {
    const id = Number(req.params.id);
    const hook = await prisma.platformWebhook.findUnique({ where: { id } });
    if (!hook) return res.status(404).json({ success: false, message: 'Webhook not found.' });
    await dispatchPlatformWebhooks(hook.eventTypes.split(',')[0] || 'platform.updated', {
      test: true,
      webhookId: hook.id,
      name: hook.name,
    });
    return res.json({ success: true, message: 'Test event dispatched.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to test webhook.' });
  }
}
