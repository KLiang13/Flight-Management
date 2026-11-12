import { beforeAll, expect, it } from 'vitest';
import loadHighs from 'highs';
import type { MilpSolver } from './milpDeparture';
import { solveRollingMilp } from './milpRolling';

let solver: MilpSolver;
beforeAll(async () => { solver = await loadHighs(); });
it('preserves heavy separation across MILP windows', () => {
  const flights = Array.from({ length: 15 }, (_, i) => ({ id: String(i), ready: i, ctot: i + 5, wake: (i % 2 ? 'M' : 'H') as 'H' | 'M' }));
  const result = solveRollingMilp(solver, flights, 2, 4);
  expect(result.scheduled).toHaveLength(15);
  expect(result.held).toHaveLength(0);
  for (let i = 1; i < result.scheduled.length; i++) {
    expect(result.scheduled[i].takeoff).toBeGreaterThanOrEqual(result.scheduled[i - 1].takeoff + 2 - 1e-6);
    const current = flights.find(f => f.id === result.scheduled[i].id)!;
    const previous = flights.find(f => f.id === result.scheduled[i - 1].id)!;
    expect(current.wake === 'H' && previous.wake === 'H').toBe(false);
  }
});
it('holds heavy departures that cannot be separated', () => {
  const result = solveRollingMilp(solver, [
    { id: 'H1', ready: 0, ctot: 5, wake: 'H' },
    { id: 'H2', ready: 0, ctot: 6, wake: 'H' },
  ]);
  expect(result.scheduled).toHaveLength(1);
  expect(result.held).toHaveLength(1);
});
it('honours the last committed heavy and runway availability', () => {
  const result = solveRollingMilp(solver, [
    { id: 'H', ready: 0, ctot: 20, wake: 'H' },
    { id: 'M', ready: 0, ctot: 20, wake: 'M' },
  ], 2, 10, { previousWake: 'H', available: 20 });
  expect(result.scheduled.map(f => f.id)).toEqual(['M', 'H']);
  expect(result.scheduled[0].takeoff).toBeGreaterThanOrEqual(20);
});
