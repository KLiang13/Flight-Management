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
import { computePlan } from './planning';

describe('weather route reservations', () => {
  it('keeps return playback chronological when permanent parking is reserved before a delayed return', () => {
    const movements = [
      { id: 'RETURN', radius: 9, priority: -1, start: 10000, end: Infinity, minimumDelay: 0, releaseDelay: (d: number) => d,
        legs: [{ start: 10000, end: Infinity, points: [{ x: 100, y: 0 }], phase: 'parked' }] },
      { id: 'RETURN', radius: 9, returning: true, priority: .25, start: 0, end: 10000, minimumDelay: 2000, releaseDelay: (d: number) => d,
        legs: [{ start: 0, end: 10000, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], phase: 'returning' }] },
    ];
    const result = reserveWeatherMovements(movements).get('RETURN')!;
    expect(result.delay).toBe(0);
    expect(result.returnDelay).toBe(2000);
    expect(result.plan.visibleFrom).toBe(0);
    expect(result.plan.visibleUntil).toBe(Infinity);
    expect(surfacePosition(result.plan, 0).point.x).toBe(0);
    expect(surfacePosition(result.plan, 6000).point.x).toBeCloseTo(40);
    expect(surfacePosition(result.plan, 11000).point.x).toBeCloseTo(90);
    expect(surfacePosition(result.plan, 12000).point.x).toBe(100);
  });
  it('reserves a returned stand before future flights, independent of callsign', async () => {
    const bytes = readFileSync('public/samples/chuyen-de.xlsx');
    const file = new File([bytes], 'Chuyên đề.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
    const workbook = await readFlightFile(file);
    const baseline = computePlan({ type: 'day', rows: workbook.enrichedRows.filter(isDepartureFromTsn), arrivals: workbook.enrichedRows.filter(isArrivalAtTsn), runway: '25L-25R' });
    const flights = baseline.flights.map(flight => flight.callsign === 'VJC142' ? { ...flight, id: 'GENERIC-RETURN', callsign: 'GENERIC-RETURN' } : flight);
    const day = new Date('2026-10-01T00:00:00').getTime();
    for (const callsign of ['GENERIC-RETURN', 'VAG678', 'VJC842', 'VFC8063']) {
      const target = flights.find(flight => flight.callsign === callsign)!;
      const start = callsign === 'GENERIC-RETURN' ? day + 807.5 * 60_000 : target.taxiStart + 30_000;
      const plan = applyWeatherPeriods(flights, baseline.arrivals, [{ start, end: start + 44_000 }], '25L-25R');
      expect(plan.flights).toHaveLength(flights.length);
      const returned = plan.flights.find(flight => flight.id === target.id)!;
      expect(returned.weather?.returnStand, callsign).toBeTruthy();
      expect(returned.wheelsOff, callsign).toBe(Infinity);
      const returnEnd = returned.returnEnd!;
      let prior = departurePosition(returned, start, 0, '25L-25R').point;
      for (let time = start + 2000; time < returnEnd + 4000; time += 2000) {
        const point = departurePosition(returned, time, 0, '25L-25R').point;
        expect(Math.hypot(point.x - prior.x, point.y - prior.y), `${callsign} continuity`).toBeLessThan(20);
        prior = point;
      }
      if (callsign === 'GENERIC-RETURN') {
        const secondStart = returnEnd + 60_000;
        const again = applyWeatherPeriods(flights, baseline.arrivals,
          [{ start, end: start + 44_000 }, { start: secondStart, end: secondStart + 44_000 }], '25L-25R');
        const held = again.flights.find(flight => flight.id === target.id)!;
        expect(held.returnStand).toBe(returned.returnStand);
        expect(held.wheelsOff).toBe(Infinity);
      }
      const parked = departurePosition(returned, returnEnd + 1, 0, '25L-25R').point;
      for (const other of plan.flights.filter(flight => flight.id !== returned.id && !flight.weather?.offApron)) {
        for (const time of [returnEnd + 1, other.tsat - 20 * 60_000 + 1, other.taxiStart - 1]) {
          if (time <= returnEnd || time < other.tsat - 20 * 60_000 || time >= other.wheelsOff) continue;
          const point = departurePosition(other, time, 0, '25L-25R').point;
          expect(Math.hypot(point.x - parked.x, point.y - parked.y), `${callsign}/${other.callsign}`)
            .toBeGreaterThanOrEqual((other.wakeCategory === 'H' ? 15 : 9) + (returned.wakeCategory === 'H' ? 15 : 9) - .01);
        }
      }
    }
  }, 60_000);
  it('does not suspend the six future departures after rain from 13:13 to 13:26', async () => {
    const bytes = readFileSync('public/samples/chuyen-de.xlsx');
    const file = new File([bytes], 'Chuyên đề.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
    const workbook = await readFlightFile(file);
    const physical = computePlan({ type: 'day', rows: workbook.enrichedRows.filter(isDepartureFromTsn), arrivals: workbook.enrichedRows.filter(isArrivalAtTsn), runway: '25L-25R' });
    const start = new Date('2026-10-01T13:13:00').getTime();
    const end = new Date('2026-10-01T13:26:00').getTime();
    const plan = applyWeatherPeriods(physical.flights, physical.arrivals, [{ start, end }], '25L-25R');
    for (const callsign of ['VJC362', 'CSN374', 'PIC6160', 'SPQ1985', 'MAS767', 'SIA183']) {
      const flight = plan.flights.find(item => item.callsign === callsign)!;
      expect(flight, callsign).toBeDefined();
      expect(flight.weather?.blockedAt, callsign).toBeUndefined();
      expect(Number.isFinite(flight.wheelsOff), callsign).toBe(true);
      expect(flight.wheelsOff, callsign).toBeLessThanOrEqual(flight.ctot + 10 * 60_000);
      expect(flight.reissuedCtot, callsign).toBeNull();
    }
  }, 30_000);
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
    const bytes = readFileSync('tests/fixtures/21102026.xlsx');
    const file = new File([bytes], '21102026.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
    const workbook = await readFlightFile(file);
    const physical = computePlan({ type: 'day', rows: workbook.enrichedRows.filter(isDepartureFromTsn), arrivals: workbook.enrichedRows.filter(isArrivalAtTsn), runway: '25L-25R' });
    const start = new Date('2026-10-01T14:00:00').getTime();
    const open = applyWeatherPeriods(physical.flights, physical.arrivals, [{ start, end: null }], '25L-25R');
    expect(open.flights.length).toBe(physical.flights.length);
    const plan = applyWeatherPeriods(physical.flights, physical.arrivals, [{ start, end: start + 40 * 60_000 }], '25L-25R');
    expect(plan.flights.every(flight => Number.isFinite(flight.wheelsOff) || flight.weather?.blockedAt !== undefined)).toBe(true);
    expect(plan.flights.some(flight => flight.weather?.surfacePlan)).toBe(true);
    const end = start + 4 * 60 * 60_000;
    for (let time = start; time < end; time += 2000) {
      const points = [
        ...plan.flights.filter(flight => !flight.weather?.offApron && time >= flight.tsat - 20 * 60_000 && time < flight.wheelsOff)
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
    for (let time = start; time < end + 60 * minute; time += 2000) {
      const active = recovered.filter(flight => !flight.weather?.offApron && time >= flight.tsat - 20 * minute && time < flight.wheelsOff);
      for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
        const pa = departurePosition(active[a], time, 0, '25L-25R').point;
        const pb = departurePosition(active[b], time, 0, '25L-25R').point;
        expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeGreaterThanOrEqual(18);
      }
    }
  });
});
