import type { MapPoint } from '../map/parkingGeometry';
import { pointOnPath as pointAlongPath } from '../map/pathMetrics';
import { taxiRoutes, pathLength, distanceAlongPathToPoint, STAND_POINTS } from '../map/surfaceGraph';
import { getArrivalRoutePoints, getRunwaySegment, getNearestReturnStand } from '../map/airfieldGeometry';
import { taxiDuration, landingRollDuration, RUNWAY_ENTRY_MS, TAKEOFF_ROLL_MS, RUNWAY_CLEARANCE_MS, takeoffDistanceProgress } from './movementPhysics';
import type { TimelineItem } from './runSimulation';
import { enforceSingleCtot } from './weather';
import type { ArrivalTimelineItem } from './arrivals';
import { ctotDelayMinutes } from './ctot';
import { clearanceRequestTime, stationaryWaitMinutesAt, tsatWaitMinutes } from './departureTiming';
import { releaseTakeoffRoll, arrivalDelayForBookedRolls, reserveCrossingsBeforeDeparture } from './runwayCoordination';

export type SurfaceLeg = { start: number; end: number; points: MapPoint[]; phase: string };
export type SurfacePlan = { visibleFrom: number; visibleUntil: number; legs: SurfaceLeg[]; route: string };
type Sample = MapPoint & { radius: number; owner?: string };
const STEP = 2000;
const CELL = 40;
const MAX_RESCHEDULE_MS = 48 * 60 * 60_000;

// Space-time reservations cover the rendered trajectories, including junctions
// shared by differently named routes. No aircraft can pass through a waiting one.
export class Reservations {
  lastConflictDelay = STEP;
  private cells = new Map<string, Sample[]>();
  private parked = new Map<string, (Sample & { start: number; end: number })[]>();
  private moving = new Map<string, (Sample & { time: number })[]>();
  private key(t: number, x: number, y: number) { return `${t}:${x}:${y}`; }
  private conflict(releaseAt: number, candidateAt: number): false {
    this.lastConflictDelay = Math.max(STEP, releaseAt + STEP - candidateAt);
    return false;
  }
  private neighbours(point: MapPoint): string[] {
    const x = Math.floor(point.x / CELL), y = Math.floor(point.y / CELL), keys: string[] = [];
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) keys.push(`${x + dx}:${y + dy}`);
    return keys;
  }
  private samples(item: SurfaceLeg, visit: (time: number, point: MapPoint) => boolean): boolean {
    for (let time = Math.floor(item.start / STEP); time <= Math.ceil(item.end / STEP); time += 1) {
      const progress = Math.max(0, Math.min(1, (time * STEP - item.start) / Math.max(1, item.end - item.start)));
      if (!visit(time, pointAlongPath(item.points, progress))) return false;
    }
    return true;
  }
  available(legs: SurfaceLeg[], radius: number, owner?: string): boolean {
    this.lastConflictDelay = STEP;
    const near = (a: MapPoint, b: Sample) => (owner === undefined || b.owner !== owner) && Math.hypot(a.x - b.x, a.y - b.y) < radius + b.radius;
    for (const item of legs) {
      if (item.end <= item.start) continue;
      if (item.points.length === 1) {
        const point = item.points[0];
        for (const key of this.neighbours(point)) {
          for (const other of this.parked.get(key) ?? []) if (item.start < other.end + STEP && item.end > other.start - STEP && near(point, other)) return this.conflict(other.end, item.start);
          for (const other of this.moving.get(key) ?? []) if (other.time * STEP >= item.start - STEP && other.time * STEP <= item.end + STEP && near(point, other)) return this.conflict(other.time * STEP, item.start);
        }
      } else if (!this.samples(item, (time, point) => {
        for (const key of this.neighbours(point)) {
          for (const other of this.parked.get(key) ?? []) if (time * STEP >= other.start - STEP && time * STEP <= other.end + STEP && near(point, other)) return this.conflict(other.end, time * STEP);
          for (let dt = -1; dt <= 1; dt += 1) for (const other of this.cells.get(`${time + dt}:${key}`) ?? []) if (near(point, other)) return this.conflict((time + dt + 1) * STEP, time * STEP);
        }
        return true;
      })) return false;
    }
    return true;
  }
  reserve(legs: SurfaceLeg[], radius: number, owner?: string) {
    for (const item of legs) {
      if (item.end <= item.start) continue;
      if (item.points.length === 1) {
        const point = item.points[0], key = `${Math.floor(point.x / CELL)}:${Math.floor(point.y / CELL)}`;
        const entries = this.parked.get(key) ?? [];
        entries.push({ ...point, radius, owner, start: item.start, end: item.end }); this.parked.set(key, entries);
      } else this.samples(item, (time, point) => {
        const x = Math.floor(point.x / CELL), y = Math.floor(point.y / CELL), key = this.key(time, x, y);
        const cell = this.cells.get(key) ?? [];
        cell.push({ ...point, radius, owner }); this.cells.set(key, cell);
        const spatial = `${x}:${y}`, entries = this.moving.get(spatial) ?? [];
        entries.push({ ...point, radius, owner, time }); this.moving.set(spatial, entries); return true;
      });
    }
  }
}

const leg = (start: number, end: number, points: MapPoint[], phase: string): SurfaceLeg => ({ start, end, points, phase });
const parked = (stand: string, start: number, end: number) => leg(start, end, [STAND_POINTS[stand]], `tại stand ${stand}`);

export function surfacePosition(plan: SurfacePlan, time: number) {
  let low = 0, high = plan.legs.length - 1;
  while (low < high) { const middle = (low + high) >>> 1; if (time < plan.legs[middle].end) high = middle; else low = middle + 1; }
  const item = plan.legs[low];
  const progress = (time - item.start) / Math.max(1, item.end - item.start);
  const point = pointAlongPath(item.points, progress);
  const next = pointAlongPath(item.points, Math.min(1, progress + 0.005));
  const previous = pointAlongPath(item.points, Math.max(0, progress - 0.005));
  return { point, phase: item.phase, rotation: item.points.length < 2 ? 0 : Math.atan2(next.x - previous.x, previous.y - next.y) * 180 / Math.PI };
}

function planDepartures(departures: TimelineItem[], inbound: ArrivalTimelineItem[], runway: string,
  reservations: Reservations, crossingRequests: ArrivalTimelineItem[]): TimelineItem[] {
  let runwayAvailable = -Infinity;
  const servedCrossings = new Set<string>();
  const flights = [...departures].sort((a, b) => a.wheelsOff - b.wheelsOff).map((source) => {
    const radius = source.wakeCategory === 'H' ? 15 : 9;
    const international = (stand: string) => Number(stand) >= 9 && Number(stand) <= 16;
    const otherStands = Object.keys(STAND_POINTS).filter(stand => stand !== source.stand
      && international(stand) === international(source.stand)
      && (international(stand) || source.wakeCategory !== 'H' || Number(stand) >= 23 && Number(stand) <= 34))
      .sort((a, b) => Math.hypot(STAND_POINTS[a].x - STAND_POINTS[source.stand].x, STAND_POINTS[a].y - STAND_POINTS[source.stand].y)
        - Math.hypot(STAND_POINTS[b].x - STAND_POINTS[source.stand].x, STAND_POINTS[b].y - STAND_POINTS[source.stand].y));
    const standChoices = [source.stand, ...otherStands];
    if (!Number.isFinite(source.wheelsOff)) {
      const visibleFrom = source.tsat - 20 * 60_000;
      for (const stand of standChoices) {
        const legs = [parked(stand, visibleFrom, Infinity)];
        if (!reservations.available(legs, radius, source.id)) continue;
        reservations.reserve(legs, radius, source.id);
        const plan = { visibleFrom, visibleUntil: Infinity, legs, route: 'suspended' };
        return { ...source, stand, surfacePlan: plan, weather: source.weather ? { ...source.weather, groundStand: stand, surfacePlan: plan } : undefined };
      }
      return { ...source, weather: source.weather ? { ...source.weather, offApron: true } : undefined };
    }
    let chosen: TimelineItem | undefined;
    const dayStart = new Date(source.readyAt).setHours(0, 0, 0, 0);
    let delay = Math.max(0, runwayAvailable - source.runwayEntryStart);
    // Delay is allocated before pushback, never by freezing an aircraft on a junction.
    while (!chosen && delay < MAX_RESCHEDULE_MS && delay <= Math.max(0, source.ctot + 600_000 - source.wheelsOff)) {
      let nextDelay = Infinity;
      for (const stand of standChoices) {
        for (const route of taxiRoutes(stand)) {
          const taxiMs = taxiDuration(pathLength(route.points));
          const pendingCrossings = crossingRequests.filter(arrival => !servedCrossings.has(arrival.id));
          const entry = reserveCrossingsBeforeDeparture(
            Math.max(source.runwayEntryStart + delay, source.readyAt + taxiMs), runwayAvailable, pendingCrossings,
            value => releaseTakeoffRoll(value + RUNWAY_ENTRY_MS, inbound) + TAKEOFF_ROLL_MS).entry;
          const legs: SurfaceLeg[] = [];
          let taxiStart = entry - taxiMs;
          const wheelsOffProjected = releaseTakeoffRoll(entry + RUNWAY_ENTRY_MS, inbound) + TAKEOFF_ROLL_MS;
          const groundMiss = wheelsOffProjected > source.ctot + 600_000;
          const commitDistance = distanceAlongPathToPoint(route.points);
          const commitAt = commitDistance === null ? Infinity : taxiStart + taxiMs * commitDistance / Math.max(1, pathLength(route.points));
          const passedCommitPoint = source.missedCtot && source.returnStand === null
            || commitAt <= source.ctot + 600_000;
          const mustReturnToStand = groundMiss && !passedCommitPoint;
          const originalReturnPlanned = source.returnStart !== null && source.returnStand !== null;
          let expiredAtStand = !originalReturnPlanned && taxiStart >= source.ctot + 600_000;
          const needsReturn = !expiredAtStand && (mustReturnToStand || (source.returnStart !== null && !passedCommitPoint));
          let returnStart = needsReturn ? source.returnStart ?? Math.max(source.ctot + 600_001, source.readyAt + taxiMs) : null;
          let returnEnd = needsReturn ? source.returnEnd : null;
          let secondTaxiStart = needsReturn ? source.secondTaxiStart : null;
          let returnStand = needsReturn
            ? source.returnStand ?? getNearestReturnStand(stand, new Set(), source.wakeCategory) : null;
          if (returnStart !== null && returnStand) {
            // Keep the first trip independent of the revised departure slot.
            // Moving its expiry by the full slot delay compounds every later delay.
            if (originalReturnPlanned) taxiStart = source.taxiStart;
            returnStart = Math.max(returnStart, taxiStart + taxiMs);
            taxiStart = Math.max(source.readyAt, returnStart - taxiMs);
            legs.push(parked(stand, clearanceRequestTime(taxiStart, dayStart), taxiStart));
            legs.push(leg(taxiStart, returnStart, route.points, 'lăn ra điểm chờ S1'));
            const back = taxiRoutes(returnStand, 'S1')[0].points;
            returnEnd = returnStart + taxiDuration(pathLength(back));
            legs.push(leg(returnStart, returnEnd, back, 'không tuân thủ CTOT · quay về vị trí đỗ'));
            const outbound = taxiRoutes(returnStand)[0].points;
            secondTaxiStart = Math.max(returnEnd + 120_000, entry - taxiDuration(pathLength(outbound)));
            if (reservations.available([...legs, parked(returnStand, returnEnd, secondTaxiStart)], radius)) {
              legs.push(parked(returnStand, returnEnd, secondTaxiStart));
              legs.push(leg(secondTaxiStart, secondTaxiStart + taxiDuration(pathLength(outbound)), outbound, 'lăn theo TSAT mới'));
            } else {
              // No pushback clearance is issued for an already occupied first route.
              // The aircraft remains at its stand and receives a revised TSAT.
              legs.length = 0;
              returnStart = null; returnEnd = null; returnStand = null; secondTaxiStart = null;
              taxiStart = entry - taxiMs;
              expiredAtStand = taxiStart >= source.ctot + 600_000;
            }
          }
          if (!legs.length) {
            legs.push(parked(stand, clearanceRequestTime(taxiStart, dayStart), taxiStart));
            legs.push(leg(taxiStart, entry, route.points, 'lăn ra điểm chờ S1'));
          }
          const crossingPriority = reserveCrossingsBeforeDeparture(Math.max(entry, legs.at(-1)!.end), runwayAvailable, pendingCrossings,
            value => releaseTakeoffRoll(value + RUNWAY_ENTRY_MS, inbound) + TAKEOFF_ROLL_MS);
          const runwayEntryStart = crossingPriority.entry;
          if (legs.at(-1)!.end < runwayEntryStart) legs.push(leg(legs.at(-1)!.end, runwayEntryStart, [route.points.at(-1)!], 'chờ tại S1'));
          const segment = getRunwaySegment(runway);
          const entryEnd = runwayEntryStart + RUNWAY_ENTRY_MS;
          const takeoffRollStart = releaseTakeoffRoll(entryEnd, inbound), wheelsOff = takeoffRollStart + TAKEOFF_ROLL_MS;
          legs.push(leg(runwayEntryStart, entryEnd, segment.entryPath, 'vào đường băng 25L'));
          if (takeoffRollStart > entryEnd) legs.push(leg(entryEnd, takeoffRollStart, [segment.threshold], 'chờ tàu đến vượt 25R'));
          // Reservation samples follow the same acceleration as the animation.
          const rollLegs = Array.from({ length: Math.ceil(TAKEOFF_ROLL_MS / STEP) }, (_, i) => {
            const start = i * STEP, end = Math.min(TAKEOFF_ROLL_MS, (i + 1) * STEP);
            return leg(takeoffRollStart + start, takeoffRollStart + end,
              [pointAlongPath([segment.threshold, segment.rollEnd], takeoffDistanceProgress(start / TAKEOFF_ROLL_MS)),
                pointAlongPath([segment.threshold, segment.rollEnd], takeoffDistanceProgress(end / TAKEOFF_ROLL_MS))], 'cất cánh 25L');
          });
          if (!reservations.available([...legs, ...rollLegs], radius)) {
            nextDelay = Math.min(nextDelay,
              Math.max(delay, runwayEntryStart - source.runwayEntryStart) + Math.max(10_000, reservations.lastConflictDelay));
            continue;
          }
          reservations.reserve([...legs, ...rollLegs], radius);
          const revised = source.missedCtot || ctotDelayMinutes(wheelsOff, source.ctot) > 0;
          const returnedToStand = returnStart !== null && returnStand !== null;
          chosen = { ...source, stand, taxiStart, taxiMinutes: taxiMs / 60_000, runwayEntryStart, takeoffRollStart, wheelsOff,
            returnStart, returnEnd, returnStand, secondTaxiStart,
            tsat: taxiStart, reissuedTsat: revised && (returnedToStand || expiredAtStand) ? secondTaxiStart ?? taxiStart : null,
            reissuedCtot: revised && !returnedToStand && !expiredAtStand ? wheelsOff : null,
            missedCtot: revised, status: revised ? 'Không tuân thủ CTOT' : source.status,
            waitMinutes: tsatWaitMinutes(wheelsOff, revised && returnedToStand ? secondTaxiStart ?? taxiStart : taxiStart),
            surfacePlan: { visibleFrom: legs[0].start, visibleUntil: wheelsOff + 8000, legs, route: route.label } };
          chosen.waitMinutes = stationaryWaitMinutesAt(chosen, wheelsOff);
          for (const id of crossingPriority.served) servedCrossings.add(id);
          runwayAvailable = wheelsOff + RUNWAY_CLEARANCE_MS;
          break;
        }
        if (chosen) break;
      }
      if (!chosen) delay = Number.isFinite(nextDelay) ? nextDelay : delay + 10_000;
    }
    if (!chosen) return planDepartures(enforceSingleCtot([{ ...source, missedCtot: true }]), inbound, runway, reservations, crossingRequests)[0];
    return chosen;
  });
  return flights;
}

function planArrivals(inbound: ArrivalTimelineItem[], flights: TimelineItem[], reservations: Reservations,
  prioritizeCrossings = false) {
  let landingAvailable = -Infinity;
  const arrivals = [...inbound].sort((a, b) => a.touchdown - b.touchdown).map((source) => {
    if (source.divertedAt !== undefined) return source;
    let chosen: ArrivalTimelineItem | undefined;
    let delay = arrivalDelayForBookedRolls(source, Math.max(0, landingAvailable - source.touchdown), flights.map(flight => flight.takeoffRollStart));
    while (!chosen && delay < MAX_RESCHEDULE_MS) {
      let nextDelay = Infinity;
      const international = (stand: string) => Number(stand) >= 9 && Number(stand) <= 16;
      const standChoices = [source.stand, ...Object.keys(STAND_POINTS).filter(stand => stand !== source.stand
        && international(stand) === international(source.stand)
        && (international(stand) || source.wakeCategory !== 'H' || Number(stand) >= 23 && Number(stand) <= 34))];
      const choices = standChoices.flatMap(stand => (['P4', 'P5'] as const).map(branch => ({ stand, branch })));
      for (const { stand, branch } of choices) {
        const route = getArrivalRoutePoints(stand, branch);
        const landingEnd = source.touchdown + delay + landingRollDuration(pathLength(route.landing), source.approachSpeedKts);
        const p5HoldAt = landingEnd + taxiDuration(pathLength(route.toHold));
        // Recompute the crossing against the final runway schedule. Carrying
        // the preliminary queue wait forward would add that same wait again
        // every time the arrival is retimed for a surface conflict.
        let crossingStart = p5HoldAt;
        for (const flight of flights) if ((!prioritizeCrossings || flight.runwayEntryStart < p5HoldAt)
          && crossingStart + 45_000 > flight.runwayEntryStart && crossingStart < flight.wheelsOff + RUNWAY_CLEARANCE_MS) crossingStart = flight.wheelsOff + RUNWAY_CLEARANCE_MS;
        const crossingEnd = crossingStart + 45_000;
        const standArrival = crossingEnd + taxiDuration(pathLength(route.fromHold.slice(2)));
        const legs = [leg(source.approachStart + delay, source.touchdown + delay, route.approach, 'tiếp cận 25R'),
          leg(source.touchdown + delay, landingEnd, route.landing, 'hạ cánh 25R'),
          leg(landingEnd, p5HoldAt, route.toHold, `lăn theo ${branch} đến điểm chờ P5`),
          leg(p5HoldAt, crossingStart, [route.toHold.at(-1)!], 'dừng trước 25L tại P5'),
          leg(crossingStart, crossingEnd, route.fromHold.slice(0, 3), 'cắt qua 25L'),
          leg(crossingEnd, standArrival, route.fromHold.slice(2), `lăn vào stand ${stand}`),
          parked(stand, standArrival, standArrival + 45 * 60_000)];
        const radius = source.wakeCategory === 'H' ? 15 : 9;
        if (!reservations.available(legs, radius)) {
          nextDelay = Math.min(nextDelay, delay + reservations.lastConflictDelay);
          continue;
        }
        reservations.reserve(legs, radius);
        chosen = { ...source, stand, approachStart: source.approachStart + delay, touchdown: source.touchdown + delay, landingEnd,
          p5HoldAt, crossingStart, crossingEnd, standArrival, exitBranch: branch,
          surfacePlan: { visibleFrom: source.approachStart + delay, visibleUntil: legs.at(-1)!.end, legs, route: branch } };
        landingAvailable = landingEnd + 60_000;
        break;
      }
      if (!chosen && !Number.isFinite(nextDelay)) return { ...source, divertedAt: source.approachStart };
      if (!chosen) delay = arrivalDelayForBookedRolls(source, nextDelay, flights.map(flight => flight.takeoffRollStart));
    }
    if (!chosen) return { ...source, divertedAt: source.approachStart };
    return chosen;
  });
  return arrivals;
}

export function planSurfaceTraffic(departures: TimelineItem[], inbound: ArrivalTimelineItem[], runway: string) {
  const previewReservations = new Reservations();
  const previewFlights = planDepartures(departures, inbound, runway, previewReservations, []);
  const previewArrivals = planArrivals(inbound, previewFlights, previewReservations);

  // First establish feasible landing/taxi routes. Give waiting arrivals a crossing
  // after the departure already on 25L; subsequent departures then plan around it.
  const reservations = new Reservations();
  const arrivals = planArrivals(previewArrivals, previewFlights, reservations, true);
  const accepted = arrivals.filter(arrival => arrival.divertedAt === undefined);
  const flights = planDepartures(departures, accepted, runway, reservations, accepted);
  return { flights, arrivals };
}
