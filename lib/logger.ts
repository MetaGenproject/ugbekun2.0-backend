import fs from 'fs';
import path from 'path';
import { Request, Response, NextFunction } from 'express';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per log file before rotating to .1

// Ensure log directory exists
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (err) {
  console.error('[LOGGER INIT] Failed to create log directory:', err);
}

const LOG_FILES = {
  error: path.join(LOG_DIR, 'error.log'),
  combined: path.join(LOG_DIR, 'combined.log'),
  client: path.join(LOG_DIR, 'client-errors.log'),
};

/**
 * Checks if a log file exceeds the max size limit and rotates it.
 */
function rotateLogFileIfNeeded(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size >= MAX_LOG_SIZE_BYTES) {
        const rotatedPath = `${filePath}.1`;
        if (fs.existsSync(rotatedPath)) {
          fs.unlinkSync(rotatedPath);
        }
        fs.renameSync(filePath, rotatedPath);
      }
    }
  } catch (err) {
    console.error(`[LOGGER ROTATION] Error rotating ${filePath}:`, err);
  }
}

/**
 * Appends a raw string line to a specific log file asynchronously with a fallback.
 */
function appendToFile(filePath: string, line: string): void {
  try {
    rotateLogFileIfNeeded(filePath);
    fs.appendFile(filePath, line + '\n', 'utf8', (err) => {
      if (err) {
        console.error(`[LOGGER WRITE ERROR] Could not write to ${filePath}:`, err.message);
      }
    });
  } catch (err: any) {
    console.error(`[LOGGER WRITE SYNC ERROR] ${filePath}:`, err?.message || err);
  }
}

/**
 * Scrubs passwords, keys, and tokens from logged objects.
 */
export function scrubSensitiveData(obj: any, depth = 0): any {
  if (depth > 4 || obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => scrubSensitiveData(item, depth + 1));
  }

  const sensitiveKeys = [
    'password',
    'pass',
    'pwd',
    'token',
    'accesstoken',
    'refreshtoken',
    'auth',
    'authorization',
    'secret',
    'apikey',
    'api_key',
    'creditcard',
    'cardnumber',
    'cvv',
  ];

  const scrubbed: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase().replace(/[^a-z]/g, '');
    if (sensitiveKeys.some((s) => lowerKey.includes(s))) {
      scrubbed[key] = '***REDACTED***';
    } else if (typeof value === 'object') {
      scrubbed[key] = scrubSensitiveData(value, depth + 1);
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bright: '\x1b[1m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function formatConsole(level: LogLevel, context: string, message: string, meta?: any): string {
  const timestamp = new Date().toISOString();
  let color = COLORS.blue;
  if (level === 'DEBUG') color = COLORS.cyan;
  if (level === 'WARN') color = COLORS.yellow;
  if (level === 'ERROR') color = COLORS.red;

  let out = `${COLORS.dim}[${timestamp}]${COLORS.reset} ${color}[${level}]${COLORS.reset} ${COLORS.magenta}[${context}]${COLORS.reset} ${message}`;
  if (meta !== undefined) {
    try {
      const clean = scrubSensitiveData(meta);
      out += ` ${COLORS.dim}${JSON.stringify(clean)}${COLORS.reset}`;
    } catch {
      // ignore serialization error
    }
  }
  return out;
}

function formatFile(level: LogLevel, context: string, message: string, error?: any, meta?: any): string {
  const timestamp = new Date().toISOString();
  const entry: Record<string, any> = {
    timestamp,
    level,
    context,
    message,
  };

  if (error) {
    if (error instanceof Error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    } else {
      entry.error = String(error);
    }
  }

  if (meta !== undefined) {
    entry.meta = scrubSensitiveData(meta);
  }

  return JSON.stringify(entry);
}

export const logger = {
  debug(context: string, message: string, meta?: any) {
    if (process.env.NODE_ENV !== 'production' || process.env.LOG_LEVEL === 'DEBUG') {
      console.log(formatConsole('DEBUG', context, message, meta));
      appendToFile(LOG_FILES.combined, formatFile('DEBUG', context, message, undefined, meta));
    }
  },

  info(context: string, message: string, meta?: any) {
    console.log(formatConsole('INFO', context, message, meta));
    appendToFile(LOG_FILES.combined, formatFile('INFO', context, message, undefined, meta));
  },

  warn(context: string, message: string, meta?: any) {
    console.warn(formatConsole('WARN', context, message, meta));
    const fileEntry = formatFile('WARN', context, message, undefined, meta);
    appendToFile(LOG_FILES.combined, fileEntry);
    appendToFile(LOG_FILES.error, fileEntry);
  },

  error(context: string, message: string, error?: any, meta?: any) {
    console.error(formatConsole('ERROR', context, message, meta));
    if (error && error.stack) {
      console.error(error.stack);
    }
    const fileEntry = formatFile('ERROR', context, message, error, meta);
    appendToFile(LOG_FILES.combined, fileEntry);
    appendToFile(LOG_FILES.error, fileEntry);
  },

  clientError(payload: {
    message: string;
    stack?: string;
    url?: string;
    route?: string;
    componentStack?: string;
    userId?: string | number;
    role?: string;
    userAgent?: string;
    timestamp?: string;
  }) {
    const timestamp = payload.timestamp || new Date().toISOString();
    const entry = JSON.stringify({
      timestamp,
      level: 'CLIENT_ERROR',
      context: 'FRONTEND',
      message: payload.message,
      route: payload.route || payload.url,
      stack: payload.stack,
      componentStack: payload.componentStack,
      user: { id: payload.userId, role: payload.role },
      userAgent: payload.userAgent,
    });

    console.error(
      `${COLORS.red}[CLIENT ERROR]${COLORS.reset} ${COLORS.magenta}[${payload.route || 'Web'}]${COLORS.reset} ${payload.message}`
    );
    appendToFile(LOG_FILES.client, entry);
    appendToFile(LOG_FILES.error, entry);
  },
};

/**
 * Express middleware to track incoming HTTP requests, latencies, and 4xx/5xx responses.
 */
export function httpLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip noisy polling or static assets
  if (req.url.startsWith('/uploads') || req.url === '/api/health') {
    return next();
  }

  const start = Date.now();
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const method = req.method;
    const url = req.originalUrl || req.url;

    const meta = {
      ip,
      status,
      durationMs: duration,
      userAgent: req.headers['user-agent'] || '',
      userId: (req as any).userId || (req as any).adminId || (req as any).teacherId || null,
      branchId: (req as any).branchId || null,
    };

    if (status >= 500) {
      logger.error('HTTP', `${method} ${url} ${status} - ${duration}ms`, undefined, {
        ...meta,
        body: scrubSensitiveData(req.body),
        query: scrubSensitiveData(req.query),
      });
    } else if (status >= 400) {
      logger.warn('HTTP', `${method} ${url} ${status} - ${duration}ms`, meta);
    } else {
      logger.info('HTTP', `${method} ${url} ${status} - ${duration}ms`, meta);
    }
  });

  next();
}

/**
 * Global Express error handling middleware to catch unhandled errors in route handlers.
 */
export function globalErrorMiddleware(err: any, req: Request, res: Response, next: NextFunction) {
  const errorId = 'err_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const status = Number(err.status || err.statusCode) || 500;
  const message = err.message || 'Internal Server Error';

  logger.error(
    'EXPRESS_UNHANDLED',
    `Unhandled error [${errorId}] on ${req.method} ${req.originalUrl}: ${message}`,
    err,
    {
      errorId,
      status,
      ip: req.ip || req.headers['x-forwarded-for'],
      body: scrubSensitiveData(req.body),
      query: scrubSensitiveData(req.query),
      headers: scrubSensitiveData(req.headers),
    }
  );

  if (res.headersSent) {
    return next(err);
  }

  return res.status(status).json({
    success: false,
    message: process.env.NODE_ENV === 'production' && status === 500
      ? 'An internal error occurred. Our engineering team has been notified.'
      : message,
    errorId,
  });
}

/**
 * Registers process uncaughtException and unhandledRejection handlers
 * to ensure that fatal issues are persisted to disk.
 */
export function registerProcessErrorHandlers() {
  process.on('uncaughtException', (err: Error) => {
    logger.error('FATAL_UNCAUGHT_EXCEPTION', `Process uncaught exception: ${err.message}`, err);
    console.error('[FATAL] Uncaught Exception:', err);
  });

  process.on('unhandledRejection', (reason: any) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error('UNHANDLED_PROMISE_REJECTION', `Unhandled promise rejection: ${msg}`, reason);
    console.error('[WARN] Unhandled Rejection:', reason);
  });
}

/**
 * Utility to read the last N lines of a log file safely for remote debugging via API.
 */
export async function readLogLines(
  type: 'error' | 'combined' | 'client',
  maxLines = 100,
  searchFilter = ''
): Promise<{ totalLines: number; lines: any[]; logFile: string }> {
  const targetFile = LOG_FILES[type] || LOG_FILES.error;

  if (!fs.existsSync(targetFile)) {
    return { totalLines: 0, lines: [], logFile: path.basename(targetFile) };
  }

  try {
    const raw = await fs.promises.readFile(targetFile, 'utf8');
    const allLines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    let filtered = allLines;
    if (searchFilter && searchFilter.trim()) {
      const q = searchFilter.toLowerCase();
      filtered = filtered.filter((line) => line.toLowerCase().includes(q));
    }

    const sliced = filtered.slice(-Math.min(maxLines, 500)).reverse();

    const parsedEntries = sliced.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });

    return {
      totalLines: filtered.length,
      lines: parsedEntries,
      logFile: path.basename(targetFile),
    };
  } catch (error: any) {
    logger.error('LOGGER_READ', `Failed to read log file ${targetFile}: ${error.message}`, error);
    return { totalLines: 0, lines: [], logFile: path.basename(targetFile) };
  }
}

/**
 * Utility to clear or rotate a log file.
 */
export async function clearLogFile(type: 'error' | 'combined' | 'client'): Promise<boolean> {
  const targetFile = LOG_FILES[type];
  if (!targetFile || !fs.existsSync(targetFile)) return false;

  try {
    await fs.promises.writeFile(targetFile, '', 'utf8');
    logger.info('LOG_MAINTENANCE', `Log file ${path.basename(targetFile)} cleared by administrator.`);
    return true;
  } catch (error: any) {
    logger.error('LOGGER_CLEAR', `Failed to clear log file ${targetFile}: ${error.message}`, error);
    return false;
  }
}

export default logger;
