import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readFlightFile } from './workbook';
import { enrichFlights, isArrivalAtTsn, isDepartureFromTsn, toDayString } from './enrichFlights';
import { runSimulation, toScheduledFlights } from '../simulation/runSimulation';
import { scheduleArrivals } from '../simulation/arrivals';

async function updatedWorkbook() {
  const bytes = readFileSync('tests/fixtures/21102026.xlsx');
  const file = new File([bytes], '21102026.xlsx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer });
  return readFlightFile(file);
}

describe('updated 21102026 flight dataset', () => {
  it('loads the supplied 70 departures and 30 arrivals with their actual operating date and CTOT', async () => {
    const workbook = await updatedWorkbook();
    const departures = workbook.enrichedRows.filter(isDepartureFromTsn);
    const arrivals = workbook.enrichedRows.filter(isArrivalAtTsn);
    expect(departures).toHaveLength(70);
    expect(arrivals).toHaveLength(30);
    expect(workbook.enrichedRows.every((row) => toDayString(row.FlyDate) === '2026-10-01')).toBe(true);
    const first = departures.find((row) => row.CallSign === 'HVN1344')!;
    const ctot = new Date(String(first.CTOT));
    expect([ctot.getHours(), ctot.getMinutes()]).toEqual([13, 20]);
    expect(ctot.getTime() - new Date(String(first.ScheduledDeparture)).getTime()).toBe(15 * 60_000);
    expect(first.Compliance).toBe('Không tuân thủ');
    expect(departures.filter((row) => row.Compliance === 'Không tuân thủ')).toHaveLength(25);
    expect(departures.filter((row) => row.International)).toHaveLength(20);
    expect(arrivals.filter((row) => row.International)).toHaveLength(8);
    expect(departures.filter((row) => row.WakeCategory === 'H')).toHaveLength(7);
    expect(arrivals.filter((row) => row.WakeCategory === 'H')).toHaveLength(4);
    const inbound = arrivals.find((row) => row.CallSign === 'VFC8084')!;
    const landing = new Date(String(inbound.ScheduledArrival));
    expect([landing.getHours(), landing.getMinutes()]).toEqual([14, 32]);
  });

  it('honours every forced noncompliance scenario and subsequently completes the flights', async () => {
    const workbook = await updatedWorkbook();
    const result = runSimulation(toScheduledFlights(workbook.enrichedRows.filter(isDepartureFromTsn)), true);
    expect(result.completed).toBe(70);
    expect(result.missedCtot).toBe(25);
    expect(result.flights.filter(flight => flight.reissuedCtot !== null || flight.reissuedTsat !== null)).toHaveLength(25);
    const forced = result.flights.filter((flight) => flight.row.Compliance === 'Không tuân thủ');
    expect(forced).toHaveLength(25);
    for (const flight of forced) {
      expect(flight.missedCtot).toBe(true);
      expect(flight.wheelsOff).toBeGreaterThan(flight.ctot + 10 * 60_000);
      if (flight.returnStand !== null) {
        expect(flight.returnStart).toBeGreaterThan(flight.ctot + 10 * 60_000);
        expect(flight.secondTaxiStart).toBeGreaterThanOrEqual(flight.returnEnd!);
        expect(flight.reissuedTsat).not.toBeNull();
      } else {
        expect(flight.reissuedCtot).toBe(flight.wheelsOff);
      }
    }
    expect(result.flights.every((flight) => Number.isFinite(flight.wheelsOff))).toBe(true);
    for (let index = 1; index < result.flights.length; index += 1) {
      expect(result.flights[index].runwayEntryStart).toBeGreaterThanOrEqual(result.flights[index - 1].wheelsOff);
      expect(result.flights[index].wakeCategory === 'H' && result.flights[index - 1].wakeCategory === 'H').toBe(false);
    }
    const arrivals = scheduleArrivals(workbook.enrichedRows.filter(isArrivalAtTsn), result.flights);
    expect(arrivals).toHaveLength(30);
    expect(arrivals.every((flight) => Number.isFinite(flight.standArrival))).toBe(true);
  });

  it('preserves timestamp CTOTs and parses clock-only or numeric Excel CTOTs on the flight date', () => {
    const rows = enrichFlights([
      { CallSign: 'CLOCK', FlyDate: '01/10/26', STD: '01:05 PM', CTOT: '01:20 PM', AirportDeliveryCode: 'VVTS' },
      { CallSign: 'SERIAL', FlyDate: '01/10/26', STD: '01:05 PM', CTOT: 0.5, AirportDeliveryCode: 'VVTS' },
      { CallSign: 'ISO', FlyDate: '01/10/26', ScheduledDeparture: '2026-10-01T06:05:00Z', CTOT: '2026-10-01T06:20:00Z', AirportDeliveryCode: 'VVTS' },
    ], 'test.xlsx');
    expect(new Date(String(rows[0].CTOT)).getHours()).toBe(13);
    expect(new Date(String(rows[0].CTOT)).getMinutes()).toBe(20);
    expect(new Date(String(rows[1].CTOT)).getHours()).toBe(12);
    expect(new Date(String(rows[2].CTOT)).getTime()).toBe(Date.parse('2026-10-01T06:20:00Z'));
  });
});
