import { describe, expect, it } from 'vitest';
import { planSurfaceTraffic, surfacePosition } from './surfaceTraffic';
import { runSimulation } from './runSimulation';
import { applyWeatherPeriods } from './weather';
import { departurePosition, arrivalPosition } from '../map/playback';
import { reserveWeatherMovements } from './weatherSurface';
import { departureCtotAt, departureTsatAt } from './departureTiming';
import { readFileSync } from 'node:fs';
import { readFlightFile } from '../data/workbook';
import { isDepartureFromTsn, isArrivalAtTsn } from '../data/enrichFlights';
import { toScheduledFlights } from './runSimulation';
import { scheduleArrivals } from './arrivals';

describe('weather route reservations', () => {
  it('finishes taxiing to S1 during open rain after passing the lamp', () => {
    const baseline = planSurfaceTraffic(runSimulation([{ id: 'PASSED', callsign: 'PASSED', aircraftType: 'A321',
      wakeCategory: 'M', stand: '71', readyAt: 790 * 60_000, ctot: 810 * 60_000, taxiMinutes: 8, row: {} }]).flights, [], '25L-25R').flights;
    const start = baseline[0].runwayEntryStart - 4000;
    const flight = applyWeatherPeriods(baseline, [], [{ start, end: null }], '25L-25R').flights[0];
    expect(flight.weather!.passedWeatherPoint).toBe(true);
    const initial = departurePosition(flight, start, 0, '25L-25R').point;
    const final = departurePosition(flight, start + 60_000, 0, '25L-25R').point;
    expect(Math.hypot(initial.x - final.x, initial.y - final.y)).toBeGreaterThan(1);
    expect(final).toEqual(baseline[0].surfacePlan!.legs.find(leg => leg.phase === 'vào đường băng 25L')!.points[0]);
    expect(flight.wheelsOff).toBe(Infinity);
  });
  it('recovers the calibrated mixed workbook after a mid-day shower', async () => {
    const bytes = readFileSync('public/samples/21102026.xlsx');
    const file = new File([bytes], '21102026.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
    const workbook = await readFlightFile(file);
    const departures = runSimulation(toScheduledFlights(workbook.enrichedRows.filter(isDepartureFromTsn)), true).flights;
    const physical = planSurfaceTraffic(departures, scheduleArrivals(workbook.enrichedRows.filter(isArrivalAtTsn), departures), '25L-25R');
    const start = physical.flights[Math.floor(physical.flights.length / 2)].taxiStart + 60_000;
    const open = applyWeatherPeriods(physical.flights, physical.arrivals, [{ start, end: null }], '25L-25R');
    expect(open.flights.length).toBe(physical.flights.length);
    const plan = applyWeatherPeriods(physical.flights, physical.arrivals, [{ start, end: start + 40 * 60_000 }], '25L-25R');
    expect(plan.flights.every(flight => Number.isFinite(flight.wheelsOff))).toBe(true);
    expect(plan.flights.some(flight => flight.weather?.surfacePlan)).toBe(true);
    const end = Math.max(...plan.flights.map(flight => flight.wheelsOff));
    for (let time = start; time < end; time += 2000) {
      const points = [
        ...plan.flights.filter(flight => time >= flight.tsat - 20 * 60_000 && time < flight.wheelsOff)
          .map(flight => ({ id: flight.id, radius: flight.wakeCategory === 'H' ? 15 : 9, point: departurePosition(flight, time, 0, '25L-25R').point })),
        ...plan.arrivals.filter(flight => flight.divertedAt === undefined
          && time >= (flight.weather?.surfacePlan?.visibleFrom ?? flight.approachStart)
          && time < (flight.weather?.surfacePlan?.visibleUntil ?? flight.surfacePlan?.visibleUntil ?? flight.standArrival + 45 * 60_000))
          .map(flight => ({ id: flight.id, radius: flight.wakeCategory === 'H' ? 15 : 9, point: arrivalPosition(flight, time).point })),
      ];
      for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++) {
        expect(Math.hypot(points[a].point.x - points[b].point.x, points[a].point.y - points[b].point.y), `${points[a].id}/${points[b].id} at ${time}`)
          .toBeGreaterThanOrEqual(points[a].radius + points[b].radius - .01);
      }
    }
  }, 30_000);
  it('delays a conflicting crossing rather than letting two aircraft intersect', () => {
    const result = reserveWeatherMovements([
      { id: 'A', radius: 9, start: 0, end: 20_000, minimumDelay: 0, releaseDelay: d => d,
        legs: [{ start: 0, end: 20_000, points: [{ x: 0, y: 50 }, { x: 100, y: 50 }], phase: 'lăn' }] },
      { id: 'B', radius: 9, start: 0, end: 20_000, minimumDelay: 0, releaseDelay: d => d,
        legs: [{ start: 0, end: 20_000, points: [{ x: 50, y: 0 }, { x: 50, y: 100 }], phase: 'lăn' }] },
    ]);
    expect(result.get('B')!.delay).toBeGreaterThan(0);
    for (let time = 0; time < 20_000; time += 500) {
      const a = surfacePosition(result.get('A')!.plan, time).point;
      const b = surfacePosition(result.get('B')!.plan, time).point;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(18);
    }
  });

  it('preserves issued clocks for returned aircraft and reserves recovered trajectories', () => {
    const minute = 60_000;
    const scheduled = [71, 75, 80].map((stand, index) => ({ id: `D${index}`, callsign: `D${index}`, aircraftType: 'A321',
      wakeCategory: 'M' as const, stand: String(stand), readyAt: (790 + index * 8) * minute,
      ctot: (810 + index * 8) * minute, taxiMinutes: 8, row: {} }));
    const baseline = planSurfaceTraffic(runSimulation(scheduled).flights, [], '25L-25R').flights;
    const start = baseline[0].taxiStart + minute, end = start + 35 * minute;
    const recovered = applyWeatherPeriods(baseline, [], [{ start, end }], '25L-25R').flights;
    const returned = recovered.filter(flight => flight.weather?.returnStand);
    expect(returned.length).toBeGreaterThan(0);
    for (const flight of returned) {
      expect(departureCtotAt(flight, flight.wheelsOff)).toBe(flight.ctot);
      expect(departureTsatAt(flight, flight.wheelsOff)).toBe(flight.tsat);
      expect(flight.reissuedCtot).toBeNull();
      expect(flight.reissuedTsat).toBeNull();
    }
    for (let time = start; time < Math.max(...recovered.map(flight => flight.wheelsOff)); time += 2000) {
      const active = recovered.filter(flight => time >= flight.tsat - 20 * minute && time < flight.wheelsOff);
      for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
        const pa = departurePosition(active[a], time, 0, '25L-25R').point;
        const pb = departurePosition(active[b], time, 0, '25L-25R').point;
        expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeGreaterThanOrEqual(18);
      }
    }
  });
});
