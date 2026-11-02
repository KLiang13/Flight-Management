export const MAX_REPORT_BYTES = 384 * 1024;
export const ROW_FIELDS = ['CallSign', 'PlaneTypeCode', 'AircraftType', 'Stand', 'ScheduledDeparture', 'ScheduledArrival', 'CTOT', 'TaxiMinutes', 'StandReadyAt', 'Compliance', 'International', 'AirportDeliveryCode', 'AirportReceiptCode', 'FlyDate'] as const;
const EVENT_FIELDS = new Set(['build', 'jobId', 'kind', 'durationMs', 'flights', 'arrivals', 'source', 'day', 'runway', 'minute', 'adverse', 'playing', 'planningWeather', 'retry', 'from', 'to', 'speed', 'seconds', 'id', 'category', 'status', 'message']);
export const STATE_FIELDS = ['id', 'callsign', 'stand', 'tsat', 'ctot', 'reissuedTsat', 'taxiStart', 'secondTaxiStart', 'runwayEntryStart', 'takeoffRollStart', 'wheelsOff', 'status', 'blockedAt', 'passedWeatherPoint'] as const;
export type Scalar = string | number | boolean | null;
export type TraceEvent = { at: number; type: string; data: Record<string, Scalar> };
export type DiagnosticContext = {
  source: string; day: string; runway: string; minute: number; speed: number;
  playing: boolean; planningWeather: boolean; weatherError: string;
  periods: { start: number; end: number | null }[];
  departures: Record<string, Scalar>[]; arrivals: Record<string, Scalar>[];
  flightStates?: Record<string, Scalar>[];
  horizon?: number | 'Infinity' | '-Infinity';
};
export type DiagnosticReport = {
  schema: 1; id: string; sessionId: string; build: string; createdAt: number;
  category: string; error: { name: string; message: string; stack: string };
  events: TraceEvent[]; context: DiagnosticContext | null;
};

export function safeText(value: unknown, limit = 128): string {
  return String(value ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:token|password|secret|api[_-]?key)=)[^\s&]+/gi, '$1[redacted]').slice(0, limit);
}
export function traceRows(rows: Record<string, unknown>[], fields: readonly string[] = ROW_FIELDS): Record<string, Scalar>[] {
  return rows.slice(0, 1000).map(row => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => {
    const value = row[key];
    return [key, typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null
      ? value : safeText(value instanceof Date ? value.toISOString() : value)];
  })));
}

/** Rebuild an allowlisted object; never write an arbitrary HTTP body to logs. */
export function parseReport(input: unknown): DiagnosticReport {
  const r = input as DiagnosticReport;
  const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
  if (!r || r.schema !== 1 || !uuid.test(r.id) || !uuid.test(r.sessionId)
    || !Number.isFinite(r.createdAt) || !Array.isArray(r.events) || r.events.length > 100
    || !r.error || typeof r.error.message !== 'string') throw new Error('Invalid report');
  const events = r.events.map(event => {
    if (!event || !Number.isFinite(event.at) || !/^[a-z_.]+$/.test(event.type) || event.type.length > 64
      || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw new Error('Invalid event');
    const data = Object.fromEntries(Object.entries(event.data).slice(0, 12).filter(([key, value]) =>
      EVENT_FIELDS.has(key) && (value === null || ['string', 'number', 'boolean'].includes(typeof value)))
      .map(([key, value]) => [key, typeof value === 'string' ? safeText(value, 256) : value]));
    return { at: event.at, type: event.type, data } as TraceEvent;
  });
  let context: DiagnosticContext | null = null;
  if (r.context) {
    const c = r.context;
    if (c.flightStates !== undefined && (!Array.isArray(c.flightStates) || c.flightStates.length > 1000)) throw new Error('Invalid flight states');
    if (!Array.isArray(c.departures) || !Array.isArray(c.arrivals) || c.departures.length + c.arrivals.length > 1000
      || !Array.isArray(c.periods) || c.periods.length > 100 || !Number.isFinite(c.minute) || !Number.isFinite(c.speed)
      || c.periods.some(p => !p || !Number.isFinite(p.start) || p.end !== null && (!Number.isFinite(p.end) || p.end < p.start))) throw new Error('Invalid context');
    context = { horizon: typeof c.horizon === 'number' && Number.isFinite(c.horizon) || c.horizon === '-Infinity' ? c.horizon : 'Infinity', source: safeText(c.source), day: safeText(c.day, 10), runway: safeText(c.runway, 20),
      minute: c.minute, speed: c.speed, playing: c.playing === true, planningWeather: c.planningWeather === true,
      weatherError: safeText(c.weatherError, 2000), periods: c.periods.map(p => ({ start: p.start, end: p.end })),
      departures: traceRows(c.departures), arrivals: traceRows(c.arrivals), flightStates: traceRows(c.flightStates ?? [], STATE_FIELDS) };
  }
  return { schema: 1, id: r.id, sessionId: r.sessionId, build: safeText(r.build, 80), createdAt: r.createdAt,
    category: safeText(r.category, 64), error: { name: safeText(r.error.name, 80), message: safeText(r.error.message, 2000), stack: safeText(r.error.stack, 8000) }, events, context };
}
