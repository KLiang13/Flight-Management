import type { ArrivalTimelineItem } from './arrivals';
import { getArrivalRoutePoints } from '../map/airfieldGeometry';
import { RUNWAY_CLEARANCE_MS, METRES_PER_PIXEL } from './movementPhysics';

// Right-hand 25R threshold on the native 2048 × 1413 parking chart.
export const ARRIVAL_25R_THRESHOLD_X = 1660;

export function arrivalThresholdClearAt(arrival: ArrivalTimelineItem): number {
  if (!Number.isFinite(arrival.approachStart) || !Number.isFinite(arrival.touchdown)) return Infinity;
  const approach = getArrivalRoutePoints(arrival.stand, arrival.exitBranch).approach;
  const start = approach[0], end = approach.at(-1)!;
  const clearedX = ARRIVAL_25R_THRESHOLD_X - 65 / METRES_PER_PIXEL;
  const progress = Math.max(0, Math.min(1, (start.x - clearedX) / (start.x - end.x)));
  return Math.ceil(arrival.approachStart + (arrival.touchdown - arrival.approachStart) * progress);
}

/** Apply the scenario's approach priority at the start of the departure roll. */
export function releaseTakeoffRoll(desired: number, arrivals: ArrivalTimelineItem[]): number {
  // Millisecond clearance boundaries survive wheelsOff/roll-duration round trips.
  let start = Math.ceil(desired);
  for (const arrival of [...arrivals].sort((a, b) => a.approachStart - b.approachStart)) {
    const clearAt = arrivalThresholdClearAt(arrival);
    if (start >= arrival.approachStart && start < clearAt) start = clearAt;
  }
  return start;
}

/** Reserve a P5 crossing before the next departure whenever the arrival is already waiting. */
export function reserveCrossingsBeforeDeparture(
  desiredEntry: number,
  runwayAvailable: number,
  requests: { id: string; p5HoldAt: number; crossingStart?: number; crossingEnd?: number }[],
  takeoffAt?: (entry: number) => number,
): { entry: number; served: string[] } {
  let entry = desiredEntry;
  let available = runwayAvailable;
  const served = new Set<string>();
  const takeoffTimes = new Map<number, number>();
  const projectedTakeoff = (value: number) => {
    if (!takeoffTimes.has(value)) takeoffTimes.set(value, takeoffAt!(value));
    return takeoffTimes.get(value)!;
  };
  const ordered = [...requests].sort((a, b) => a.p5HoldAt - b.p5HoldAt || a.id.localeCompare(b.id));
  let previousEntry: number;
  do {
    previousEntry = entry;
    for (const request of ordered) {
      if (served.has(request.id)) continue;
      const overlaps = request.crossingStart !== undefined && request.crossingEnd !== undefined
        && takeoffAt !== undefined && entry < request.crossingEnd + 15_000 && projectedTakeoff(entry) + RUNWAY_CLEARANCE_MS > request.crossingStart;
      if (request.p5HoldAt > entry && !overlaps) continue;
      const crossingStart = Math.max(request.p5HoldAt, available, request.crossingStart ?? -Infinity);
      available = Math.max(crossingStart + 45_000, request.crossingEnd ?? -Infinity) + 15_000;
      entry = Math.max(entry, available);
      served.add(request.id);
    }
  } while (entry > previousEntry);
  return { entry, served: [...served] };
}

/** A later surface retiming must not introduce an approach across a booked roll start. */
export function arrivalDelayForBookedRolls(arrival: ArrivalTimelineItem, delay: number, rollStarts: number[]): number {
  let adjusted = delay;
  const clearAt = arrivalThresholdClearAt(arrival);
  for (const roll of [...rollStarts].sort((a, b) => a - b)) {
    if (roll >= arrival.approachStart + adjusted && roll < clearAt + adjusted) {
      adjusted = roll + 2000 - arrival.approachStart;
    }
  }
  return adjusted;
}
