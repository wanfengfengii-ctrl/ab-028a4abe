/**
 * Domain types for recovering buoy telemetry send order.
 *
 * Each observed packet carries:
 *  - a counter remainder (the on-device rotating counter modulo `modulus`)
 *  - an integer send-time window [timeLower, timeUpper] (measurement units,
 *    inclusive on both ends)
 *
 * The service jointly assigns every packet a distinct absolute counter
 * (congruent to its remainder modulo `modulus`) and an integer send time
 * inside its window, such that for every adjacent pair in recovered order the
 * time difference is consistent with the counter difference and the sampling
 * interval bounds:
 *
 *     minInterval * counterDifference <= timeDifference
 *     timeDifference                 <= maxInterval * counterDifference
 */

export interface PacketInput {
  /** Stable caller-assigned identifier of the observed packet. */
  id: string;
  /** Observed rotating-counter remainder, in [0, modulus). */
  remainder: number;
  /** Inclusive lower bound of the integer send-time window. */
  timeLower: number;
  /** Inclusive upper bound of the integer send-time window. */
  timeUpper: number;
}

export interface SolveRequest {
  /** Rotating-counter modulus; absolute counters are congruent modulo it. */
  modulus: number;
  /** Inclusive absolute-counter search window. */
  countMin: number;
  countMax: number;
  /** Lower bound of the sampling interval between successive transmissions. */
  minInterval: number;
  /** Upper bound of the sampling interval between successive transmissions. */
  maxInterval: number;
  /** 6..14 uniquely identified observed packets, given in download order. */
  packets: PacketInput[]
}

/** One adjacency in the recovered order, with its feasibility evidence. */
export interface AdjacencyEvidence {
  fromId: string;
  toId: string;
  fromCount: number;
  toCount: number;
  /** Positive absolute-counter difference (always >= 1, counters distinct). */
  countDifference: number;
  fromTime: number;
  toTime: number;
  /** Positive send-time difference. */
  timeDifference: number;
  /** Inclusive feasibility window for the time difference. */
  minTimeDifference: number;
  maxTimeDifference: number;
  /**
   * Per-step interval implied by the realised pair; always lies within
   * [minInterval, maxInterval].
   */
  effectiveInterval: string;
}

/** A contiguous run of absolute counters absent from the observed packets. */
export interface MissingSpan {
  /** Absolute counter of the first missing packet in the run. */
  fromCount: number;
  /** Absolute counter of the last missing packet in the run. */
  toCount: number;
  /** Number of missing packets in the run. */
  missing: number;
  /** Id of the observed packet immediately before the run. */
  afterId: string;
  /** Id of the observed packet immediately after the run. */
  beforeId: string;
}

export interface AssignedPacket {
  /** Recovered position, 0-based (0 = earliest transmitted). */
  position: number;
  id: string;
  count: number;
  time: number;
}

export interface SolveResult {
  order: string[];
  assignments: AssignedPacket[];
  /** Total missing absolute counters strictly between first and last counts. */
  totalMissing: number;
  missingSpans: MissingSpan[];
  adjacencyEvidence: AdjacencyEvidence[];
  /** Sum of |selectedTime - midpoint(window)| over all packets. */
  totalMidpointDeviation: number;
}

/** Stable business error codes (see README / PROTOCOL.md). */
export type BusinessErrorCode =
  | 'INVALID_REQUEST'
  | 'NO_CONSISTENT_INTERPRETATION';

export interface ConstraintEvidence {
  /** Position (0-based) at which the chain could not be extended. */
  position: number;
  fromId?: string;
  toId?: string;
  reason: string;
  detail: string;
  /** Packet-id prefix already placed when the blocking constraint was hit. */
  attemptedPrefix?: string[];
}

export class BusinessError extends Error {
  readonly code: BusinessErrorCode;
  readonly evidence?: ConstraintEvidence;

  constructor(
    code: BusinessErrorCode,
    message: string,
    evidence?: ConstraintEvidence,
  ) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
    this.evidence = evidence;
  }
}
