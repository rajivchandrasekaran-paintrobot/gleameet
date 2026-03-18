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

const app = express();
const PORT = process.env.PORT || 3001;

// Global middleware
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || 'chrome-extension://*' }));
app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);

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

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`GleaMeet backend running on port ${PORT}`);
});

export default app;
