import { computePlan, type PlanningJob } from './planning';

globalThis.onmessage = (event: MessageEvent<PlanningJob>) => {
  try { globalThis.postMessage({ plan: computePlan(event.data) }); }
  catch (error) { globalThis.postMessage({ error: (error as Error).message, name: (error as Error).name, stack: (error as Error).stack }); }
};
