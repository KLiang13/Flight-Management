// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readFlightFile } from '../data/workbook';
import { isArrivalAtTsn, isDepartureFromTsn } from '../data/enrichFlights';
import { departurePosition, arrivalPosition } from '../map/playback';
import { getStandPoint, getRunwaySegment, getArrivalRoutePoints, MAP_VIEWBOX } from '../map/airfieldGeometry';
import { taxiRoutes, pathLength } from '../map/surfaceGraph';
import { runSimulation, toScheduledFlights } from './runSimulation';
import { planSurfaceTraffic } from './surfaceTraffic';
import { scheduleArrivals } from './arrivals';
import { arrivalThresholdClearAt } from './runwayCoordination';
import { TAKEOFF_ROLL_MS, TAKEOFF_METRES_PER_SECOND, RUNWAY_LENGTH_METRES, METRES_PER_PIXEL } from './movementPhysics';

describe('calibrated surface traffic', () => {
  it('uses native image coordinates and surveyed stands rather than a uniform grid', () => {
    expect(MAP_VIEWBOX).toBe('0 0 2048 1413');
    expect(getStandPoint('16')).toEqual({ x: 1424, y: 621 });
    expect(getStandPoint('83').x - getStandPoint('84').x).toBe(105);
    for (const stand of ['16', '26', '71', '72', '73', '91']) {
      for (const route of taxiRoutes(stand)) {
        expect(route.points[0]).toEqual(getStandPoint(stand));
        expect(route.points.at(-1)).toEqual({ x: 1973, y: 476 });
        expect(pathLength(route.points)).toBeGreaterThan(0);
      }
    }
  });

  it('computes acceleration and moves immediately beyond the runway after lift-off', () => {
    expect(TAKEOFF_ROLL_MS / 1000 * TAKEOFF_METRES_PER_SECOND / 2).toBeCloseTo(RUNWAY_LENGTH_METRES);
    const raw = runSimulation(toScheduledFlights([{ CallSign: 'TEST', Stand: '71', ScheduledDeparture: '2026-10-01T08:00:00Z', CTOT: '2026-10-01T08:10:00Z' }]));
    const flight = planSurfaceTraffic(raw.flights, [], '25L-25R').flights[0];
    const segment = getRunwaySegment('25L');
    const half = departurePosition(flight, flight.takeoffRollStart + TAKEOFF_ROLL_MS / 2, 0, '25L').point;
    expect(segment.threshold.x - half.x).toBeCloseTo((segment.threshold.x - segment.rollEnd.x) / 4, 2);
    const end = departurePosition(flight, flight.wheelsOff, 0, '25L').point;
    const airborne = departurePosition(flight, flight.wheelsOff + 1000, 0, '25L').point;
    expect(end.x).toBeCloseTo(segment.rollEnd.x, 2);
    expect((end.x - airborne.x) * METRES_PER_PIXEL).toBeCloseTo(TAKEOFF_METRES_PER_SECOND, 2);
    expect(airborne.y).toBeLessThan(end.y);
  });

  it('prefers P4 and keeps the P5 fallback connected to the same holding point', () => {
    const preferred = getArrivalRoutePoints('16', 'P4');
    const fallback = getArrivalRoutePoints('16', 'P5');
    expect(preferred.toHold.at(-1)).toEqual(fallback.toHold.at(-1));
    expect(preferred.toHold[0].x).toBe(735);
    expect(fallback.toHold[0].x).toBe(590);
    expect(preferred.toHold).not.toEqual(fallback.toHold);
  });

  it('completes the new dataset without overlapping rendered aircraft or runway crossings', async () => {
    const bytes = readFileSync('tests/fixtures/21102026.xlsx');
    const file = new File([bytes], '21102026.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
    const workbook = await readFlightFile(file);
    const raw = runSimulation(toScheduledFlights(workbook.enrichedRows.filter(isDepartureFromTsn)), true);
    const plan = planSurfaceTraffic(raw.flights, scheduleArrivals(workbook.enrichedRows.filter(isArrivalAtTsn), raw.flights), '25L-25R');
    expect(plan.flights).toHaveLength(70); expect(plan.arrivals).toHaveLength(30);
    expect(plan.flights.reduce((sum, flight) => sum + flight.waitMinutes, 0)).toBeLessThan(1500);
    for (const flight of plan.flights) {
      if (flight.weather?.offApron) continue;
      expect(flight.surfacePlan).toBeDefined();
      if (!Number.isFinite(flight.wheelsOff)) { expect(flight.reissuedCtot).toBeNull(); continue; }
      expect(flight.wheelsOff - flight.takeoffRollStart).toBeCloseTo(TAKEOFF_ROLL_MS, 2);
      if (flight.forceCtotMiss) {
        expect(flight.missedCtot).toBe(true);
        expect(flight.wheelsOff).toBeGreaterThan(flight.ctot + 600_000);
      }
      if (flight.returnStart !== null) {
        expect(flight.returnStart).toBeGreaterThan(flight.ctot + 600_000);
        expect(flight.secondTaxiStart).toBeGreaterThan(flight.returnEnd!);
      }
    }
    for (const arrival of plan.arrivals.filter(flight => flight.divertedAt === undefined)) for (const departure of plan.flights.filter(flight => Number.isFinite(flight.wheelsOff))) {
      expect(arrival.crossingEnd <= departure.runwayEntryStart || arrival.crossingStart >= departure.wheelsOff).toBe(true);
      expect(departure.runwayEntryStart < arrival.p5HoldAt || departure.runwayEntryStart >= arrival.crossingEnd).toBe(true);
      expect(departure.takeoffRollStart < arrival.approachStart || departure.takeoffRollStart >= arrivalThresholdClearAt(arrival)).toBe(true);
    }
    const all = [...plan.flights.filter(flight => !flight.weather?.offApron), ...plan.arrivals.filter(flight => flight.divertedAt === undefined)];
    const start = Math.min(...all.map((flight) => flight.surfacePlan!.visibleFrom));
    const end = start + 24 * 60 * 60_000;
    for (let time = start; time < end; time += 1000) {
      const active = all.filter((flight) => time >= flight.surfacePlan!.visibleFrom && time < flight.surfacePlan!.visibleUntil);
      const positions = active.map((flight) => ({ id: flight.id, ...('wheelsOff' in flight ? departurePosition(flight, time, 0, '25L') : arrivalPosition(flight, time)) }));
      for (let i = 0; i < positions.length; i += 1) for (let j = i + 1; j < positions.length; j += 1) {
        const a = positions[i], b = positions[j];
        expect(Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y), `${a.id}/${b.id} at ${new Date(time).toISOString()} ${JSON.stringify([a,b])}`).toBeGreaterThanOrEqual(17);
      }
    }
  }, 60_000);
});
