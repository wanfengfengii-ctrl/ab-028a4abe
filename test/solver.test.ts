import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {solve} from '../src/solver.js';
import {BusinessError} from '../src/types.js';
import {validateRequest} from '../src/validation.js';
import type {PacketInput, SolveRequest} from '../src/types.js';

/** Headline cross-week sample with real packet loss (see README). */
function crossWeekRequest(): SolveRequest {
  // True transmissions were every ~10 time units (jitter 9..11).
  // Observed counters: 6,7,10,15,16,17 with modulus 8 - the counter
  // remainder wraps 7 -> 0.. twice, and counters 8,9 and 11..14 are lost.
  // Packets arrive shuffled (download order must not become collect order).
  const packets: PacketInput[] = [
    {id: 'D', remainder: 7, timeLower: 148, timeUpper: 152}, // count 15, t 150
    {id: 'A', remainder: 6, timeLower: 58, timeUpper: 62},  // count  6, t  60
    {id: 'F', remainder: 1, timeLower: 168, timeUpper: 172}, // count 17, t 170
    {id: 'B', remainder: 7, timeLower: 68, timeUpper: 72},   // count  7, t  70
    {id: 'C', remainder: 2, timeLower: 98, timeUpper: 103},  // count 10, t 101
    {id: 'E', remainder: 0, timeLower: 157, timeUpper: 161}, // count 16, t 159
  ];
  return {
    modulus: 8,
    countMin: 0,
    countMax: 24,
    minInterval: 9,
    maxInterval: 11,
    packets,
  };
}

describe('cross-week recovery with packet loss', () => {
  const result = solve(crossWeekRequest());

  it('recovers send order independent of download order', () => {
    assert.deepEqual(result.order, ['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('assigns absolute counters across the modulus wrap', () => {
    assert.deepEqual(result.assignments.map((a) => a.count), [6, 7, 10, 15, 16, 17]);
  });

  it('selects integer send times inside every window', () => {
    // t=100 and t=101 tie on midpoint deviation for packet C; the solver
    // deterministically keeps the earliest of the tied optimal time vectors.
    assert.deepEqual(result.assignments.map((a) => a.time), [60, 70, 100, 150, 159, 170]);
    const byId = new Map(crossWeekRequest().packets.map((p) => [p.id, p]));
    for (const a of result.assignments) {
      const p = byId.get(a.id)!;
      assert.ok(a.time >= p.timeLower && a.time <= p.timeUpper);
      assert.equal(a.count % 8, p.remainder);
    }
  });

  it('minimises total midpoint deviation (0.5; integer ties pick earliest vector)', () => {
    assert.equal(result.totalMidpointDeviation, 0.5);
  });

  it('reports the two missing counter spans and total', () => {
    assert.equal(result.totalMissing, 6);
    assert.deepEqual(result.missingSpans, [
      {fromCount: 8, toCount: 9, missing: 2, afterId: 'B', beforeId: 'C'},
      {fromCount: 11, toCount: 14, missing: 4, afterId: 'C', beforeId: 'D'},
    ]);
  });

  it('gives per-adjacency constraint evidence that actually holds', () => {
    assert.equal(result.adjacencyEvidence.length, 5);
    for (const e of result.adjacencyEvidence) {
      assert.ok(e.countDifference >= 1);
      assert.ok(
        e.timeDifference >= e.minTimeDifference,
        `${e.fromId}->${e.toId}: ${e.timeDifference} < ${e.minTimeDifference}`,
      );
      assert.ok(
        e.timeDifference <= e.maxTimeDifference,
        `${e.fromId}->${e.toId}: ${e.timeDifference} > ${e.maxTimeDifference}`,
      );
      assert.equal(
        e.timeDifference,
        e.toTime - e.fromTime,
      );
      assert.equal(
        e.countDifference,
        e.toCount - e.fromCount,
      );
    }
    assert.deepEqual(
      result.adjacencyEvidence.map((e) => [e.fromId, e.toId]),
      [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'F']],
    );
  });
});

describe('objective lexicographic order', () => {
  it('prefers fewest missing counters first', () => {
    // Wide time windows so timing never binds; the assignment spanning the
    // fewest counters must win even when another chain fits.
    const req: SolveRequest = {
      modulus: 4,
      countMin: 0,
      countMax: 16,
      minInterval: 0,
      maxInterval: 100,
      packets: [
        {id: 'p0', remainder: 0, timeLower: 0, timeUpper: 1000},
        {id: 'p1', remainder: 1, timeLower: 0, timeUpper: 1000},
        {id: 'p2', remainder: 2, timeLower: 0, timeUpper: 1000},
        {id: 'p3', remainder: 3, timeLower: 0, timeUpper: 1000},
        {id: 'p4', remainder: 0, timeLower: 0, timeUpper: 1000},
        {id: 'p5', remainder: 1, timeLower: 0, timeUpper: 1000},
      ],
    };
    const r = solve(req);
    assert.deepEqual(r.assignments.map((a) => a.count), [0, 1, 2, 3, 4, 5]);
    assert.equal(r.totalMissing, 0);
  });

  it('breaks exact objective ties by lexicographically smallest id order', () => {
    // minInterval == maxInterval == 0 decouples time from counters; every
    // permutation admits the same counter set and the same (midpoint) times,
    // so the id-lexicographic order must win.
    const ids = ['zeta', 'alpha', 'mu', 'beta', 'omega', 'iota'];
    const req: SolveRequest = {
      modulus: 100,
      countMin: 0,
      countMax: 1000,
      minInterval: 0,
      maxInterval: 0,
      packets: ids.map((id) => ({
        id, remainder: 0, timeLower: 10, timeUpper: 10,
      })),
    };
    const r = solve(req);
    assert.deepEqual(r.order, [...ids].sort());
    assert.deepEqual(r.assignments.map((a) => a.time), new Array(6).fill(10));
  });

  it('pulls every send time to its window midpoint when feasible', () => {
    const req: SolveRequest = {
      modulus: 5,
      countMin: 0,
      countMax: 10,
      minInterval: 1,
      maxInterval: 100,
      packets: [0, 1, 2, 3, 4, 0].map((r, i) => ({
        id: `q${i}`,
        remainder: r,
        timeLower: 100 + i * 10,
        timeUpper: 106 + i * 10,
      })),
    };
    const r = solve(req);
    // Midpoints 103,113,123,... are mutually compatible (gaps 1, dt 10).
    assert.deepEqual(r.assignments.map((a) => a.time), [103, 113, 123, 133, 143, 153]);
    assert.equal(r.totalMidpointDeviation, 0);
  });
});

describe('infeasible instances', () => {
  it('returns NO_CONSISTENT_INTERPRETATION with first blocking evidence', () => {
    // Time windows force chronological order r5,r4,...,r0 while counters
    // (one per remainder in [0,9], modulus 10, fixed interval) force the
    // reverse ordering - no global interpretation exists.
    const req: SolveRequest = {
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
    assert.throws(
      () => solve(req),
      (err: unknown) => {
        assert.ok(err instanceof BusinessError);
        const e: BusinessError = err;
        assert.equal(e.code, 'NO_CONSISTENT_INTERPRETATION');
        assert.ok(e.evidence);
        assert.ok(typeof e.evidence!.reason === 'string');
        assert.ok(e.evidence!.detail.length > 0);
        return true;
      },
    );
  });

  it('flags a packet whose remainder never lands in the counter window', () => {
    const req: SolveRequest = {
      modulus: 7,
      countMin: 8,
      countMax: 12,
      minInterval: 1,
      maxInterval: 10,
      packets: [1, 2, 3, 4, 5, 6].map((r, i) => ({
        id: `x${i}`,
        remainder: r,
        timeLower: i * 5,
        timeUpper: i * 5 + 100,
      })),
    };
    assert.throws(
      () => solve(req),
      (err: unknown) => {
        assert.ok(err instanceof BusinessError);
        const e: BusinessError = err;
        assert.equal(e.code, 'NO_CONSISTENT_INTERPRETATION');
        assert.equal(e.evidence!.reason, 'packet_has_no_congruent_count_in_window');
        return true;
      },
    );
  });
});

describe('request validation', () => {
  const base = (): SolveRequest => crossWeekRequest();

  it('rejects fewer than 6 packets', () => {
    const req = base();
    req.packets = req.packets.slice(0, 5);
    assert.throws(() => validateRequest(req), (e: unknown) =>
      e instanceof BusinessError && e.code === 'INVALID_REQUEST');
  });

  it('rejects duplicate ids', () => {
    const req = base();
    req.packets[1] = {...req.packets[0]!};
    assert.throws(() => validateRequest(req), (e: unknown) =>
      e instanceof BusinessError && e.code === 'INVALID_REQUEST');
  });

  it('rejects out-of-range remainders', () => {
    const req = base();
    req.packets[0] = {...req.packets[0]!, remainder: 8};
    assert.throws(() => validateRequest(req), (e: unknown) =>
      e instanceof BusinessError && e.code === 'INVALID_REQUEST');
  });

  it('rejects inverted time windows and inverted interval bounds', () => {
    const req = base();
    req.packets[0] = {...req.packets[0]!, timeLower: 10, timeUpper: 5};
    assert.throws(() => validateRequest(req), (e: unknown) =>
      e instanceof BusinessError && e.code === 'INVALID_REQUEST');
    const req2 = base();
    req2.minInterval = 12;
    assert.throws(() => validateRequest(req2), (e: unknown) =>
      e instanceof BusinessError && e.code === 'INVALID_REQUEST');
  });
});

// ---------- Randomised brute-force cross-check ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exhaustive reference solver over permutations x counters x times. */
function bruteForce(req: SolveRequest):
  {missing: number; dev2: number; order: string[]} | null {
  const {modulus, countMin, countMax, minInterval, maxInterval, packets} = req;
  const n = packets.length;
  const options: number[][] = packets.map((p) => {
    const first = countMin + ((p.remainder - (countMin % modulus) + modulus) % modulus);
    const out: number[] = [];
    for (let c = first; c <= countMax; c += modulus) out.push(c);
    return out;
  });

  let best: {missing: number; dev2: number; order: string[]} | null = null;
  const chosenNode: number[] = [];
  const chosenCount: number[] = [];
  const used = new Array<boolean>(n).fill(false);

  const consider = (): void => {
    // Time DP over the fixed node/count chain.
    let dp: number[] = [];
    const first = packets[chosenNode[0]!]!;
    for (let t = first.timeLower; t <= first.timeUpper; t++) {
      dp.push(Math.abs(2 * t - (first.timeLower + first.timeUpper)));
    }
    for (let k = 1; k < n; k++) {
      const p = packets[chosenNode[k]!]!;
      const prev = packets[chosenNode[k - 1]!]!;
      const gap = chosenCount[k]! - chosenCount[k - 1]!;
      const next: number[] = [];
      for (let t = p.timeLower; t <= p.timeUpper; t++) {
        let bestPrev = Infinity;
        for (let s = prev.timeLower; s <= prev.timeUpper; s++) {
          const dt = t - s;
          if (dt >= gap * minInterval && dt <= gap * maxInterval) {
            const v = dp[s - prev.timeLower]!;
            if (v < bestPrev) bestPrev = v;
          }
        }
        next.push(
          bestPrev === Infinity
            ? Infinity
            : bestPrev + Math.abs(2 * t - (p.timeLower + p.timeUpper)),
        );
      }
      dp = next;
    }
    let dev2 = Infinity;
    for (const v of dp) if (v < dev2) dev2 = v;
    if (dev2 === Infinity) return;
    const missing = chosenCount[n - 1]! - chosenCount[0]! + 1 - n;
    const order = chosenNode.map((i) => packets[i]!.id);
    if (
      best === null
      || missing < best.missing
      || (missing === best.missing && dev2 < best.dev2)
      || (missing === best.missing && dev2 === best.dev2 && lex(order, best.order))
    ) {
      best = {missing, dev2, order};
    }
  };

  const recurse = (): void => {
    if (chosenNode.length === n) {
      consider();
      return;
    }
    const prevCount = chosenCount.length === 0 ? -Infinity : chosenCount.at(-1)!;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      for (const c of options[i]!) {
        if (c <= prevCount) continue;
        used[i] = true;
        chosenNode.push(i);
        chosenCount.push(c);
        recurse();
        chosenCount.pop();
        chosenNode.pop();
        used[i] = false;
      }
    }
  };
  recurse();
  return best;
}

function lex(a: string[], b: string[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return a.length < b.length;
}

describe('randomised equivalence with exhaustive reference', () => {
  const rand = mulberry32(20260930);

  for (let trial = 0; trial < 40; trial++) {
    const n = 4 + Math.floor(rand() * 3); // 4..6 (validation's 6-floor bypassed)
    const modulus = 2 + Math.floor(rand() * 4);
    const countMin = 0;
    const countMax = 4 + Math.floor(rand() * 9);
    const minInterval = Math.floor(rand() * 3);
    const maxInterval = minInterval + Math.floor(rand() * 3);
    const packets: PacketInput[] = [];
    for (let i = 0; i < n; i++) {
      const lo = Math.floor(rand() * 20);
      const hi = lo + Math.floor(rand() * 5);
      packets.push({
        id: `id${String.fromCharCode(97 + i)}${trial}`,
        remainder: Math.floor(rand() * modulus),
        timeLower: lo,
        timeUpper: hi,
      });
    }
    const req: SolveRequest = {
      modulus, countMin, countMax, minInterval, maxInterval, packets,
    };

    it(`trial ${trial}: n=${n} mod=${modulus} counts=[0,${countMax}] interval=[${minInterval},${maxInterval}]`, () => {
      const reference = bruteForce(req);
      if (reference === null) {
        assert.throws(() => solve(req), (e: unknown) =>
          e instanceof BusinessError && e.code === 'NO_CONSISTENT_INTERPRETATION');
        return;
      }
      const got = solve(req);
      assert.equal(got.totalMissing, reference.missing, 'missing mismatch');
      assert.equal(got.totalMidpointDeviation * 2, reference.dev2, 'deviation mismatch');
      assert.deepEqual(got.order, reference.order, 'order mismatch');

      // Internal consistency of the returned witness.
      const byId = new Map(packets.map((p) => [p.id, p]));
      let counts: number[] = [];
      for (const a of got.assignments) {
        const p = byId.get(a.id)!;
        assert.ok(a.time >= p.timeLower && a.time <= p.timeUpper);
        assert.equal(a.count % modulus, ((p.remainder % modulus) + modulus) % modulus);
        counts.push(a.count);
      }
      counts = [];
      for (let k = 1; k < got.assignments.length; k++) {
        const a = got.assignments[k - 1]!;
        const b = got.assignments[k]!;
        const gap = b.count - a.count;
        const dt = b.time - a.time;
        assert.ok(gap >= 1);
        counts.push(gap);
        assert.ok(dt >= gap * minInterval && dt <= gap * maxInterval);
      }
      assert.equal(new Set(got.assignments.map((a) => a.count)).size, n);
    });
  }
});
