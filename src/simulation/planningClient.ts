import { trace } from '../diagnostics/client';
import { computeMilpPlan, type computePlan, type PlanningJob } from './planning';
import { loadMilpSolver } from './milpLoader';

/** Terminating an obsolete worker prevents old weather results replacing a newer choice. */
export function planAsync(job: PlanningJob, signal?: AbortSignal): Promise<ReturnType<typeof computePlan>> {
  const started = performance.now();
  const jobId = crypto.randomUUID();
  trace('planning.started', { jobId, kind: job.type });
  return new Promise<ReturnType<typeof computePlan>>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => { worker?.terminate(); if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (typeof Worker === 'undefined') {
      timer = setTimeout(async () => { try { const solver = await loadMilpSolver(); if (signal?.aborted) return; resolve(computeMilpPlan(solver, job)); } catch (error) { reject(error); } finally { clean(); } }, 0);
      return;
    }
    try {
      worker = new Worker(new URL('./planning.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => { clean(); if (event.data.error) { const error = new Error(event.data.error); error.name = event.data.name || 'Error'; if (event.data.stack) error.stack = event.data.stack; reject(error); } else resolve(event.data.plan); };
      worker.onerror = event => { clean(); reject(new Error(event.message || 'Không thể lập lịch.')); };
      worker.postMessage(job);
    } catch (error) { clean(); reject(error); }
  }).then(plan => {
    trace('planning.completed', { jobId, kind: job.type, durationMs: Math.round(performance.now() - started), flights: plan.flights.length, arrivals: plan.arrivals.length });
    return plan;
  }, error => {
    trace(signal?.aborted ? 'planning.cancelled' : 'planning.failed', { jobId, kind: job.type, durationMs: Math.round(performance.now() - started), message: String(error.message).slice(0, 256) });
    throw error;
  });
}
