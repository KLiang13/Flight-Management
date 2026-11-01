import { describe, expect, it } from 'vitest';
import { createDclEvents } from './dclScenario';

describe('DCL playback scenario', () => {
  it('replays RCD, FSM, CLD and confirmed CDA messages using sample conventions', () => {
    const events = createDclEvents('VN123', Date.parse('2023-11-03T08:00:00Z'), 1, { stand: '12', destination: 'VVDN', aircraftType: 'A321', runway: '25L-25R', tsat: Date.parse('2023-11-03T08:30:00Z') });
    expect(events.map((event) => event.callsign).every((name) => name === 'VN123')).toBe(true);
    expect(events.some((event) => event.message.startsWith('RCD VN123-VVTS'))).toBe(true);
    expect(events.some((event) => event.message.includes('RCD RECEIVED REQUEST BEING PROCESSED'))).toBe(true);
    expect(events.some((event) => event.message.startsWith('CLD') && event.message.includes('TSAT'))).toBe(true);
    expect(events.some((event) => event.message.includes('CDA RECEIVED CLEARANCE CONFIRMED'))).toBe(true);
  });

  it('accepts requests for every scenario seed', () => {
    for (const seed of [1, 13, 26, 39]) {
      const events = createDclEvents('VN123', 0, seed);
      expect(events.every(event => event.status === 'OK')).toBe(true);
      expect(events).toHaveLength(4);
    }
  });
});
