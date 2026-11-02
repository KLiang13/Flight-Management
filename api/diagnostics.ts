import { MAX_REPORT_BYTES, parseReport } from '../src/diagnostics/schema.js';

// Best-effort per-instance throttling; no public read endpoint and no raw IPs in logs.
const clients = new Map<string, { at: number; count: number }>();
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    const origin = request.headers.get('origin');
    if (!origin || origin !== new URL(request.url).origin) return new Response(null, { status: 403 });
    if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response(null, { status: 415 });
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown';
    const now = Date.now(), old = clients.get(ip);
    const client = old && now - old.at < 60_000 ? old : { at: now, count: 0 };
    if (++client.count > 10) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
    if (clients.size >= 500 && !clients.has(ip)) clients.delete(clients.keys().next().value!);
    clients.set(ip, client);
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400 });
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPORT_BYTES) { await reader.cancel(); return new Response(null, { status: 413 }); }
      chunks.push(value);
    }
    let report;
    try { report = parseReport(JSON.parse(await new Blob(chunks).text())); }
    catch { return new Response(null, { status: 400 }); }
    // Chunk strings by characters to stay comfortably under Vercel's per-line log limit.
    const payload = JSON.stringify(report);
    const total = Math.ceil(payload.length / 8000);
    for (let part = 0; part < total; part++) console.log(JSON.stringify({ event: 'tsn.diagnostic', reportId: report.id,
      sessionId: report.sessionId, build: report.build, receivedAt: now, part, total, payload: payload.slice(part * 8000, (part + 1) * 8000) }));
    return Response.json({ id: report.id }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  },
};
