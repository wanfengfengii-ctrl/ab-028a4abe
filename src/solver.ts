import type {
  AdjacencyEvidence,
  AssignedPacket,
  ConstraintEvidence,
  MissingSpan,
  PacketInput,
  SolveRequest,
  SolveResult,
} from './types.js';
import {BusinessError} from './types.js';

/**
 * Joint recovery of absolute counters and integer send times.
 *
 * Model
 * -----
 * For every observed packet i we choose:
 *   - an absolute counter c_i in [countMin, countMax] with
 *     c_i ≡ remainder_i (mod modulus);
 *   - an integer send time t_i in [timeLower_i, timeUpper_i].
 *
 * In recovered order the (c, t) pairs are strictly increasing in c (distinct
 * absolute counters; a larger counter was transmitted later). For two
 * adjacent packets with counter gap d = c_b - c_a:
 *
 *     d * minInterval <= t_b - t_a <= d * maxInterval
 *
 * Objective, lexicographic:
 *   1. minimum number of missing counters between first and last observed
 *      packet (= c_last - c_first + 1 - packetCount);
 *   2. minimum sum of |t_i - midpoint(window_i)|;
 *   3. lexicographically smallest recovered packet-id sequence.
 *
 * Algorithm
 * ---------
 * Depth-first enumeration of the (permutation, absolute counters) part.
 * Along each partial chain a dynamic-programming layer is maintained over
 * the candidate send times of the last packet:
 *
 *     dp_k(t) = minimum doubled midpoint deviation of the placed prefix
 *               whose last packet is sent exactly at t
 *
 * The transition is a sliding-window minimum (the previous send time must
 * lie in [t - d*maxInterval, t - d*minInterval]), so extending a chain costs
 * O(window width) and yields the *exact* optimal times for that chain - no
 * time branching is needed. Prefix DP minima give sound lower bounds for
 * pruning, and states (used packets, last packet, last counter) that are
 * pointwise dominated are memoised away.
 */

interface Node {
  idx: number;
  id: string;
  remainder: number;
  /** Feasible absolute counters, ascending. */
  options: number[];
  lo: number;
  hi: number;
}

/** DP layer for one placed prefix (last packet fixed, its counter fixed). */
interface Layer {
  j: number;
  c: number;
  /** Candidate-time grid is the packet window [lo, hi] inclusive. */
  lo: number;
  hi: number;
  /**
   * Doubled deviation cost of the best prefix ending at each grid time.
   * Finite values stay well below INF (max ~ 14 * windowWidth).
   */
  dp: Int32Array;
  /** Back-pointer into the previous layer's grid (null for the first layer). */
  prev: Int32Array | null;
}

interface DeadEnd {
  depth: number;
  prefix: string[];
  fromId: string | undefined;
  toId: string | undefined;
  reason: string;
  detail: string;
}

interface MemoEntry {
  missing: number;
  /** Pointwise prefix DP costs over the last packet's window grid. */
  dp: Int32Array;
  /** NUL-joined id prefix; lexical order matches id-array lex order. */
  prefixKey: string;
}

/** Hard safety bounds on the exhaustive search. */
const SEARCH_STATE_LIMIT
  = Number.parseInt(process.env.REORDER_STATE_LIMIT ?? '', 10) || 20_000_000;
const MEMO_LIMIT = 120_000;
/** Infinity marker for the deviation DP (real costs stay far below). */
const INF = 1_000_000_000;
/** Cap total memoised DP width so memory stays bounded (~tens of MB). */
const MEMO_CELL_LIMIT = 4_000_000;
const PREFIX_SEP = String.fromCharCode(0);

export function solve(req: SolveRequest): SolveResult {
  const {
    modulus, countMin, countMax, minInterval, maxInterval, packets,
  } = req;
  const n = packets.length;

  // Node iteration order is id-ascending: for equal objectives the first
  // optimal chain found carries the lexicographic tie-break.
  const sortedPackets: PacketInput[] = [...packets].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const nodes: Node[] = sortedPackets.map((p, idx) => {
    const first
      = countMin + mod(p.remainder - mod(countMin, modulus), modulus);
    const options: number[] = [];
    for (let c = first; c <= countMax; c += modulus) {
      options.push(c);
    }
    return {idx, id: p.id, remainder: p.remainder, options, lo: p.timeLower, hi: p.timeUpper};
  });

  for (const node of nodes) {
    if (node.options.length === 0) {
      throw noInterpretation({
        position: 0,
        reason: 'packet_has_no_congruent_count_in_window',
        detail:
          `packet "${node.id}" (remainder ${node.remainder}) has no absolute `
          + `counter in [${countMin}, ${countMax}] congruent modulo ${modulus}`,
        toId: node.id,
      });
    }
  }

  // Incumbent.
  let bestMissing = Infinity;
  let bestDev2 = Infinity;
  let bestOrder: string[] | null = null;
  let bestLayers: Layer[] | null = null;
  let bestCounts: number[] | null = null;
  let bestNodeIdxs: number[] | null = null;

  // Current partial chain.
  const layers: Layer[] = [];
  const pathNodeIdxs: number[] = [];
  let usedMask = 0;
  let curMissing = 0;

  const bestDeadEnd: {value: DeadEnd | null} = {value: null};
  const memo = new Map<string, MemoEntry>();
  let memoCells = 0;
  let states = 0;

  function prefixIds(): string[] {
    return pathNodeIdxs.map((j) => nodes[j]!.id);
  }

  function prefixKeyWith(id: string): string {
    let key = '';
    for (const j of pathNodeIdxs) key += PREFIX_SEP + nodes[j]!.id;
    return key + PREFIX_SEP + id;
  }

  function recordDeadEnd(
    fromId: string | undefined,
    reason: string,
    detail: string,
    toId?: string,
  ): void {
    const candidate: DeadEnd = {
      depth: layers.length,
      prefix: prefixIds(),
      fromId,
      toId,
      reason,
      detail,
    };
    const cur = bestDeadEnd.value;
    if (
      cur === null
      || candidate.depth > cur.depth
      || (candidate.depth === cur.depth && lexLess(candidate.prefix, cur.prefix))
    ) {
      bestDeadEnd.value = candidate;
    }
  }

  /** First layer: the packet alone may be sent at any time in its window. */
  function firstLayer(j: number, c: number): Layer {
    const node = nodes[j]!;
    const twiceMid = node.lo + node.hi;
    const width = node.hi - node.lo + 1;
    const dp = new Int32Array(width);
    for (let t = node.lo, i = 0; t <= node.hi; t++, i++) {
      const v = 2 * t - twiceMid;
      dp[i] = v < 0 ? -v : v;
    }
    return {j, c, lo: node.lo, hi: node.hi, dp, prev: null};
  }

  /**
   * Extend `prevLayer` with packet j at counter c. Returns null when no
   * prefix send time can satisfy the accumulated timing constraints.
   *
   * For candidate time t, previous time s must satisfy
   * t - gap*maxInterval <= s <= t - gap*minInterval, so the transition is a
   * sliding-window minimum over the previous grid (monotone deque).
   */
  function extendLayer(prevLayer: Layer, j: number, c: number): Layer | null {
    const node = nodes[j]!;
    const gap = c - prevLayer.c;
    const lowDt = gap * minInterval;
    const highDt = gap * maxInterval;

    const width = node.hi - node.lo + 1;
    const dp = new Int32Array(width).fill(INF);
    const prevIdx = new Int32Array(width).fill(-1);
    const twiceMid = node.lo + node.hi;

    // Deque over previous-grid indices, increasing s, dp values ascending.
    const deque: number[] = [];
    let head = 0;
    let nextAdd = 0; // next prev-grid index eligible to add
    const prevLo = prevLayer.lo;
    const prevHi = prevLayer.hi;
    const prevDp = prevLayer.dp;
    const prevWidth = prevHi - prevLo + 1;

    let finite = false;

    for (let i = 0; i < width; i++) {
      const t = node.lo + i;
      const sUpper = t - lowDt;
      const sLower = t - highDt;

      while (nextAdd < prevWidth) {
        const sAdd = prevLo + nextAdd;
        if (sAdd > sUpper) break;
        while (deque.length > head) {
          const back = deque[deque.length - 1]!;
          if (prevDp[back]! <= prevDp[nextAdd]!) break;
          deque.pop();
        }
        deque.push(nextAdd);
        nextAdd++;
      }
      while (deque.length > head) {
        const front = deque[head]!;
        if (prevLo + front >= sLower) break;
        head++;
      }

      if (deque.length > head) {
        const idx = deque[head]!;
        if (prevDp[idx]! !== INF) {
          const v = 2 * t - twiceMid;
          const own = v < 0 ? -v : v;
          dp[i] = own + prevDp[idx]!;
          prevIdx[i] = idx;
          finite = true;
        }
      }
    }

    if (!finite) return null;
    return {j, c, lo: node.lo, hi: node.hi, dp, prev: prevIdx};
  }

  function layerMin(layer: Layer): {cost: number; index: number} {
    let cost = INF;
    let index = -1;
    for (let i = 0; i < layer.dp.length; i++) {
      const v = layer.dp[i]!;
      // Strict improvement keeps the earliest send time on ties, matching the
      // sliding-window predecessor choice and yielding the lexicographically
      // smallest optimal time vector.
      if (v < cost) {
        cost = v;
        index = i;
      }
    }
    return {cost, index};
  }

  /**
   * Why can the smallest candidate of the lexicographically smallest unused
   * packet not follow the current last packet? Direct pair analysis used for
   * human-readable evidence.
   */
  function adjacencyFailure(prevLayer: Layer) {
    const prevCount = prevLayer.c;
    const j = prevLayer.j;
    const prevNode = nodes[j]!;
    // Earliest time the prefix can still end at (DP feasibility is global).
    let prevEarliest = INF;
    for (let i = 0; i < prevLayer.dp.length; i++) {
      if (prevLayer.dp[i]! !== INF) {
        prevEarliest = prevLayer.lo + i;
        break;
      }
    }
    let prevLatest = -INF;
    for (let i = prevLayer.dp.length - 1; i >= 0; i--) {
      if (prevLayer.dp[i]! !== INF) {
        prevLatest = prevLayer.lo + i;
        break;
      }
    }

    for (let k = 0; k < n; k++) {
      if ((usedMask >> k) & 1) continue;
      const node = nodes[k]!;
      const feasible = node.options.filter((x) => x > prevCount);
      if (feasible.length === 0) {
        return {
          reason: 'no_absolute_counter_above_predecessor',
          toId: node.id,
          detail:
            `packet "${node.id}" (remainder ${node.remainder}) has no congruent `
            + `counter > ${prevCount} within [${countMin}, ${countMax}]`,
        };
      }
      const c = feasible[0]!;
      const gap = c - prevCount;
      const lowDt = gap * minInterval;
      const highDt = gap * maxInterval;
      const tLo = Math.max(node.lo, prevEarliest + lowDt);
      const tHi = Math.min(node.hi, prevLatest + highDt);
      if (tLo <= tHi) {
        return {
          reason: 'accumulated_timing_constraints',
          toId: node.id,
          detail:
            `packet "${node.id}" is pairwise reachable from "${prevNode.id}" at `
            + `counter ${c} (gap ${gap}, time-delta window [${lowDt}, ${highDt}]), `
            + `but no send time survives the timing constraints accumulated from `
            + `the prefix ${JSON.stringify(prefixIds())} - an earlier packet's `
            + `window already forces an incompatible last send time`,
        };
      }
      let why: string;
      if (node.hi < prevEarliest + lowDt) {
        why = `its latest possible time ${node.hi} precedes the earliest required `
          + `${prevEarliest + lowDt}`;
      } else if (node.lo > prevLatest + highDt) {
        why = `its earliest possible time ${node.lo} exceeds the latest allowed `
          + `${prevLatest + highDt}`;
      } else {
        why = `its window [${node.lo}, ${node.hi}] and the required range `
          + `[${prevEarliest + lowDt}, ${prevLatest + highDt}] do not intersect`;
      }
      return {
        reason: 'adjacency_interval_window',
        toId: node.id,
        detail:
          `cannot extend to packet "${node.id}" at its smallest candidate count `
          + `${c} (counter gap ${gap}): time delta must be in [${lowDt}, ${highDt}]; `
          + `prefix last send time is constrained to [${prevEarliest}, ${prevLatest}]; ${why}`,
      };
    }
    return {reason: 'no_unused_packet', detail: 'all packets are already placed'};
  }

  function dfs(): void {
    if (++states > SEARCH_STATE_LIMIT) {
      throw new BusinessError(
        'NO_CONSISTENT_INTERPRETATION',
        'search state budget exhausted while seeking a consistent interpretation',
        {
          position: layers.length,
          reason: 'search_limit_exceeded',
          detail: `evaluated more than ${SEARCH_STATE_LIMIT} partial chains`,
          attemptedPrefix: prefixIds(),
        },
      );
    }

    const depth = layers.length;
    const current = depth > 0 ? layers[depth - 1]! : null;

    if (depth === n) {
      const {cost: minDev2, index} = layerMin(current!);
      const order = prefixIds();
      const better
        = curMissing < bestMissing
        || (curMissing === bestMissing && minDev2 < bestDev2)
        || (curMissing === bestMissing
          && minDev2 === bestDev2
          && (bestOrder === null || lexLess(order, bestOrder)));
      if (better) {
        bestMissing = curMissing;
        bestDev2 = minDev2;
        bestOrder = order;
        bestLayers = [...layers];
        bestCounts = layers.map((l) => l.c);
        bestNodeIdxs = [...pathNodeIdxs];
        void index;
      }
      return;
    }

    // Lower-bound prune: prefix DP minimum is a lower bound on total deviation.
    if (current !== null) {
      const {cost: prefixMin} = layerMin(current);
      if (curMissing > bestMissing) return;
      if (curMissing === bestMissing && prefixMin > bestDev2) return;
    }

    const remaining = n - depth;

    if (current !== null) {
      // Cheap necessary look-aheads before doing any extension work.
      let blocker: {reason: string; detail: string; toId?: string} | undefined;
      if (current.c + remaining > countMax) {
        blocker = {
          reason: 'insufficient_counter_room',
          detail:
            `need ${remaining} more distinct counters above ${current.c} but the `
            + `search window ends at ${countMax}`,
        };
      } else {
        // Feasible send-time range of the prefix anchor.
        let anchorEarliest = INF;
        let anchorLatest = -INF;
        for (let i = 0; i < current.dp.length; i++) {
          if (current.dp[i]! !== INF) {
            anchorEarliest = current.lo + i;
            break;
          }
        }
        for (let i = current.dp.length - 1; i >= 0; i--) {
          if (current.dp[i]! !== INF) {
            anchorLatest = current.lo + i;
            break;
          }
        }

        for (let k = 0; k < n; k++) {
          if ((usedMask >> k) & 1) continue;
          const node = nodes[k]!;
          const optsAbove = node.options.filter((x) => x > current.c);
          if (optsAbove.length === 0) {
            blocker = {
              reason: 'no_absolute_counter_above_predecessor',
              toId: node.id,
              detail:
                `packet "${node.id}" (remainder ${node.remainder}) has no `
                + `congruent counter above ${current.c} within `
                + `[${countMin}, ${countMax}]`,
            };
            break;
          }
          // Wherever this packet ends up among the remaining ones:
          //  - it needs at least one more hop than now, so its latest time
          //    cannot precede the earliest anchor time + minInterval;
          //  - with its largest admissible counter its earliest time must not
          //    lie beyond the latest anchor time + maxInterval * max gap.
          const maxGap = optsAbove[optsAbove.length - 1]! - current.c;
          if (node.hi < anchorEarliest + minInterval) {
            blocker = {
              reason: 'time_window_too_early',
              toId: node.id,
              detail:
                `packet "${node.id}" window ends at ${node.hi}, before the `
                + `earliest send time reachable after the prefix anchor span `
                + `[${anchorEarliest}, ${anchorLatest}] (at least ${minInterval})`,
            };
            break;
          }
          if (node.lo > anchorLatest + maxInterval * maxGap) {
            blocker = {
              reason: 'time_window_too_late',
              toId: node.id,
              detail:
                `packet "${node.id}" window starts at ${node.lo}, later than the `
                + `latest reachable send time ${anchorLatest + maxInterval * maxGap} `
                + `even using its largest counter gap ${maxGap}`,
            };
            break;
          }
        }
      }
      if (blocker !== undefined) {
        recordDeadEnd(nodes[current.j]!.id, blocker.reason, blocker.detail, blocker.toId);
        return;
      }
    }

    let branchCount = 0;

    for (let j = 0; j < n; j++) {
      if ((usedMask >> j) & 1) continue;
      const node = nodes[j]!;

      for (const c of node.options) {
        if (current !== null && c <= current.c) continue;

        const addedMissing = current === null ? 0 : c - current.c - 1;
        const nextMissing = curMissing + addedMissing;

        // O(1) objective-1 prune before any timing DP work: once an
        // incumbent exists, a prefix that already missed more packets can
        // never catch up.
        if (nextMissing > bestMissing) continue;
        // Leave enough counter room for the packets still to be placed.
        if (c + (n - depth - 1) > countMax) continue;

        let layer: Layer | null;
        if (current === null) {
          layer = firstLayer(j, c);
        } else {
          layer = extendLayer(current, j, c);
          if (layer === null) continue;
        }

        // Objective-2 prune on the prefix deviation lower bound.
        if (nextMissing === bestMissing) {
          const {cost: branchMin} = layerMin(layer);
          if (branchMin > bestDev2) continue;
          // The prefix already matches the incumbent on both numeric
          // objectives and future packets can only add deviation. Such a
          // branch can at best tie; prune it as soon as its id prefix is
          // lexicographically behind the incumbent order.
          if (branchMin === bestDev2 && bestOrder !== null) {
            const candidate = prefixIds().concat(node.id);
            if (prefixLexBehind(candidate, bestOrder)) continue;
          }
        }

        // Dominance memo on (used set, last packet, last counter). The DP
        // grids align because the last packet (hence its window) is fixed.
        const memoKey = `${usedMask | (1 << j)}|${j}|${c}`;
        const candidateKey = prefixKeyWith(node.id);
        const prior = memo.get(memoKey);
        if (prior !== undefined) {
          let dominated = false;
          if (nextMissing >= prior.missing) {
            // Pointwise domination with INF semantics: prior.dp <= cand.dp at
            // every grid cell also guarantees prior's feasible end-time set
            // is a superset of cand's (cand finite => prior finite). This
            // coverage is mandatory even when cand missed more packets:
            // histories reaching the same last counter can differ in their
            // achievable end-time spans, so a larger missing scalar alone is
            // not sufficient to dominate.
            let pointwise = true;
            for (let i = 0; i < layer.dp.length; i++) {
              if (prior.dp[i]! > layer.dp[i]!) {
                pointwise = false;
                break;
              }
            }
            if (pointwise) {
              if (nextMissing > prior.missing) {
                // Strictly more missing: every completion through cand maps
                // to a strictly better-objective-1 completion through prior.
                dominated = true;
              } else {
                // Equal missing and deviation-wise no worse: the tertiary
                // id-order tie-break decides. NUL separators precede every
                // allowed id character, so string comparison matches the
                // id-array lexicographic order of equal-length prefixes.
                dominated = candidateKey >= prior.prefixKey;
              }
            }
          }
          if (dominated) continue;
        }
        if (memo.size < MEMO_LIMIT && memoCells + layer.dp.length <= MEMO_CELL_LIMIT) {
          memo.set(memoKey, {
            missing: nextMissing,
            dp: layer.dp.slice(),
            prefixKey: candidateKey,
          });
          memoCells += layer.dp.length;
        }

        branchCount++;

        curMissing = nextMissing;
        usedMask |= 1 << j;
        pathNodeIdxs.push(j);
        layers.push(layer);

        dfs();

        layers.pop();
        pathNodeIdxs.pop();
        usedMask &= ~(1 << j);
        curMissing -= addedMissing;
      }
    }

    if (branchCount === 0 && current !== null) {
      const failure = adjacencyFailure(current);
      recordDeadEnd(nodes[current.j]!.id, failure.reason, failure.detail, failure.toId);
    }
  }

  dfs();

  if (
    bestLayers === null
    || bestCounts === null
    || bestNodeIdxs === null
    || bestOrder === null
  ) {
    throw buildNoInterpretationError(bestDeadEnd.value);
  }

  // Recover optimal send times by backtracking the DP predecessor chain.
  const times: number[] = new Array<number>(n);
  const chosenLayers: Layer[] = bestLayers;
  {
    const last = chosenLayers[n - 1]!;
    let idx = layerMin(last).index;
    for (let k = n - 1; k >= 0; k--) {
      const layer = chosenLayers[k]!;
      times[k] = layer.lo + idx;
      if (k > 0) idx = layer.prev![idx]!;
    }
  }

  return buildResult(
    req,
    nodes,
    bestNodeIdxs,
    bestCounts,
    times,
    bestDev2 / 2,
  );
}

function buildResult(
  req: SolveRequest,
  nodes: Node[],
  chosenNodeIdxs: number[],
  chosenCounts: number[],
  chosenTimes: number[],
  totalMidpointDeviation: number,
): SolveResult {
  const order: string[] = [];
  const assignments: AssignedPacket[] = [];
  const missingSpans: MissingSpan[] = [];
  const adjacencyEvidence: AdjacencyEvidence[] = [];
  let totalMissing = 0;

  for (let k = 0; k < chosenNodeIdxs.length; k++) {
    const node = nodes[chosenNodeIdxs[k]!]!;
    const count = chosenCounts[k]!;
    const time = chosenTimes[k]!;
    order.push(node.id);
    assignments.push({position: k, id: node.id, count, time});

    if (k > 0) {
      const prevNode = nodes[chosenNodeIdxs[k - 1]!]!;
      const prevCount = chosenCounts[k - 1]!;
      const prevTime = chosenTimes[k - 1]!;
      const gap = count - prevCount;
      const dt = time - prevTime;
      totalMissing += gap - 1;
      if (gap > 1) {
        missingSpans.push({
          fromCount: prevCount + 1,
          toCount: count - 1,
          missing: gap - 1,
          afterId: prevNode.id,
          beforeId: node.id,
        });
      }
      adjacencyEvidence.push({
        fromId: prevNode.id,
        toId: node.id,
        fromCount: prevCount,
        toCount: count,
        countDifference: gap,
        fromTime: prevTime,
        toTime: time,
        timeDifference: dt,
        minTimeDifference: gap * req.minInterval,
        maxTimeDifference: gap * req.maxInterval,
        effectiveInterval: formatInterval(dt, gap),
      });
    }
  }

  return {
    order,
    assignments,
    totalMissing,
    missingSpans,
    adjacencyEvidence,
    totalMidpointDeviation,
  };
}

/** The retained dead end already is the furthest (ties: smallest prefix). */
function buildNoInterpretationError(chosen: DeadEnd | null): BusinessError {
  if (chosen === null) {
    return noInterpretation({
      position: 0,
      reason: 'no_extension',
      detail: 'no packet could be placed as the first element of a chain',
    });
  }
  const evidence: ConstraintEvidence = {
    position: chosen.depth,
    fromId: chosen.fromId,
    toId: chosen.toId,
    reason: chosen.reason,
    detail: chosen.detail,
    attemptedPrefix: chosen.prefix,
  };
  return new BusinessError(
    'NO_CONSISTENT_INTERPRETATION',
    'no globally consistent assignment of absolute counters and send times exists in the search window',
    evidence,
  );
}

function noInterpretation(evidence: ConstraintEvidence): BusinessError {
  return new BusinessError(
    'NO_CONSISTENT_INTERPRETATION',
    'no globally consistent assignment of absolute counters and send times exists in the search window',
    evidence,
  );
}

function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

function lexLess(a: string[], b: string[]): boolean {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return a.length < b.length;
}

/** True if `prefix` is already lexicographically behind `full`. */
function prefixLexBehind(prefix: string[], full: string[]): boolean {
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i]! > full[i]!) return true;
    if (prefix[i]! < full[i]!) return false;
  }
  return false;
}

/** Render the realised per-step interval as an exact fraction. */
function formatInterval(dt: number, gap: number): string {
  const base = `${dt}/${gap}`;
  if (dt % gap === 0) return `${base} (=${dt / gap})`;
  const decimal = (dt / gap).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `${base} (=${decimal})`;
}
