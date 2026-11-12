import { describe, expect, it, beforeAll } from 'vitest';
import loadHighs from 'highs';
import { solveDepartureMilp, type MilpSolver } from './milpDeparture';

let solver: MilpSolver;
beforeAll(async () => { solver = await loadHighs(); });

describe('MILP runway sequencing prototype', () => {
  it('places a medium between heavy departures and respects the CTOT window', () => {
    const flights = [
      { id: 'H1', ready: 0, ctot: 10, wake: 'H' as const },
      { id: 'H2', ready: 0, ctot: 10, wake: 'H' as const },
      { id: 'M', ready: 0, ctot: 10, wake: 'M' as const },
    ];
    const result = solveDepartureMilp(solver, flights);
    expect(result.map(f => f.id)[1]).toBe('M');
    expect(result.every(f => !f.missed && f.takeoff >= 5 && f.takeoff <= 20)).toBe(true);
  });

  it('counts an unavoidable missed CTOT', () => {
    const result = solveDepartureMilp(solver, [{ id: 'late', ready: 21, ctot: 10, wake: 'M' }]);
    expect(result[0]).toEqual({ id: 'late', takeoff: 21, missed: true });
  });

  it('does not schedule a takeoff during a closed runway interval', () => {
    const result = solveDepartureMilp(solver, [{ id: 'rain', ready: 10, ctot: 10, wake: 'M' }], 2, [{ start: 9, end: 15 }]);
    expect(result[0].takeoff).toBe(15);
    expect(result[0].missed).toBe(false);
  });

  it('rejects a non-finite runway separation', () => {
    expect(() => solveDepartureMilp(solver, [{ id: 'A', ready: 0, ctot: 10, wake: 'M' }], Infinity)).toThrow('không hợp lệ');
  });

  it('rejects an invalid closure interval', () => {
    expect(() => solveDepartureMilp(solver, [{ id: 'A', ready: 0, ctot: 10, wake: 'M' }], 2, [{ start: 2, end: 2 }])).toThrow('không hợp lệ');
  });

  it('reports infeasibility instead of fabricating a schedule', () => {
    expect(() => solveDepartureMilp(solver, [
      { id: 'H1', ready: 0, ctot: 10, wake: 'H' },
      { id: 'H2', ready: 0, ctot: 10, wake: 'H' },
    ])).toThrow('Infeasible');
  });
});
