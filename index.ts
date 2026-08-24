import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import redisClient from './config/redis';
import cron from 'node-cron';
import { execFile } from 'child_process';

const app = express();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const PORT = process.env.PORT || 5001;

// Middleware
const extraAllowedOrigins = (process.env.ALLOWED_HOSTS || process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow non-browser client requests (curl, mobile native, Postman)
    if (!origin) {
      callback(null, true);
      return;
    }

    const allowedOrigins = [
      process.env.FRONTEND_URL || 'http://localhost:3001',
      'http://127.0.0.1:3001',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'https://ugbekun-beta.vercel.app',
      'https://www.ugbekun-beta.vercel.app',
      ...extraAllowedOrigins
    ];

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    // Dynamic pattern matching for local network IPs and Vercel preview domains
    const isAllowedHostPattern = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|.*\.vercel\.app)(:\d+)?$/i.test(origin);

    if (isAllowedHostPattern) {
      callback(null, true);
      return;
    }

    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Access-Control-Allow-Headers', 'x-admin-teacher-id'],
  optionsSuccessStatus: 200
}));

// Normalize Content-Type headers (handles comma-separated proxy duplicates like "application/json, application/json")
app.use((req: Request, _res: Response, next: NextFunction) => {
  const ct = req.headers['content-type'];
  if (typeof ct === 'string' && ct.includes('application/json')) {
    req.headers['content-type'] = 'application/json';
  }
  next();
});

// Allow larger JSON payloads for base64-encoded logos
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Global Cache-Control middleware for API endpoints to prevent stale response caching
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// Static uploads with revalidation cache control
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  }
}));

// Routes
import authRouter from './routes/auth';
import onboardingRouter from './routes/onboarding';
import superadminRouter from './routes/superadmin';
import adminRouter from './routes/admin';
import teacherRouter from './routes/teacher';
import studentRouter from './routes/student';
import parentRouter from './routes/parent';
import verifyRouter from './routes/verify';
import publicTenantRouter from './routes/publicTenant';
import { uploadBase64File } from './lib/cloudinary';

app.use('/api/public/tenant', publicTenantRouter);
app.use('/api/public', publicTenantRouter);
app.use('/api/auth', authRouter);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/superadmin', superadminRouter);
app.use('/api/admin', adminRouter);
app.use('/api/teacher', teacherRouter);
app.use('/api/student', studentRouter);
app.use('/api/parent', parentRouter);
app.use('/api/verify', verifyRouter);

// Media Upload Endpoint
app.post('/api/upload', async (req: Request, res: Response) => {
  try {
    const { base64, mime, folder } = req.body;
    if (!base64 || !mime) {
      return res.status(400).json({ success: false, message: 'Missing base64 data or mime type.' });
    }
    const url = await uploadBase64File({ base64, mime, folder: folder || 'ugbekun_tasks' });
    return res.json({ success: true, url });
  } catch (err: any) {
    console.error('[UPLOAD ERROR]', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to upload media.' });
  }
});

// Health Check Endpoint
app.get('/api/health', async (req: Request, res: Response) => {
  try {
    // Check DB Connection
    await prisma.$queryRaw`SELECT 1`;

    // Check Redis Connection
    let redisStatus = 'disconnected';
    try {
      const ping = await redisClient.ping();
      redisStatus = ping === 'PONG' ? 'connected' : 'disconnected';
    } catch (redisError: any) {
      console.warn('[HEALTH] Redis health check failed:', redisError.message);
      redisStatus = redisError.message?.includes('NOAUTH') ? 'auth_required' : 'error';
    }

    res.status(200).json({
      status: 'ok',
      message: 'Server is healthy',
      database: 'connected',
      redis: redisStatus
    });
  } catch (error: any) {
    console.error('Health check failed:', error);
    res.status(500).json({
      status: 'error',
      message: 'Health check failed',
      error: error.message
    });
  }
});

// Basic Root Route
app.get('/', (req: Request, res: Response) => {
  res.send('Welcome to Ugbekun 2.0 Backend API (TypeScript Engine)');
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED CRON JOBS
// ─────────────────────────────────────────────────────────────────────────────

// 1. Weekly Attendance Gamification Evaluator
//    Runs every Monday at 06:00 AM server time
cron.schedule('0 6 * * 1', () => {
  console.log('[CRON] Running weekly attendance gamification evaluation...');
  execFile('node', ['scripts/evaluateWeeklyAttendance.js'], { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) {
      console.error('[CRON] Weekly attendance evaluation failed:', err.message);
    } else {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
  });
}, { timezone: 'Africa/Lagos' });

// 2. Weekly Attrition Radar Evaluator
//    Runs every Monday at 06:30 AM server time
cron.schedule('30 6 * * 1', () => {
  console.log('[CRON] Running weekly AI predictive attrition radar...');
  execFile('node', ['scripts/evaluateWeeklyAttrition.js'], { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) {
      console.error('[CRON] Weekly attrition radar failed:', err.message);
    } else {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
  });
}, { timezone: 'Africa/Lagos' });

console.log('[CRON] Scheduled jobs registered: Weekly Attendance (Mon 06:00) + Attrition Radar (Mon 06:30) [Africa/Lagos]');

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  await redisClient.quit();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  await redisClient.quit();
  process.exit(0);
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT} (TypeScript)`);
});

export default app;
