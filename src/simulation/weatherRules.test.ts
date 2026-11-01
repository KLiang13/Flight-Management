import { describe, it, expect } from 'vitest';
import { runSimulation } from './runSimulation';
import { applyWeatherPeriods, hasMissedCtotAt, weatherDclEvents, composeWeatherDclEvents, weatherStatus } from './weather';
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
    expect(messages.some(event => event.message.includes('ADVERSE WEATHER') || event.message.includes('STANDBY'))).toBe(false);
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
    expect(suspended.map(event => event.message.split(' ')[0])).toEqual(['RCD']);
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

describe('started aircraft CTOT status', () => {
  it('shows CTOT EXPIRED only after expiry and until a replacement is issued', () => {
    const planned = base(790, 800);
    const recovered = applyWeatherPeriods([planned], [], [{ start: 793 * minute, end: 825 * minute }], '25L-25R').flights[0];
    expect(weatherStatus(recovered, 809 * minute)?.label).toBe('Chờ thời tiết tốt');
    expect(weatherStatus(recovered, 810 * minute)?.label).not.toBe('CTOT EXPIRED');
    expect(weatherStatus(recovered, 810 * minute + 1)?.label).toBe('CTOT EXPIRED');
    expect(weatherStatus(recovered, 824 * minute)?.tsat).toBe(planned.tsat);
    expect(weatherStatus(recovered, 825 * minute)?.label).toBe('Đã cấp CTOT mới');
    expect(recovered.reissuedTsat).toBeNull();
  });
  it('does not label an unstarted aircraft CTOT EXPIRED during startup suspension', () => {
    const planned = base(797, 807);
    const held = applyWeatherPeriods([planned], [], [{ start: 787 * minute, end: 850 * minute }], '25L-25R').flights[0];
    expect(weatherStatus(held, 840 * minute)?.label).toBe('Chờ thời tiết tốt');
    expect(weatherStatus(held, 840 * minute)?.tsat).toBeNull();
    expect(weatherStatus(held, 850 * minute)?.label).toBe('Đã cấp TSAT mới');
  });
});

describe('S1 queue after weather recovery', () => {
  it('keeps three queued aircraft apart and enters 25L only at the revised entry time', () => {
    const planned = base(790, 800);
    const recovered = applyWeatherPeriods([planned], [], [{ start: 793 * minute, end: 825 * minute }], '25L-25R').flights[0];
    const waitingAt = recovered.runwayEntryStart - 1000;
    const positions = [0, 1, 2].map(index =>
      departurePosition({ ...recovered, id: 'QUEUE-' + index }, waitingAt, index, '25L-25R'));
    expect(new Set(positions.map(position => position.point.x + ':' + position.point.y)).size).toBe(3);
    expect(positions.every(position => position.phase === 'chờ lượt vào 25L')).toBe(true);
    expect(departurePosition(recovered, recovered.runwayEntryStart + 1000, 0, '25L-25R').phase).toBe('vào đường băng 25L');
    expect(departurePosition(recovered, recovered.takeoffRollStart + 1000, 0, '25L-25R').phase).toBe('cất cánh 25L');
    expect(departurePosition(recovered, recovered.wheelsOff + 1000, 0, '25L-25R').phase).toBe('đã cất cánh 25L');
  });
});
