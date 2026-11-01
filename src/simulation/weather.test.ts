import { describe, expect, it } from 'vitest';
import { runSimulation, type ScheduledFlight } from './runSimulation';
import { arrivalPosition, departurePosition } from '../map/playback';
import { getArrivalRoutePoints } from '../map/airfieldGeometry';
import { applyWeatherPeriods, weatherStatus, weatherDclEvents } from './weather';
import { formatDclMessage } from '../dcl/dclScenario';
import { scheduleArrivals } from './arrivals';
import { readFileSync } from 'node:fs';
import { readFlightFile } from '../data/workbook';
import { isArrivalAtTsn, isDepartureFromTsn, toDayString } from '../data/enrichFlights';
import { toScheduledFlights } from './runSimulation';

const minute = 60_000;
const flight = (id: string, ready: number, ctot: number): ScheduledFlight => ({
  id, callsign: id, aircraftType: 'A321', wakeCategory: 'M', stand: '73',
  readyAt: ready * minute, ctot: ctot * minute, taxiMinutes: 8, row: {},
});

describe('manual adverse weather', () => {
  it('releases the rendered arrival when its crossing is rescheduled instead of replaying the old hold', () => {
    const arrival = scheduleArrivals([{ CallSign: 'ARR', PlaneTypeCode: 'A321', Stand: '75',
      ScheduledArrival: new Date(10 * minute).toISOString() }], [])[0];
    const route = getArrivalRoutePoints(arrival.stand, arrival.exitBranch);
    const crossingStart = arrival.p5HoldAt + 30 * minute;
    const previous = { ...arrival, crossingStart, crossingEnd: crossingStart + 45_000,
      standArrival: crossingStart + 5 * minute,
      surfacePlan: { visibleFrom: arrival.approachStart, visibleUntil: crossingStart + 50 * minute, route: 'P4',
        legs: [{ start: arrival.p5HoldAt, end: crossingStart, points: [route.toHold.at(-1)!], phase: 'dừng trước 25L tại P5' }] } };
    for (const start of [arrival.touchdown + 1000, arrival.p5HoldAt + 5 * minute]) {
      const next = applyWeatherPeriods([], [previous], [{ start, end: start + minute }], '25L-25R').arrivals[0];
      expect(next.crossingStart).toBe(Math.max(arrival.p5HoldAt, start));
      expect(arrivalPosition(next, next.crossingStart + 1000).phase).toBe('cắt qua 25L');
      expect(arrivalPosition(next, start - 1)).toEqual(arrivalPosition(previous, start - 1));
      if (start > arrival.p5HoldAt) expect(arrivalPosition(next, start).point).toEqual(arrivalPosition(previous, start - 1).point);
    }
  });

  it('blocks new departures indefinitely while the clock can pass CTOT', () => {
    const base = runSimulation([flight('ONE', 10, 20)]).flights;
    const result = applyWeatherPeriods(base, [], [{ start: 11 * minute, end: null }], '25L-25R');
    const delayed = result.flights[0];
    expect(delayed.wheelsOff).toBe(Infinity);
    expect(weatherStatus(delayed, 30 * minute)?.missed).toBe(true);
    expect(weatherStatus(delayed, 31 * minute)?.missed).toBe(true);
    expect(delayed.reissuedCtot).toBeNull();
    expect(delayed.weather!.returnStart).toBe(11 * minute);
    expect(departurePosition(delayed, 50 * minute, 0, '25L-25R').phase).toContain('stand');
  });

  it('returns before point X and recovers without changing the started aircraft clocks', () => {
    const original = runSimulation([flight('ONE', 10, 20)]).flights[0];
    const base = [{ ...original, taxiMinutes: 40, runwayEntryStart: 50 * minute, takeoffRollStart: 50.3 * minute, wheelsOff: 52 * minute }];
    const rain = applyWeatherPeriods(base, [], [{ start: 11 * minute, end: null }], '25L-25R').flights[0];
    const returning = rain.weather!;
    const before = departurePosition(rain, returning.returnStart! - 1, 0, '25L-25R').point;
    const after = departurePosition(rain, returning.returnStart!, 0, '25L-25R').point;
    expect(Math.hypot(before.x - after.x, before.y - after.y)).toBeLessThan(0.01);
    const recovered = applyWeatherPeriods(base, [], [{ start: 11 * minute, end: 50 * minute }], '25L-25R').flights[0];
    expect(recovered.reissuedTsat).toBeNull();
    expect(recovered.reissuedCtot).toBeNull();
    const events = weatherDclEvents([recovered], [{ start: 11 * minute, end: 50 * minute }]);
    expect(events.every((event) => formatDclMessage(event.message).length > 1)).toBe(true);
    expect(events.some((event) => event.message.includes('CTOT REVISED'))).toBe(false);
    expect(events.some((event) => event.message.includes('TSAT REVISED'))).toBe(false);
    expect(events.filter(event => event.message.includes('CTOT EXPIRED')).every(event => formatDclMessage(event.message).length === 2)).toBe(true);
    expect(recovered.runwayEntryStart).toBeGreaterThan(recovered.weather!.returnEnd!);
    expect(departurePosition(recovered, 200 * minute, 0, '25L-25R').phase).toContain('stand');
  });

  it('keeps aircraft that have not started at their stand and preserves committed departures', () => {
    const base = runSimulation([flight('ONE', 10, 20), flight('TWO', 40, 50)]).flights;
    const result = applyWeatherPeriods(base, [], [{ start: 19 * minute, end: 70 * minute }], '25L-25R');
    expect(result.flights[0]).toBe(base[0]);
    const waiting = result.flights[1];
    expect(waiting.weather!.heldAtStand).toBe(true);
    expect(waiting.weather!.groundStand).toBe('73');
    expect(waiting.weather!.returnStand).toBeNull();
    expect(waiting.weather!.missedAt).toBeNull();
    expect(departurePosition(waiting, 65 * minute, 0, '25L-25R').phase).toContain('stand 73');
    expect(waiting.secondTaxiStart).toBeGreaterThanOrEqual(70 * minute);
  });

  it('prioritizes an available valid slot before an expired aircraft after recovery', () => {
    const base = runSimulation([flight('EXPIRED', 10, 20), flight('VALID', 20, 50)]).flights;
    const start = base.find(item => item.id === 'EXPIRED')!.runwayEntryStart - 1;
    const result = applyWeatherPeriods(base, [], [{ start, end: 35 * minute }], '25L-25R');
    const valid = result.flights.find((item) => item.id === 'VALID')!;
    const expired = result.flights.find((item) => item.id === 'EXPIRED')!;
    expect(valid.weather?.missedAt).toBeNull();
    expect(valid.wheelsOff).toBe(Infinity);
    expect(expired.weather!.returnStand).toBeNull();
    expect(expired.wheelsOff).toBe(Infinity);
  });

  it('retains Medium aircraft needed between Heavy departures after rain', () => {
    const heavy = (id: string, ready: number, ctot: number): ScheduledFlight => ({
      ...flight(id, ready, ctot), aircraftType: 'B777', wakeCategory: 'H', stand: '23',
    });
    const base = runSimulation([heavy('H1', 10, 100), flight('M1', 12, 102), heavy('H2', 14, 104)]).flights;
    const result = applyWeatherPeriods(base, [], [{ start: 11 * minute, end: 50 * minute }], '25L-25R');
    expect(result.flights.filter(item => Number.isFinite(item.wheelsOff)).map(item => item.wakeCategory)).toEqual(['M', 'H']);
    expect(result.flights.find(item => item.id === 'H1')!.wheelsOff).toBe(Infinity);
  });

  it('preserves past positions across repeated weather toggles', () => {
    const base = runSimulation([flight('ONE', 10, 20)]).flights;
    const first = [{ start: 11 * minute, end: 50 * minute }];
    const initial = applyWeatherPeriods(base, [], first, '25L-25R').flights[0];
    const repeated = applyWeatherPeriods(base, [], [...first, { start: 50.1 * minute, end: 80 * minute }], '25L-25R').flights[0];
    expect(departurePosition(repeated, 35 * minute, 0, '25L-25R')).toEqual(departurePosition(initial, 35 * minute, 0, '25L-25R'));
    expect(repeated.wheelsOff).toBe(initial.wheelsOff);
  });

  it('does not rewrite earlier issued slots when a later brief shower has no impact', () => {
    const base = runSimulation([flight('ONE', 10, 20), flight('TWO', 12, 22)]).flights;
    const first = [{ start: 11 * minute, end: 50 * minute }];
    const initial = applyWeatherPeriods(base, [], first, '25L-25R');
    const lateStart = Math.max(...initial.flights.map(item => item.wheelsOff)) + minute;
    const repeated = applyWeatherPeriods(base, [], [...first, { start: lateStart, end: lateStart + .5 * minute }], '25L-25R');
    for (const item of initial.flights) {
      const after = repeated.flights.find((candidate) => candidate.id === item.id)!;
      expect(after.reissuedCtot).toBe(item.reissuedCtot);
      expect(after.reissuedTsat).toBe(item.reissuedTsat);
    }
  });

  it('diverts airborne arrivals and does not bring them back after recovery', () => {
    const base = runSimulation([flight('ONE', 10, 20)]).flights;
    const arrivals = scheduleArrivals([{
      CallSign: 'ARR', PlaneTypeCode: 'A321', Stand: '16', ScheduledArrival: new Date(25 * minute).toISOString(),
    }], base);
    const blocked = applyWeatherPeriods(base, arrivals, [{ start: 11 * minute, end: null }], '25L-25R');
    expect(blocked.arrivals[0].divertedAt).toBeDefined();
    const recovered = applyWeatherPeriods(base, arrivals, [{ start: 11 * minute, end: 50 * minute }], '25L-25R');
    expect(recovered.arrivals[0].divertedAt).toBe(blocked.arrivals[0].divertedAt);
    expect(recovered.arrivals[0].touchdown).toBe(arrivals[0].touchdown);
    const noArrivals = applyWeatherPeriods(base, [], [{ start: 11 * minute, end: 50 * minute }], '25L-25R');
    expect(recovered.flights.map(item => item.wheelsOff)).toEqual(noArrivals.flights.map(item => item.wheelsOff));
  });

  it('keeps arrivals already on the ground and accepts approaches after recovery', () => {
    const base = runSimulation([flight('ONE', 10, 20)]).flights;
    const arrivals = scheduleArrivals([
      { CallSign: 'LANDED', PlaneTypeCode: 'A321', Stand: '16', ScheduledArrival: new Date(5 * minute).toISOString() },
      { CallSign: 'LATER', PlaneTypeCode: 'A321', Stand: '17', ScheduledArrival: new Date(80 * minute).toISOString() },
    ], base);
    const plan = applyWeatherPeriods(base, arrivals, [{ start: 11 * minute, end: 50 * minute }], '25L-25R');
    expect(plan.arrivals.every(arrival => arrival.divertedAt === undefined)).toBe(true);
  });
});

describe('weather recovery with bundled workbooks', () => {
  it.each(['21102026.xlsx', 'chuyen-de.xlsx', '3-days.xls', '7-days.xls'])('recovers every departure in %s with valid slots and runway separation', async (filename) => {
    const bytes = readFileSync(`public/samples/${filename}`);
    const file = new File([bytes], filename);
    Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
    const workbook = await readFlightFile(file);
    const counts = new Map<string, number>();
    for (const row of workbook.enrichedRows.filter(isDepartureFromTsn)) {
      const day = toDayString(row.FlyDate ?? row.Date);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    const day = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const rows = workbook.enrichedRows.filter((row) => toDayString(row.FlyDate ?? row.Date) === day);
    const base = runSimulation(toScheduledFlights(rows.filter(isDepartureFromTsn)), true).flights;
    const arrivals = scheduleArrivals(rows.filter(isArrivalAtTsn), base);
    const start = base[0].taxiStart + minute;
    const plan = applyWeatherPeriods(base, arrivals, [{ start, end: start + 40 * minute }], '25L-25R');
    expect(plan.flights).toHaveLength(base.length);
    expect(plan.flights.every(item => Number.isFinite(item.wheelsOff) || item.weather?.blockedAt !== undefined)).toBe(true);
    for (let index = 0; index < plan.flights.length; index += 1) {
      const item = plan.flights[index];
      if (!Number.isFinite(item.wheelsOff)) { expect(item.reissuedCtot).toBeNull(); continue; }
      if (item.reissuedTsat !== null) {
        expect(item.reissuedCtot).toBeNull();
        expect(item.wheelsOff).toBeGreaterThanOrEqual(item.reissuedTsat + item.taxiMinutes * minute);
      } else if (!item.weather?.returnedAfterStartup) {
        const slot = item.reissuedCtot ?? item.ctot;
        expect(item.wheelsOff).toBeGreaterThanOrEqual(slot - 5 * minute);
        expect(item.wheelsOff).toBeLessThanOrEqual(slot + 10 * minute);
      }
      const previous = plan.flights.slice(0, index).filter(flight => Number.isFinite(flight.wheelsOff)).at(-1);
      if (previous) {
        expect(item.runwayEntryStart).toBeGreaterThanOrEqual(previous.wheelsOff);
        expect(item.wakeCategory === 'H' && previous.wakeCategory === 'H').toBe(false);
      }
    }
    for (const arrival of plan.arrivals.filter(item => item.divertedAt === undefined)) {
      expect(Number.isFinite(arrival.standArrival)).toBe(true);
      for (const departure of plan.flights.filter(flight => Number.isFinite(flight.wheelsOff))) {
        expect(arrival.crossingEnd <= departure.runwayEntryStart || arrival.crossingStart >= departure.wheelsOff + 10_000).toBe(true);
        if (arrival.crossingStart >= start) expect(departure.runwayEntryStart < Math.max(arrival.p5HoldAt, start)
          || departure.runwayEntryStart >= arrival.crossingEnd, `${arrival.callsign}/${departure.callsign}`).toBe(true);
      }
    }
  });
});
