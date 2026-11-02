import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseReport, traceRows } from './schema';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); localStorage.clear(); vi.resetModules(); });
describe('diagnostic reports', () => {
  it('keeps effective TSAT and stand and drops unrelated state fields', async () => {
    const { makeReport, setDiagnosticContext } = await import('./client');
    setDiagnosticContext(() => ({ source: 'cd', day: '2026-10-01', runway: '25L-25R', minute: 811,
      speed: 60, playing: false, planningWeather: false, weatherError: '', periods: [], departures: [], arrivals: [],
      flightStates: [{ id: 'T-1', callsign: 'T', tsat: 12345, ctot: 45678, stand: '73', privateField: 'drop' }] }));
    expect(makeReport(new Error('test'), 'test').context?.flightStates).toEqual([{ id: 'T-1', callsign: 'T', tsat: 12345, ctot: 45678, stand: '73' }]);
    setDiagnosticContext(() => { throw new Error('snapshot unavailable'); });
    expect(makeReport(new Error('test'), 'test').context).toBeNull();
  });
  it('keeps only simulation fields and redacts credential-shaped strings', () => {
    const rows = traceRows([{ CallSign: 'TST1', CTOT: new Date('2026-10-01T06:00:00Z'), email: 'private@example.com', password: 'secret' }]);
    expect(rows).toEqual([{ CallSign: 'TST1', CTOT: '2026-10-01T06:00:00.000Z' }]);
  });
  it('captures actions and snapshot, limits repeated errors, and keeps a backup when delivery fails', async () => {
    vi.stubEnv('PROD', true);
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const { trace, captureError, setDiagnosticContext } = await import('./client');
    setDiagnosticContext(() => ({ source: 'cd', day: '2026-10-01', runway: '25L-25R', minute: 811,
      speed: 60, playing: false, planningWeather: true, weatherError: '',
      periods: [{ start: 1, end: 2 }], departures: [{ CallSign: 'TST1', CTOT: '2026-10-01T13:20' }], arrivals: [] }));
    for (let i = 0; i < 120; i++) trace('weather.changed', { minute: i });
    const id = captureError(new Error('token=secret recovery failed'), 'weather_planning');
    expect(captureError(new Error('token=secret recovery failed'), 'weather_planning')).toBe(id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const sent = parseReport(JSON.parse(fetcher.mock.calls[0][1].body));
    expect(sent.events).toHaveLength(100);
    expect(sent.context?.minute).toBe(811);
    expect(sent.error.message).not.toContain('secret');
    const backup = JSON.parse(localStorage.getItem('tsn-diagnostics-v1')!);
    expect(backup[0].id).toBe(id);
    await Promise.resolve();
  });
});
