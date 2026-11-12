import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { enrichFlights } from '../src/data/enrichFlights';
import { computePlan } from '../src/simulation/planning';
import { solveDepartureMilp } from '../src/simulation/milpDeparture';
import loadHighs from 'highs';
import { solvePairwiseMilp } from '../src/simulation/milpPairwise';
import { solveRollingMilp } from '../src/simulation/milpRolling';
import { computeMilpDayCandidate } from '../src/simulation/milpPlan';
import { applyWeatherPeriods } from '../src/simulation/weather';

it('measures the existing whole-day planner and records the prototype limit', async () => {
  const book = XLSX.read(readFileSync('public/samples/chuyen-de.xlsx'));
  const dep = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets.DEP).map(row => ({ ...row, FlightDirection: 'DEP' }));
  const arr = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets.ARR).map(row => ({ ...row, FlightDirection: 'ARR' }));
  const rows = enrichFlights([...dep, ...arr], 'Chuyên đề.xlsx');
  const departures = rows.filter(row => row.FlightDirection === 'DEP');
  const arrivals = rows.filter(row => row.FlightDirection === 'ARR');
  const start = performance.now();
  const normal = computePlan({ type: 'day', rows: departures, arrivals, runway: '25L-25R' });
  const normalMs = performance.now() - start;
  const first = Math.min(...normal.flights.map(f => f.ctot));
  const weatherStart = first + 5 * 60_000;
  const started = performance.now();
  const bad = computePlan({ type: 'weather', flights: normal.flights, arrivals: normal.arrivals,
    periods: [{ start: weatherStart, end: weatherStart + 20 * 60_000 }], runway: '25L-25R', horizon: Infinity });
  const weatherMs = performance.now() - started;
  const highs = await loadHighs();
  const candidateStart = performance.now();
  const candidate = computeMilpDayCandidate(highs, departures, arrivals, '25L-25R');
  const candidateMs = performance.now() - candidateStart;
  const weatherCandidateStart = performance.now();
  const candidateWeather = applyWeatherPeriods(candidate.flights, candidate.arrivals, [{ start: weatherStart, end: weatherStart + 20 * 60_000 }], '25L-25R', Infinity, highs);
  const candidateWeatherMs = performance.now() - weatherCandidateStart;
  const stats = (plan: typeof normal) => ({ airborne: plan.flights.filter(f => Number.isFinite(f.wheelsOff)).length,
    missed: plan.flights.filter(f => f.missedCtot).length, wait: Math.round(plan.flights.reduce((sum, f) => sum + f.waitMinutes, 0)),
    diverted: plan.arrivals.filter(f => f.divertedAt !== undefined).length });
  console.log(JSON.stringify({ reference: stats(normal), referenceWeather: stats(bad), milp: stats(candidate), milpWeather: stats(candidateWeather), candidateMs, candidateWeatherMs }));
  expect(candidate.flights).toHaveLength(normal.flights.length);
  expect(candidateWeather.arrivals).toHaveLength(normal.arrivals.length);
  const sample = normal.flights.slice(0, 12).map(f => ({ id: f.id, ready: (f.readyAt + f.taxiMinutes * 60_000) / 60_000, ctot: f.ctot / 60_000, wake: f.wakeCategory }));
  const milpStarted = performance.now();
  const milpSample = solveDepartureMilp(highs, sample);
  const milpSampleMs = performance.now() - milpStarted;
  expect(milpSample).toHaveLength(sample.length);
  expect(() => solveDepartureMilp(highs, normal.flights.map(f => ({ id: f.id, ready: f.readyAt / 60_000,
    ctot: f.ctot / 60_000, wake: f.wakeCategory })))).toThrow('tối đa 12 chuyến');
  const rollingStarted = performance.now();
  const rolling = solveRollingMilp(highs, normal.flights.map(f => ({ id: f.id, ready: (f.readyAt + f.taxiMinutes * 60_000) / 60_000, ctot: f.ctot / 60_000, wake: f.wakeCategory })));
  console.log(JSON.stringify({ rollingMs: performance.now() - rollingStarted, rollingScheduled: rolling.scheduled.length, rollingHeld: rolling.held.length }));
  const pairStarted = performance.now();
  let pairStatus = 'Optimal';
  try { solvePairwiseMilp(highs, normal.flights.map(f => ({ id: f.id, ready: (f.readyAt + f.taxiMinutes * 60_000) / 60_000, ctot: f.ctot / 60_000, wake: f.wakeCategory }))); } catch (error) { pairStatus = String(error); }
  console.log(JSON.stringify({ pairStatus, pairMs: performance.now() - pairStarted }));
  const wetStarted = performance.now();
  let wetStatus = 'Optimal';
  try { solvePairwiseMilp(highs, normal.flights.map(f => ({ id: f.id, ready: (f.readyAt + f.taxiMinutes * 60_000) / 60_000, ctot: f.ctot / 60_000, wake: f.wakeCategory })), 2, [{ start: weatherStart / 60_000, end: (weatherStart + 20 * 60_000) / 60_000 }]); } catch (error) { wetStatus = String(error); }
  console.log(JSON.stringify({ wetStatus, wetMs: performance.now() - wetStarted }));
  console.log(JSON.stringify({ departures: normal.flights.length, arrivals: normal.arrivals.length, normalMs,
    weatherMs, weatherFlights: bad.flights.length, weatherArrivals: bad.arrivals.length, milpSampleMs, milpSampleSize: sample.length }));
});
