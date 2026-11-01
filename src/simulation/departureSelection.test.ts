import { describe, expect, it } from 'vitest';
import { runSimulation, toScheduledFlights } from './runSimulation';
import { ctotDelayMinutes } from './ctot';
import { stationaryWaitMinutesAt } from './departureTiming';

describe('departure selection', () => {
  it('does not idle the runway behind a future slot while a valid flight is ready', () => {
    const flights = toScheduledFlights([
      { CallSign: 'LATER', Stand: '71', ScheduledDeparture: '2026-10-01T08:00:00Z', CTOT: '2026-10-01T08:50:00Z', TaxiMinutes: 3 },
      { CallSign: 'NOW', Stand: '72', ScheduledDeparture: '2026-10-01T08:00:00Z', CTOT: '2026-10-01T08:05:00Z', TaxiMinutes: 3 },
    ]);
    const plan = runSimulation(flights, true);
    expect(plan.flights[0].callsign).toBe('NOW');
    expect(ctotDelayMinutes(plan.flights[0].wheelsOff, plan.flights[0].ctot)).toBe(0);
    expect(plan.flights[0].waitMinutes).toBe(stationaryWaitMinutesAt(plan.flights[0], plan.flights[0].wheelsOff));
    expect(plan.flights[0].taxiStart).toBe(plan.flights[1].taxiStart);
  });

  it('makes the mandatory noncompliance scenario actually exceed the original CTOT window', () => {
    const plan = runSimulation(toScheduledFlights([{
      CallSign: 'FORCED', Stand: '71', ScheduledDeparture: '2026-10-01T08:00:00Z',
      CTOT: '2026-10-01T08:20:00Z', TaxiMinutes: 3, Compliance: 'Không tuân thủ',
    }]));
    expect(plan.flights[0].wheelsOff).toBeGreaterThan(plan.flights[0].ctot + 600_000);
    expect(ctotDelayMinutes(plan.flights[0].wheelsOff, plan.flights[0].ctot)).toBeGreaterThan(10);
    expect(plan.flights[0].waitMinutes).toBe(stationaryWaitMinutesAt(plan.flights[0], plan.flights[0].wheelsOff));
  });
});
