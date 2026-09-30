#!/usr/bin/env node
/**
 * One-shot verification used by the `verify` Docker Compose service.
 *
 *  1. waits for the API health endpoint to report healthy;
 *  2. re-runs the TypeScript build (must succeed with zero diagnostics);
 *  3. runs the code's unit-test suite (node --test), including the
 *     cross-week packet-loss cases and brute-force equivalence checks;
 *  4. runs an HTTP smoke test with the cross-week packet-loss sample;
 *  5. checks the negative paths (422 stable business error code with the
 *     first blocking constraint evidence; 400 for invalid requests).
 *
 * Exits non-zero on the first failed check so the container terminates with a
 * meaningful status code on its own.
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileP = promisify(execFile);

const API_URL = (process.env.API_URL ?? 'http://api:3000').replace(/\/$/, '');
const DEADLINE_MS
  = Number.parseInt(process.env.VERIFY_WAIT_MS ?? '60000', 10) || 60_000;

function fail(message, extra) {
  console.error(`✗ ${message}`);
  if (extra !== undefined) console.error(extra);
  process.exit(1);
}

async function runStep(label, command, args) {
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    const {stdout, stderr} = await execFileP(command, args, {cwd: process.cwd()});
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    console.log(`✓ ${label}`);
  } catch (err) {
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    fail(`${label} failed (exit ${err.code})`);
  }
}

async function waitForHealth() {
  const start = Date.now();
  let lastError = 'not started';
  while (Date.now() - start < DEADLINE_MS) {
    try {
      const res = await fetch(`${API_URL}/healthz`);
      if (res.ok) {
        console.log(`✓ API healthy at ${API_URL} (after ${Date.now() - start} ms)`);
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`API did not become healthy within ${DEADLINE_MS} ms`, lastError);
}

async function postRecover(body) {
  const res = await fetch(`${API_URL}/api/v1/recover`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return {status: res.status, payload};
}

/** The headline cross-week sample: modulus 8 wraps twice; 6 packets lost. */
const crossWeekSample = {
  modulus: 8,
  countMin: 0,
  countMax: 24,
  minInterval: 9,
  maxInterval: 11,
  packets: [
    {id: 'D', remainder: 7, timeLower: 148, timeUpper: 152},
    {id: 'A', remainder: 6, timeLower: 58, timeUpper: 62},
    {id: 'F', remainder: 1, timeLower: 168, timeUpper: 172},
    {id: 'B', remainder: 7, timeLower: 68, timeUpper: 72},
    {id: 'C', remainder: 2, timeLower: 98, timeUpper: 103},
    {id: 'E', remainder: 0, timeLower: 157, timeUpper: 161},
  ],
};

function assert(condition, message, extra) {
  if (!condition) fail(message, extra);
}

async function smokeCrossWeek() {
  const {status, payload} = await postRecover(crossWeekSample);
  if (status !== 200) fail('cross-week smoke expected HTTP 200', JSON.stringify(payload));

  assert(
    JSON.stringify(payload.order) === JSON.stringify(['A', 'B', 'C', 'D', 'E', 'F']),
    'recovered order mismatch',
    JSON.stringify(payload.order),
  );
  assert(
    JSON.stringify(payload.assignments.map((a) => a.count))
      === JSON.stringify([6, 7, 10, 15, 16, 17]),
    'absolute counters mismatch (wraparound recovery failed)',
    JSON.stringify(payload.assignments.map((a) => a.count)),
  );
  assert(payload.totalMissing === 6, 'totalMissing must be 6', payload.totalMissing);
  assert(
    JSON.stringify(payload.missingSpans)
      === JSON.stringify([
        {fromCount: 8, toCount: 9, missing: 2, afterId: 'B', beforeId: 'C'},
        {fromCount: 11, toCount: 14, missing: 4, afterId: 'C', beforeId: 'D'},
      ]),
    'missing spans mismatch',
    JSON.stringify(payload.missingSpans),
  );

  const byId = new Map(crossWeekSample.packets.map((p) => [p.id, p]));
  for (const a of payload.assignments) {
    const p = byId.get(a.id);
    assert(a.time >= p.timeLower && a.time <= p.timeUpper, `time of ${a.id} outside window`);
    assert(a.count % 8 === p.remainder, `counter of ${a.id} not congruent to remainder`);
  }

  assert(payload.adjacencyEvidence.length === 5, 'expected 5 adjacency evidence entries');
  for (const e of payload.adjacencyEvidence) {
    assert(
      e.timeDifference >= e.minTimeDifference
        && e.timeDifference <= e.maxTimeDifference
        && e.countDifference >= 1
        && e.timeDifference === e.toTime - e.fromTime
        && e.countDifference === e.toCount - e.fromCount,
      `adjacency evidence ${e.fromId}->${e.toId} violates its own constraint`,
      JSON.stringify(e),
    );
  }
  console.log('✓ cross-week HTTP smoke (order, counters, times, missing spans, evidence)');
  console.log(`  order: ${payload.order.join(' -> ')}`);
  console.log(`  adjacency: ${payload.adjacencyEvidence
    .map((e) => `${e.fromId}->${e.toId} Δc=${e.countDifference} Δt=${e.timeDifference}∈[${e.minTimeDifference},${e.maxTimeDifference}]`)
    .join(' | ')}`);
}

async function smokeInfeasible() {
  // Fixed interval 10 with unique remainders 0..5 in [0,9] forces one counter
  // ordering; the time windows force the reverse time ordering. No global
  // interpretation exists.
  const infeasible = {
    modulus: 10,
    countMin: 0,
    countMax: 9,
    minInterval: 10,
    maxInterval: 10,
    packets: [5, 4, 3, 2, 1, 0].map((r) => ({
      id: `r${r}`,
      remainder: r,
      timeLower: (5 - r) * 10,
      timeUpper: (5 - r) * 10,
    })),
  };
  const {status, payload} = await postRecover(infeasible);
  assert(status === 422, `infeasible smoke expected HTTP 422, got ${status}`, JSON.stringify(payload));
  assert(payload?.error?.code === 'NO_CONSISTENT_INTERPRETATION', 'stable error code mismatch',
    JSON.stringify(payload));
  assert(
    typeof payload.error.evidence?.reason === 'string'
      && typeof payload.error.evidence?.detail === 'string'
      && payload.error.evidence.detail.length > 0,
    'first blocking constraint evidence missing',
    JSON.stringify(payload.error.evidence),
  );
  console.log(`✓ infeasible HTTP smoke (422 ${payload.error.code}: ${payload.error.evidence.reason})`);
}

async function smokeInvalid() {
  const {status, payload} = await postRecover({...crossWeekSample, modulus: 1});
  assert(status === 400, `invalid request expected HTTP 400, got ${status}`, JSON.stringify(payload));
  assert(payload?.error?.code === 'INVALID_REQUEST', 'INVALID_REQUEST code mismatch');
  console.log('✓ invalid-request HTTP smoke (400 INVALID_REQUEST)');
}

await waitForHealth();
await runStep('TypeScript build (tsc)', 'npm', ['run', 'build']);
await runStep('Unit tests (node --test)', 'npm', ['test']);
await smokeCrossWeek();
await smokeInfeasible();
await smokeInvalid();
console.log('\nALL VERIFICATION CHECKS PASSED');
