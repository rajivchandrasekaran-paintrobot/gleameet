import { Request, Response, NextFunction } from 'express';
import { incrementCounter, observeHistogram } from '../services/metrics';

/** Structured request logging with timing and metrics (OBS-001) */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const { method, url } = req;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const { statusCode } = res;

    // Structured log
    const log = {
      ts: new Date().toISOString(),
      method,
      url,
      status: statusCode,
      duration_ms: duration,
    };
    console.log(JSON.stringify(log));

    // Metrics
    const routeBase = url.split('?')[0].split('/')[1] || 'root';
    observeHistogram('gleameet_http_request_duration_ms', duration, { method, route: routeBase });
    incrementCounter('gleameet_http_responses_total', { method, route: routeBase, status: String(statusCode) });
  });

  next();
}
