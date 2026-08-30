import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import dns from 'node:dns';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {
  // ignore if unsupported
}

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __prismaInstance: PrismaClient | undefined;
}

const pool =
  global.__pgPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 0,
  });

if (process.env.NODE_ENV !== 'production') {
  global.__pgPool = pool;
}

const adapter = new PrismaPg(pool);

export const prisma: PrismaClient =
  global.__prismaInstance || new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  global.__prismaInstance = prisma;
}

export default prisma;
