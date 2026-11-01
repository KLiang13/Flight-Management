import { describe, expect, it } from 'vitest';
import { runSimulation } from './runSimulation';
import { applyWeatherPeriods, enforceSingleCtot, weatherDclEvents, weatherStatus } from './weather';
import { departureCtotAt, departureTsatAt } from './departureTiming';
import { departurePosition } from '../map/playback';

const minute = 60_000;
const base = () => runSimulation([{ id: 'D', callsign: 'D', aircraftType: 'A321', wakeCategory: 'M', stand: '73',
  readyAt: 100 * minute, ctot: 120 * minute, taxiMinutes: 8, row: {} }]).flights[0];

describe('single CTOT operating policy', () => {
  it('shows a future issued TSAT during rain and awaits revision only once it is due', () => {
    const original = base();
    const flight = applyWeatherPeriods([original], [], [{ start: 90 * minute, end: null }], '25L-25R').flights[0];
    expect(weatherStatus(flight, original.tsat - 1)!.tsat).toBe(original.tsat);
    expect(weatherStatus(flight, original.tsat)!.tsat).toBeNull();
  });
  it('preserves future TSAT after recovery and shows awaiting for a blocked due startup', () => {
    const original = base();
    const future = applyWeatherPeriods([original], [], [{ start: 80 * minute, end: 90 * minute }], '25L-25R').flights[0];
    expect(weatherStatus(future, 90 * minute)?.tsat ?? departureTsatAt(future, 90 * minute)).toBe(original.tsat);
    const blocked = applyWeatherPeriods([original], [], [{ start: 95 * minute, end: 115 * minute }], '25L-25R').flights[0];
    expect(weatherStatus(blocked, 115 * minute)!.tsat).toBeNull();
  });
  it('keeps future departures valid when rain ends before their startup deadline', () => {
    const original = { ...base(), ctot: 105 * minute, wheelsOff: 110 * minute };
    expect(original.wheelsOff).toBeLessThanOrEqual(original.ctot + 10 * minute);
    const flight = applyWeatherPeriods([original], [], [{ start: 60 * minute, end: 73 * minute }], '25L-25R').flights[0];
    expect(Number.isFinite(flight.wheelsOff)).toBe(true);
    expect(flight.weather?.blockedAt).toBeUndefined();
    expect(flight.reissuedCtot).toBeNull();
  });
  it('releases a waiting S1 aircraft after late recovery without changing either clock', () => {
    const original = base();
    const periods = [{ start: original.runwayEntryStart - 1, end: 150 * minute }];
    const flight = applyWeatherPeriods([original], [], periods, '25L-25R').flights[0];
    expect(flight.weather!.passedWeatherPoint).toBe(true);
    expect(Number.isFinite(flight.wheelsOff)).toBe(true);
    expect(flight.takeoffRollStart).toBeGreaterThanOrEqual(150 * minute);
    expect(flight.reissuedCtot).toBeNull();
    expect(flight.reissuedTsat).toBeNull();
    expect(departureCtotAt(flight, flight.wheelsOff)).toBe(original.ctot);
    expect(departureTsatAt(flight, flight.wheelsOff)).toBe(original.tsat);
    expect(departurePosition(flight, flight.takeoffRollStart + 1000, 0, '25L-25R').phase).toBe('cất cánh 25L');
  });
  it('can release a previously suspended S1 aircraft through a later weather recovery', () => {
    const original = base();
    const waiting = applyWeatherPeriods([original], [], [{ start: original.runwayEntryStart - 1, end: null }], '25L-25R').flights[0];
    const suspended = { ...waiting, weather: { ...waiting.weather!, blockedAt: 140 * minute } };
    const flight = applyWeatherPeriods([suspended], [], [{ start: 145 * minute, end: 150 * minute }], '25L-25R').flights[0];
    expect(Number.isFinite(flight.wheelsOff)).toBe(true);
    expect(flight.takeoffRollStart).toBeGreaterThanOrEqual(150 * minute);
    expect(flight.reissuedCtot).toBeNull();
    expect(flight.reissuedTsat).toBeNull();
  });
  it('sends an awaiting-TSAT message when a baseline-suspended request falls in rain', () => {
    const flight = enforceSingleCtot([{ ...base(), missedCtot: true }])[0];
    const periods = [{ start: 70 * minute, end: 140 * minute }];
    const plan = applyWeatherPeriods([flight], [], periods, '25L-25R');
    expect(weatherDclEvents(plan.flights, periods).some(event => event.message.includes('AWAIT NEW TSAT'))).toBe(true);
    expect(plan.flights[0].wheelsOff).toBe(Infinity);
  });
  it('revises startup only when rain clears before CTOT minus taxi time', () => {
    const original = base();
    const periods = [{ start: 95 * minute, end: 105 * minute }];
    const flight = applyWeatherPeriods([original], [], periods, '25L-25R').flights[0];
    expect(flight.reissuedTsat).toBe(105 * minute);
    expect(flight.reissuedCtot).toBeNull();
    expect(departureCtotAt(flight, flight.wheelsOff)).toBe(original.ctot);
    expect(weatherDclEvents([flight], periods).some(event => event.message.includes('TSAT REVISED'))).toBe(true);
  });
  it('holds an unstarted aircraft forever when recovery is at or after the startup deadline', () => {
    const original = base();
    for (const end of [112, 115, 140]) {
      const periods = [{ start: 95 * minute, end: end * minute }];
      const flight = applyWeatherPeriods([original], [], periods, '25L-25R').flights[0];
      expect(flight.wheelsOff).toBe(Infinity);
      expect(flight.reissuedTsat).toBeNull();
      expect(flight.reissuedCtot).toBeNull();
      expect(weatherDclEvents([flight], periods).some(event => event.message.includes('AWAIT NEW TSAT'))).toBe(true);
      expect(departurePosition(flight, 200 * minute, 0, '25L-25R').phase).toContain('stand');
    }
  });
  it('returns a started aircraft before the lamp and never restarts or issues new clocks', () => {
    const original = base();
    const periods = [{ start: original.taxiStart + minute, end: 140 * minute }];
    const flight = applyWeatherPeriods([original], [], periods, '25L-25R').flights[0];
    expect(flight.weather!.returnStand).not.toBeNull();
    expect(flight.wheelsOff).toBe(Infinity);
    expect(flight.reissuedTsat).toBeNull();
    expect(flight.reissuedCtot).toBeNull();
    expect(departureTsatAt(flight, 200 * minute)).toBe(original.tsat);
  });
  it('does not revive an already suspended aircraft in a later shower', () => {
    const original = base();
    const flight = applyWeatherPeriods([original], [], [{ start: 95 * minute, end: 140 * minute }, { start: 150 * minute, end: 170 * minute }], '25L-25R').flights[0];
    expect(flight.wheelsOff).toBe(Infinity);
    expect(flight.reissuedTsat).toBeNull();
    expect(departureCtotAt(flight, 200 * minute)).toBe(original.ctot);
  });
  it('cancels a missed baseline slot without issuing a replacement CTOT', () => {
    const original = base();
    const flight = enforceSingleCtot([{ ...original, missedCtot: true, reissuedCtot: original.ctot + 50 * minute }])[0];
    expect(flight.wheelsOff).toBe(Infinity);
    expect(flight.reissuedCtot).toBeNull();
    expect(departureCtotAt(flight, 200 * minute)).toBe(original.ctot);
  });
});
