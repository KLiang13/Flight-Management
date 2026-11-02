import { MAX_REPORT_BYTES, parseReport, safeText, type DiagnosticContext, type DiagnosticReport, type TraceEvent } from './schema';

const STORAGE = 'tsn-diagnostics-v1';
const sessionId = crypto.randomUUID();
const build = import.meta.env.VITE_APP_BUILD ?? 'local';
const events: TraceEvent[] = [];
let getContext: (() => DiagnosticContext) | undefined;
let lastError: { signature: string; at: number; id: string } | undefined;
let installed = false;
let reportsSent = 0;

export function trace(type: string, data: TraceEvent['data'] = {}) {
  events.push({ at: Date.now(), type, data });
  if (events.length > 100) events.shift();
}
export function setDiagnosticContext(provider: () => DiagnosticContext) { getContext = provider; }
function saved(): DiagnosticReport[] {
  try { return (JSON.parse(localStorage.getItem(STORAGE) ?? '[]') as unknown[]).map(parseReport)
    .filter(r => Date.now() - r.createdAt < 7 * 86400_000).slice(-3); } catch { return []; }
}
function save(report: DiagnosticReport) {
  try { localStorage.setItem(STORAGE, JSON.stringify([...saved().filter(r => r.id !== report.id), report].slice(-3))); } catch { /* Reporting must not stop playback if storage is full or unavailable. */ }
}
export function makeReport(error: unknown, category: string): DiagnosticReport {
  const e = error instanceof Error ? error : new Error(safeText(error, 2000));
  let context: DiagnosticContext | null = null;
  try { context = getContext?.() ?? null; } catch { /* Last known actions remain available without a snapshot. */ }
  const report = { schema: 1, id: crypto.randomUUID(), sessionId, build, createdAt: Date.now(), category,
    error: { name: e.name, message: e.message, stack: e.stack ?? '' }, events: [...events], context };
  try { return parseReport(report); }
  catch { return parseReport({ ...report, context: null }); }
}
export function captureError(error: unknown, category: string): string {
  const signature = `${category}:${error instanceof Error ? error.message : String(error)}`;
  if (lastError?.signature === signature && Date.now() - lastError.at < 5000) return lastError.id;
  const report = makeReport(error, category);
  lastError = { signature, at: Date.now(), id: report.id };
  save(report);
  trace('error.captured', { id: report.id, category });
  const fullBody = JSON.stringify(report);
  const body = new TextEncoder().encode(fullBody).length <= MAX_REPORT_BYTES ? fullBody
    : JSON.stringify({ ...report, context: null });
  // Vite has no Function endpoint. Keep a local report without producing recursive 404s.
  if (import.meta.env.PROD && reportsSent++ < 10 && new TextEncoder().encode(body).length <= MAX_REPORT_BYTES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    void fetch('/api/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      credentials: 'omit', signal: controller.signal }).then(response => {
      trace('report.delivery', { id: report.id, status: response.status });
    }).catch(() => trace('report.delivery', { id: report.id, status: 'offline' })).finally(() => clearTimeout(timer));
  }
  return report.id;
}
export function downloadDiagnostics() {
  const report = makeReport(new Error('User requested diagnostic export'), 'manual_export');
  const blob = new Blob([JSON.stringify({ current: report, recentErrors: saved() }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `tsn-log-${report.sessionId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function installDiagnostics() {
  if (installed) return;
  installed = true;
  trace('session.started', { build });
  window.addEventListener('error', event => captureError(event.error ?? new Error(event.message), 'window_error'));
  window.addEventListener('unhandledrejection', event => captureError(event.reason, 'unhandled_rejection'));
}
