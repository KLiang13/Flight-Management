import { distanceAlongPathToPoint } from './surfaceGraph';
import { surfacePosition } from '../simulation/surfaceTraffic';
import type { ArrivalTimelineItem } from '../simulation/arrivals';
import { TAKEOFF_ROLL_MS, type TimelineItem } from '../simulation/runSimulation';

import { AIRBORNE_VISIBLE_MS, RUNWAY_ENTRY_MS, TAKEOFF_METRES_PER_SECOND, METRES_PER_PIXEL, takeoffDistanceProgress } from '../simulation/movementPhysics';
export const TAKEOFF_VISIBLE_AFTER_MS = AIRBORNE_VISIBLE_MS;
import { getArrivalRoutePoints, getHoldingPoint, getRunwaySegment, getStandPoint, getTaxiRoutePoints, pointAlongPath, type MapPoint } from './airfieldGeometry';

export type AircraftPosition = { point: MapPoint; phase: string; rotation: number };

function weatherHoldingPosition(flight: TimelineItem, queueIndex: number, runway: string): MapPoint {
  if (queueIndex <= 0) return getHoldingPoint(runway);
  const route = getTaxiRoutePoints(flight.weather?.returnStand ?? flight.stand, runway);
  const length = route.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(point.x - route[index].x, point.y - route[index].y), 0);
  return pointAlongPath(route, Math.max(0, 1 - queueIndex * 28 / Math.max(1, length)));
}

export function departurePosition(flight: TimelineItem, time: number, queueIndex: number, runway: string): AircraftPosition {
  const weather = flight.weather;
  if (weather) {
    if (time < weather.start) return departurePosition(weather.previous, time, queueIndex, runway);
    if (weather.previous.runwayEntryStart <= weather.start && !weather.returnStand && time < flight.takeoffRollStart) {
      const entryPath = getRunwaySegment(runway).entryPath;
      const previousPoint = departurePosition(weather.previous, weather.start, queueIndex, runway).point;
      const length = entryPath.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - entryPath[i].x, point.y - entryPath[i].y), 0);
      const entryElapsed = (distanceAlongPathToPoint(entryPath, previousPoint, 2) ?? 0) / length * RUNWAY_ENTRY_MS;
      const resumedElapsed = Math.max(0, time - Math.max(weather.revisionAt ?? Infinity, flight.runwayEntryStart));
      return { point: pointAlongPath(getRunwaySegment(runway).entryPath, Math.min(1, (entryElapsed + resumedElapsed) / RUNWAY_ENTRY_MS)),
        phase: 'chờ thời tiết hoặc huấn lệnh trên 25L', rotation: -90 };
    }

    const missed = weather.missedAt !== null && time >= weather.missedAt;
    if (missed && weather.returnStand) {
      if (weather.returnStart !== null && time < weather.returnStart) return {
        ...departurePosition(weather.previous, Math.min(time, weather.previous.runwayEntryStart - 1), queueIndex, runway),
        phase: 'không tuân thủ CTOT · chờ vị trí đỗ trống',
      };
      if (weather.returnEnd !== null && time < weather.returnEnd && weather.returnPath.length) return {
        point: pointAlongPath(weather.returnPath, (time - weather.returnStart!) / (weather.returnEnd - weather.returnStart!)),
        phase: 'không tuân thủ CTOT · quay về vị trí đỗ', rotation: 0,
      };
      if (time < weather.resumedTaxiStart) return {
        point: getStandPoint(weather.returnStand), phase: `chờ CTOT mới tại stand ${weather.returnStand}`, rotation: 0,
      };
    }
    if (missed && !weather.returnStand && time < flight.runwayEntryStart) return {
      ...departurePosition(weather.previous, Math.min(time, weather.previous.runwayEntryStart - 1), queueIndex, runway),
      ...(time >= weather.groundReadyAt ? { point: weatherHoldingPosition(flight, queueIndex, runway) } : {}),
      phase: 'chờ lượt vào 25L',
    };
    if (weather.heldAtStand && time < weather.resumedTaxiStart) return {
      point: getStandPoint(weather.groundStand),
      phase: missed ? `chờ TSAT/CTOT mới tại stand ${weather.groundStand}` : `chờ thời tiết tốt tại stand ${weather.groundStand}`, rotation: 0,
    };
    if ((weather.heldAtStand || missed) && time < weather.groundReadyAt) {
      const route = getTaxiRoutePoints(weather.returnStand ?? weather.groundStand, runway);
      return { point: pointAlongPath(route, (time - weather.resumedTaxiStart) / (weather.groundReadyAt - weather.resumedTaxiStart)),
        phase: weather.heldAtStand ? 'lăn theo TSAT mới' : 'lăn theo CTOT mới', rotation: 0 };
    }
    if (!weather.heldAtStand && !missed && time < weather.groundReadyAt) return departurePosition(weather.previous, Math.min(time, weather.previous.runwayEntryStart - 1), queueIndex, runway);
    if (time < flight.runwayEntryStart) return {
      ...departurePosition(weather.previous, Math.min(time, weather.previous.runwayEntryStart - 1), queueIndex, runway),
      ...(missed && !weather.returnStand ? { phase: 'không tuân thủ CTOT · chờ vị trí đỗ trống' } : { phase: 'chờ thời tiết hoặc slot mới tại S1' }),
      ...(time >= weather.groundReadyAt ? { point: weatherHoldingPosition(flight, queueIndex, runway) } : {}),
    };
    // Use the ordinary runway animation after the revised clearance.
    return departurePosition({ ...flight, weather: undefined, surfacePlan: undefined, returnStart: null, returnEnd: null,
      returnStand: null, secondTaxiStart: null, taxiStart: -Infinity }, time, queueIndex, runway);
  }
  if (flight.surfacePlan) {
    if (time < flight.takeoffRollStart) return surfacePosition(flight.surfacePlan, time);
    return departurePosition({ ...flight, surfacePlan: undefined, returnStart: null, returnEnd: null, returnStand: null, secondTaxiStart: null, taxiStart: -Infinity }, time, queueIndex, runway);
  }
  const stand = getStandPoint(flight.stand);
  const route = getTaxiRoutePoints(flight.stand, runway);
  const hold = getHoldingPoint(runway);
  const taxiEnd = flight.taxiStart + flight.taxiMinutes * 60_000;
  const runwaySegment = getRunwaySegment(runway);
  if (time < flight.taxiStart) return { point: stand, phase: `tại stand ${flight.stand}`, rotation: 0 };
  if (time < taxiEnd) return { point: pointAlongPath(route, (time - flight.taxiStart) / (taxiEnd - flight.taxiStart)), phase: 'đang lăn ra điểm chờ', rotation: 0 };
  if (flight.returnStart !== null && flight.returnEnd !== null && flight.secondTaxiStart !== null && flight.returnStand) {
    if (time < flight.returnStart) return { point: hold, phase: 'chờ tại S1', rotation: 0 };
    const returnRoute = [...getTaxiRoutePoints(flight.returnStand, runway)].reverse();
    if (time < flight.returnEnd) return { point: pointAlongPath(returnRoute, (time - flight.returnStart) / (flight.returnEnd - flight.returnStart)), phase: 'quay về vị trí đỗ', rotation: 0 };
    if (time < flight.secondTaxiStart) return { point: getStandPoint(flight.returnStand), phase: `chờ TSAT mới tại stand ${flight.returnStand}`, rotation: 0 };
    const secondTaxiEnd = flight.secondTaxiStart + flight.taxiMinutes * 60_000;
    if (time < secondTaxiEnd) return { point: pointAlongPath([...returnRoute].reverse(), (time - flight.secondTaxiStart) / (secondTaxiEnd - flight.secondTaxiStart)), phase: 'lăn ra lần hai', rotation: 0 };
  }
  if (time < flight.runwayEntryStart) return {
    point: queueIndex <= 0 ? hold : { x: hold.x - queueIndex * 25, y: hold.y }, phase: 'chờ tại S1', rotation: 0,
  };
  const entryEnd = flight.runwayEntryStart + RUNWAY_ENTRY_MS;
  if (time < entryEnd) return {
    point: pointAlongPath(runwaySegment.entryPath, (time - flight.runwayEntryStart) / RUNWAY_ENTRY_MS),
    phase: 'vào đường băng 25L', rotation: -90,
  };
  if (time < flight.takeoffRollStart) return {
    point: runwaySegment.threshold, phase: 'chờ tàu đến vượt 25R', rotation: -90,
  };
  if (time >= flight.wheelsOff) return { point: { x: runwaySegment.rollEnd.x - (time - flight.wheelsOff) / 1000 * TAKEOFF_METRES_PER_SECOND / METRES_PER_PIXEL, y: runwaySegment.rollEnd.y - (time - flight.wheelsOff) / 1000 * 4 }, phase: 'đã cất cánh 25L', rotation: -90 };
  return { point: pointAlongPath([runwaySegment.threshold, runwaySegment.rollEnd], takeoffDistanceProgress((time - flight.takeoffRollStart) / TAKEOFF_ROLL_MS)), phase: 'cất cánh 25L', rotation: -90 };
}

export function arrivalPosition(flight: ArrivalTimelineItem, time: number): AircraftPosition {
  const weather = flight.weather;
  if (weather && time < weather.start) return arrivalPosition(weather.previous, time);
  if (!weather && flight.surfacePlan && time >= flight.touchdown) return surfacePosition(flight.surfacePlan, time);
  const route = getArrivalRoutePoints(flight.stand, flight.exitBranch);
  if (weather && time < flight.approachStart) return {
    point: route.approach[0], phase: 'chờ tiếp cận do thời tiết xấu', rotation: -90,
  };
  if (time >= flight.standArrival) return { point: route.fromHold.at(-1)!, phase: `đang đỗ tại stand ${flight.stand}`, rotation: 0 };
  if (time < flight.touchdown) return {
    point: pointAlongPath(route.approach, (time - flight.approachStart) / (flight.touchdown - flight.approachStart)),
    phase: 'tiếp cận 25R', rotation: -90,
  };
  if (time < flight.landingEnd) return {
    point: pointAlongPath(route.landing, (time - flight.touchdown) / (flight.landingEnd - flight.touchdown)),
    phase: 'hạ cánh 25R', rotation: -90,
  };
  if (time < flight.p5HoldAt) return {
    point: pointAlongPath(route.toHold, (time - flight.landingEnd) / (flight.p5HoldAt - flight.landingEnd)),
    phase: `lăn theo ${flight.exitBranch ?? 'P4'} đến điểm chờ P5`, rotation: 0,
  };
  if (time < flight.crossingStart) return { point: route.toHold.at(-1)!, phase: 'dừng trước 25L tại P5', rotation: 0 };
  if (time < flight.crossingEnd) return {
    point: pointAlongPath(route.fromHold.slice(0, 3), (time - flight.crossingStart) / (flight.crossingEnd - flight.crossingStart)),
    phase: 'cắt qua 25L', rotation: 0,
  };
  return {
    point: pointAlongPath(route.fromHold.slice(2), (time - flight.crossingEnd) / (flight.standArrival - flight.crossingEnd)),
    phase: `lăn vào stand ${flight.stand}`, rotation: 0,
  };
}
