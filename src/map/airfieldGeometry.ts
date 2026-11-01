import type { WakeCategory } from '../data/aircraft';
import { pointAlongPath, type MapPoint } from './parkingGeometry';
import { STAND_POINTS, INTERNATIONAL_BAYS, DOMESTIC_BAYS, HOLD_S1, P5_HOLD, RUNWAY_ENTRY, RUNWAY_END, taxiRoutes, runwayEntryPath, arrivalExitPaths, curve } from './surfaceGraph';
export { pointAlongPath };
export type { MapPoint };
export const MAP_VIEWBOX = '0 0 2048 1413';
export const ARRIVAL_P5_HOLD = P5_HOLD;
export function getStandPoint(stand: string): MapPoint {
  const point = STAND_POINTS[stand.trim().toUpperCase()];
  if (!point) throw new Error(`Stand ${stand} chưa có tọa độ trên chart.`);
  return point;
}
export function getHoldingPoint(_runway: string): MapPoint { return HOLD_S1; }
export function getRunwaySegment(_runway: string) {
  return { entryPath: runwayEntryPath(), threshold: RUNWAY_ENTRY, rollEnd: RUNWAY_END };
}
export function getTaxiRoutePoints(stand: string, _runway: string): MapPoint[] { return taxiRoutes(stand)[0].points; }
export function getArrivalRoutePoints(stand: string, branch: 'P4' | 'P5' = 'P4') {
  const { exit, path } = arrivalExitPaths(branch);
  const taxiPath = taxiRoutes(stand, 'P5')[0].points;
  const join = taxiPath.findIndex(point => point.x === 580 && point.y === 559);
  const crossingExit = { x: 440, y: 473 };
  const toStand = join >= 0
    ? [crossingExit, { x: 440, y: 488 },
      ...curve({ x: 440, y: 488 }, { x: 450, y: 505 }, { x: 490, y: 533 }, { x: 520, y: 546 }).slice(1),
      ...curve({ x: 520, y: 546 }, { x: 540, y: 558 }, { x: 553, y: 559 }, { x: 580, y: 559 }).slice(1),
      ...taxiPath.slice(join + 1)]
    : [...curve(crossingExit, { x: 440, y: 487 }, { x: 451, y: 495 }, { x: 475, y: 495 }), ...taxiPath.slice(1)];
  return {
    approach: [{ x: 1860, y: 227 }, { x: 1610, y: 227 }],
    landing: [{ x: 1610, y: 227 }, exit],
    toHold: path,
    fromHold: [P5_HOLD, { x: 440, y: 411 }, crossingExit, ...toStand.slice(1)],
  };
}
export function getNearestReturnStand(originalStand: string, unavailable: Set<string>, category: WakeCategory, from: MapPoint = HOLD_S1): string {
  const international = Number(originalStand) >= 1 && Number(originalStand) <= 16;
  const candidates = international ? [...INTERNATIONAL_BAYS] : category === 'H'
    ? Array.from({ length: 12 }, (_, index) => String(index + 23)) : [...DOMESTIC_BAYS];
  candidates.sort((a, b) => {
    const pa = getStandPoint(a), pb = getStandPoint(b);
    return Math.hypot(pa.x - from.x, pa.y - from.y) - Math.hypot(pb.x - from.x, pb.y - from.y);
  });
  return candidates.find((stand) => !unavailable.has(stand)) ?? candidates[0];
}
export function getTaxiRouteDescription(_runway: string, stand: string): string {
  return `Stand ${stand} → đường lăn sân đỗ → TWY V/S → S1 → RWY 25L`;
}
