import { describe, expect, it } from 'vitest';
import { runSimulation } from './runSimulation';
import { applyWeatherPeriods } from './weather';
import { clearanceRequestTime, departureCtotAt, departureTsatAt, departureWaitMinutesAt, stationaryWaitMinutesAt } from './departureTiming';

const minute = 60_000;
const flight = () => runSimulation([{
  id: 'DEP', callsign: 'DEP', aircraftType: 'A321', wakeCategory: 'M' as const,
  stand: '73', readyAt: 60 * minute, ctot: 75 * minute, taxiMinutes: 8, row: {},
}]).flights[0];

describe('RCD appearance and TSAT waiting time', () => {
  it('requests clearance exactly twenty minutes before TSAT, including before midnight', () => {
    expect(clearanceRequestTime(60 * minute, 0)).toBe(40 * minute);
    expect(clearanceRequestTime(5 * minute, 0)).toBe(-15 * minute);
  });

  it('excludes normal taxi and runway motion from the completed wait', () => {
    const departure = flight();
    expect(departure.missedCtot).toBe(false);
    expect(departure.waitMinutes).toBeCloseTo(Math.max(0, (departure.runwayEntryStart - departure.taxiStart) / minute - departure.taxiMinutes));
    expect(departure.waitMinutes).toBeGreaterThanOrEqual(0);
  });

  it('starts waiting at TSAT, independently of RCD, and stops at actual takeoff', () => {
    const departure = flight();
    expect(departureWaitMinutesAt(departure, departure.tsat - 10 * minute)).toBe(0);
    expect(departureWaitMinutesAt(departure, departure.tsat)).toBe(0);
    expect(departureWaitMinutesAt(departure, departure.tsat + minute)).toBe(0);
    expect(departureWaitMinutesAt(departure, departure.wheelsOff + 10 * minute))
      .toBe(departure.waitMinutes);
  });

  it('uses a revised TSAT only after it is issued and does not reset TSAT for revised CTOT', () => {
    const departure = flight();
    const revised = { ...departure, reissuedTsat: 100 * minute, returnEnd: 90 * minute,
      wheelsOff: 115 * minute };
    expect(departureTsatAt(revised, 80 * minute)).toBe(departure.tsat);
    expect(departureTsatAt(revised, 95 * minute)).toBe(100 * minute);
    expect(departureTsatAt(revised, 115 * minute)).toBe(100 * minute);
    expect(departureTsatAt({ ...revised, reissuedTsat: null, reissuedCtot: 115 * minute }, 115 * minute))
      .toBe(departure.tsat);
  });

  it('keeps both issued clocks when a subsequent shower returns a started aircraft', () => {
    const first = applyWeatherPeriods([flight()], [], [{ start: 55 * minute, end: 62 * minute }], '25L-25R').flights[0];
    const start = first.reissuedTsat! + minute;
    const second = applyWeatherPeriods([first], [], [{ start, end: start + 30 * minute }], '25L-25R').flights[0];
    expect(second.reissuedTsat).toBeNull();
    expect(second.reissuedCtot).toBeNull();
    expect(departureCtotAt(second, second.wheelsOff)).toBe(departureCtotAt(first, start));
    expect(departureTsatAt(second, second.wheelsOff)).toBe(first.reissuedTsat);
    expect(departureWaitMinutesAt(second, second.wheelsOff)).toBe(second.waitMinutes);
  });

  it('resets the baseline to the latest weather-issued TSAT and preserves earlier playback', () => {
    const departure = flight();
    const recovered = applyWeatherPeriods([departure], [], [{ start: 55 * minute, end: 62 * minute }], '25L-25R').flights[0];
    expect(recovered.reissuedTsat).not.toBeNull();
    expect(departureWaitMinutesAt(recovered, 50 * minute)).toBe(0);
    expect(departureWaitMinutesAt(recovered, recovered.reissuedTsat!)).toBe(0);
    expect(recovered.waitMinutes).toBe(0);
  });
});

describe('stationary surface waiting', () => {
  it('counts a stop inside a taxi route, but not moving legs or takeoff roll', () => {
    const departure = { ...flight(), tsat: 60 * minute, reissuedTsat: null,
      wheelsOff: 76 * minute, takeoffRollStart: 75 * minute,
      surfacePlan: { visibleFrom: 60 * minute, visibleUntil: 76 * minute, route: 'test', legs: [
        { start: 60 * minute, end: 65 * minute, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], phase: 'taxi' },
        { start: 65 * minute, end: 68 * minute, points: [{ x: 10, y: 0 }], phase: 'hold' },
        { start: 68 * minute, end: 75 * minute, points: [{ x: 10, y: 0 }, { x: 20, y: 0 }], phase: 'taxi' },
      ] } };
    expect(stationaryWaitMinutesAt(departure, 64 * minute)).toBe(0);
    expect(stationaryWaitMinutesAt(departure, 66 * minute)).toBe(1);
    expect(stationaryWaitMinutesAt(departure, 70 * minute)).toBe(3);
    expect(stationaryWaitMinutesAt(departure, 76 * minute)).toBe(3);
    expect(stationaryWaitMinutesAt(departure, 90 * minute)).toBe(3);
  });
});

describe('CTOT displayed at replay time', () => {
  it('shows the old CTOT until recovery, then the new CTOT, and restores it on rewind', () => {
    const original = flight();
    const recovered = applyWeatherPeriods([original], [], [{ start: 55 * minute, end: 62 * minute }], '25L-25R').flights[0];
    expect(departureCtotAt(recovered, 99 * minute)).toBe(original.ctot);
    expect(departureCtotAt(recovered, 100 * minute)).toBe(original.ctot);
    expect(departureCtotAt(recovered, 50 * minute)).toBe(original.ctot);
  });
  it('preserves CTOT and revises TSAT for a feasible returned aircraft', () => {
    const original = flight();
    const recovered = applyWeatherPeriods([original], [], [{ start: original.taxiStart + minute, end: 62 * minute }], '25L-25R').flights[0];
    expect(recovered.reissuedTsat).toBe(62 * minute);
    expect(recovered.reissuedCtot).toBeNull();
    expect(departureTsatAt(recovered, 100 * minute)).toBe(62 * minute);
    expect(departureCtotAt(recovered, 100 * minute)).toBe(original.ctot);
  });
});
