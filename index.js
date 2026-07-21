require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const redisClient = require('./config/redis');
const cron = require('node-cron');

const app = express();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    'https://ugbekun-beta.vercel.app'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-teacher-id']
}));
// Allow larger JSON payloads for base64-encoded logos
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
const authRouter = require('./routes/auth');
const onboardingRouter = require('./routes/onboarding');
const superadminRouter = require('./routes/superadmin');
const adminRouter = require('./routes/admin');
const teacherRouter = require('./routes/teacher');
const studentRouter = require('./routes/student');
const parentRouter = require('./routes/parent');
const verifyRouter = require('./routes/verify');
app.use('/api/auth', authRouter);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/superadmin', superadminRouter);
app.use('/api/admin', adminRouter);
app.use('/api/teacher', teacherRouter);
app.use('/api/student', studentRouter);
app.use('/api/parent', parentRouter);
app.use('/api/verify', verifyRouter);

// Media Upload Endpoint
const { uploadBase64File } = require('./lib/cloudinary');
app.post('/api/upload', async (req, res) => {
  try {
    const { base64, mime, folder } = req.body;
    if (!base64 || !mime) {
      return res.status(400).json({ success: false, message: 'Missing base64 data or mime type.' });
    }
    const url = await uploadBase64File({ base64, mime, folder: folder || 'ugbekun_tasks' });
    return res.json({ success: true, url });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to upload media.' });
  }
});

// Health Check Endpoint
app.get('/api/health', async (req, res) => {
  try {
    // Check DB Connection
    await prisma.$queryRaw`SELECT 1`;
    
    // Check Redis Connection
    let redisStatus = 'disconnected';
    try {
      const ping = await redisClient.ping();
      redisStatus = ping === 'PONG' ? 'connected' : 'disconnected';
    } catch (redisError) {
      console.warn('[HEALTH] Redis health check failed:', redisError.message);
      redisStatus = redisError.message.includes('NOAUTH') ? 'auth_required' : 'error';
    }

    res.status(200).json({
      status: 'ok',
      message: 'Server is healthy',
      database: 'connected',
      redis: redisStatus
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({
      status: 'error',
      message: 'Health check failed',
      error: error.message
    });
  }
});

// Basic Root Route
app.get('/', (req, res) => {
  res.send('Welcome to Ugbekun 2.0 Backend API');
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED CRON JOBS
// ─────────────────────────────────────────────────────────────────────────────

// 1. Weekly Attendance Gamification Evaluator
//    Runs every Monday at 06:00 AM server time
cron.schedule('0 6 * * 1', () => {
  console.log('[CRON] Running weekly attendance gamification evaluation...');
  const { execFile } = require('child_process');
  execFile('node', ['scripts/evaluateWeeklyAttendance.js'], { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) {
      console.error('[CRON] Weekly attendance evaluation failed:', err.message);
    } else {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
  });
}, { scheduled: true, timezone: 'Africa/Lagos' });

// 2. Weekly Attrition Radar Evaluator
//    Runs every Monday at 06:30 AM server time
cron.schedule('30 6 * * 1', () => {
  console.log('[CRON] Running weekly AI predictive attrition radar...');
  const { execFile } = require('child_process');
  execFile('node', ['scripts/evaluateWeeklyAttrition.js'], { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) {
      console.error('[CRON] Weekly attrition radar failed:', err.message);
    } else {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
  });
}, { scheduled: true, timezone: 'Africa/Lagos' });

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
  console.log(`Server is running on port ${PORT}`);
});
