import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { authRouter } from './routes/auth';
import { meetingsRouter } from './routes/meetings';
import { eventsRouter } from './routes/events';
import { promptsRouter } from './routes/prompts';
import { reportsRouter } from './routes/reports';
import { historyRouter } from './routes/history';
import { registryRouter } from './routes/registry';
import { userRouter } from './routes/user';
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { authMiddleware } from './middleware/auth';
import { pool } from './db/pool';
import { redis } from './db/redis';
import { exportMetrics, incrementCounter } from './services/metrics';
import { startRetentionService } from './services/retention-service';

const app = express();
const PORT = process.env.PORT || 3001;

// Global middleware
app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || (origin && origin.startsWith('chrome-extension://')) || (origin && origin.startsWith('http://localhost'))) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'));
    }
  },
}));
app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);

// Request counter middleware
app.use((req, _res, next) => {
  incrementCounter('gleameet_http_requests_total', { method: req.method, path: req.path.split('/')[1] || 'root' });
  next();
});

// Public routes
app.use('/auth', authRouter);

// Protected routes
app.use('/meetings', authMiddleware, meetingsRouter);
app.use('/events', authMiddleware, eventsRouter);
app.use('/prompts', authMiddleware, promptsRouter);
app.use('/reports', authMiddleware, reportsRouter);
app.use('/history', authMiddleware, historyRouter);
app.use('/registry', authMiddleware, registryRouter);
app.use('/user', authMiddleware, userRouter);

// Health check with dependency status
app.get('/health', async (_req, res) => {
  const checks: Record<string, string> = { status: 'ok' };

  // Check Postgres
  try {
    await pool.query('SELECT 1');
    checks.postgres = 'connected';
  } catch {
    checks.postgres = 'disconnected';
    checks.status = 'degraded';
  }

  // Check Redis
  try {
    await redis.ping();
    checks.redis = 'connected';
  } catch {
    checks.redis = 'disconnected';
    checks.status = 'degraded';
  }

  checks.timestamp = new Date().toISOString();
  checks.uptime_seconds = String(Math.round(process.uptime()));

  const statusCode = checks.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(checks);
});

// Prometheus-style metrics endpoint
app.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(exportMetrics());
});

// Error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`[SERVER] GleaMeet backend running on port ${PORT}`);
  console.log(`[SERVER] Health: http://localhost:${PORT}/health`);
  console.log(`[SERVER] Metrics: http://localhost:${PORT}/metrics`);

  // Start retention service (cleanup every 6 hours)
  if (process.env.NODE_ENV !== 'test') {
    startRetentionService();
  }
});

export default app;
