import { afterEach, expect, it, vi } from 'vitest';
import { planAsync } from './planningClient';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
}
afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances = []; });

it('terminates obsolete work and rejects its promise on cancellation', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const controller = new AbortController();
  const request = planAsync({ type: 'day', rows: [], arrivals: [], runway: '25L-25R' }, controller.signal);
  controller.abort();
  await expect(request).rejects.toHaveProperty('name', 'AbortError');
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
});

it('returns worker output and releases the worker after completion', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const request = planAsync({ type: 'day', rows: [], arrivals: [], runway: '25L-25R' });
  FakeWorker.instances[0].onmessage!({ data: { plan: { flights: [], arrivals: [] } } });
  await expect(request).resolves.toEqual({ flights: [], arrivals: [] });
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
});
