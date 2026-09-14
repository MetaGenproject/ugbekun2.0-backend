import express, { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { hashApiKey } from '../lib/platformRuntime';

const router = express.Router();

export async function requirePlatformApiKey(req: Request, res: Response, next: NextFunction) {
  const header = String(req.headers.authorization || '');
  const raw = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : String(req.headers['x-api-key'] || '').trim();

  if (!raw) {
    res.status(401).json({ success: false, message: 'API key required.' });
    return;
  }

  try {
    const record = await prisma.platformApiKey.findUnique({
      where: { keyHash: hashApiKey(raw) },
    });
    if (!record || !record.active) {
      res.status(401).json({ success: false, message: 'Invalid API key.' });
      return;
    }
    await prisma.platformApiKey.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    });
    (req as any).platformApiKey = record;
    next();
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message || 'API key lookup failed.' });
  }
}

router.get('/status', requirePlatformApiKey, (req: Request, res: Response) => {
  const key = (req as any).platformApiKey;
  res.json({
    success: true,
    platform: 'ugbekun',
    keyName: key?.name,
    scopes: key?.scopes,
  });
});

export default router;
