import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import loadHighs from 'highs';
import * as XLSX from 'xlsx';
import { enrichFlights } from '../src/data/enrichFlights';
import { computeMilpDayCandidate } from '../src/simulation/milpPlan';
import { applyWeatherPeriods } from '../src/simulation/weather';
import { RUNWAY_CLEARANCE_MS } from '../src/simulation/movementPhysics';
import { arrivalThresholdClearAt } from '../src/simulation/runwayCoordination';

it('builds and validates the full sample MILP day candidate', async () => {
  const book = XLSX.read(readFileSync('public/samples/chuyen-de.xlsx'));
  const dep = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets.DEP).map(row => ({ ...row, FlightDirection: 'DEP' }));
  const arr = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets.ARR).map(row => ({ ...row, FlightDirection: 'ARR' }));
  const rows = enrichFlights([...dep, ...arr], 'Chuyên đề.xlsx');
  const highs = await loadHighs();
  const statuses: string[] = [];
  const solver = { solve: (model: string, options: { output_flag: boolean; time_limit: number }) => {
    const result = highs.solve(model, options); statuses.push(result.Status); return result;
  } };
  const plan = computeMilpDayCandidate(solver, rows.filter(r => r.FlightDirection === 'DEP'), rows.filter(r => r.FlightDirection === 'ARR'), '25L-25R');
  expect(plan.flights).toHaveLength(70);
  expect(plan.arrivals).toHaveLength(30);
  const active = plan.flights.filter(f => Number.isFinite(f.wheelsOff)).sort((a, b) => a.wheelsOff - b.wheelsOff);
  for (let i = 1; i < active.length; i++) {
    expect(active[i].runwayEntryStart).toBeGreaterThanOrEqual(active[i - 1].wheelsOff);
    expect(active[i].wakeCategory === 'H' && active[i - 1].wakeCategory === 'H').toBe(false);
  }
  for (const arrival of plan.arrivals.filter(a => a.divertedAt === undefined)) for (const departure of active) {
    expect(arrival.crossingEnd <= departure.runwayEntryStart || arrival.crossingStart >= departure.wheelsOff + RUNWAY_CLEARANCE_MS).toBe(true);
    expect(departure.takeoffRollStart < arrival.approachStart || departure.takeoffRollStart >= arrivalThresholdClearAt(arrival)).toBe(true);
  }
  const start = Math.min(...plan.flights.map(f => f.ctot)) + 5 * 60_000;
  const recovered = applyWeatherPeriods(plan.flights, plan.arrivals, [{ start, end: start + 20 * 60_000 }], '25L-25R', undefined, solver);
  expect(recovered.flights).toHaveLength(70);
  expect(recovered.arrivals).toHaveLength(30);
  const airborne = recovered.flights.filter(f => Number.isFinite(f.wheelsOff)).sort((a, b) => a.wheelsOff - b.wheelsOff);
  for (let i = 1; i < airborne.length; i++) {
    expect(airborne[i].runwayEntryStart).toBeGreaterThanOrEqual(airborne[i - 1].wheelsOff);
    expect(airborne[i].wakeCategory === 'H' && airborne[i - 1].wakeCategory === 'H', JSON.stringify({ before: airborne[i-1].callsign, after: airborne[i].callsign })).toBe(false);
  }
  for (const arrival of recovered.arrivals.filter(a => a.divertedAt === undefined)) for (const departure of airborne) {
    expect(arrival.crossingEnd <= departure.runwayEntryStart || arrival.crossingStart >= departure.wheelsOff + 10_000, JSON.stringify({ arrival: arrival.id, crossing: [arrival.crossingStart, arrival.crossingEnd], departure: departure.id, runway: [departure.runwayEntryStart, departure.wheelsOff] })).toBe(true);
    expect(departure.takeoffRollStart < arrival.approachStart || departure.takeoffRollStart >= arrivalThresholdClearAt(arrival)).toBe(true);
  }
  const start2 = new Date('2026-10-01T13:27:30').getTime();
  const end2 = new Date('2026-10-01T13:30:00').getTime();
  const second = applyWeatherPeriods(plan.flights, plan.arrivals, [{ start: start2, end: end2 }], '25L-25R', undefined, solver);
  const original142 = plan.flights.find(f => f.callsign === 'VJC142')!;
  const revised142 = second.flights.find(f => f.callsign === 'VJC142')!;
  expect(revised142.ctot).toBe(original142.ctot);
  expect(revised142.reissuedTsat).toBe(end2);
  expect(Number.isFinite(revised142.wheelsOff)).toBe(true);
  const longStart = new Date('2026-10-01T12:50:00').getTime();
  const longEnd = new Date('2026-10-01T14:28:23').getTime();
  const longRain = applyWeatherPeriods(plan.flights, plan.arrivals, [{ start: longStart, end: longEnd }], '25L-25R', undefined, solver);
  for (const callsign of ['SIA183', 'VJC254', 'MAS759', 'SPQ864']) {
    const flight = longRain.flights.find(f => f.callsign === callsign)!;
    const initial = plan.flights.find(f => f.id === flight.id)!;
    expect(flight.ctot, callsign).toBe(initial.ctot);
    if (Number.isFinite(initial.wheelsOff)) expect(Number.isFinite(flight.wheelsOff), JSON.stringify({ callsign, initial: { ctot: initial.ctot, tsat: initial.tsat, wheelsOff: initial.wheelsOff }, now: { wheelsOff: flight.wheelsOff, state: flight.weather && { blockedAt: flight.weather.blockedAt, offApron: flight.weather.offApron, returnStand: flight.weather.returnStand, held: flight.weather.heldAtStand } } })).toBe(true);
  }
  console.log(JSON.stringify({ active: active.length, held: plan.flights.length - active.length, recovered: airborne.length, statuses }));
}, 60_000);
