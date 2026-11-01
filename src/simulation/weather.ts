import type { TimelineItem } from './runSimulation';
import { RUNWAY_MOVEMENT_MS, TAKEOFF_ROLL_MS } from './movementPhysics';
import type { ArrivalTimelineItem } from './arrivals';
import { departurePosition, arrivalPosition } from '../map/playback';
import type { SurfacePlan } from './surfaceTraffic';
import { weatherTrajectory, reserveWeatherMovements, WeatherSurfaceConflict, type WeatherMovement } from './weatherSurface';
import { getNearestReturnStand, getStandPoint, getTaxiRoutePoints, type MapPoint } from '../map/airfieldGeometry';
import type { DclEvent } from '../dcl/dclScenario';
import { departureCtotAt, departureTsatAt, departureWaitMinutesAt } from './departureTiming';
import { releaseTakeoffRoll, arrivalDelayForBookedRolls, reserveCrossingsBeforeDeparture } from './runwayCoordination';
import { CTOT_COMMIT_POINT, weatherReturnVia1A } from '../map/surfaceGraph';

const MINUTE = 60_000;
const MOVEMENT = RUNWAY_MOVEMENT_MS;
export type WeatherPeriod = { start: number; end: number | null };
export type WeatherDepartureState = WeatherPeriod & {
  previous: TimelineItem; heldAtStand: boolean; groundStand: string; surfacePlan?: SurfacePlan;
  atStand?: boolean; passedWeatherPoint?: boolean; outboundRoute?: MapPoint[]; assignedCtot?: number;
  missedAt: number | null; returnStart: number | null; returnEnd: number | null;
  returnStand: string | null; returnPath: MapPoint[]; returnedAfterStartup?: boolean;
  resumedTaxiStart: number; groundReadyAt: number; revisionAt: number | null;
  blockedAt?: number; awaitTsat?: boolean; normalSuspension?: boolean; offApron?: boolean;
};
export type WeatherArrivalState = WeatherPeriod & { previous: ArrivalTimelineItem; surfacePlan?: SurfacePlan };

function pathLength(path: MapPoint[]): number {
  return path.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - path[index].x, point.y - path[index].y), 0);
}

type Reservation = { stand: string; from: number; until: number; id: string };

function applyPeriod(departures: TimelineItem[], incoming: ArrivalTimelineItem[], period: WeatherPeriod, runway: string, horizon: number) {
  const release = period.end ?? Infinity;
  const diverted = incoming.filter(arrival => arrival.divertedAt !== undefined
    || (arrival.touchdown >= period.start && arrival.approachStart < release))
    .map(arrival => arrival.divertedAt !== undefined ? arrival
      : { ...arrival, divertedAt: Math.max(period.start, arrival.approachStart) });
  const divertedIds = new Set(diverted.map(arrival => arrival.id));
  const inbound = incoming.filter(arrival => !divertedIds.has(arrival.id));
  const reservations: Reservation[] = departures.map((flight) => ({
    stand: flight.stand, from: flight.readyAt - 45 * MINUTE,
    until: flight.taxiStart >= period.start ? Math.max(flight.taxiStart, release) : flight.taxiStart, id: flight.id,
  }));
  for (const flight of departures) if (flight.returnStand && flight.returnStart !== null) reservations.push({
    stand: flight.returnStand, from: flight.returnStart, until: flight.secondTaxiStart ?? Infinity, id: flight.id,
  });
  for (const arrival of inbound) if (Number.isFinite(arrival.standArrival) && arrival.approachStart < period.start) reservations.push({
    stand: arrival.stand, from: arrival.standArrival, until: Infinity, id: arrival.id,
  });
  const currentState = (flight: TimelineItem) => flight.weather?.start === period.start ? flight.weather : undefined;
  const activeSlot = (flight: TimelineItem) => departureCtotAt(flight, period.start);
  const previousTakeoff = (flight: TimelineItem) => Number.isFinite(flight.wheelsOff) ? flight.wheelsOff
    : flight.weather?.passedWeatherPoint && !flight.weather.returnStand ? -Infinity : Infinity;
  function stateFor(previous: TimelineItem): WeatherDepartureState {
    const old = previous.weather;
    const waitingAfterReturn = previous.returnEnd !== null && previous.returnEnd <= period.start
      && (previous.secondTaxiStart ?? Infinity) >= period.start;
    const heldAtStand = previous.taxiStart >= period.start
      || Boolean(old?.heldAtStand && old.resumedTaxiStart >= period.start);
    const groundStand = waitingAfterReturn ? previous.returnStand! : old?.heldAtStand
      ? old.returnStand ?? old.groundStand : previous.stand;
    const position = departurePosition(previous, period.start, 0, runway).point;
    const standPoint = getStandPoint(groundStand);
    const atStand = heldAtStand || Math.hypot(position.x - standPoint.x, position.y - standPoint.y) < 2;
    const passedWeatherPoint = position.x >= CTOT_COMMIT_POINT.x && position.y <= CTOT_COMMIT_POINT.y + 3;
    const outboundRoute = previous.surfacePlan?.legs.find(leg => leg.start <= period.start && period.start < leg.end && leg.points.length > 1)?.points
      ?? getTaxiRoutePoints(groundStand, runway);
    const resumedTaxiStart = atStand ? Math.max(previous.secondTaxiStart ?? previous.taxiStart, release) : previous.taxiStart;
    const groundReadyAt = atStand ? resumedTaxiStart + previous.taxiMinutes * MINUTE
      : Math.max(previous.taxiStart + previous.taxiMinutes * MINUTE,
        previous.secondTaxiStart === null ? -Infinity : previous.secondTaxiStart + previous.taxiMinutes * MINUTE);
    return { ...period, previous, heldAtStand, groundStand, atStand, passedWeatherPoint, outboundRoute, resumedTaxiStart, groundReadyAt,
      missedAt: null, returnStart: null, returnEnd: null, returnStand: null, returnPath: [], returnedAfterStartup: old?.returnedAfterStartup, revisionAt: period.end };
  }
  function divert(state: WeatherDepartureState): WeatherDepartureState {
    const previous = state.previous;
    const missedAt = Math.max(period.start, activeSlot(previous) + 10 * MINUTE + 1);
    if (state.heldAtStand || state.atStand) return { ...state, missedAt: state.heldAtStand ? null : missedAt };
    if (state.returnStand || state.passedWeatherPoint) {
      return { ...state, missedAt, revisionAt: state.returnEnd === null ? period.end : state.revisionAt };
    }
    let returnStart = period.start;
    let returnEnd: number | null = missedAt;
    let returnStand: string | null = state.groundStand;
    let route: MapPoint[] = [];
    if (!state.heldAtStand) {
      returnStand = null;
      const times = [period.start, ...reservations.filter((item) => item.until > period.start && Number.isFinite(item.until)).map((item) => item.until)]
        .sort((a, b) => a - b);
      for (const time of times) {
        const occupied = new Set(reservations.filter((item) => item.id !== previous.id && item.from <= time && item.until > time).map((item) => item.stand));
        const candidate = getNearestReturnStand(state.groundStand, occupied, previous.wakeCategory, departurePosition(previous, period.start, 0, runway).point);
        if (!occupied.has(candidate)) { returnStart = time; returnStand = candidate; break; }
      }
      returnEnd = null;
      if (returnStand) {
        const point = departurePosition(previous, period.start, 0, runway).point;
        route = weatherReturnVia1A(point, state.outboundRoute ?? getTaxiRoutePoints(state.groundStand, runway), returnStand);
        returnEnd = returnStart + Math.max(MINUTE, pathLength(route) * (3059 / 1750) / 1852 / 20 * 3_600_000);
      }
    }
    const resumedTaxiStart = Math.max(release, (returnEnd ?? Infinity) + MOVEMENT);
    if (returnStand) reservations.push({ stand: returnStand, from: returnStart, until: resumedTaxiStart, id: previous.id });
    return { ...state, missedAt: period.start, blockedAt: period.start, returnStart, returnEnd, returnStand, returnPath: route, resumedTaxiStart,
      groundReadyAt: resumedTaxiStart + previous.taxiMinutes * MINUTE,
      revisionAt: period.end === null || returnEnd === null ? null : Math.max(period.end, returnEnd) };
  }
  function withState(input: WeatherDepartureState, forecast: number): TimelineItem {
    const previous = input.previous;
    const deadline = previous.ctot - previous.taxiMinutes * MINUTE;
    const blocked = input.blockedAt !== undefined || (input.end !== null && (
      (input.heldAtStand && input.end >= deadline) || (!input.passedWeatherPoint && forecast > previous.ctot + 10 * MINUTE)));
    const state: WeatherDepartureState = { ...input,
      blockedAt: blocked ? input.blockedAt ?? input.end ?? input.start : undefined,
      awaitTsat: blocked && input.heldAtStand,
      returnedAfterStartup: Boolean(input.returnedAfterStartup || (!input.heldAtStand && input.returnStand)),
      resumedTaxiStart: blocked && (input.atStand || input.returnStand) ? Infinity : input.resumedTaxiStart,
      groundReadyAt: blocked && (input.atStand || input.returnStand) ? Infinity : input.groundReadyAt,
      assignedCtot: previous.ctot };
    const wheelsOff = blocked ? Infinity : forecast;
    const result: TimelineItem = { ...previous, weather: state, wheelsOff,
      runwayEntryStart: wheelsOff - MOVEMENT, takeoffRollStart: wheelsOff - TAKEOFF_ROLL_MS,
      missedCtot: previous.missedCtot || blocked || forecast > previous.ctot + 10 * MINUTE,
      returnStart: state.returnStart, returnEnd: state.returnEnd, returnStand: state.returnStand,
      secondTaxiStart: state.resumedTaxiStart, reissuedCtot: null,
      reissuedTsat: !blocked && state.heldAtStand && state.end !== null
        && state.resumedTaxiStart !== departureTsatAt(previous, state.start) ? state.resumedTaxiStart : null,
      waitMinutes: 0, status: blocked ? 'Không tuân thủ CTOT' : 'Chờ khởi hành' };
    result.waitMinutes = departureWaitMinutesAt(result, wheelsOff);
    return result;
  }
  const committed = departures.filter((flight) => flight.takeoffRollStart < period.start);
  let pending = departures.filter((flight) => flight.takeoffRollStart >= period.start).map((previous) => {
    if (previous.weather?.blockedAt !== undefined && !(previous.weather.passedWeatherPoint && !previous.weather.returnStand)) return previous;
    let state = stateFor(previous);
    // A shower that clears before the planned startup does not revise that clearance.
    if (state.heldAtStand && state.resumedTaxiStart === (previous.secondTaxiStart ?? previous.taxiStart)
      && state.resumedTaxiStart >= release) return previous;
    if (!state.heldAtStand && !state.atStand && !state.passedWeatherPoint) state = divert(state);
    const earliest = Math.max(previousTakeoff(previous), release + MOVEMENT, state.groundReadyAt + MOVEMENT);
    if (state.returnStart === null && earliest === previous.wheelsOff && (!state.heldAtStand || state.resumedTaxiStart === (previous.secondTaxiStart ?? previous.taxiStart))) return previous;
    if (!state.heldAtStand && earliest > activeSlot(previous) + 10 * MINUTE) state = divert(state);
    return withState(state, Math.max(earliest, state.groundReadyAt + MOVEMENT));
  });
  const suspended = pending.filter(flight => flight.weather?.blockedAt !== undefined);
  pending = pending.filter(flight => flight.weather?.blockedAt === undefined);
  if (period.end !== null && suspended.some(flight => flight.weather?.passedWeatherPoint)) {
    for (const flight of pending) suspended.push(withState({ ...(currentState(flight) ?? stateFor(flight)), blockedAt: period.end }, Infinity));
    pending = [];
  }
  let flights: TimelineItem[];
  let landingForecast: ArrivalTimelineItem[] | null = null;
  if (period.end === null) {
    flights = [...committed, ...suspended, ...pending];
  } else {
    // Reserve startup times in time order, so a later return to stand cannot
    // block an otherwise ready aircraft with a valid slot.
    const taxiStarts = departures.filter((flight) => !pending.some((item) => item.id === flight.id && currentState(item))).map((flight) => flight.secondTaxiStart ?? flight.taxiStart);
    function reserveTaxi(desired: number): number {
      if (!Number.isFinite(desired)) return desired;
      let next = desired;
      for (const occupied of [...taxiStarts].sort((a, b) => a - b)) {
        if (next + MOVEMENT <= occupied) break;
        if (next < occupied + MOVEMENT) next = occupied + MOVEMENT;
      }
      taxiStarts.push(next);
      return next;
    }
    const needsStartup = pending.filter((flight) => currentState(flight) && (currentState(flight)!.heldAtStand || currentState(flight)!.atStand || currentState(flight)!.returnStand !== null))
      .sort((a, b) => a.weather!.resumedTaxiStart - b.weather!.resumedTaxiStart
        || Number(a.weather!.missedAt !== null) - Number(b.weather!.missedAt !== null) || a.order - b.order);
    for (const flight of needsStartup) {
      const state = flight.weather!;
      const start = reserveTaxi(state.resumedTaxiStart);
      const next = { ...state, resumedTaxiStart: start, groundReadyAt: start + flight.taxiMinutes * MINUTE };
      Object.assign(flight, withState(next, Math.max(next.previous.wheelsOff, next.groundReadyAt + MOVEMENT)));
    }
    const completed = [...committed].sort((a, b) => a.wheelsOff - b.wheelsOff);
    let forecastLandingAvailable = -Infinity;
    const arrivalForecast = [...inbound].sort((a, b) => a.touchdown - b.touchdown || a.id.localeCompare(b.id)).map(arrival => {
      if (arrival.approachStart < period.start) {
        forecastLandingAvailable = arrival.touchdown + MOVEMENT;
        return arrival;
      }
      let approachStart = Math.max(arrival.approachStart, release, forecastLandingAvailable);
      const provisional = { ...arrival, approachStart, touchdown: arrival.touchdown + approachStart - arrival.approachStart };
      approachStart += arrivalDelayForBookedRolls(provisional, 0, committed.map(flight => flight.takeoffRollStart));
      const delay = approachStart - arrival.approachStart;
      const forecast = { ...arrival, approachStart, touchdown: arrival.touchdown + delay, p5HoldAt: arrival.p5HoldAt + delay };
      forecastLandingAvailable = forecast.touchdown + MOVEMENT;
      return forecast;
    });
    landingForecast = arrivalForecast;
    const servedCrossings = new Set(inbound.filter(arrival => arrival.crossingStart < period.start).map(arrival => arrival.id));
    let available = completed.at(-1)?.wheelsOff ?? -Infinity;
    if (Number.isFinite(available)) available += MOVEMENT;
    const earliest = (flight: TimelineItem) => currentState(flight)
      ? Math.max(previousTakeoff(currentState(flight)!.previous), release + MOVEMENT, currentState(flight)!.groundReadyAt + MOVEMENT)
      : flight.wheelsOff;
    while (pending.length) {
      const expired = (flight: TimelineItem) => Boolean(currentState(flight)?.returnedAfterStartup || currentState(flight)?.returnStand)
        || (currentState(flight)?.missedAt ?? Infinity) <= Math.max(release, available, earliest(flight));
      pending.sort((a, b) => Number(Boolean(currentState(b)?.passedWeatherPoint)) - Number(Boolean(currentState(a)?.passedWeatherPoint))
        || Number(expired(a)) - Number(expired(b))
        || earliest(a) - earliest(b) || a.order - b.order);
      let index = 0;
      const heavyCount = pending.filter((flight) => flight.wakeCategory === 'H').length;
      const mediumCount = pending.length - heavyCount;
      if (completed.at(-1)?.wakeCategory !== 'H' && pending[0].wakeCategory === 'M' && heavyCount > mediumCount) {
        index = pending.findIndex((flight) => flight.wakeCategory === 'H');
      }
      if (completed.at(-1)?.wakeCategory === 'H' && pending[0].wakeCategory === 'H') {
        index = pending.findIndex((flight) => flight.wakeCategory === 'M');
        if (index < 0) {
          for (const item of pending) suspended.push(withState({ ...(currentState(item) ?? stateFor(item)), blockedAt: period.end ?? period.start }, Infinity));
          pending.length = 0; break;
        }
      }
      let [flight] = pending.splice(index, 1);
      if (flight.weather?.blockedAt !== undefined) { suspended.push(flight); continue; }
      let wheelsOff = Math.max(earliest(flight), available);
      let previousTakeoff: number;
      let crossingPriority: { entry: number; served: string[] };
      do {
        previousTakeoff = wheelsOff;
        crossingPriority = reserveCrossingsBeforeDeparture(wheelsOff - MOVEMENT,
          completed.length ? completed.at(-1)!.wheelsOff + 10_000 : -Infinity,
          arrivalForecast.filter(arrival => !servedCrossings.has(arrival.id))
            .map(arrival => ({ id: arrival.id, p5HoldAt: Math.max(arrival.p5HoldAt, period.start) })));
        wheelsOff = crossingPriority.entry + MOVEMENT;
        wheelsOff = releaseTakeoffRoll(wheelsOff - TAKEOFF_ROLL_MS, arrivalForecast) + TAKEOFF_ROLL_MS;
        for (const crossing of inbound.filter((arrival) => arrival.crossingStart < period.start).sort((a, b) => a.crossingStart - b.crossingStart)) {
          if (wheelsOff - MOVEMENT < crossing.crossingEnd + 10_000 && wheelsOff > crossing.crossingStart) {
            wheelsOff = crossing.crossingEnd + 10_000 + MOVEMENT;
          }
        }
      } while (Number.isFinite(wheelsOff) && wheelsOff > previousTakeoff);
      const state = currentState(flight);
      const previous = state?.previous ?? flight;
      if (Number.isFinite(wheelsOff) && !state?.heldAtStand && (state?.missedAt ?? null) === null && wheelsOff > activeSlot(previous) + 10 * MINUTE) {
        let state = divert(currentState(flight) ?? stateFor(previous));
        const start = reserveTaxi(state.resumedTaxiStart);
        state = { ...state, resumedTaxiStart: start, groundReadyAt: start + flight.taxiMinutes * MINUTE };
        pending.push(withState(state, state.groundReadyAt + MOVEMENT));
        continue;
      }
      if (state || wheelsOff > flight.wheelsOff) flight = withState(state ?? stateFor(previous), wheelsOff);
      if (flight.weather?.blockedAt !== undefined) suspended.push(flight);
      else {
        for (const id of crossingPriority.served) servedCrossings.add(id);
        completed.push(flight); available = wheelsOff + MOVEMENT;
      }
    }
    flights = [...completed, ...suspended];
  }
  flights = flights.map((flight, index) => flight.order === index + 1 ? flight : { ...flight, order: index + 1 });

  let landingAvailable = -Infinity;
  let crossingAvailable = -Infinity;
  const arrivals = [...inbound].sort((a, b) => a.touchdown - b.touchdown || a.id.localeCompare(b.id)).map((previous) => {
    let arrival = previous;
    if (previous.approachStart >= period.start) {
      let approachStart = Math.max(previous.approachStart, release, landingAvailable);
      const provisional = { ...previous, approachStart, touchdown: previous.touchdown + approachStart - previous.approachStart };
      const forecast = landingForecast?.find(item => item.id === previous.id);
      if (forecast) approachStart = forecast.approachStart;
      else approachStart += arrivalDelayForBookedRolls(provisional, 0, flights.map(flight => flight.takeoffRollStart));
      const delay = approachStart - previous.approachStart;
      if (delay > 0) arrival = {
        ...previous, weather: { ...period, previous }, approachStart,
        touchdown: previous.touchdown + delay, landingEnd: previous.landingEnd + delay,
        p5HoldAt: previous.p5HoldAt + delay, crossingStart: previous.crossingStart + delay,
        crossingEnd: previous.crossingEnd + delay, standArrival: previous.standArrival + delay,
      };
    }
    landingAvailable = arrival.touchdown + MOVEMENT;
    if (!Number.isFinite(arrival.touchdown)) return arrival;
    if (previous.crossingStart < period.start) {
      crossingAvailable = Math.max(crossingAvailable, previous.crossingEnd + 15_000);
      return arrival;
    }
    // A revised clearance cannot move an aircraft retroactively before this weather event.
    let crossingStart = Math.max(arrival.p5HoldAt, crossingAvailable, period.start);
    for (const departure of flights) {
      if (Number.isFinite(departure.wheelsOff) && crossingStart < departure.wheelsOff + 10_000
        && crossingStart + 45_000 > departure.runwayEntryStart) crossingStart = departure.wheelsOff + 10_000;
    }
    crossingAvailable = crossingStart + MINUTE;
    const standArrival = crossingStart + 45_000 + (arrival.standArrival - arrival.crossingEnd);
    const changed = crossingStart !== previous.crossingStart || standArrival !== previous.standArrival;
    return { ...arrival, crossingStart, crossingEnd: crossingStart + 45_000, standArrival,
      // Preserve pre-weather playback, then animate the revised crossing times.
      ...(changed ? { weather: { ...period, previous }, surfacePlan: undefined } : {}) };
  });
  return reserveWeatherPlan(flights, [...arrivals, ...diverted], period, runway, horizon);
}

/** Validate the actual post-weather trajectories with the same surface reservations as normal operations. */
function reserveWeatherPlan(flights: TimelineItem[], arrivals: ArrivalTimelineItem[], period: WeatherPeriod, runway: string, horizon: number, tried = new Map<string, Set<string>>()) {
  // Synthetic scheduler-only inputs do not yet have calibrated surface trajectories.
  if (!flights.some(flight => flight.surfacePlan) && !arrivals.some(arrival => arrival.surfacePlan)) return { flights, arrivals };
  const movements: WeatherMovement[] = [];
  for (const arrival of arrivals) {
    if (arrival.divertedAt !== undefined || arrival.standArrival + 45 * MINUTE <= period.start) continue;
    const start = Math.max(period.start, arrival.approachStart), end = arrival.standArrival + 45 * MINUTE;
    movements.push({ id: arrival.id, radius: arrival.wakeCategory === 'H' ? 15 : 9, start, end, minimumDelay: 0, holdAtStart: arrival.approachStart <= period.start, priority: arrival.approachStart <= period.start ? 0 : 2,
      legs: weatherTrajectory(start, end, time => arrivalPosition(arrival, time), [arrival.touchdown, arrival.landingEnd, arrival.p5HoldAt, arrival.crossingStart, arrival.crossingEnd, arrival.standArrival]),
      releaseDelay: (delay, booked) => arrivalDelayForBookedRolls(arrival, delay,
        flights.filter(flight => booked.has(flight.id)).map(flight => flight.takeoffRollStart + booked.get(flight.id)!.delay)) });
  }
  const ordered = [...flights].sort((a, b) => a.order - b.order);
  for (const flight of ordered) {
    if (flight.weather?.offApron || flight.wheelsOff <= period.start || flight.tsat - 20 * MINUTE > horizon) continue;
    const state = flight.weather;
    const visibleStart = Math.max(period.start, flight.tsat - 20 * MINUTE);
    const start = state?.returnEnd !== null && state?.returnEnd !== undefined ? Math.max(visibleStart, state.returnEnd) : visibleStart;
    if (state?.returnEnd !== null && state?.returnEnd !== undefined && state.returnEnd > visibleStart) {
      movements.push({ id: flight.id, returning: true, priority: .25 - departurePosition(flight, visibleStart, 0, runway).point.x / 10000,
        radius: flight.wakeCategory === 'H' ? 15 : 9, start: visibleStart, end: state.returnEnd, minimumDelay: 0,
        legs: weatherTrajectory(visibleStart, state.returnEnd, time => departurePosition(flight, time, 0, runway)),
        releaseDelay: delay => delay });
    }
    const remainingTaxiEnd = state && !state.heldAtStand && !state.returnStand && Number.isFinite(state.groundReadyAt) ? state.groundReadyAt : start;
    const end = Number.isFinite(flight.wheelsOff) ? flight.wheelsOff : Math.max(start + 2000, state?.returnEnd ?? start, remainingTaxiEnd);
    const queueIndex = (time: number) => ordered.filter(item => {
      const weather = item.weather;
      return weather && !weather.returnStand && !weather.heldAtStand && time >= weather.groundReadyAt && time < item.runwayEntryStart;
    }).findIndex(item => item.id === flight.id);
    const checkpoints = [flight.taxiStart, flight.runwayEntryStart, flight.takeoffRollStart, flight.wheelsOff,
      state?.missedAt ?? Infinity, state?.returnStart ?? Infinity, state?.returnEnd ?? Infinity,
      state?.resumedTaxiStart ?? Infinity, state?.groundReadyAt ?? Infinity,
      ...(state?.previous.surfacePlan?.legs.flatMap(leg => [leg.start, leg.end]) ?? []),
      ...(state?.previous.weather?.surfacePlan?.legs.flatMap(leg => [leg.start, leg.end]) ?? [])];
    const legs = weatherTrajectory(start, end, time => departurePosition(flight, time, Math.max(0, queueIndex(time)), runway), checkpoints);
    if (!Number.isFinite(flight.wheelsOff)) legs.push({ start: end, end: Infinity, points: [departurePosition(flight, end, Math.max(0, queueIndex(end)), runway).point], phase: 'chờ thời tiết tốt' });
    movements.push({ id: flight.id, priority: state?.blockedAt !== undefined && !state.returnStand ? -1 + (flight.tsat - 20 * MINUTE - period.start) / MINUTE / 1_000_000 : 1, radius: flight.wakeCategory === 'H' ? 15 : 9, start,
      end: Number.isFinite(flight.wheelsOff) ? end : Infinity, legs, minimumDelay: 0,
      entryAt: Number.isFinite(flight.runwayEntryStart) ? flight.runwayEntryStart : undefined,
      releaseDelay: (desired, booked) => {
        const delay = Math.max(desired, booked.get(flight.id)?.returnDelay ?? 0);
        if (!Number.isFinite(flight.takeoffRollStart)) return delay;
        return releaseTakeoffRoll(flight.takeoffRollStart + delay, arrivals.filter(item => item.divertedAt === undefined)) - flight.takeoffRollStart;
      } });
  }
  let reserved: ReturnType<typeof reserveWeatherMovements>;
  try { reserved = reserveWeatherMovements(movements); }
  catch (error) {
    if (!(error instanceof WeatherSurfaceConflict)) throw error;
    const arriving = arrivals.find(item => item.id === error.movement.id);
    if (arriving && arriving.approachStart >= period.start) {
      const occupied = new Set(tried.get(arriving.id) ?? []);
      occupied.add(arriving.stand);
      for (const departure of flights) if (departure.weather?.blockedAt !== undefined && !departure.weather.offApron)
        occupied.add(departure.weather.returnStand ?? departure.weather.groundStand);
      for (const other of arrivals) if (other.id !== arriving.id && other.divertedAt === undefined
        && other.standArrival < arriving.standArrival + 45 * MINUTE && other.standArrival + 45 * MINUTE > arriving.standArrival) occupied.add(other.stand);
      const stand = getNearestReturnStand(arriving.stand, occupied, arriving.wakeCategory);
      tried.set(arriving.id, new Set([...occupied, stand]));
      const next = occupied.has(stand) ? { ...arriving, divertedAt: arriving.approachStart }
        : { ...arriving, stand, surfacePlan: undefined, weather: undefined };
      return reserveWeatherPlan(flights, arrivals.map(item => item.id === arriving.id ? next : item), period, runway, horizon, tried);
    }
    const flight = flights.find(item => item.id === error.movement.id);

    if (!flight || (flight.weather ? !flight.weather.heldAtStand : flight.taxiStart < period.start)
      || flight.tsat - 20 * MINUTE < period.start) throw error;
    const from = flight.tsat - 20 * MINUTE, until = flight.secondTaxiStart ?? flight.taxiStart;
    const unavailable = new Set(tried.get(flight.id) ?? []);
    unavailable.add(flight.weather?.groundStand ?? flight.stand);
    for (const other of flights) {
      if (other.id === flight.id) continue;
      const delay = error.booked.get(other.id)?.delay ?? 0;
      if (other.tsat - 20 * MINUTE < until && (other.secondTaxiStart ?? other.taxiStart) + delay > from) unavailable.add(other.weather?.groundStand ?? other.stand);
      if (other.returnStand && (other.returnStart ?? Infinity) < until && (other.secondTaxiStart ?? Infinity) + delay > from) unavailable.add(other.returnStand);
    }
    for (const other of arrivals) if (other.divertedAt === undefined && other.standArrival < until && other.standArrival + 45 * MINUTE > from) unavailable.add(other.stand);
    const stand = getNearestReturnStand(flight.stand, unavailable, flight.wakeCategory, getStandPoint(flight.stand));
    if (unavailable.has(stand)) {
      return reserveWeatherPlan(flights.map(item => item.id === flight.id ? { ...item, weather: { ...item.weather!, offApron: true } } : item), arrivals, period, runway, horizon, tried);
    }
    tried.set(flight.id, new Set([...unavailable, stand]));
    const previous = flight.weather?.previous ?? flight;
    const state = flight.weather ?? { ...period, previous, heldAtStand: true, groundStand: stand,
      missedAt: null, returnStart: null, returnEnd: null, returnStand: null, returnPath: [],
      resumedTaxiStart: flight.taxiStart, groundReadyAt: flight.taxiStart + flight.taxiMinutes * MINUTE, revisionAt: period.end };
    const reassigned = { ...flight, stand, weather: { ...state, groundStand: stand, surfacePlan: undefined } };
    return reserveWeatherPlan(flights.map(item => item.id === flight.id ? reassigned : item), arrivals, period, runway, horizon, tried);
  }
  const newlyExpired = flights.filter(flight => {
    const movement = reserved.get(flight.id), state = flight.weather;
    return movement && state && !state.passedWeatherPoint && state.end !== null && state.blockedAt === undefined
      && ((state.heldAtStand && state.end >= flight.ctot - flight.taxiMinutes * MINUTE)
        || flight.wheelsOff + movement.delay > flight.ctot + 10 * MINUTE);
  });
  if (newlyExpired.length) {
    const ids = new Set(newlyExpired.map(flight => flight.id));
    const blockedS1 = newlyExpired.some(flight => flight.weather?.passedWeatherPoint);
    const stopped = flights.map(flight => {
      if (!ids.has(flight.id) && !(blockedS1 && flight.takeoffRollStart >= period.start)) return flight;
      const state = flight.weather;
      if (!state || state.blockedAt !== undefined) return flight;
      return { ...flight, wheelsOff: Infinity, runwayEntryStart: Infinity, takeoffRollStart: Infinity,
        reissuedCtot: null, reissuedTsat: null, secondTaxiStart: state.heldAtStand || state.returnStand ? Infinity : flight.secondTaxiStart,
        weather: { ...state, blockedAt: period.end ?? period.start, awaitTsat: state.heldAtStand,
          resumedTaxiStart: state.heldAtStand || state.returnStand ? Infinity : state.resumedTaxiStart,
          groundReadyAt: state.heldAtStand || state.returnStand ? Infinity : state.groundReadyAt } };
    });
    return reserveWeatherPlan(stopped, arrivals, period, runway, horizon, tried);
  }
  const shifted = (value: number | null, delay: number) => value !== null && value >= period.start ? value + delay : value;
  const safeArrivals = arrivals.map(arrival => {
    const movement = reserved.get(arrival.id);
    if (!movement) return arrival;
    const delay = movement.delay;
    return { ...arrival, weather: { ...period, previous: arrival, surfacePlan: movement.plan },
      approachStart: shifted(arrival.approachStart, delay)!, touchdown: shifted(arrival.touchdown, delay)!,
      landingEnd: shifted(arrival.landingEnd, delay)!, p5HoldAt: shifted(arrival.p5HoldAt, delay)!,
      crossingStart: shifted(arrival.crossingStart, delay)!, crossingEnd: shifted(arrival.crossingEnd, delay)!,
      standArrival: arrival.standArrival + delay };
  });
  const safeFlights = flights.map(flight => {
    const movement = reserved.get(flight.id);
    if (!movement) return flight;
    const delay = movement.delay, returnDelay = movement.returnDelay ?? delay;
    const state = flight.weather ?? { ...period, previous: flight, heldAtStand: flight.taxiStart >= period.start,
      groundStand: flight.stand, atStand: flight.taxiStart >= period.start, missedAt: null,
      returnStart: null, returnEnd: null, returnStand: null, returnPath: [],
      resumedTaxiStart: flight.taxiStart, groundReadyAt: flight.taxiStart + flight.taxiMinutes * MINUTE, revisionAt: period.end };
    const wheelsOff = flight.wheelsOff + delay;
    const oldSlot = departureCtotAt(state.previous, period.start);
    const returned = Boolean(state.returnedAfterStartup || state.returnStand);
    const assignedCtot = flight.ctot;
    const next: TimelineItem = { ...flight, wheelsOff,
      runwayEntryStart: flight.runwayEntryStart + delay, takeoffRollStart: flight.takeoffRollStart + delay,
      returnStart: shifted(flight.returnStart, returnDelay), returnEnd: shifted(flight.returnEnd, returnDelay),
      secondTaxiStart: shifted(flight.secondTaxiStart, delay),
      reissuedTsat: state.blockedAt === undefined && delay > 0 && state.heldAtStand ? (flight.reissuedTsat ?? flight.tsat) + delay : flight.reissuedTsat,
      reissuedCtot: null,
      weather: { ...state, surfacePlan: movement.plan, assignedCtot, returnedAfterStartup: returned,
        returnStart: shifted(state.returnStart, returnDelay), returnEnd: shifted(state.returnEnd, returnDelay),
        resumedTaxiStart: state.resumedTaxiStart + delay, groundReadyAt: state.groundReadyAt + delay,
        revisionAt: state.revisionAt === null ? null : Math.max(state.revisionAt, shifted(state.returnEnd, returnDelay) ?? -Infinity) } };
    next.waitMinutes = departureWaitMinutesAt(next, wheelsOff);
    return next;
  });
  return { flights: safeFlights, arrivals: safeArrivals };
}

/** CTOT is issued once. A missed original slot has no automatic restart. */
export function enforceSingleCtot(flights: TimelineItem[]): TimelineItem[] {
  function suspend(flight: TimelineItem): TimelineItem {
    if (flight.weather?.blockedAt !== undefined) return { ...flight, reissuedCtot: null, reissuedTsat: null };
    return { ...flight, wheelsOff: Infinity, runwayEntryStart: Infinity, takeoffRollStart: Infinity,
      missedCtot: true, reissuedCtot: null, reissuedTsat: null, returnStart: null, returnEnd: null, returnStand: null, secondTaxiStart: null,
      weather: { start: flight.tsat - 20 * MINUTE, end: null, previous: flight, heldAtStand: true, atStand: true, groundStand: flight.stand,
        missedAt: flight.ctot + 10 * MINUTE + 1, blockedAt: flight.ctot + 10 * MINUTE + 1, normalSuspension: true,
        returnStart: null, returnEnd: null, returnStand: null, returnPath: [],
        resumedTaxiStart: Infinity, groundReadyAt: Infinity, revisionAt: null, assignedCtot: flight.ctot } };
  }
  let lastCategory: string | undefined;
  const ordered = [...flights].sort((a, b) => a.wheelsOff - b.wheelsOff || a.order - b.order);
  const result = new Map<string, TimelineItem>();
  for (const flight of ordered) {
    if (flight.missedCtot || !Number.isFinite(flight.wheelsOff) || flight.wheelsOff > flight.ctot + 10 * MINUTE
      || lastCategory === 'H' && flight.wakeCategory === 'H') result.set(flight.id, suspend(flight));
    else { lastCategory = flight.wakeCategory; result.set(flight.id, { ...flight, reissuedCtot: null, reissuedTsat: null }); }
  }
  return flights.map(flight => result.get(flight.id)!);
}

export function applyWeatherPeriods(flights: TimelineItem[], arrivals: ArrivalTimelineItem[], periods: WeatherPeriod[], runway: string, horizon?: number) {
  return periods.reduce((plan, period) => applyPeriod(plan.flights, plan.arrivals, period, runway, period.end === null ? horizon ?? period.start : Infinity), { flights, arrivals });
}

export function departureAtTime(flight: TimelineItem, time: number): TimelineItem {
  return flight.weather && time < flight.weather.start ? departureAtTime(flight.weather.previous, time) : flight;
}

export function hasMissedCtotAt(flight: TimelineItem, time: number): boolean {
  const weather = flight.weather;
  if (!weather) return flight.missedCtot && time >= flight.ctot + 10 * MINUTE
    || flight.returnStart !== null && time >= flight.returnStart;
  if (time < weather.start) return hasMissedCtotAt(weather.previous, time);
  return (weather.blockedAt !== undefined && time >= weather.blockedAt) || Math.min(time, flight.wheelsOff) > flight.ctot + 10 * MINUTE
    || hasMissedCtotAt(weather.previous, weather.start);
}

export function hasReissuedSlotAt(flight: TimelineItem, time: number): boolean {
  const weather = flight.weather;
  if (!weather) return (flight.reissuedCtot !== null || flight.reissuedTsat !== null)
    && (flight.returnEnd === null || time >= flight.returnEnd);
  if (time < weather.start) return hasReissuedSlotAt(weather.previous, time);
  return (weather.revisionAt !== null && time >= weather.revisionAt && (flight.reissuedTsat !== null || flight.reissuedCtot !== null)) || hasReissuedSlotAt(weather.previous, weather.start);
}

export function weatherStatus(flight: TimelineItem, time: number): { label: string; missed: boolean; pending: boolean; tsat: number | null } | null {
  const weather = flight.weather;
  if (!weather) return null;
  if (time < weather.start) return weatherStatus(weather.previous, time);
  const missed = hasMissedCtotAt(flight, time);
  const pending = weather.revisionAt === null || time < weather.revisionAt;
  return {
    label: missed ? 'Không tuân thủ CTOT' : pending
      ? weather.normalSuspension ? 'Chờ khởi hành' : 'Chờ thời tiết tốt'
      : flight.reissuedTsat !== null ? 'Đã cấp TSAT mới' : flight.reissuedCtot !== null ? 'Đã cấp CTOT mới' : 'Chờ khởi hành',
    missed, pending, tsat: pending && weather.heldAtStand && !weather.normalSuspension ? null : departureTsatAt(flight, time),
  };
}

/** A slot revision does not assign a stand; only an actual return changes it. */
export function departureStandAt(flight: TimelineItem, time: number): string {
  if (flight.weather) {
    const state = flight.weather;
    if (time < state.start) return departureStandAt(state.previous, time);
    if (state.returnStand && state.returnEnd !== null && time >= state.returnEnd) return state.returnStand;
    if (state.heldAtStand) return state.groundStand;
    return departureStandAt(state.previous, time);
  }
  return flight.returnStand && flight.returnEnd !== null && time >= flight.returnEnd
    ? flight.returnStand : flight.stand;
}

export function departureStatusAt(flight: TimelineItem, time: number, runway: string): string {
  if (time >= flight.wheelsOff) return 'Cất cánh';
  if (time >= flight.takeoffRollStart) return 'Chạy đà';
  const weather = weatherStatus(flight, time);
  if (weather) return weather.label;
  if (hasMissedCtotAt(flight, time)) return 'Không tuân thủ CTOT';
  const phase = departurePosition(flight, time, 0, runway).phase;
  if (phase.includes('đường băng')) return 'Vào đường băng';
  if (phase.includes('điểm chờ') || phase.includes('đang lăn') || phase.startsWith('lăn')) return 'Đang lăn';
  if (phase.includes('chờ tại S1')) return 'Chờ tại điểm giữ S1';
  return 'Chờ khởi hành';
}

function messageStamp(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')} ${String(date.getDate()).padStart(2, '0')}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getFullYear()).slice(-2)}`;
}

export function weatherDclEvents(flights: TimelineItem[], periods: WeatherPeriod[], requests: DclEvent[] = []): DclEvent[] {
  const events: DclEvent[] = [];
  for (const flight of flights) {
    let original = flight;
    while (original.weather) original = original.weather.previous;
    const request = requests.find(event => event.flightId === flight.id && event.message.startsWith('RCD ') && !event.message.includes('(RETRY)'));
    const requestedAt = request?.time ?? original.tsat - 20 * MINUTE;
    for (const period of periods) {
      let current = flight;
      while (current.weather && current.weather.start > period.start) current = current.weather.previous;
      const state = current.weather?.start === period.start ? current.weather : undefined;
      const requestDuringRain = (requestedAt >= period.start && requestedAt < (period.end ?? Infinity))
        || requests.some(event => event.flightId === flight.id && event.time >= period.start && event.time < (period.end ?? Infinity));
      if (!state && !requestDuringRain) continue;
      // Weather broadcasts belong to the independent weather bulletin, not DCL.
      if (state?.missedAt !== null && state?.missedAt !== undefined) events.push({
        id: `${flight.id}-weather-${period.start}-expired`, flightId: flight.id, time: state.missedAt,
        callsign: flight.callsign, direction: 'Hệ thống → Tổ lái',
        message: `FSM ${messageStamp(state.missedAt)} VVTS ${flight.callsign} CTOT EXPIRED`, status: 'OK',
      });
      if ((state?.awaitTsat || (!state && flight.weather?.normalSuspension && requestDuringRain)) && period.end !== null) {
        events.push({ id: `${flight.id}-weather-${period.start}-await`, flightId: flight.id, time: Math.max(period.end, requestedAt + 15_000), callsign: flight.callsign, direction: 'Hệ thống → Tổ lái', message: `CLD ${messageStamp(Math.max(period.end, requestedAt + 15_000))} VVTS PDC 001 ${flight.callsign} AWAIT NEW TSAT`, status: 'OK' });
        continue;
      }
      const revisionAt = state ? state.revisionAt : period.end;
      if (revisionAt === null || !Number.isFinite(current.wheelsOff)) continue;
      const clearanceAt = Math.max(revisionAt, requestedAt + 15_000);
      if (periods.some(later => later.start > period.start && clearanceAt >= later.start && clearanceAt < (later.end ?? Infinity))) continue;
      const startup = departureTsatAt(current, clearanceAt);
      const firstSuspension = Math.min(...periods.filter(item => (item.end ?? Infinity) > requestedAt).map(item => item.start));
      const priorClearance = requests.some(event => event.flightId === flight.id && event.message.startsWith('CLD ') && event.time < Math.min(period.start, firstSuspension))
        || events.some(event => event.flightId === flight.id && event.message.startsWith('CLD ') && event.time < period.start);

      const needsStartupRevision = state?.heldAtStand && current.reissuedTsat !== null;
      if (priorClearance && !needsStartupRevision) continue;
      const revised = 'TSAT';
      const revisionLabel = state && (revised === 'TSAT' ? current.reissuedTsat !== null : current.reissuedCtot !== null) ? ' REVISED' : '';
      const value = startup;
      const stamp = new Date(value).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' }).replace(':', '');
      events.push({
        id: `${flight.id}-weather-${period.start}-cld`, flightId: flight.id, time: clearanceAt,
        callsign: flight.callsign, direction: 'Hệ thống → Tổ lái',
        message: `CLD ${messageStamp(clearanceAt)} VVTS PDC 001 ${flight.callsign} CLRD TO ${String(flight.row.AirportReceiptCode ?? 'VVDN')} OFF 25L VIA SID DEMO1 SQUAWK 2201 ${revised}${revisionLabel} ${stamp}`, status: 'OK',
      }, {
        id: `${flight.id}-weather-${period.start}-cda`, flightId: flight.id, time: clearanceAt + 25_000,
        callsign: flight.callsign, direction: 'Tổ lái → Hệ thống',
        message: `CDA ${messageStamp(clearanceAt + 25_000)} VVTS ${flight.callsign} CDA RECEIVED CLEARANCE CONFIRMED`, status: 'OK',
      });
    }
  }
  return events;
}

export function composeWeatherDclEvents(events: DclEvent[], flights: TimelineItem[], periods: WeatherPeriod[]): DclEvent[] {
  const cutoffs = flights.map(flight => {
    let state = flight.weather;
    while (state?.previous.weather) state = state.previous.weather;
    const rain = periods.filter(period => events.some(event => event.flightId === flight.id
      && event.time >= period.start && event.time < (period.end ?? Infinity)));
    return { id: flight.id, time: Math.min(state?.start ?? Infinity, ...rain.map(period => period.start)) };
  });
  return [...events.filter(event => (event.message.startsWith('RCD ') && !event.message.includes('(RETRY)'))
    || (event.message.startsWith('CDA ') && events.some(clearance => clearance.flightId === event.flightId && clearance.message.startsWith('CLD ') && clearance.time < (cutoffs.find(cutoff => cutoff.id === event.flightId)?.time ?? Infinity)))
    || !cutoffs.some(cutoff => event.flightId === cutoff.id && event.time >= cutoff.time)),
    ...weatherDclEvents(flights, periods, events)].filter(event => !/ADVERSE WEATHER|WEATHER IMPROVED|DEPARTURE CLEARANCES RESUMED|\bCTOT(?: REVISED)? \d{4}/.test(event.message)).map(event => {
      if (!event.message.startsWith('RCD ')) return event;
      const flight = flights.find(item => item.id === event.flightId);
      return flight ? { ...event, message: event.message.replace(/(-STAND )\S+?(-[A-Z]{4} ATIS)/, `$1${departureStandAt(flight, event.time)}$2`) } : event;
    }).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}
