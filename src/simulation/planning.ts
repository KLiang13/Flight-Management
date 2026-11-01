import { runSimulation, toScheduledFlights } from './runSimulation';
import { planSurfaceTraffic } from './surfaceTraffic';
import { scheduleArrivals } from './arrivals';
import { applyWeatherPeriods, enforceSingleCtot } from './weather';
import type { TimelineItem } from './runSimulation';
import type { ArrivalTimelineItem } from './arrivals';
import type { WeatherPeriod } from './weather';

export type PlanningJob =
  | { type: 'day'; rows: Record<string, unknown>[]; arrivals: Record<string, unknown>[]; runway: string }
  | { type: 'weather'; flights: TimelineItem[]; arrivals: ArrivalTimelineItem[]; periods: WeatherPeriod[]; runway: string; horizon: number };

export function computePlan(job: PlanningJob) {
  if (job.type === 'weather') return applyWeatherPeriods(job.flights, job.arrivals, job.periods, job.runway, job.horizon);
  const raw = runSimulation(toScheduledFlights(job.rows), true);
  let flights = enforceSingleCtot(raw.flights);
  for (;;) {
    const physical = planSurfaceTraffic(flights, scheduleArrivals(job.arrivals, flights), job.runway);
    const checked = enforceSingleCtot(physical.flights);
    if (checked.filter(flight => !Number.isFinite(flight.wheelsOff)).length === flights.filter(flight => !Number.isFinite(flight.wheelsOff)).length) return { flights: checked, arrivals: physical.arrivals };
    flights = checked;
  }
}

