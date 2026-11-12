import loadHighs from 'highs';
import wasmUrl from 'highs/runtime?url';
import type { MilpSolver } from './milpDeparture';

let instance: Promise<MilpSolver> | undefined;

/** Each planning worker owns its own WebAssembly solver instance. */
export function loadMilpSolver(): Promise<MilpSolver> {
  if (!instance) {
    const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
    instance = loadHighs(isNode ? undefined : { locateFile: () => wasmUrl }).catch(error => {
      instance = undefined;
      throw error;
    });
  }
  return instance;
}
