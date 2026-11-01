import { describe, expect, it } from 'vitest';
import { runSimulation } from './runSimulation';
import { applyWeatherPeriods } from './weather';
import { clearanceRequestTime, departureWaitMinutesAt, tsatWaitMinutes } from './departureTiming';

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

  it('counts TSAT to actual takeoff even for a compliant CTOT', () => {
    const departure = flight();
    expect(departure.missedCtot).toBe(false);
    expect(departure.waitMinutes).toBe(tsatWaitMinutes(departure.wheelsOff, departure.tsat));
    expect(departure.waitMinutes).toBeGreaterThan(0);
  });

  it('starts waiting at TSAT, independently of RCD, and stops at actual takeoff', () => {
    const departure = flight();
    expect(departureWaitMinutesAt(departure, departure.tsat - 10 * minute)).toBe(0);
    expect(departureWaitMinutesAt(departure, departure.tsat)).toBe(0);
    expect(departureWaitMinutesAt(departure, departure.tsat + minute)).toBe(1);
    expect(departureWaitMinutesAt(departure, departure.wheelsOff + 10 * minute))
      .toBe(tsatWaitMinutes(departure.wheelsOff, departure.tsat));
  });

  it('uses a revised TSAT only after it is issued and does not reset TSAT for revised CTOT', () => {
    const departure = flight();
    const revised = { ...departure, reissuedTsat: 100 * minute, returnEnd: 90 * minute,
      wheelsOff: 115 * minute };
    expect(departureWaitMinutesAt(revised, 80 * minute)).toBe(20);
    expect(departureWaitMinutesAt(revised, 95 * minute)).toBe(0);
    expect(departureWaitMinutesAt(revised, 115 * minute)).toBe(15);
    expect(departureWaitMinutesAt({ ...revised, reissuedTsat: null, reissuedCtot: 115 * minute }, 115 * minute))
      .toBe(55);
  });

  it('keeps the latest TSAT when a subsequent weather period revises only CTOT', () => {
    const first = applyWeatherPeriods([flight()], [], [{ start: 55 * minute, end: 100 * minute }], '25L-25R').flights[0];
    const start = first.reissuedTsat! + minute;
    const second = applyWeatherPeriods([first], [], [{ start, end: start + 9 * minute }], '25L-25R').flights[0];
    expect(second.reissuedTsat).toBeNull();
    expect(second.reissuedCtot).not.toBeNull();
    expect(second.waitMinutes).toBe(0);
    expect(departureWaitMinutesAt(second, second.wheelsOff)).toBe(second.waitMinutes);
  });

  it('resets the baseline to the latest weather-issued TSAT and preserves earlier playback', () => {
    const departure = flight();
    const recovered = applyWeatherPeriods([departure], [], [{ start: 55 * minute, end: 100 * minute }], '25L-25R').flights[0];
    expect(recovered.reissuedTsat).not.toBeNull();
    expect(departureWaitMinutesAt(recovered, 50 * minute)).toBe(0);
    expect(departureWaitMinutesAt(recovered, recovered.reissuedTsat!)).toBe(0);
    expect(recovered.waitMinutes).toBe(0);
  });
});
