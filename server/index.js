import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const dbPath = process.env.DB_PATH ?? 'data/library.sqlite';
const origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`;
const { app, close } = createApp({ dbPath, origin });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Library booking server listening at ${origin}`);
});

const shutdown = () => server.close(() => close());
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
