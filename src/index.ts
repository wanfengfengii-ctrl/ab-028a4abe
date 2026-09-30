import {createApp} from './server.js';

const port = Number.parseInt(process.env.API_PORT ?? '3000', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`API_PORT must be an integer in 1..65535, got "${process.env.API_PORT}"`);
  process.exit(1);
}

const server = createApp();

server.listen(port, () => {
  console.log(`buoy-telemetry-reorder listening on 0.0.0.0:${port}`);
});

const shutdown = (signal: string): void => {
  console.log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
