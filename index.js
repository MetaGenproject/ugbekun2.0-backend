require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const redisClient = require('./config/redis');

const app = express();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
const authRouter = require('./routes/auth');
const onboardingRouter = require('./routes/onboarding');
app.use('/api/auth', authRouter);
app.use('/api/onboarding', onboardingRouter);

// Health Check Endpoint
app.get('/api/health', async (req, res) => {
  try {
    // Check DB Connection
    await prisma.$queryRaw`SELECT 1`;
    
    // Check Redis Connection
    const ping = await redisClient.ping();

    res.status(200).json({
      status: 'ok',
      message: 'Server is healthy',
      database: 'connected',
      redis: ping === 'PONG' ? 'connected' : 'disconnected'
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
