import { computePlan, type PlanningJob } from './planning';

/** Terminating an obsolete worker prevents old weather results replacing a newer choice. */
export function planAsync(job: PlanningJob, signal?: AbortSignal): Promise<ReturnType<typeof computePlan>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => { worker?.terminate(); if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (typeof Worker === 'undefined') {
      timer = setTimeout(() => { try { resolve(computePlan(job)); } catch (error) { reject(error); } finally { clean(); } }, 0);
      return;
    }
    try {
      worker = new Worker(new URL('./planning.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => { clean(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.plan); };
      worker.onerror = event => { clean(); reject(new Error(event.message || 'Không thể lập lịch.')); };
      worker.postMessage(job);
    } catch (error) { clean(); reject(error); }
  });
}
