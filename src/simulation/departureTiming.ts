import type { TimelineItem } from './runSimulation';
import { RUNWAY_ENTRY_MS } from './movementPhysics';

export function clearanceRequestTime(tsat: number, dayStart: number): number {
  return tsat - 20 * 60_000;
}

export function tsatWaitMinutes(actualTakeoff: number, tsat: number): number {
  if (!Number.isFinite(actualTakeoff) || !Number.isFinite(tsat)) return 0;
  return Math.max(0, (actualTakeoff - tsat) / 60_000);
}

/** Use only the latest TSAT already issued at the replay cursor. CTOT revisions do not reset it. */
export function departureTsatAt(flight: TimelineItem, time: number): number {
  if (flight.weather) {
    const { previous, start, revisionAt } = flight.weather;
    if (time >= start && flight.reissuedTsat !== null && revisionAt !== null && time >= revisionAt) return flight.reissuedTsat;
    return departureTsatAt(previous, time);
  }
  return flight.reissuedTsat !== null && time >= (flight.returnEnd ?? -Infinity) ? flight.reissuedTsat : flight.tsat;
}

/** Return only a CTOT already issued at the replay cursor, never a future revision. */
export function departureCtotAt(flight: TimelineItem, time: number): number {
  if (flight.weather) {
    const { revisionAt, previous } = flight.weather;
    if (revisionAt !== null && time >= revisionAt && Number.isFinite(flight.wheelsOff)
      && (flight.reissuedCtot !== null || flight.reissuedTsat !== null)) {
      return flight.reissuedCtot ?? flight.wheelsOff;
    }
    return departureCtotAt(previous, time);
  }
  const revisedAt = flight.returnEnd ?? flight.ctot + 10 * 60_000;
  return time >= revisedAt ? flight.reissuedCtot
    ?? (flight.reissuedTsat !== null ? flight.wheelsOff : flight.ctot) : flight.ctot;
}

/** Only stationary intervals after the latest issued TSAT count as normal waiting. */
export function stationaryWaitMinutesAt(flight: TimelineItem, time: number): number {
  const start = departureTsatAt(flight, time), end = Math.min(time, flight.wheelsOff);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const moving: [number, number][] = flight.surfacePlan
    ? flight.surfacePlan.legs.filter(leg => leg.points.some(point =>
        Math.hypot(point.x - leg.points[0].x, point.y - leg.points[0].y) > .01))
      .map(leg => [leg.start, leg.end])
    : [
        [flight.taxiStart, flight.taxiStart + flight.taxiMinutes * 60_000],
        ...(flight.returnStart !== null && flight.returnEnd !== null ? [[flight.returnStart, flight.returnEnd] as [number, number]] : []),
        ...(flight.secondTaxiStart !== null ? [[flight.secondTaxiStart, flight.secondTaxiStart + flight.taxiMinutes * 60_000] as [number, number]] : []),
        [flight.runwayEntryStart, flight.runwayEntryStart + RUNWAY_ENTRY_MS],
      ];
  moving.push([flight.takeoffRollStart, flight.wheelsOff]);
  const intervals = moving.map(([a, b]) => [Math.max(start, a), Math.min(end, b)] as const)
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let movingMs = 0, coveredUntil = start;
  for (const [a, b] of intervals) {
    movingMs += Math.max(0, b - Math.max(a, coveredUntil));
    coveredUntil = Math.max(coveredUntil, b);
  }
  return Math.max(0, (end - start - movingMs) / 60_000);
}

export function departureWaitMinutesAt(flight: TimelineItem, time: number): number {
  const weather = flight.weather;
  if (!weather) return stationaryWaitMinutesAt(flight, time);
  if (time < weather.start) return departureWaitMinutesAt(weather.previous, time);
  // A suspension before startup cancels the old slot without a compliance penalty.
  if (weather.heldAtStand) return 0;
  let previous = weather.previous;
  while (previous.weather && previous.weather.start > weather.start) previous = previous.weather.previous;
  const oldSlot = previous.reissuedCtot ?? (previous.reissuedTsat !== null
    ? previous.reissuedTsat + previous.taxiMinutes * 60_000 + (previous.wheelsOff - previous.runwayEntryStart)
    : previous.ctot);
  const actual = Math.min(time, flight.wheelsOff);
  return Number.isFinite(actual) && Number.isFinite(oldSlot)
    ? Math.max(0, (actual - oldSlot - 10 * 60_000) / 60_000) : 0;
}
