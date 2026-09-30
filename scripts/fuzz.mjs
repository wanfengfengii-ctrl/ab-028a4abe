// Fuzz harness: compare solver against exhaustive brute force on instances
// tuned to make different histories merge at the same memo state
// (small modulus, fixed/tight intervals, overlapping time windows).
import {solve} from '../dist/src/solver.js';
import {BusinessError} from '../dist/src/types.js';
import {validateRequest} from '../dist/src/validation.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bruteForce(req) {
  const {modulus, countMin, countMax, minInterval, maxInterval, packets} = req;
  const n = packets.length;
  const options = packets.map((p) => {
    const first = countMin + (((p.remainder - (countMin % modulus)) % modulus) + modulus) % modulus;
    const out = [];
    for (let c = first; c <= countMax; c += modulus) out.push(c);
    return out;
  });
  let best = null;
  const cn = [], cc = [], used = new Array(n).fill(false);
  const consider = () => {
    let dp = [];
    const f = packets[cn[0]];
    for (let t = f.timeLower; t <= f.timeUpper; t++) dp.push(Math.abs(2 * t - (f.timeLower + f.timeUpper)));
    for (let k = 1; k < n; k++) {
      const p = packets[cn[k]], prev = packets[cn[k - 1]];
      const gap = cc[k] - cc[k - 1];
      const next = [];
      for (let t = p.timeLower; t <= p.timeUpper; t++) {
        let b = Infinity;
        for (let s = prev.timeLower; s <= prev.timeUpper; s++) {
          const dt = t - s;
          if (dt >= gap * minInterval && dt <= gap * maxInterval) {
            const v = dp[s - prev.timeLower];
            if (v < b) b = v;
          }
        }
        next.push(b === Infinity ? Infinity : b + Math.abs(2 * t - (p.timeLower + p.timeUpper)));
      }
      dp = next;
    }
    let dev2 = Infinity;
    for (const v of dp) if (v < dev2) dev2 = v;
    if (dev2 === Infinity) return;
    const missing = cc[n - 1] - cc[0] + 1 - n;
    const order = cn.map((i) => packets[i].id);
    if (!best || missing < best.missing || (missing === best.missing && dev2 < best.dev2)
      || (missing === best.missing && dev2 === best.dev2 && lex(order, best.order))) {
      best = {missing, dev2, order};
    }
  };
  const rec = () => {
    if (cn.length === n) return consider();
    const pc = cc.length ? cc.at(-1) : -Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      for (const c of options[i]) {
        if (c <= pc) continue;
        used[i] = true; cn.push(i); cc.push(c);
        rec();
        cc.pop(); cn.pop(); used[i] = false;
      }
    }
  };
  rec();
  return best;
}
function lex(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return a.length < b.length;
}

const rand = mulberry32(Number(process.argv[2] ?? 1234));
let trials = Number(process.argv[3] ?? 300);
let fails = 0;
for (let trial = 0; trial < trials; trial++) {
  const n = 6;
  const modulus = 2 + Math.floor(rand() * 2); // 2..3 -> many counter options/merges
  const countMax = 9 + Math.floor(rand() * 12);
  const fixed = rand() < 0.7;
  const minInterval = fixed ? 5 + Math.floor(rand() * 8) : Math.floor(rand() * 4);
  const maxInterval = fixed ? minInterval : minInterval + 1 + Math.floor(rand() * 3);
  const packets = [];
  for (let i = 0; i < n; i++) {
    const center = Math.floor(rand() * 140);
    const w = Math.floor(rand() * 8);
    packets.push({
      id: `p${i}`,
      remainder: Math.floor(rand() * modulus),
      timeLower: center,
      timeUpper: center + w,
    });
  }
  const req = {modulus, countMin: 0, countMax, minInterval, maxInterval, packets};
  const ref = bruteForce(req);
  let got;
  try {
    // bypass the 6..14 validator (n already >=6) and call solve directly
    got = solve(req);
  } catch (e) {
    if (e instanceof BusinessError && e.code === 'NO_CONSISTENT_INTERPRETATION') got = null;
    else { console.log('THROW', trial, e.message); fails++; continue; }
  }
  if (ref === null) {
    if (got !== null) { console.log('FALSE FEASIBLE', trial, JSON.stringify(req)); fails++; }
    continue;
  }
  if (!got) { console.log('FALSE INFEASIBLE', trial, JSON.stringify(req)); fails++; if (fails > 5) break; continue; }
  if (got.totalMissing !== ref.missing
    || got.totalMidpointDeviation * 2 !== ref.dev2
    || JSON.stringify(got.order) !== JSON.stringify(ref.order)) {
    console.log('MISMATCH', trial, JSON.stringify(req), 'ref', ref, 'got', {
      m: got.totalMissing, d: got.totalMidpointDeviation * 2, o: got.order,
    });
    fails++;
    if (fails > 5) break;
  }
}
console.log(fails === 0 ? `ALL ${trials} TRIALS PASSED` : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
