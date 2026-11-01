import { describe, it, expect } from 'vitest';
import { runSimulation } from './runSimulation';
import { applyWeatherPeriods, hasMissedCtotAt, weatherDclEvents, composeWeatherDclEvents } from './weather';
import { clearanceRequestTime, departureWaitMinutesAt } from './departureTiming';
import { departurePosition } from '../map/playback';
import { formatDclMessage, createDclEvents } from '../dcl/dclScenario';

const minute = 60_000;
const base = (startup: number, slot: number) => runSimulation([{
  id: 'D', callsign: 'D', aircraftType: 'A321', wakeCategory: 'M', stand: '73',
  readyAt: startup * minute, ctot: slot * minute, taxiMinutes: 8, row: {},
}]).flights[0];

describe('weather suspension rules', () => {
  it('TH1 counts 16 minutes at 13:46 against the old 13:30 tolerance end', () => {
    const planned = base(790, 800);
    const recovered = applyWeatherPeriods([planned], [], [{ start: 793 * minute, end: 825 * minute }], '25L-25R').flights[0];
    const actual = { ...recovered, wheelsOff: 826 * minute };
    expect(recovered.weather!.heldAtStand).toBe(false);
    expect(recovered.weather!.returnStand).toBeNull();
    expect(departureWaitMinutesAt(actual, 810 * minute)).toBe(0);
    expect(departureWaitMinutesAt(actual, 826 * minute)).toBe(16);
    expect(departureWaitMinutesAt(actual, 900 * minute)).toBe(16);
    expect(hasMissedCtotAt(actual, 826 * minute)).toBe(true);
  });

  it('TH2 suspends startup without a violation or waiting penalty', () => {
    const planned = base(797, 807);
    const periods = [{ start: 787 * minute, end: 825 * minute }];
    const recovered = applyWeatherPeriods([planned], [], periods, '25L-25R').flights[0];
    expect(recovered.weather!.heldAtStand).toBe(true);
    expect(recovered.reissuedTsat).toBeGreaterThanOrEqual(825 * minute);
    expect(departureWaitMinutesAt(recovered, 824 * minute)).toBe(0);
    expect(departureWaitMinutesAt(recovered, recovered.wheelsOff)).toBe(0);
    expect(hasMissedCtotAt(recovered, recovered.wheelsOff)).toBe(false);
  });

  it('keeps RCD at old TSAT-20 during rain, FSM standby, then CLD/CDA on recovery', () => {
    const planned = base(797, 807);
    const periods = [{ start: 776 * minute, end: 825 * minute }];
    const recovered = applyWeatherPeriods([planned], [], periods, '25L-25R').flights[0];
    const requestAt = clearanceRequestTime(planned.tsat, 0);
    expect(requestAt).toBe(777 * minute);
    const requests = createDclEvents('D', requestAt, 13).map(event => ({ ...event, flightId: 'D' }));
    const messages = weatherDclEvents([recovered], periods, requests);
    expect(messages.find(event => event.message.startsWith('FSM ') && event.message.includes('STANDBY'))?.time).toBe(requestAt + 15_000);
    expect(messages.some(event => event.status === 'TIMEOUT' || event.message.includes('VOICE') || event.message.includes('ALL '))).toBe(false);
    const clearance = messages.find(event => event.message.startsWith('CLD '))!;
    expect(clearance.time).toBe(825 * minute);
    expect(clearance.message).toContain('TSAT REVISED');
    expect(formatDclMessage(clearance.message)).toHaveLength(5);
    expect(messages.find(event => event.message.startsWith('CDA '))?.time).toBe(clearance.time + 25_000);
  });

  it('does not move an aircraft back to S1 when rain interrupts runway entry', () => {
    const planned = base(10, 20);
    const start = (planned.runwayEntryStart + planned.takeoffRollStart) / 2;
    const recovered = applyWeatherPeriods([planned], [], [{ start, end: 25 * minute }], '25L-25R').flights[0];
    const before = departurePosition(planned, start, 0, '25L-25R').point;
    const after = departurePosition(recovered, start, 0, '25L-25R').point;
    expect(Math.hypot(before.x - after.x, before.y - after.y)).toBeLessThan(0.01);
  });
  it('removes old timeout, retry and CLD events during an earlier DCL-only rain period', () => {
    const planned = base(100, 110);
    const periods = [{ start: 79 * minute, end: 85 * minute }, { start: 95 * minute, end: 120 * minute }];
    const recovered = applyWeatherPeriods([planned], [], periods, '25L-25R').flights[0];
    const requests = createDclEvents('D', 80 * minute, 13).map(event => ({ ...event, flightId: 'D' }));
    const combined = composeWeatherDclEvents(requests, [recovered], periods);
    const suspended = combined.filter(event => event.time >= 79 * minute && event.time < 85 * minute);
    expect(suspended.map(event => event.message.split(' ')[0])).toEqual(['RCD', 'FSM']);
    expect(suspended.some(event => event.status === 'TIMEOUT' || event.message.includes('VOICE'))).toBe(false);
    expect(combined.filter(event => event.message.startsWith('RCD '))).toHaveLength(1);
    expect(combined.find(event => event.message.startsWith('CLD '))?.time).toBe(85 * minute);
  });

  it('pauses a pending clearance even when RCD was sent just before rain', () => {
    const planned = base(100, 110);
    const periods = [{ start: 80.3 * minute, end: 85 * minute }];
    const recovered = applyWeatherPeriods([planned], [], periods, '25L-25R').flights[0];
    const requests = createDclEvents('D', 80 * minute, 13).map(event => ({ ...event, flightId: 'D' }));
    const combined = composeWeatherDclEvents(requests, [recovered], periods);
    expect(combined.some(event => event.status === 'TIMEOUT' || event.message.includes('VOICE'))).toBe(false);
    expect(combined.find(event => event.message.startsWith('CLD '))?.time).toBe(85 * minute);
  });

  it('preserves the actual runway-entry progress across two rain interruptions', () => {
    const planned = base(10, 20);
    const firstPeriod = { start: (planned.runwayEntryStart + planned.takeoffRollStart) / 2, end: 25 * minute };
    const first = applyWeatherPeriods([planned], [], [firstPeriod], '25L-25R').flights[0];
    const start = first.runwayEntryStart + 3000;
    const repeated = applyWeatherPeriods([planned], [], [firstPeriod, { start, end: 35 * minute }], '25L-25R').flights[0];
    const before = departurePosition(first, start, 0, '25L-25R').point;
    const after = departurePosition(repeated, start, 0, '25L-25R').point;
    expect(Math.hypot(before.x - after.x, before.y - after.y)).toBeLessThan(0.01);
  });
});
