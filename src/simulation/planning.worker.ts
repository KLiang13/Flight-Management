import { computeMilpPlan, type PlanningJob } from './planning';
import { loadMilpSolver } from './milpLoader';

globalThis.onmessage = async (event: MessageEvent<PlanningJob>) => {
  try { const solver = await loadMilpSolver(); globalThis.postMessage({ plan: computeMilpPlan(solver, event.data) }); }
  catch (error) { globalThis.postMessage({ error: (error as Error).message, name: (error as Error).name, stack: (error as Error).stack }); }
};
