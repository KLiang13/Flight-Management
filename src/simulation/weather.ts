import type { TimelineItem } from './runSimulation';
import { RUNWAY_MOVEMENT_MS, TAKEOFF_ROLL_MS } from './movementPhysics';
import type { ArrivalTimelineItem } from './arrivals';
import { departurePosition } from '../map/playback';
import { getNearestReturnStand, getTaxiRoutePoints, type MapPoint } from '../map/airfieldGeometry';
import type { DclEvent } from '../dcl/dclScenario';
import { departureTsatAt, departureWaitMinutesAt } from './departureTiming';
import { releaseTakeoffRoll, arrivalDelayForBookedRolls, reserveCrossingsBeforeDeparture } from './runwayCoordination';
import { distanceAlongPathToPoint } from '../map/surfaceGraph';

const MINUTE = 60_000;
const MOVEMENT = RUNWAY_MOVEMENT_MS;
export type WeatherPeriod = { start: number; end: number | null };
export type WeatherDepartureState = WeatherPeriod & {
  previous: TimelineItem; heldAtStand: boolean; groundStand: string;
  missedAt: number | null; returnStart: number | null; returnEnd: number | null;
  returnStand: string | null; returnPath: MapPoint[];
  resumedTaxiStart: number; groundReadyAt: number; revisionAt: number | null;
};
export type WeatherArrivalState = WeatherPeriod & { previous: ArrivalTimelineItem };

function pathLength(path: MapPoint[]): number {
  return path.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - path[index].x, point.y - path[index].y), 0);
}

// Join the reverse taxi route at the nearest point, preserving the aircraft's
// actual position when its slot expires instead of moving it back to S1.
function returnPath(from: MapPoint, stand: string, runway: string): MapPoint[] {
  const route = [...getTaxiRoutePoints(stand, runway)].reverse();
  let nearest = 0;
  let projected = route[0];
  let distance = Infinity;
  for (let index = 0; index < route.length - 1; index += 1) {
    const a = route[index], b = route[index + 1];
    const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = length ? Math.max(0, Math.min(1, ((from.x - a.x) * (b.x - a.x) + (from.y - a.y) * (b.y - a.y)) / length)) : 0;
    const point = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    const candidate = Math.hypot(from.x - point.x, from.y - point.y);
    if (candidate < distance) { distance = candidate; nearest = index; projected = point; }
  }
  return [from, projected, ...route.slice(nearest + 1)];
}

type Reservation = { stand: string; from: number; until: number; id: string };

function applyPeriod(departures: TimelineItem[], incoming: ArrivalTimelineItem[], period: WeatherPeriod, runway: string) {
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
  const activeSlot = (flight: TimelineItem) => {
    const assigned = flight.weather?.revisionAt ?? flight.returnEnd ?? Infinity;
    if (assigned > period.start) return flight.ctot;
    if (flight.reissuedCtot !== null) return flight.reissuedCtot;
    if (flight.reissuedTsat !== null) return flight.reissuedTsat + flight.taxiMinutes * MINUTE + MOVEMENT;
    return flight.ctot;
  };
  function stateFor(previous: TimelineItem): WeatherDepartureState {
    const old = previous.weather;
    const waitingAfterReturn = previous.returnEnd !== null && previous.returnEnd <= period.start
      && (previous.secondTaxiStart ?? Infinity) >= period.start;
    const heldAtStand = previous.taxiStart >= period.start
      || Boolean(old?.heldAtStand && old.resumedTaxiStart >= period.start);
    const groundStand = waitingAfterReturn ? previous.returnStand! : old?.heldAtStand
      ? old.returnStand ?? old.groundStand : previous.stand;
    const resumedTaxiStart = heldAtStand ? Math.max(previous.secondTaxiStart ?? previous.taxiStart, release) : previous.taxiStart;
    const groundReadyAt = heldAtStand ? resumedTaxiStart + previous.taxiMinutes * MINUTE
      : Math.max(previous.taxiStart + previous.taxiMinutes * MINUTE,
        previous.secondTaxiStart === null ? -Infinity : previous.secondTaxiStart + previous.taxiMinutes * MINUTE);
    return { ...period, previous, heldAtStand, groundStand, resumedTaxiStart, groundReadyAt,
      missedAt: null, returnStart: null, returnEnd: null, returnStand: null, returnPath: [], revisionAt: period.end };
  }
  function divert(state: WeatherDepartureState): WeatherDepartureState {
    const previous = state.previous;
    const missedAt = Math.max(period.start, activeSlot(previous) + 10 * MINUTE + 1);
    const outboundRoute = getTaxiRoutePoints(previous.stand, 'S1');
    const commitDistance = pathLength(outboundRoute) > 0
      ? distanceAlongPathToPoint(outboundRoute) : null;
    const commitAt = commitDistance === null ? Infinity
      : previous.taxiStart + previous.taxiMinutes * MINUTE * commitDistance / pathLength(outboundRoute);
    if (!state.heldAtStand && Math.min(commitAt, previous.taxiStart + previous.taxiMinutes * MINUTE) <= missedAt) {
      return { ...state, missedAt, returnStart: null, returnEnd: null, returnStand: null, returnPath: [],
        resumedTaxiStart: previous.taxiStart, groundReadyAt: previous.taxiStart + previous.taxiMinutes * MINUTE,
        revisionAt: period.end };
    }
    let returnStart = missedAt;
    let returnEnd: number | null = missedAt;
    let returnStand: string | null = state.groundStand;
    let route: MapPoint[] = [];
    if (!state.heldAtStand) {
      returnStand = null;
      const times = [missedAt, ...reservations.filter((item) => item.until > missedAt && Number.isFinite(item.until)).map((item) => item.until)]
        .sort((a, b) => a - b);
      for (const time of times) {
        const occupied = new Set(reservations.filter((item) => item.id !== previous.id && item.from <= time && item.until > time).map((item) => item.stand));
        const candidate = getNearestReturnStand(previous.stand, occupied, previous.wakeCategory);
        if (!occupied.has(candidate)) { returnStart = time; returnStand = candidate; break; }
      }
      returnEnd = null;
      if (returnStand) {
        const point = departurePosition(previous, Math.min(returnStart, previous.runwayEntryStart - 1), 0, runway).point;
        route = returnPath(point, returnStand, runway);
        returnEnd = returnStart + Math.max(MINUTE, pathLength(route) * (3059 / 1750) / 1852 / 20 * 3_600_000);
      }
    }
    const resumedTaxiStart = Math.max(release, (returnEnd ?? Infinity) + MOVEMENT);
    if (returnStand) reservations.push({ stand: returnStand, from: returnStart, until: resumedTaxiStart, id: previous.id });
    return { ...state, missedAt, returnStart, returnEnd, returnStand, returnPath: route, resumedTaxiStart,
      groundReadyAt: resumedTaxiStart + previous.taxiMinutes * MINUTE,
      revisionAt: period.end === null || returnEnd === null ? null : Math.max(period.end, returnEnd) };
  }
  function withState(state: WeatherDepartureState, wheelsOff: number): TimelineItem {
    const previous = state.previous;
    const issued = state.revisionAt !== null && Number.isFinite(wheelsOff);
    const revisedAtStand = state.heldAtStand;
    const result = { ...previous, weather: state, wheelsOff, runwayEntryStart: wheelsOff - MOVEMENT, takeoffRollStart: wheelsOff - TAKEOFF_ROLL_MS,
      missedCtot: previous.missedCtot || state.missedAt !== null,
      returnStart: state.returnStart, returnEnd: state.returnEnd, returnStand: state.returnStand,
      secondTaxiStart: state.resumedTaxiStart,
      reissuedCtot: issued && !revisedAtStand ? wheelsOff : null,
      reissuedTsat: issued && revisedAtStand ? state.resumedTaxiStart : null,
      waitMinutes: 0,
      status: issued ? 'Đã cấp TSAT/CTOT mới' : 'Chờ thời tiết tốt' };
    result.waitMinutes = departureWaitMinutesAt(result, wheelsOff);
    return result;
  }
  const committed = departures.filter((flight) => flight.takeoffRollStart < period.start);
  const pending = departures.filter((flight) => flight.takeoffRollStart >= period.start).map((previous) => {
    let state = stateFor(previous);
    const earliest = Math.max(previous.wheelsOff, release + MOVEMENT, state.groundReadyAt + MOVEMENT);
    if (earliest === previous.wheelsOff && (!state.heldAtStand || state.resumedTaxiStart === (previous.secondTaxiStart ?? previous.taxiStart))) return previous;
    if (!state.heldAtStand && earliest > activeSlot(previous) + 10 * MINUTE) state = divert(state);
    return withState(state, Math.max(earliest, state.groundReadyAt + MOVEMENT));
  });
  let flights: TimelineItem[];
  let landingForecast: ArrivalTimelineItem[] | null = null;
  if (period.end === null) {
    flights = [...committed, ...pending];
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
    const needsStartup = pending.filter((flight) => currentState(flight) && (currentState(flight)!.heldAtStand || currentState(flight)!.returnStand !== null))
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
      ? Math.max(currentState(flight)!.previous.wheelsOff, release + MOVEMENT, currentState(flight)!.groundReadyAt + MOVEMENT)
      : flight.wheelsOff;
    while (pending.length) {
      pending.sort((a, b) => earliest(a) - earliest(b)
        || Number(currentState(a)?.missedAt !== null && currentState(a)?.missedAt !== undefined) - Number(currentState(b)?.missedAt !== null && currentState(b)?.missedAt !== undefined)
        || a.order - b.order);
      let index = 0;
      const heavyCount = pending.filter((flight) => flight.wakeCategory === 'H').length;
      const mediumCount = pending.length - heavyCount;
      if (completed.at(-1)?.wakeCategory !== 'H' && pending[0].wakeCategory === 'M' && heavyCount > mediumCount) {
        index = pending.findIndex((flight) => flight.wakeCategory === 'H');
      }
      if (completed.at(-1)?.wakeCategory === 'H' && pending[0].wakeCategory === 'H') {
        index = pending.findIndex((flight) => flight.wakeCategory === 'M');
        if (index < 0) throw new Error('Không còn tàu M để tách hai tàu H sau khi khôi phục thời tiết.');
      }
      let [flight] = pending.splice(index, 1);
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
      for (const id of crossingPriority.served) servedCrossings.add(id);
      completed.push(flight);
      available = wheelsOff + MOVEMENT;
    }
    flights = completed;
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
  return { flights, arrivals: [...arrivals, ...diverted].sort((a, b) => a.touchdown - b.touchdown || a.id.localeCompare(b.id)) };
}

export function applyWeatherPeriods(flights: TimelineItem[], arrivals: ArrivalTimelineItem[], periods: WeatherPeriod[], runway: string) {
  return periods.reduce((plan, period) => applyPeriod(plan.flights, plan.arrivals, period, runway), { flights, arrivals });
}

export function departureAtTime(flight: TimelineItem, time: number): TimelineItem {
  return flight.weather && time < flight.weather.start ? departureAtTime(flight.weather.previous, time) : flight;
}

export function hasMissedCtotAt(flight: TimelineItem, time: number): boolean {
  const weather = flight.weather;
  if (!weather) return flight.missedCtot && time >= flight.ctot + 10 * MINUTE
    || flight.returnStart !== null && time >= flight.returnStart;
  if (time < weather.start) return hasMissedCtotAt(weather.previous, time);
  return (weather.missedAt !== null && time >= weather.missedAt) || hasMissedCtotAt(weather.previous, weather.start);
}

export function hasReissuedSlotAt(flight: TimelineItem, time: number): boolean {
  const weather = flight.weather;
  if (!weather) return (flight.reissuedCtot !== null || flight.reissuedTsat !== null)
    && (flight.returnEnd === null || time >= flight.returnEnd);
  if (time < weather.start) return hasReissuedSlotAt(weather.previous, time);
  return (weather.revisionAt !== null && time >= weather.revisionAt) || hasReissuedSlotAt(weather.previous, weather.start);
}

export function weatherStatus(flight: TimelineItem, time: number): { label: string; missed: boolean; pending: boolean; tsat: number | null } | null {
  const weather = flight.weather;
  if (!weather) return null;
  if (time < weather.start) return weatherStatus(weather.previous, time);
  const missed = weather.missedAt !== null && time >= weather.missedAt;
  const pending = weather.revisionAt === null || time < weather.revisionAt;
  return {
    label: pending
      ? missed && !weather.heldAtStand ? 'CTOT EXPIRED' : 'Chờ thời tiết tốt'
      : missed ? 'Không tuân thủ CTOT' : weather.heldAtStand ? 'Đã cấp TSAT mới' : 'Đã cấp CTOT mới',
    missed, pending, tsat: pending && weather.heldAtStand ? null : departureTsatAt(flight, time),
  };
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
      const revisionAt = state ? state.revisionAt : period.end;
      if (revisionAt === null || !Number.isFinite(current.wheelsOff)) continue;
      const clearanceAt = Math.max(revisionAt, requestedAt + 15_000);
      if (periods.some(later => later.start > period.start && clearanceAt >= later.start && clearanceAt < (later.end ?? Infinity))) continue;
      const startup = current.reissuedTsat ?? original.tsat;
      const slot = current.reissuedCtot ?? current.wheelsOff;
      const revised = state && !state.heldAtStand ? 'CTOT' : 'TSAT';
      const value = revised === 'TSAT' ? startup : slot;
      const stamp = new Date(value).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' }).replace(':', '');
      events.push({
        id: `${flight.id}-weather-${period.start}-cld`, flightId: flight.id, time: clearanceAt,
        callsign: flight.callsign, direction: 'Hệ thống → Tổ lái',
        message: `CLD ${messageStamp(clearanceAt)} VVTS PDC 001 ${flight.callsign} CLRD TO ${String(flight.row.AirportReceiptCode ?? 'VVDN')} OFF 25L VIA SID DEMO1 SQUAWK 2201 ${revised} REVISED ${stamp}`, status: 'OK',
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
    || !cutoffs.some(cutoff => event.flightId === cutoff.id && event.time >= cutoff.time)),
    ...weatherDclEvents(flights, periods, events)].filter(event => !/ADVERSE WEATHER|WEATHER IMPROVED|DEPARTURE CLEARANCES RESUMED/.test(event.message)).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}
