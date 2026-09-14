import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import dns from 'node:dns';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore if unsupported
}

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __prismaInstance: PrismaClient | undefined;
}

function createPool() {
  const connectionString = process.env.DATABASE_URL || '';
  const usesSupabasePooler = /pooler\.supabase\.com|:6543/i.test(connectionString);
  const max = Number(process.env.PG_POOL_MAX || (usesSupabasePooler ? 5 : 10));

  const pool = new Pool({
    connectionString,
    max: Number.isFinite(max) && max > 0 ? max : 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
    allowExitOnIdle: true,
    ssl: /sslmode=(require|no-verify)/i.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined,
  });

  pool.on('error', (err) => {
    console.error('[PG POOL] Unexpected client error:', err.message);
  });

  return pool;
}

const pool = global.__pgPool || createPool();

if (process.env.NODE_ENV !== 'production') {
  global.__pgPool = pool;
}

const adapter = new PrismaPg(pool);

export const prisma: PrismaClient =
  global.__prismaInstance || new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  global.__prismaInstance = prisma;
}

export async function disconnectPrisma() {
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  try {
    await pool.end();
  } catch {
    // ignore
  }
  global.__pgPool = undefined;
  global.__prismaInstance = undefined;
}

export async function retryOnConnectivity<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isDatabaseConnectivityError(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}

export function isDatabaseConnectivityError(error: unknown): boolean {
  const err = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = String(err?.code || err?.cause?.code || '');
  const message = `${err?.message || ''} ${err?.cause?.message || ''}`;
  return (
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'P1001' ||
    /getaddrinfo|EAI_AGAIN|Can't reach database|Connection terminated|timeout expired|timeout exceeded when trying to connect/i.test(
      message
    )
  );
}

export default prisma;
