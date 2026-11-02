import { describe, expect, it, vi } from 'vitest';
import * as surfaceGraph from '../map/surfaceGraph';
import { planSurfaceTraffic, surfacePosition } from './surfaceTraffic';
import { runSimulation } from './runSimulation';
import { applyWeatherPeriods, weatherDclEvents, weatherStatus } from './weather';
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
  it('preserves future departures and their clocks after the 12:50 to 14:28:23 shower', async () => {
    const bytes = readFileSync('public/samples/chuyen-de.xlsx');
    const file = new File([bytes], 'Chuyên đề.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
    const workbook = await readFlightFile(file);
    const baseline = computePlan({ type: 'day', rows: workbook.enrichedRows.filter(isDepartureFromTsn),
      arrivals: workbook.enrichedRows.filter(isArrivalAtTsn), runway: '25L-25R' });
    const start = new Date('2026-10-01T12:50:00').getTime();
    const end = new Date('2026-10-01T14:28:23').getTime();
    const plan = applyWeatherPeriods(baseline.flights, baseline.arrivals, [{ start, end }], '25L-25R');
    for (const callsign of ['SIA183', 'VJC254', 'MAS759', 'SPQ864']) {
      const flight = plan.flights.find(f => f.callsign === callsign)!;
      const original = baseline.flights.find(f => f.id === flight.id)!;
      expect(Number.isFinite(flight.wheelsOff), callsign).toBe(true);
      expect(flight.reissuedTsat, callsign).toBeNull();
      expect(flight.ctot, callsign).toBe(original.ctot);
      expect(departureTsatAt(flight, end), callsign).toBe(original.tsat);
      expect(flight.wheelsOff, callsign).toBeLessThanOrEqual(flight.ctot + 10 * 60_000 + 1);
      const startAt = flight.secondTaxiStart ?? flight.taxiStart;
      const before = departurePosition(flight, startAt - 1, 0, '25L-25R').point;
      const after = departurePosition(flight, startAt + 1, 0, '25L-25R').point;
      expect(Math.hypot(before.x - after.x, before.y - after.y), callsign).toBeLessThan(1);
    }
    for (const flight of plan.flights) {
      if (flight.weather?.offApron) expect(flight.wheelsOff).toBe(Infinity);
      if (flight.tsat > end && flight.weather?.blockedAt !== undefined) {
        expect(weatherStatus(flight, end + 12 * 60 * 60_000)?.tsat, flight.callsign).toBe(flight.tsat);
      }
    }
    for (let time = end; time < end + 9 * 60 * 60_000; time += 10_000) {
      const active = plan.flights.filter(f => !f.weather?.offApron && time >= f.tsat - 20 * 60_000 && time < f.wheelsOff);
      for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
        const pa = departurePosition(active[a], time, 0, '25L-25R').point;
        const pb = departurePosition(active[b], time, 0, '25L-25R').point;
        expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeGreaterThanOrEqual(
          (active[a].wakeCategory === 'H' ? 15 : 9) + (active[b].wakeCategory === 'H' ? 15 : 9) - .01);
      }
    }
  }, 60_000);

  it('releases a returned aircraft with revised TSAT when its original CTOT remains feasible', async () => {
    const bytes = readFileSync('public/samples/chuyen-de.xlsx');
    const file = new File([bytes], 'Chuyên đề.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
    const workbook = await readFlightFile(file);
    const baseline = computePlan({ type: 'day', rows: workbook.enrichedRows.filter(isDepartureFromTsn),
      arrivals: workbook.enrichedRows.filter(isArrivalAtTsn), runway: '25L-25R' });
    const start = new Date('2026-10-01T13:27:30').getTime();
    const end = new Date('2026-10-01T13:30:00').getTime();
    const plan = applyWeatherPeriods(baseline.flights, baseline.arrivals, [{ start, end }], '25L-25R');
    const target = plan.flights.find(f => f.callsign === 'VJC142')!;
    expect(target.returnStand).toBeTruthy();
    expect(target.reissuedTsat).toBe(end);
    expect(target.reissuedCtot).toBeNull();
    expect(target.ctot).toBe(baseline.flights.find(f => f.id === target.id)!.ctot);
    expect(Number.isFinite(target.wheelsOff)).toBe(true);
    expect(target.secondTaxiStart).toBeGreaterThanOrEqual(target.returnEnd!);
    expect(target.wheelsOff).toBeLessThanOrEqual(target.ctot + 10 * 60_000 + 1);
    expect(departureTsatAt(target, end)).toBe(end);
    expect(weatherDclEvents(plan.flights, [{ start, end }]).some(event =>
      event.flightId === target.id && event.message.includes('TSAT REVISED'))).toBe(true);
    const returnMiddle = start + 20_000;
    const repeated = applyWeatherPeriods(baseline.flights, baseline.arrivals,
      [{ start, end: start + 10_000 }, { start: returnMiddle, end }], '25L-25R');
    const again = repeated.flights.find(f => f.id === target.id)!;
    expect(again.returnStand).toBeTruthy();
    expect(again.reissuedTsat).toBe(end);
    expect(Number.isFinite(again.wheelsOff)).toBe(true);
    expect(again.secondTaxiStart).toBeGreaterThanOrEqual(again.returnEnd!);
    const before = departurePosition(repeated.flights.find(f => f.id === target.id)!, returnMiddle - 1, 0, '25L-25R').point;
    const at = departurePosition(again, returnMiddle, 0, '25L-25R').point;
    expect(Math.hypot(before.x - at.x, before.y - at.y)).toBeLessThan(1);
    const rainAgain = target.secondTaxiStart! + 30_000;
    const afterRestart = applyWeatherPeriods(baseline.flights, baseline.arrivals,
      [{ start, end }, { start: rainAgain, end: rainAgain + 30_000 }], '25L-25R');
    const nextReturn = afterRestart.flights.find(f => f.id === target.id)!;
    expect(nextReturn.weather!.groundStand).toBe(target.returnStand);
    const priorPoint = departurePosition(target, rainAgain, 0, '25L-25R').point;
    const nextPoint = departurePosition(nextReturn, rainAgain, 0, '25L-25R').point;
    expect(Math.hypot(priorPoint.x - nextPoint.x, priorPoint.y - nextPoint.y)).toBeLessThan(1);
  }, 60_000);

  it.each([false, true])('isolates the reported route conflict without stopping the day (alternatives blocked: %s)', async (noAlternatives) => {
    const bytes = readFileSync('public/samples/chuyen-de.xlsx');
    const file = new File([bytes], 'Chuyên đề.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
    const workbook = await readFlightFile(file);
    const baseline = computePlan({ type: 'day', rows: workbook.enrichedRows.filter(isDepartureFromTsn),
      arrivals: workbook.enrichedRows.filter(isArrivalAtTsn), runway: '25L-25R' });
    const start = 1790836159674, end = 1790836249199;
    if (noAlternatives) baseline.flights = baseline.flights.map(f => f.callsign === 'VAG678' ? { ...f, ctot: start - 10 * 60_000 } : f);
    const originalRoutes = surfaceGraph.taxiRoutes;
    const routes = noAlternatives ? vi.spyOn(surfaceGraph, 'taxiRoutes').mockImplementation((stand, from) =>
      stand === '99' && (from === undefined || from === 'stand')
        ? originalRoutes(stand, from).slice(0, 1) : originalRoutes(stand, from)) : undefined;
    let plan: ReturnType<typeof applyWeatherPeriods>;
    try { plan = applyWeatherPeriods(baseline.flights, baseline.arrivals, [{ start, end }], '25L-25R'); }
    finally { routes?.mockRestore(); }
    expect(plan.flights).toHaveLength(70);
    const target = plan.flights.find(f => f.callsign === 'VFC8063')!;
    expect(Number.isFinite(target.wheelsOff)).toBe(!noAlternatives);
    expect(plan.flights.filter(f => Number.isFinite(f.wheelsOff)).length).toBeGreaterThan(50);
    expect(target.ctot).toBe(baseline.flights.find(f => f.id === target.id)!.ctot);
    expect(departureTsatAt(target, end)).toBe(target.tsat);
    expect(target.reissuedCtot).toBeNull();
    for (let time = start; time < end + 30 * 60_000; time += 2000) {
      const active = plan.flights.filter(f => !f.weather?.offApron && time >= f.tsat - 20 * 60_000 && time < f.wheelsOff);
      for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
        const pa = departurePosition(active[a], time, 0, '25L-25R').point;
        const pb = departurePosition(active[b], time, 0, '25L-25R').point;
        expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeGreaterThanOrEqual(
          (active[a].wakeCategory === 'H' ? 15 : 9) + (active[b].wakeCategory === 'H' ? 15 : 9) - .01);
      }
    }
  }, 60_000);

  it('keeps revised TSAT at weather recovery while safely separating calibrated departures', () => {
    const minute = 60_000;
    const scheduled = [71, 75, 80].map((stand, index) => ({ id: `RESUME${index}`, callsign: `RESUME${index}`, aircraftType: 'A321',
      wakeCategory: 'M' as const, stand: String(stand), readyAt: (790 + index * 2) * minute,
      ctot: (810 + index * 2) * minute, taxiMinutes: 8, row: {} }));
    const baseline = planSurfaceTraffic(runSimulation(scheduled).flights, [], '25L-25R').flights;
    const start = Math.min(...baseline.map(flight => flight.taxiStart)) - minute;
    const end = Math.max(...baseline.map(flight => flight.taxiStart)) + minute;
    const recovered = applyWeatherPeriods(baseline, [], [{ start, end }], '25L-25R').flights;
    for (const flight of recovered) {
      expect(flight.weather?.heldAtStand).toBe(true);
      expect(flight.weather?.blockedAt).toBeUndefined();
      expect(Number.isFinite(flight.wheelsOff)).toBe(true);
      expect(flight.reissuedTsat).toBe(end);
      expect(departureTsatAt(flight, end)).toBe(end);
      expect(flight.reissuedCtot).toBeNull();
      expect(flight.ctot).toBe(baseline.find(original => original.id === flight.id)!.ctot);
    }
    expect(new Set(recovered.map(flight => flight.secondTaxiStart)).size).toBe(3);
    for (let time = end; time < Math.max(...recovered.map(flight => flight.wheelsOff)); time += 2000) {
      const active = recovered.filter(flight => time < flight.wheelsOff);
      for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
        const pa = departurePosition(active[a], time, 0, '25L-25R').point;
        const pb = departurePosition(active[b], time, 0, '25L-25R').point;
        expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeGreaterThanOrEqual(18 - .01);
      }
    }
  });

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
      if (Number.isFinite(returned.wheelsOff)) {
        expect(returned.wheelsOff, callsign).toBeLessThanOrEqual(returned.ctot + 10 * 60_000 + 1);
        expect(returned.reissuedTsat, callsign).toBe(start + 44_000);
      }
      const returnEnd = returned.returnEnd!;
      let prior = departurePosition(returned, start, 0, '25L-25R').point;
      for (let time = start + 2000; time < returnEnd + 4000; time += 2000) {
        const point = departurePosition(returned, time, 0, '25L-25R').point;
        expect(Math.hypot(point.x - prior.x, point.y - prior.y), `${callsign} continuity`).toBeLessThan(20);
        prior = point;
      }
      if (callsign === 'GENERIC-RETURN' && !Number.isFinite(returned.wheelsOff)) {
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
          if (time <= returnEnd || time >= (returned.secondTaxiStart ?? Infinity) || time < other.tsat - 20 * 60_000 || time >= other.wheelsOff) continue;
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
