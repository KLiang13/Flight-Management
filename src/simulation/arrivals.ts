import { approachSpeedKts, wakeCategory, type WakeCategory } from '../data/aircraft';
import { getArrivalRoutePoints, type MapPoint } from '../map/airfieldGeometry';
import { taxiDuration, landingRollDuration } from './movementPhysics';
import type { TimelineItem } from './runSimulation';

export type ArrivalTimelineItem = {
  divertedAt?: number;
  surfacePlan?: import('./surfaceTraffic').SurfacePlan;
  weather?: import('./weather').WeatherArrivalState;
  exitBranch?: 'P4' | 'P5';
  id: string; callsign: string; aircraftType: string; wakeCategory: WakeCategory; stand: string;
  international: boolean; touchdown: number; approachStart: number; landingEnd: number;
  p5HoldAt: number; crossingStart: number; crossingEnd: number; standArrival: number;
  approachSpeedKts: number; row: Record<string, unknown>;
};

function pathLength(points: MapPoint[]): number {
  return points.slice(1).reduce((total, point, index) => total + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
}

export function scheduleArrivals(rows: Record<string, unknown>[], departures: TimelineItem[]): ArrivalTimelineItem[] {
  let crossingAvailable = -Infinity;
  let p4Available = -Infinity;
  let landingAvailable = -Infinity;
  const orderedRows = [...rows].sort((a, b) => {
    const timeA = new Date(String(a.ScheduledArrival ?? '')).getTime();
    const timeB = new Date(String(b.ScheduledArrival ?? '')).getTime();
    return timeA - timeB || String(a.CallSign ?? '').localeCompare(String(b.CallSign ?? ''));
  });
  return orderedRows.map((row, index) => {
    const touchdown = Math.max(new Date(String(row.ScheduledArrival ?? '')).getTime(), landingAvailable);
    if (!Number.isFinite(touchdown)) throw new Error(`Giờ hạ cánh không hợp lệ: ${String(row.CallSign ?? index + 1)}`);
    const aircraftType = String(row.PlaneTypeCode ?? row.AircraftType ?? 'A320');
    const wake = wakeCategory(aircraftType);
    const stand = String(row.Stand ?? '—');
    const approachSpeed = approachSpeedKts(wake);
    const preferred = getArrivalRoutePoints(stand, 'P4');
    const preferredRoll = landingRollDuration(pathLength(preferred.landing), approachSpeed);
    const exitBranch: 'P4' | 'P5' = touchdown + preferredRoll >= p4Available ? 'P4' : 'P5';
    const route = getArrivalRoutePoints(stand, exitBranch);
    const landingEnd = touchdown + landingRollDuration(pathLength(route.landing), approachSpeed);
    landingAvailable = landingEnd + 60_000;
    const p5HoldAt = landingEnd + taxiDuration(pathLength(route.toHold));
    if (exitBranch === 'P4') p4Available = p5HoldAt + 15_000;
    let crossingStart = Math.max(p5HoldAt, crossingAvailable);
    // Exclusive occupancy: crossing waits until the departure has left 25L.
    for (const departure of [...departures].sort((a, b) => a.runwayEntryStart - b.runwayEntryStart)) {
      if (crossingStart < departure.wheelsOff + 12_000 && crossingStart + 45_000 > departure.runwayEntryStart) {
        crossingStart = departure.wheelsOff + 12_000;
      }
    }
    const crossingEnd = crossingStart + 45_000;
    crossingAvailable = crossingEnd + 15_000;
    const taxiMs = taxiDuration(pathLength(route.fromHold.slice(2)));
    return {
      id: `${String(row.CallSign ?? `ARR-${index + 1}`)}-arrival-${index}`,
      callsign: String(row.CallSign ?? `ARR-${index + 1}`), aircraftType, wakeCategory: wake,
      stand, international: Boolean(row.International), touchdown,
      approachStart: touchdown - 6 / approachSpeed * 3_600_000, landingEnd, p5HoldAt,
      crossingStart, crossingEnd, standArrival: crossingEnd + taxiMs, exitBranch,
      approachSpeedKts: approachSpeed, row,
    };
  }).sort((a, b) => a.touchdown - b.touchdown || a.id.localeCompare(b.id));
}
