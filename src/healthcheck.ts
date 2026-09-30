/**
 * Container health-check probe. Exits 0 when GET /healthz answers 200,
 * non-zero otherwise. Port comes from API_PORT (same variable the server
 * binds), defaulting to 3000.
 */
const port = Number.parseInt(process.env.API_PORT ?? '3000', 10);
const url = `http://127.0.0.1:${Number.isInteger(port) ? port : 3000}/healthz`;

try {
  const res = await fetch(url, {signal: AbortSignal.timeout(2000)});
  if (res.status !== 200) {
    console.error(`health check failed: HTTP ${res.status}`);
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  console.error(`health check error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
