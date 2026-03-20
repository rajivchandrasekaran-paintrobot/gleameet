import { Pool } from 'pg';

/** Postgres connection pool — supports DATABASE_URL (Render) or individual vars (local) */
export const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      }
    : {
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT || '5432', 10),
        database: process.env.PG_DATABASE || 'gleameet',
        user: process.env.PG_USER || 'gleameet',
        password: process.env.PG_PASSWORD || 'gleameet_dev',
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      },
);

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});
