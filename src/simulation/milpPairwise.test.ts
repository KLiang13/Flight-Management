import { beforeAll, describe, expect, it } from 'vitest';
import loadHighs from 'highs';
import type { MilpSolver } from './milpDeparture';
import { solvePairwiseMilp } from './milpPairwise';

let solver: MilpSolver;
beforeAll(async () => { solver = await loadHighs(); });
describe('pairwise MILP prototype', () => {
  it('separates heavy departures with a medium departure', () => {
    const result = solvePairwiseMilp(solver, [
      { id: 'H1', ready: 0, ctot: 10, wake: 'H' },
      { id: 'H2', ready: 0, ctot: 10, wake: 'H' },
      { id: 'M', ready: 0, ctot: 10, wake: 'M' },
    ]);
    expect(result[1].id).toBe('M');
    expect(result.every(f => !f.missed)).toBe(true);
  });
  it('keeps a departure outside a closed runway interval', () => {
    const result = solvePairwiseMilp(solver, [{ id: 'R', ready: 10, ctot: 10, wake: 'M' }], 2, [{ start: 9, end: 15 }]);
    expect(result[0].takeoff).toBe(15);
  });
  it('rejects an impossible consecutive heavy queue', () => {
    expect(() => solvePairwiseMilp(solver, [
      { id: 'H1', ready: 0, ctot: 10, wake: 'H' },
      { id: 'H2', ready: 0, ctot: 10, wake: 'H' },
    ])).toThrow('Infeasible');
  });
});
