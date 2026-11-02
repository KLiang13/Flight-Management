import { Reservations, type SurfaceLeg, type SurfacePlan } from './surfaceTraffic';
import type { AircraftPosition } from '../map/playback';

/** Sample the same trajectory that is displayed, compressing stationary intervals. */
export function weatherTrajectory(start: number, end: number, position: (time: number) => AircraftPosition, checkpoints: number[] = []): SurfaceLeg[] {
  const boundaries = [...new Set([...checkpoints, end])].filter(time => Number.isFinite(time) && time > start).sort((a, b) => a - b);
  const legs: SurfaceLeg[] = [];
  let previous = position(start);
  for (let time = start; time < end;) {
    let nextTime = Math.min(end, time + 2000), next = position(nextTime);
    if (Math.hypot(next.point.x - previous.point.x, next.point.y - previous.point.y) < .001) {
      const boundary = boundaries.find(value => value > nextTime);
      if (boundary !== undefined) {
        const before = position(boundary - .01);
        if (before.phase === previous.phase && Math.hypot(before.point.x - previous.point.x, before.point.y - previous.point.y) < .001) {
          nextTime = boundary; next = position(boundary);
        }
      }
    }
    const stationary = Math.hypot(next.point.x - previous.point.x, next.point.y - previous.point.y) < .001;
    const last = legs.at(-1);
    if (stationary && last?.points.length === 1 && Math.hypot(last.points[0].x - previous.point.x, last.points[0].y - previous.point.y) < .001) last.end = nextTime;
    else legs.push({ start: time, end: nextTime, points: stationary ? [previous.point] : [previous.point, next.point], phase: previous.phase });
    time = nextTime; previous = next;
  }
  return legs;
}

export type WeatherReserved = { delay: number; returnDelay?: number; plan: SurfacePlan };

export class WeatherSurfaceConflict extends Error {
  constructor(public movement: WeatherMovement, public booked: Map<string, WeatherReserved>) { super(`Không có tuyến lăn an toàn sau thời tiết cho ${movement.id}.`); }
}

export type WeatherMovement = {
  id: string; radius: number; start: number; end: number; legs: SurfaceLeg[];
  minimumDelay: number; returning?: boolean; priority?: number; holdAtStart?: boolean; entryAt?: number; releaseDelay: (delay: number, booked: ReadonlyMap<string, WeatherReserved>) => number;
};

/** Reserve complete rendered movements, including the stop while awaiting a safe route. */
export function reserveWeatherMovements(movements: WeatherMovement[]): Map<string, WeatherReserved> {
  const reservations = new Reservations();
  const result = new Map<string, WeatherReserved>();
  let previousDepartureEnd = -Infinity;
  for (const movement of [...movements].sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1))) {
    if (!movement.legs.length) continue;
    let delay = movement.releaseDelay(Math.max(movement.minimumDelay,
      movement.entryAt === undefined ? 0 : previousDepartureEnd + 12_000 - movement.entryAt), result);
    let accepted = false;
    while (delay < 48 * 60 * 60_000) {
      const legs = movement.legs.map(leg => ({ ...leg, start: leg.start + delay, end: leg.end + delay }));
      if (delay > 0 && movement.holdAtStart !== false) legs.unshift({ start: movement.start, end: movement.start + delay, points: [movement.legs[0].points[0]], phase: 'chờ phân cách đường lăn' });
      if (reservations.available(legs, movement.radius, movement.id)) {
        reservations.reserve(legs, movement.radius, movement.id);
        const previous = result.get(movement.id);
        // Reservation priority must not change the chronological playback of one aircraft.
        // A returned aircraft's parking may be booked before its approach to that stand.
        const priorLegs = movement.returning && previous
          ? previous.plan.legs.map(leg => ({ ...leg, start: Math.max(leg.start, movement.end + delay) }))
            .filter(leg => leg.end > leg.start)
          : previous?.plan.legs ?? [];
        const combined = [...priorLegs, ...legs].sort((a, b) => a.start - b.start || a.end - b.end);
        result.set(movement.id, { delay: movement.returning ? previous?.delay ?? delay : delay,
          returnDelay: movement.returning ? delay : previous?.returnDelay,
          plan: { visibleFrom: Math.min(previous?.plan.visibleFrom ?? Infinity, legs[0].start),
            visibleUntil: Math.max(previous?.plan.visibleUntil ?? -Infinity, movement.end + delay),
            legs: combined, route: 'weather-reserved' } });
        if (movement.entryAt !== undefined && Number.isFinite(movement.end)) previousDepartureEnd = movement.end + delay;
        accepted = true; break;
      }
      delay = movement.releaseDelay(delay + Math.max(2000, reservations.lastConflictDelay), result);
    }
    if (!accepted) throw new WeatherSurfaceConflict(movement, result);
  }
  return result;
}
