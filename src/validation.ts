import {BusinessError, type PacketInput, type SolveRequest} from './types.js';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function isInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x);
}

/**
 * Validate a solve request. Every failure surfaces as a stable
 * INVALID_REQUEST business error; HTTP-independent so the solver core can be
 * used directly.
 */
export function validateRequest(req: unknown): SolveRequest {
  if (req === null || typeof req !== 'object') {
    throw new BusinessError('INVALID_REQUEST', 'request body must be an object', {
      position: -1,
      reason: 'malformed_body',
      detail: 'expected a JSON object',
    });
  }
  const r = req as Record<string, unknown>;

  for (const field of [
    'modulus',
    'countMin',
    'countMax',
    'minInterval',
    'maxInterval',
  ] as const) {
    if (!isInt(r[field])) {
      throw new BusinessError(
        'INVALID_REQUEST',
        `field "${field}" must be an integer`,
        {position: -1, reason: 'invalid_field', detail: field},
      );
    }
  }

  const {
    modulus, countMin, countMax, minInterval, maxInterval,
  } = r as unknown as Pick<
    SolveRequest,
    'modulus' | 'countMin' | 'countMax' | 'minInterval' | 'maxInterval'
  >;

  if (modulus < 2) {
    throw invalid('modulus must be an integer >= 2', 'modulus', `${modulus}`);
  }
  if (countMin > countMax) {
    throw invalid('countMin must be <= countMax', 'count_range', `${countMin}..${countMax}`);
  }
  if (countMax - countMin > 400) {
    throw invalid(
      'absolute counter search window is too wide (max span 400)',
      'count_range_too_wide',
      `${countMin}..${countMax}`,
    );
  }
  if (minInterval < 0 || maxInterval < 0) {
    throw invalid('interval bounds must be non-negative integers', 'interval', 'negative');
  }
  if (minInterval > maxInterval) {
    throw invalid('minInterval must be <= maxInterval', 'interval', `${minInterval}..${maxInterval}`);
  }
  if (maxInterval > 1_000_000_000) {
    throw invalid('maxInterval out of supported range', 'interval', `${maxInterval}`);
  }
  if (!Array.isArray(r.packets)) {
    throw invalid('packets must be an array', 'packets', 'not an array');
  }
  const packets = r.packets as unknown[];
  if (packets.length < 6 || packets.length > 14) {
    throw invalid(
      'between 6 and 14 unique packets are required',
      'packet_count',
      `${packets.length}`,
    );
  }

  const ids = new Set<string>();
  const normalised: PacketInput[] = packets.map((p, i) => {
    if (p === null || typeof p !== 'object') {
      throw invalid(`packet at index ${i} must be an object`, 'packet', `index ${i}`);
    }
    const o = p as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) {
      throw invalid(`packet at index ${i} has an invalid id`, 'packet_id', `index ${i}`);
    }
    // The solver relies on a NUL-joined lexicographic encoding of id prefixes;
    // keep ids to non-control characters and bounded length.
    if (o.id.length > 64 || /[\u0000-\u001f\u007f]/.test(o.id)) {
      throw invalid(
        `packet at index ${i} id must be 1..64 non-control characters`,
        'packet_id_format',
        `index ${i}`,
      );
    }
    if (ids.has(o.id)) {
      throw invalid(`duplicate packet id "${o.id}"`, 'duplicate_id', o.id);
    }
    ids.add(o.id);
    if (!isInt(o.remainder) || !isInt(o.timeLower) || !isInt(o.timeUpper)) {
      throw invalid(
        `packet "${o.id}" requires integer remainder, timeLower, timeUpper`,
        'packet_fields',
        o.id,
      );
    }
    if (o.remainder < 0 || o.remainder >= modulus) {
      throw invalid(
        `packet "${o.id}" remainder ${o.remainder} outside [0, ${modulus - 1}]`,
        'remainder_range',
        o.id,
      );
    }
    if (o.timeLower > o.timeUpper) {
      throw invalid(
        `packet "${o.id}" has timeLower > timeUpper`,
        'time_window',
        o.id,
      );
    }
    if (o.timeUpper - o.timeLower > 300) {
      throw invalid(
        `packet "${o.id}" time window is too wide (max span 300)`,
        'time_window_too_wide',
        o.id,
      );
    }
    // Guard against arithmetic overflow once differences get multiplied by
    // interval bounds later on.
    if (
      Math.abs(o.timeLower) > MAX_SAFE_INTEGER / 4 ||
      Math.abs(o.timeUpper) > MAX_SAFE_INTEGER / 4
    ) {
      throw invalid(`packet "${o.id}" time values out of supported range`, 'time_range', o.id);
    }
    if (Math.abs(countMin) > MAX_SAFE_INTEGER / 8 || Math.abs(countMax) > MAX_SAFE_INTEGER / 8) {
      throw invalid('count window out of supported range', 'count_range', 'overflow guard');
    }
    return {
      id: o.id,
      remainder: o.remainder,
      timeLower: o.timeLower,
      timeUpper: o.timeUpper,
    };
  });

  return {modulus, countMin, countMax, minInterval, maxInterval, packets: normalised};
}

function invalid(message: string, reason: string, detail: string): BusinessError {
  return new BusinessError('INVALID_REQUEST', message, {
    position: -1,
    reason,
    detail,
  });
}
