import type { MilpDeparture, MilpRunwayResult, MilpSolver } from './milpDeparture';

/** Experimental pairwise ordering formulation; it does not plan surface routes. */
export function solvePairwiseMilp(solver: MilpSolver, flights: MilpDeparture[], separation = 2, blocked: { start: number; end: number }[] = [], previousWake?: 'H' | 'M', lastWake?: 'H' | 'M'): MilpRunwayResult[] {
  const n = flights.length;
  if (!n) return [];
  if (!Number.isFinite(separation) || separation <= 0 || flights.some(f => !Number.isFinite(f.ready) || !Number.isFinite(f.ctot)) || new Set(flights.map(f => f.id)).size !== n) throw new Error('Dữ liệu chuyến bay không hợp lệ.');
  const origin = Math.min(...flights.map(f => Math.min(f.ready, f.ctot - 5)));
  const ready = flights.map(f => f.ready - origin);
  const ctot = flights.map(f => f.ctot - origin);
  if (blocked.some(w => !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start)) throw new Error('Khoảng đóng đường băng không hợp lệ.');
  const windows = blocked.map(w => ({ start: w.start - origin, end: w.end - origin })).filter(w => w.end > 0);
  const horizon = Math.max(...ready, ...ctot, ...windows.map(w => w.end)) + n * separation + 60;
  const bigM = horizon + separation + Math.max(0, ...windows.map(w => -w.start));
  const penalty = n * horizon + 1;
  const lines = ['Minimize', ` obj: ${flights.map((_, i) => `t_${i}`).join(' + ')} + ${flights.map((_, i) => `${penalty} miss_${i}`).join(' + ')}`, 'Subject To'];
  for (let i = 0; i < n; i++) {
    lines.push(` ready_${i}: t_${i} >= ${Math.max(ready[i], ctot[i] - 5)}`);
    if (previousWake === 'H' && flights[i].wake === 'H') lines.push(` previous_heavy_${i}: rank_${i} >= 1`);
    if (lastWake && flights[i].wake !== lastWake) lines.push(` last_wake_${i}: rank_${i} <= ${n - 2}`);
    const buffer = flights[i].planningBufferMinutes ?? 0;
    if (!Number.isFinite(buffer) || buffer < 0 || buffer > 10) throw new Error('Biên dự phòng không hợp lệ.');
    lines.push(` deadline_${i}: t_${i} - ${bigM} miss_${i} <= ${ctot[i] + 10 - buffer}`);
    windows.forEach((window, w) => {
      lines.push(` before_block_${i}_${w}: t_${i} - ${bigM} after_${i}_${w} <= ${window.start}`);
      lines.push(` after_block_${i}_${w}: t_${i} - ${bigM} after_${i}_${w} >= ${window.end - bigM}`);
    });
    for (let j = i + 1; j < n; j++) {
      const y = `before_${i}_${j}`;
      const gap = flights[i].wake === 'H' && flights[j].wake === 'H' ? 2 : 1;
      const rankM = n + 1;
      lines.push(` time_f_${i}_${j}: t_${j} - t_${i} - ${bigM} ${y} >= ${separation - bigM}`);
      lines.push(` time_b_${i}_${j}: t_${i} - t_${j} + ${bigM} ${y} >= ${separation}`);
      lines.push(` rank_f_${i}_${j}: rank_${j} - rank_${i} - ${rankM} ${y} >= ${gap - rankM}`);
      lines.push(` rank_b_${i}_${j}: rank_${i} - rank_${j} + ${rankM} ${y} >= ${gap}`);
    }
  }
  lines.push('Bounds');
  for (let i = 0; i < n; i++) lines.push(` 0 <= t_${i} <= ${horizon}`, ` 0 <= rank_${i} <= ${n - 1}`);
  lines.push('Generals', ...flights.map((_, i) => ` rank_${i}`), 'Binary', ...flights.map((_, i) => ` miss_${i}`));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) lines.push(` before_${i}_${j}`);
    windows.forEach((_, w) => lines.push(` after_${i}_${w}`));
  }
  lines.push('End');
  const result = solver.solve(lines.join('\n'), { output_flag: false, time_limit: n > 12 ? 20 : 3 });
  if (result.Status !== 'Optimal' && result.Status !== 'Time limit reached') throw new Error(`MILP chưa có nghiệm khả thi được xác nhận: ${result.Status}`);
  const value = (name: string) => (result.Columns[name] as { Primal?: number } | undefined)?.Primal;
  const ordered = flights.map((f, i) => {
    const time = value(`t_${i}`);
    if (time === undefined || !Number.isFinite(time)) throw new Error('Nghiệm MILP không hợp lệ.');
    if (windows.some(w => time > w.start + 1e-6 && time < w.end - 1e-6)) throw new Error('Nghiệm MILP nằm trong khoảng đóng đường băng.');
    return { id: f.id, takeoff: time + origin, missed: time > ctot[i] + 10 + 1e-6 };
  }).sort((a, b) => a.takeoff - b.takeoff);
  for (let i = 0; i < n; i++) {
    const f = flights.find(item => item.id === ordered[i].id)!;
    if (ordered[i].takeoff < Math.max(f.ready, f.ctot - 5) - 1e-6 || (i && ordered[i].takeoff < ordered[i - 1].takeoff + separation - 1e-6) || (i && f.wake === 'H' && flights.find(g => g.id === ordered[i - 1].id)!.wake === 'H')) throw new Error('Nghiệm MILP vi phạm ràng buộc.');
  }
  if (previousWake === 'H' && flights.find(f => f.id === ordered[0].id)!.wake === 'H') throw new Error('Nghiệm MILP vi phạm hạng tàu trước đó.');
  if (lastWake && flights.find(f => f.id === ordered.at(-1)!.id)!.wake !== lastWake) throw new Error('Nghiệm MILP vi phạm hạng tàu cuối.');
  return ordered;
}
