import type { TimelineItem } from './runSimulation';

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

export function departureWaitMinutesAt(flight: TimelineItem, time: number): number {
  const weather = flight.weather;
  if (!weather) return tsatWaitMinutes(Math.min(time, flight.wheelsOff), departureTsatAt(flight, time));
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
