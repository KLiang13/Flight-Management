// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import handler from '../../api/diagnostics';
import { MAX_REPORT_BYTES } from '../../src/diagnostics/schema';

afterEach(() => vi.restoreAllMocks());
const origin = 'https://tsn-flight-management.vercel.app';
const report = () => ({ schema: 1, id: crypto.randomUUID(), sessionId: crypto.randomUUID(), build: 'test', createdAt: Date.now(),
  category: 'weather_planning', error: { name: 'Error', message: 'recovery failed', stack: 'test stack' },
  events: [{ at: Date.now(), type: 'weather.changed', data: { adverse: false, minute: 811 } }], context: null });
const request = (body: string, requestOrigin = origin) => new Request(`${origin}/api/diagnostics`, {
  method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json', 'x-forwarded-for': crypto.randomUUID() }, body });
it('writes a searchable report and permits no public reads or cross-origin writes', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const payload = report();
  const response = await handler.fetch(request(JSON.stringify(payload)));
  expect(response.status).toBe(201);
  const entries = log.mock.calls.map(([entry]) => JSON.parse(entry));
  expect(entries[0].reportId).toBe(payload.id);
  expect(JSON.parse(entries.map(entry => entry.payload).join('')).error.message).toBe('recovery failed');
  expect((await handler.fetch(new Request(`${origin}/api/diagnostics`))).status).toBe(405);
  expect((await handler.fetch(request(JSON.stringify(payload), 'https://unrelated.example'))).status).toBe(403);
});
it('rejects invalid or oversized payloads without logging them', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect((await handler.fetch(request('{}'))).status).toBe(400);
  expect((await handler.fetch(request('x'.repeat(MAX_REPORT_BYTES + 1)))).status).toBe(413);
  expect(log).not.toHaveBeenCalled();
});
