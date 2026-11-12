import { scheduleArrivals } from './arrivals';
import { solveRollingMilp } from './milpRolling';
import { solvePairwiseMilp } from './milpPairwise';
import { RUNWAY_MOVEMENT_MS, TAKEOFF_ROLL_MS } from './movementPhysics';
import { toScheduledFlights, type TimelineItem } from './runSimulation';
import { planSurfaceTraffic } from './surfaceTraffic';
import { enforceSingleCtot } from './weather';
import type { MilpSolver } from './milpDeparture';

/** Produce a MILP departure schedule, then reserve physical routes and
 * suspend departures that fail the original CTOT or wake constraints. */
export function computeMilpDayCandidate(solver: MilpSolver, rows: Record<string, unknown>[], incoming: Record<string, unknown>[], runway: string) {
  const scheduled = toScheduledFlights(rows);
  const inputs = scheduled.map(f => ({
    id: f.id, wake: f.wakeCategory, ctot: f.ctot / 60_000, planningBufferMinutes: 3,
    ready: Math.max(f.readyAt + f.taxiMinutes * 60_000 + RUNWAY_MOVEMENT_MS,
      f.forceCtotMiss ? f.ctot + 600_001 : -Infinity) / 60_000,
  }));
  const decision = inputs.length <= 70
    ? { scheduled: solvePairwiseMilp(solver, inputs, RUNWAY_MOVEMENT_MS / 60_000), held: [] }
    : solveRollingMilp(solver, inputs, RUNWAY_MOVEMENT_MS / 60_000);
  const byId = new Map(scheduled.map(f => [f.id, f]));
  const solution = [...decision.scheduled, ...decision.held.map(f => ({ id: f.id, takeoff: Infinity, missed: true }))];
  let flights: TimelineItem[] = solution.map((result, index) => {
    const flight = byId.get(result.id)!;
    const wheelsOff = result.takeoff * 60_000;
    return { ...flight, order: index + 1, taxiStart: flight.readyAt, tsat: flight.readyAt,
      wheelsOff, runwayEntryStart: wheelsOff - RUNWAY_MOVEMENT_MS,
      takeoffRollStart: wheelsOff - TAKEOFF_ROLL_MS, waitMinutes: 0, missedCtot: result.missed,
      reissuedCtot: null, reissuedTsat: null, returnStart: null, returnEnd: null, returnStand: null,
      secondTaxiStart: null, status: result.missed ? 'Không tuân thủ CTOT' : 'Đúng CTOT' };
  });
  flights = enforceSingleCtot(flights);
  for (;;) {
    const physical = planSurfaceTraffic(flights, scheduleArrivals(incoming, flights), runway);
    const checked = enforceSingleCtot(physical.flights);
    if (checked.filter(f => !Number.isFinite(f.wheelsOff)).length === flights.filter(f => !Number.isFinite(f.wheelsOff)).length) return { flights: checked, arrivals: physical.arrivals };
    flights = checked;
  }
}
