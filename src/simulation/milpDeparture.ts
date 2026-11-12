/** Independent runway sequencing model. Times are minutes from a shared origin.
 * This does not model surface traffic or weather and must not be used as an
 * operational schedule until the resulting trajectories are validated. */
export type MilpDeparture = { id: string; ready: number; ctot: number; wake: 'H' | 'M'; planningBufferMinutes?: number };
export type MilpRunwayResult = { id: string; takeoff: number; missed: boolean };
export type MilpSolver = { solve: (model: string, options: { output_flag: boolean; time_limit: number }) => {
  Status: string; Columns: Record<string, unknown>;
} };

/** Solve an explicitly bounded, small runway ordering problem with HiGHS. */
export function solveDepartureMilp(solver: MilpSolver, flights: MilpDeparture[], separation = 2, blocked: { start: number; end: number }[] = []): MilpRunwayResult[] {
  if (flights.length === 0) return [];
  if (flights.length > 12) throw new Error('Mô hình thử nghiệm chỉ hỗ trợ tối đa 12 chuyến.');
  if (!Number.isFinite(separation) || !(separation > 0) || flights.some(f => !Number.isFinite(f.ready) || !Number.isFinite(f.ctot)) || new Set(flights.map(f => f.id)).size !== flights.length) {
    throw new Error('Dữ liệu chuyến bay không hợp lệ.');
  }
  const n = flights.length;
  const origin = Math.min(...flights.map(f => Math.min(f.ready, f.ctot - 5)));
  const ready = flights.map(f => f.ready - origin);
  const ctot = flights.map(f => f.ctot - origin);
  if (blocked.some(w => !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start)) throw new Error('Khoảng đóng đường băng không hợp lệ.');
  const windows = blocked.map(w => ({ start: w.start - origin, end: w.end - origin })).filter(w => w.end > 0);
  const horizon = Math.max(...ready, ...ctot, ...windows.map(w => w.end)) + n * separation + 60;
  const bigM = horizon + Math.max(0, ...windows.map(w => -w.start)) + 10;
  // This bound ensures a single additional missed slot costs more than all
  // possible changes in the sum of takeoff times in this finite horizon.
  const missPenalty = n * horizon + 1;
  const x = (i: number, p: number) => `x_${i}_${p}`;
  const lines = ['Minimize', ` obj: ${Array.from({ length: n }, (_, p) => `t_${p}`).join(' + ')} + ${flights.map((_, i) => `${missPenalty} miss_${i}`).join(' + ')}`, 'Subject To'];
  for (let i = 0; i < n; i++) lines.push(` assign_${i}: ${Array.from({ length: n }, (_, p) => x(i, p)).join(' + ')} = 1`);
  for (let p = 0; p < n; p++) {
    lines.push(` position_${p}: ${flights.map((_, i) => x(i, p)).join(' + ')} = 1`);
    if (p) lines.push(` separation_${p}: t_${p} - t_${p - 1} >= ${separation}`);
    windows.forEach((window, w) => {
      lines.push(` before_block_${p}_${w}: t_${p} - ${bigM} after_${p}_${w} <= ${window.start}`);
      lines.push(` after_block_${p}_${w}: t_${p} - ${bigM} after_${p}_${w} >= ${window.end - bigM}`);
    });
    const heavy = flights.map((f, i) => f.wake === 'H' ? i : -1).filter(i => i >= 0);
    if (p && heavy.length > 0) {
      const terms = heavy.flatMap(i => [x(i, p - 1), x(i, p)]);
      lines.push(` heavy_${p}: ${terms.join(' + ')} <= 1`);
    }
    for (let i = 0; i < n; i++) {
      lines.push(` ready_${i}_${p}: t_${p} - ${bigM} ${x(i, p)} >= ${Math.max(ready[i], ctot[i] - 5) - bigM}`);
      lines.push(` deadline_${i}_${p}: t_${p} + ${bigM} ${x(i, p)} - ${bigM} miss_${i} <= ${ctot[i] + 10 + bigM}`);
    }
  }
  lines.push('Bounds', ...Array.from({ length: n }, (_, p) => ` 0 <= t_${p} <= ${horizon}`), 'Binary');
  for (let i = 0; i < n; i++) lines.push(` miss_${i}`, ...Array.from({ length: n }, (_, p) => ` ${x(i, p)}`));
  for (let p = 0; p < n; p++) windows.forEach((_, w) => lines.push(` after_${p}_${w}`));
  lines.push('End');
  const result = solver.solve(lines.join('\n'), { output_flag: false, time_limit: 10 });
  if (result.Status !== 'Optimal') throw new Error(`MILP chưa có nghiệm tối ưu được xác nhận: ${result.Status}`);
  const value = (name: string) => (result.Columns[name] as { Primal?: number } | undefined)?.Primal;
  const output: MilpRunwayResult[] = [];
  for (let p = 0; p < n; p++) {
    const assigned = flights.map((_, i) => i).filter(i => (value(x(i, p)) ?? 0) > 0.5);
    const time = value(`t_${p}`);
    if (assigned.length !== 1 || time === undefined || !Number.isFinite(time)) throw new Error('Nghiệm MILP không hợp lệ.');
    const i = assigned[0];
    if (windows.some(w => time > w.start + 1e-6 && time < w.end - 1e-6)) throw new Error('Nghiệm MILP nằm trong khoảng đóng đường băng.');
    output.push({ id: flights[i].id, takeoff: time + origin, missed: time > ctot[i] + 10 + 1e-6 });
  }
  for (let p = 0; p < n; p++) {
    const f = flights.find(flight => flight.id === output[p].id)!;
    if (output[p].takeoff < Math.max(f.ready, f.ctot - 5) - 1e-6 || (p && output[p].takeoff < output[p - 1].takeoff + separation - 1e-6) || (p && f.wake === 'H' && flights.find(g => g.id === output[p - 1].id)!.wake === 'H')) throw new Error('Nghiệm MILP vi phạm ràng buộc.');
  }
  if (new Set(output.map(f => f.id)).size !== n) throw new Error('Nghiệm MILP trùng chuyến.');
  return output;
}
