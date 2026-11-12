import type { MilpDeparture, MilpRunwayResult, MilpSolver } from './milpDeparture';
import { solvePairwiseMilp } from './milpPairwise';

/** Rolling-horizon MILP runway candidate. Each window is optimal for its own
 * selected flights, not a proof of global optimality across the full day. */
export function solveRollingMilp(solver: MilpSolver, flights: MilpDeparture[], separation = 2, windowSize = 6, context: { previousWake?: 'H' | 'M'; available?: number; blocked?: { start: number; end: number }[] } = {}) {
  if (!Number.isInteger(windowSize) || windowSize < 2 || windowSize > 12) throw new Error('Kích thước cửa sổ MILP không hợp lệ.');
  if (new Set(flights.map(f => f.id)).size !== flights.length) throw new Error('Dữ liệu chuyến bay không hợp lệ.');
  const remaining = [...flights].sort((a, b) => a.ctot - b.ctot || a.ready - b.ready || a.id.localeCompare(b.id));
  const scheduled: MilpRunwayResult[] = [];
  const held: MilpDeparture[] = [];
  let last: MilpRunwayResult | undefined;
  let previousWake: 'H' | 'M' | undefined = context.previousWake;
  while (remaining.length) {
    const group = remaining.splice(0, windowSize);
    const excessHeavy = () => group.filter(f => f.wake === 'H').length - group.filter(f => f.wake === 'M').length - (previousWake === 'H' ? 0 : 1);
    while (excessHeavy() > 0) {
      let heavyIndex = group.length - 1;
      while (group[heavyIndex].wake !== 'H') heavyIndex--;
      const mediumIndex = remaining.findIndex(f => f.wake === 'M');
      const [heavy] = group.splice(heavyIndex, 1);
      if (mediumIndex >= 0) {
        const [medium] = remaining.splice(mediumIndex, 1);
        group.push(medium);
        remaining.unshift(heavy);
      } else held.push(heavy);
    }
    if (!group.length) continue;
    const ready = group.map(f => ({ ...f, ready: Math.max(f.ready, context.available ?? -Infinity, last ? last.takeoff + separation : -Infinity) }));
    const moreHeavy = remaining.filter(f => f.wake === 'H').length > remaining.filter(f => f.wake === 'M').length;
    const solved = solvePairwiseMilp(solver, ready, separation, context.blocked ?? [], previousWake, moreHeavy ? 'M' : undefined);
    scheduled.push(...solved);
    last = solved.at(-1);
    previousWake = group.find(f => f.id === last?.id)!.wake;
  }
  return { scheduled, held };
}
