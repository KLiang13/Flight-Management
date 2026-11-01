import { isWithinCtotWindow } from './ctot';
import { stationaryWaitMinutesAt, tsatWaitMinutes } from './departureTiming';
import { optimizeFlights } from './optimizer';
import { wakeCategory, type WakeCategory } from '../data/aircraft';
import { getNearestReturnStand } from '../map/airfieldGeometry';
import { distanceAlongPathToPoint, pathLength, taxiRoutes } from '../map/surfaceGraph';

import { RUNWAY_MOVEMENT_MS, TAKEOFF_ROLL_MS } from './movementPhysics';
export { RUNWAY_MOVEMENT_MS, TAKEOFF_ROLL_MS };

export type ScheduledFlight = {
  id: string; callsign: string; aircraftType: string; stand: string; wakeCategory: WakeCategory;
  readyAt: number; ctot: number; taxiMinutes: number; row: Record<string, unknown>;
  forceCtotMiss?: boolean;
};
export type TimelineItem = ScheduledFlight & {
  surfacePlan?: import('./surfaceTraffic').SurfacePlan;
  weather?: import('./weather').WeatherDepartureState;
  order: number; wheelsOff: number; taxiStart: number; waitMinutes: number;
  runwayEntryStart: number; takeoffRollStart: number;
  missedCtot: boolean; reissuedCtot: number | null; tsat: number; reissuedTsat: number | null;
  returnStart: number | null; returnEnd: number | null; returnStand: string | null; secondTaxiStart: number | null; status: string;
};
export type SimulationResult = {
  flights: TimelineItem[]; totalWaitMinutes: number; missedCtot: number;
  reissuedCtot: number; completed: number; durationMinutes: number;
};

type QueueEntry = {
  flight: ScheduledFlight; slot: number; hadMissed: boolean;
  taxiStart: number; taxiComplete: number; returnStart?: number; returnEnd?: number; returnStand?: string; secondTaxiStart?: number;
};

function dateNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value;
  const parsed = new Date(String(value ?? '')).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toScheduledFlights(rows: Record<string, unknown>[]): ScheduledFlight[] {
  return rows.map((row, index) => {
    const scheduled = dateNumber(row.ScheduledDeparture, Date.parse('2023-11-03T05:00:00Z') + index * 180_000);
    const ctot = dateNumber(row.CTOT, scheduled);
    const taxiMinutes = Math.max(3, Math.min(20, Number(row.TaxiMinutes) || 8));
    const standReady = dateNumber(row.StandReadyAt, scheduled - taxiMinutes * 60_000);
    const aircraftType = String(row.PlaneTypeCode ?? row.AircraftType ?? 'A320');
    return {
      id: String(row.CallSign ?? `FLT-${index + 1}`) + `-${index}`,
      callsign: String(row.CallSign ?? `FLT-${index + 1}`),
      aircraftType, wakeCategory: wakeCategory(aircraftType),
      forceCtotMiss: String(row.Compliance ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase().replace(/\s+/g, ' ') === 'khong tuan thu',
      stand: String(row.Stand ?? '—'), readyAt: Math.max(scheduled - taxiMinutes * 60_000, standReady), ctot, taxiMinutes, row,
    };
  });
}

function runOrderedSimulation(ordered: ScheduledFlight[]): SimulationResult {
  if (!ordered.length) return { flights: [], totalWaitMinutes: 0, missedCtot: 0, reissuedCtot: 0, completed: 0, durationMinutes: 0 };
  const arrivals: QueueEntry[] = [];
  const standAvailable = new Map<string, number>();
  // Pushback at one stand must not throttle unrelated stands and taxi routes.
  // Shared-route separation is enforced by the surface reservation planner.
  for (const flight of [...ordered].sort((a, b) => a.readyAt - b.readyAt || a.ctot - b.ctot || a.id.localeCompare(b.id))) {
    const taxiStart = Math.max(flight.readyAt, standAvailable.get(flight.stand) ?? -Infinity);
    arrivals.push({ flight, slot: flight.ctot, hadMissed: false, taxiStart, taxiComplete: taxiStart + flight.taxiMinutes * 60_000 });
    standAvailable.set(flight.stand, taxiStart + 120_000);
  }
  arrivals.sort((a, b) => a.taxiComplete - b.taxiComplete || a.flight.id.localeCompare(b.flight.id));

  const holdingQueue: QueueEntry[] = [];
  const returnReservations = new Map<string, number>();
  const result: TimelineItem[] = [];
  let runwayAvailable = -Infinity;
  let nextArrival = 0;
  let clock = arrivals[0]?.taxiComplete ?? 0;
  while (nextArrival < arrivals.length || holdingQueue.length) {
    if (!holdingQueue.length && nextArrival < arrivals.length) clock = Math.max(clock, arrivals[nextArrival].taxiComplete);
    while (nextArrival < arrivals.length && arrivals[nextArrival].taxiComplete <= clock) holdingQueue.push(arrivals[nextArrival++]);
    if (!holdingQueue.length) continue;

    const future = arrivals.slice(nextArrival);
    const remaining = [...holdingQueue, ...future];
    const heavyCount = remaining.filter(entry => entry.flight.wakeCategory === 'H').length;
    const mediumCount = remaining.length - heavyCount;
    const requiredWake = result.at(-1)?.wakeCategory === 'H' ? 'M'
      : heavyCount > mediumCount ? 'H' : null;
    const eligible = holdingQueue.filter(entry => requiredWake === null || entry.flight.wakeCategory === requiredWake);
    if (!eligible.length) {
      const next = future.find(entry => entry.flight.wakeCategory === requiredWake);
      if (!next) throw new Error('Không thể tách hai tàu H liên tiếp bằng tàu M trong lịch còn lại.');
      clock = Math.max(clock, next.taxiComplete);
      continue;
    }
    const earliestFor = (entry: QueueEntry) => Math.max(entry.taxiComplete + RUNWAY_MOVEMENT_MS, runwayAvailable,
      entry.slot - 5 * 60_000, entry.flight.forceCtotMiss && !entry.hadMissed ? entry.flight.ctot + 600_001 : -Infinity);
    eligible.sort((a, b) => earliestFor(a) - earliestFor(b) || a.slot - b.slot || a.flight.id.localeCompare(b.flight.id));
    let item = holdingQueue.splice(holdingQueue.indexOf(eligible[0]), 1)[0];
    const forcedMiss = Boolean(item.flight.forceCtotMiss && !item.hadMissed);
    const earliestTakeoff = Math.max(item.taxiComplete + RUNWAY_MOVEMENT_MS, runwayAvailable, item.slot - 5 * 60_000,
      forcedMiss ? item.flight.ctot + 10 * 60_000 + 1 : -Infinity);
    if (nextArrival < arrivals.length && arrivals[nextArrival].taxiComplete + RUNWAY_MOVEMENT_MS < earliestTakeoff) {
      holdingQueue.push(item);
      clock = Math.max(clock, arrivals[nextArrival].taxiComplete);
      continue;
    }
    while (nextArrival < arrivals.length && arrivals[nextArrival].taxiComplete <= earliestTakeoff) holdingQueue.push(arrivals[nextArrival++]);
    const originalWindowMissed = forcedMiss || !isWithinCtotWindow(new Date(earliestTakeoff), new Date(item.slot));
    if (originalWindowMissed && !item.hadMissed) {
      const route = taxiRoutes(item.flight.stand)[0]?.points ?? [];
      const pointXDistance = distanceAlongPathToPoint(route);
      const pointXAt = pointXDistance === null ? Infinity
        : item.taxiStart + item.flight.taxiMinutes * 60_000 * pointXDistance / Math.max(1, pathLength(route));
      const ctotExpiry = item.slot + 10 * 60_000 + 1;
      if (pointXAt <= ctotExpiry) item = { ...item, hadMissed: true };
    }
    if (originalWindowMissed && !item.hadMissed) {
      const returnStart = Math.max(item.taxiComplete, item.slot + 10 * 60_000 + 1);
      const returnEnd = returnStart + item.flight.taxiMinutes * 60_000;
      const unavailable = new Set([...returnReservations].filter(([, until]) => until > returnStart).map(([stand]) => stand));
      const returnStand = getNearestReturnStand(item.flight.stand, unavailable, item.flight.wakeCategory);
      const secondTaxiStart = Math.max(returnEnd + 2 * 60_000, earliestTakeoff + holdingQueue.length * RUNWAY_MOVEMENT_MS);
      const newSlot = secondTaxiStart + item.flight.taxiMinutes * 60_000 + RUNWAY_MOVEMENT_MS;
      returnReservations.set(returnStand, newSlot);
      const reissued: QueueEntry = {
        ...item, slot: newSlot, hadMissed: true, taxiComplete: secondTaxiStart + item.flight.taxiMinutes * 60_000,
        returnStart, returnEnd, returnStand, secondTaxiStart,
      };
      let insertion = nextArrival;
      while (insertion < arrivals.length && arrivals[insertion].taxiComplete <= reissued.taxiComplete) insertion += 1;
      arrivals.splice(insertion, 0, reissued);
      // A forced scenario waits for expiry without blocking other valid slots.
      if (!forcedMiss) clock = Math.max(clock, returnStart);
      continue;
    }
    const wheelsOff = earliestTakeoff;
    const reissuedCtot = item.hadMissed && !item.returnStand ? wheelsOff : null;
    const flight = item.flight;
    const waitMinutes = tsatWaitMinutes(wheelsOff, item.returnStand ? item.secondTaxiStart ?? item.taxiStart : item.taxiStart);
    runwayAvailable = wheelsOff + RUNWAY_MOVEMENT_MS;
    clock = runwayAvailable;
    result.push({
      ...flight, order: result.length + 1, taxiStart: item.taxiStart, wheelsOff, waitMinutes,
      missedCtot: item.hadMissed, runwayEntryStart: wheelsOff - RUNWAY_MOVEMENT_MS,
      takeoffRollStart: wheelsOff - TAKEOFF_ROLL_MS, reissuedCtot,
      tsat: item.taxiStart, reissuedTsat: item.returnStand ? item.secondTaxiStart ?? null : null,
      returnStart: item.returnStart ?? null, returnEnd: item.returnEnd ?? null,
      returnStand: item.returnStand ?? null, secondTaxiStart: item.secondTaxiStart ?? null,
      status: item.hadMissed ? 'Không tuân thủ CTOT' : 'Đúng CTOT',
    });
  }
  result.sort((a, b) => a.wheelsOff - b.wheelsOff || a.id.localeCompare(b.id));
  result.forEach((flight, index) => { flight.order = index + 1; flight.waitMinutes = stationaryWaitMinutesAt(flight, flight.wheelsOff); });
  const totalWaitMinutes = result.reduce((sum, flight) => sum + flight.waitMinutes, 0);
  return {
    flights: result, totalWaitMinutes, missedCtot: result.filter((flight) => flight.missedCtot).length,
    reissuedCtot: result.filter((flight) => flight.reissuedCtot !== null).length,
    completed: result.length, durationMinutes: result.length ? (result.at(-1)!.wheelsOff - result[0].readyAt) / 60_000 : 0,
  };
}

export function runSimulation(flights: ScheduledFlight[], proposed = false): SimulationResult {
  if (!proposed) {
    return runOrderedSimulation([...flights].sort((a, b) => a.ctot - b.ctot || a.readyAt - b.readyAt || a.id.localeCompare(b.id)));
  }
  const baselineOrder = [...flights].sort((a, b) => a.ctot - b.ctot || a.readyAt - b.readyAt || a.id.localeCompare(b.id));
  const baseline = runOrderedSimulation(baselineOrder);
  const greedyOrder = optimizeFlights(flights.map((flight) => ({ ...flight, ctot: flight.ctot, ready: flight.readyAt, taxi: flight.taxiMinutes })));
  const readyOrder = [...flights].sort((a, b) => a.readyAt - b.readyAt || a.ctot - b.ctot || a.id.localeCompare(b.id));
  const candidates = [runOrderedSimulation(greedyOrder), runOrderedSimulation(readyOrder), baseline];
  candidates.sort((a, b) => a.totalWaitMinutes - b.totalWaitMinutes || a.missedCtot - b.missedCtot);
  return candidates[0];
}

export function improvementPercent(baseline: number, proposed: number): number {
  return baseline <= 0 ? 0 : Math.max(0, ((baseline - proposed) / baseline) * 100);
}


