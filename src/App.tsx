import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, ArrowUpRight, CalendarDays, ChevronDown,
  Clock3, FileSpreadsheet, Info, Layers3, MapPin, Pause, Play, Plane, Radio, RotateCcw, Search,
  ZoomIn, ZoomOut, CloudRain, Sun, Maximize2,
} from 'lucide-react';
import './styles/app.css';
import './styles/interface.css';
import { captureError, downloadDiagnostics, setDiagnosticContext, trace } from './diagnostics/client';
import { STATE_FIELDS, traceRows } from './diagnostics/schema';
import { WeatherEffects } from './components/WeatherEffects';
import { readFlightFile, type ImportedWorkbook } from './data/workbook';
import { isArrivalAtTsn, isDepartureFromTsn, toDayString } from './data/enrichFlights';
import { createDclEvents, formatDclMessage, type DclEvent } from './dcl/dclScenario';
import { runSimulation, toScheduledFlights, type SimulationResult, type TimelineItem } from './simulation/runSimulation';
import { getHoldingPoint, getRunwaySegment, getTaxiRouteDescription, MAP_VIEWBOX } from './map/airfieldGeometry';
import { arrivalPosition, departurePosition, TAKEOFF_VISIBLE_AFTER_MS } from './map/playback';
import { planAsync } from './simulation/planningClient';
import { scheduleArrivals, type ArrivalTimelineItem } from './simulation/arrivals';
import { clearanceRequestTime, departureCtotAt, departureTsatAt, departureWaitMinutesAt, departureTravelTimeMs } from './simulation/departureTiming';
import { applyWeatherPeriods, composeWeatherDclEvents, weatherStatus, departureStandAt, departureStatusAt, departureAtTime, hasMissedCtotAt, hasReissuedSlotAt, type WeatherPeriod } from './simulation/weather';

type FilePickerWindow = Window & { showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]> };
const SAMPLE_FILES = [
  { id: 'cd', label: 'Chuyên đề · tàu đi và đến', dates: '01.10.2026', filename: 'Chuyên đề.xlsx', url: '/samples/chuyen-de.xlsx' },
  { id: '7d', label: 'Bộ dữ liệu 7 ngày', dates: '01–07.11.2023', filename: 'Số liệu 7 ngày từ  01.11.23  đến 07.11.23.xls', url: '/samples/7-days.xls' },
  { id: '3d', label: 'Bộ dữ liệu 3 ngày', dates: '03–05.11.2023', filename: 'Số liệu 3 ngày từ  03.11.23  đến 05.11.23.xls', url: '/samples/3-days.xls' },
];
const RUNWAYS = [
  { id: '25L-25R', label: '25L / 25R' },
];
const speeds = [1, 5, 10, 30, 60];
const timeFormat = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortTimeFormat = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' });
const numberFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const fmtTime = (time: number) => Number.isFinite(time) ? timeFormat.format(time) : '—';
const fmtShort = (time: number) => Number.isFinite(time) ? shortTimeFormat.format(time) : '—';
const fmtTravelTime = (flight: TimelineItem) => {
  const seconds = Math.ceil(departureTravelTimeMs(flight) / 1000);
  return `${Math.floor(seconds / 60)} phút ${String(seconds % 60).padStart(2, '0')} giây`;
};
const fmtNumber = (n: number) => numberFormat.format(n);
const seeded = (text: string) => [...text].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

const DclMessageRow = memo(function DclMessageRow({ event, onSelect }: { event: DclEvent; onSelect: (callsign: string) => void }) {
  const messageFlow = event.direction === 'Tổ lái → Hệ thống' ? 'ACFT → ATC' : 'ATC → ACFT';
  const resultClass = event.status === 'OK' ? 'ok' : event.status === 'TỪ CHỐI' ? 'rejected' : 'timeout';
  return <tr className="dcl-board-row" onClick={() => onSelect(event.callsign)}>
    <td className="dcl-board-time">{fmtTime(event.time)}</td>
    <td><span className="dcl-flow">{messageFlow}</span></td>
    <td><code className="dcl-raw-message">{formatDclMessage(event.message).map((line, index) => <span className="dcl-message-line" key={index}>{line}</span>)}</code></td>
    <td><span className={`dcl-result dcl-result-${resultClass}`}><i />{event.status}</span></td>
  </tr>;
});

function App() {
  const [imported, setImported] = useState<ImportedWorkbook | null>(null);
  const [baselineFlights, setFlights] = useState<TimelineItem[]>([]);
  const [baselineArrivals, setArrivals] = useState<ArrivalTimelineItem[]>([]);
  const [weatherPeriods, setWeatherPeriods] = useState<WeatherPeriod[]>([]);
  const [weatherRequested, setWeatherRequested] = useState(false);
  const [proposed, setProposed] = useState<SimulationResult | null>(null);
  const [events, setEvents] = useState<DclEvent[]>([]);
  const [selectedFlight, setSelectedFlight] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState(SAMPLE_FILES[0].id);
  const [runway, setRunway] = useState(RUNWAYS[0].id);
  const [day, setDay] = useState('2023-11-03');
  const [speed, setSpeed] = useState(10);
  const [playing, setPlaying] = useState(false);
  const [minute, setMinute] = useState(300);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('Đang nạp dữ liệu chuyến đi và đến…');
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [filter, setFilter] = useState('all');
  const [showAllFlights, setShowAllFlights] = useState(false);
  const [showDclHistory, setShowDclHistory] = useState(false);
  const [focusMode, setFocusMode] = useState(() => localStorage.getItem('tsn-focus-mode') === 'true');
  const fileInput = useRef<HTMLInputElement>(null);
  const mapScroller = useRef<HTMLDivElement>(null);
  const sampleCache = useRef(new Map<string, ImportedWorkbook>());
  const sampleRequests = useRef(new Map<string, Promise<ImportedWorkbook>>());
  const customWorkbook = useRef<ImportedWorkbook | null>(null);
  const activeLoad = useRef(0);
  const dayJob = useRef<AbortController | null>(null);
  useEffect(() => { dayJob.current?.abort(); return () => dayJob.current?.abort(); }, [day, selectedSource]);

  function useWorkbook(next: ImportedWorkbook, source: string) {
    trace('dataset.selected', { source });
    dayJob.current?.abort(); dayJob.current = null;
    const movements = next.enrichedRows.filter((row) => isDepartureFromTsn(row) || isArrivalAtTsn(row));
    const dateCounts = new Map<string, number>();
    for (const row of movements) {
      const normalized = toDayString(row.FlyDate ?? row.Date);
      dateCounts.set(normalized, (dateCounts.get(normalized) ?? 0) + 1);
    }
    const activeDay = [...dateCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '2023-11-03';
    const dailyRows = movements.filter((row) => toDayString(row.FlyDate ?? row.Date) === activeDay);
    if (!dailyRows.length) throw new Error('Không tìm thấy chuyến đi hoặc đến VVTS trong dữ liệu này.');
    setImported(next); setSelectedSource(source); setDay(activeDay);
    setFlights([]); setArrivals([]); setProposed(null); setEvents([]); setPlaying(false); setMinute(0);
    setWeatherPeriods([]); setWeatherRequested(false);
    setMessage(`Đã sẵn sàng ${next.file.name} · ${fmtNumber(dailyRows.filter(isDepartureFromTsn).length)} chuyến đi · ${fmtNumber(dailyRows.filter(isArrivalAtTsn).length)} chuyến đến.`);
  }

  function fetchSample(id: string): Promise<ImportedWorkbook> {
    const cached = sampleCache.current.get(id);
    if (cached) return Promise.resolve(cached);
    const inFlight = sampleRequests.current.get(id);
    if (inFlight) return inFlight;
    const sample = SAMPLE_FILES.find((item) => item.id === id);
    if (!sample) return Promise.reject(new Error('Không tìm thấy bộ dữ liệu mẫu.'));
    const request = (async () => {
      const response = await fetch(sample.url);
      if (!response.ok) throw new Error(`Không tải được ${sample.filename} (${response.status}).`);
      const file = new File([await response.blob()], sample.filename, { type: sample.filename.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.ms-excel' });
      const workbook = await readFlightFile(file);
      sampleCache.current.set(id, workbook);
      return workbook;
    })();
    sampleRequests.current.set(id, request);
    void request.finally(() => sampleRequests.current.delete(id)).catch(() => undefined);
    return request;
  }

  async function selectSample(id: string) {
    const requestId = ++activeLoad.current;
    setSelectedSource(id);
    setBusy(true); setMessage('Đang chuẩn bị dữ liệu mẫu…');
    try {
      const next = await fetchSample(id);
      if (requestId === activeLoad.current) useWorkbook(next, id);
    } catch (error) {
      if (requestId === activeLoad.current) setMessage(`Lỗi dữ liệu mẫu: ${(error as Error).message}`);
    } finally {
      if (requestId === activeLoad.current) setBusy(false);
    }
  }

  useEffect(() => {
    void selectSample(SAMPLE_FILES[0].id).then(() => {
      for (const sample of SAMPLE_FILES.slice(1)) void fetchSample(sample.id).catch(() => undefined);
    });
  }, []);

  async function openWorkbook() {
    setBusy(true); setMessage('Đang mở workbook và chuẩn hóa dữ liệu…');
    try {
      const picker = (window as FilePickerWindow).showOpenFilePicker;
      let file: File; let handle: FileSystemFileHandle | undefined;
      if (picker) {
        const [selected] = await picker.call(window, {
          multiple: false, excludeAcceptAllOption: false,
          types: [{ description: 'Flight data Excel/CSV', accept: { 'application/vnd.ms-excel': ['.xls', '.xlsx', '.csv'], 'text/csv': ['.csv'] } }],
        });
        handle = selected; file = await selected.getFile();
      } else {
        fileInput.current?.click(); setBusy(false); setMessage('Trình duyệt đang mở hộp thoại chọn file.'); return;
      }
      await loadWorkbook(file, handle);
    } catch (error) {
      if ((error as DOMException).name !== 'AbortError') setMessage(`Không thể mở file: ${(error as Error).message}`);
      setBusy(false);
    }
  }

  async function loadWorkbook(file: File, handle?: FileSystemFileHandle) {
    const requestId = ++activeLoad.current;
    try {
      const next = await readFlightFile(file, handle);
      if (requestId === activeLoad.current) { customWorkbook.current = next; useWorkbook(next, 'custom'); }
    } catch (error) { if (requestId === activeLoad.current) setMessage(`Lỗi dữ liệu: ${(error as Error).message}`); }
    if (requestId === activeLoad.current) setBusy(false);
  }

  const currentSchedule = useMemo(() => imported?.enrichedRows.filter(isDepartureFromTsn) ?? [], [imported]);
  const dailySchedule = useMemo(() => currentSchedule.filter((row) => toDayString(row.FlyDate ?? row.Date) === day), [currentSchedule, day]);
  const dailyArrivals = useMemo(() => imported?.enrichedRows.filter((row) => isArrivalAtTsn(row) && toDayString(row.FlyDate ?? row.Date) === day) ?? [], [imported, day]);
  const timeCursor = new Date(day + 'T00:00:00').getTime() + minute * 60_000;
  const dayStart = new Date(day + 'T00:00:00').getTime();
  const weatherHorizon = weatherPeriods.some(period => period.end === null)
    ? baselineFlights.reduce((latest, flight) => { const request = flight.tsat - 20 * 60_000; return request <= timeCursor ? Math.max(latest, request) : latest; }, -Infinity)
    : Infinity;
  const [planningWeather, setPlanningWeather] = useState(false);
  const [weatherAttempt, setWeatherAttempt] = useState(0);
  const [weatherResult, setWeatherResult] = useState<{ source: typeof baselineFlights | null; flights: typeof baselineFlights; arrivals: typeof baselineArrivals; error: string }>({ source: null, flights: [], arrivals: [], error: '' });
  useEffect(() => {
    if (!weatherPeriods.length || (!baselineFlights.length && !baselineArrivals.length)) {
      setWeatherResult({ source: baselineFlights, flights: baselineFlights, arrivals: baselineArrivals, error: '' });
      setPlanningWeather(false); return;
    }
    const controller = new AbortController();
    setPlanningWeather(true);
    setWeatherResult(previous => previous.error ? { ...previous, error: '' } : previous);
    planAsync({ type: 'weather', flights: baselineFlights, arrivals: baselineArrivals, periods: weatherPeriods, runway, horizon: weatherHorizon }, controller.signal)
      .then(plan => { if (!controller.signal.aborted) setWeatherResult({ source: baselineFlights, ...plan, error: '' }); })
      .catch(error => { if (!controller.signal.aborted) { const id = captureError(error, 'weather_planning'); setWeatherResult(previous => ({ ...previous, error: `${(error as Error).message} · Mã lỗi ${id}` })); setPlaying(false); } })
      .finally(() => { if (!controller.signal.aborted) setPlanningWeather(false); });
    return () => controller.abort();
  }, [baselineFlights, baselineArrivals, weatherPeriods, runway, weatherHorizon, weatherAttempt]);
  const weatherPlan = weatherResult.source === baselineFlights ? weatherResult : { flights: baselineFlights, arrivals: baselineArrivals, error: '' };
  const { flights, arrivals } = weatherPlan;
  useEffect(() => {
    setDiagnosticContext(() => ({ source: selectedSource, day, runway, minute, speed, playing, planningWeather,
      weatherError: weatherPlan.error, periods: weatherPeriods,
      horizon: Number.isFinite(weatherHorizon) ? weatherHorizon : weatherHorizon === -Infinity ? '-Infinity' : 'Infinity',
      flightStates: traceRows(flights.slice(0, 1000).map(flight => ({ id: flight.id, callsign: flight.callsign,
        stand: departureStandAt(flight, timeCursor), tsat: departureTsatAt(flight, timeCursor), ctot: flight.ctot,
        reissuedTsat: flight.reissuedTsat, taxiStart: flight.taxiStart, secondTaxiStart: flight.secondTaxiStart,
        runwayEntryStart: flight.runwayEntryStart, takeoffRollStart: flight.takeoffRollStart, wheelsOff: flight.wheelsOff,
        status: departureStatusAt(flight, timeCursor, runway), blockedAt: flight.weather?.blockedAt,
        passedWeatherPoint: flight.weather?.passedWeatherPoint })), STATE_FIELDS),
      departures: traceRows(dailySchedule.slice(0, 1000)),
      arrivals: traceRows(dailyArrivals.slice(0, Math.max(0, 1000 - dailySchedule.length))) }));
  });
  const holdingPoint = getHoldingPoint(runway);
  const runwaySegment = getRunwaySegment(runway);
  const badWeather = proposed ? weatherPeriods.some((period) => period.start <= timeCursor && (period.end === null || timeCursor < period.end)) : weatherRequested;
  const openWeather = weatherPeriods.some((period) => period.end === null);
  const latestMovement = Math.max(...flights.map((flight) => flight.wheelsOff).filter(Number.isFinite), ...arrivals.filter(flight => flight.divertedAt === undefined).map((flight) => flight.standArrival).filter(Number.isFinite), 0);
  const playbackStartMinute = Math.min(0, ...baselineFlights.map(flight => Math.floor((clearanceRequestTime(flight.tsat, dayStart) - dayStart) / 60_000)), ...baselineArrivals.map(flight => Math.floor((flight.approachStart - dayStart) / 60_000)));
  const clockMinute = ((minute % 1440) + 1440) % 1440;
  const playbackEndMinute = Math.max(1440, Math.ceil(((latestMovement || dayStart + 1440 * 60_000) - dayStart) / 600_000) * 10, openWeather ? Math.ceil((minute + 60) / 60) * 60 : 0);
  const playbackEndLabel = playbackEndMinute <= 1440
    ? '24:00'
    : `${String(Math.floor((playbackEndMinute - 1440) / 60)).padStart(2, '0')}:${String((playbackEndMinute - 1440) % 60).padStart(2, '0')} +1 ngày`;
  const holdingQueue = flights
    .filter((flight) => {
      const weather = flight.weather;
      if (weather && timeCursor >= weather.start) {
        if (weather.missedAt !== null && timeCursor >= weather.missedAt && timeCursor < weather.groundReadyAt) return false;
        return timeCursor >= (weather.heldAtStand ? weather.groundReadyAt : weather.previous.taxiStart + flight.taxiMinutes * 60_000) && timeCursor < flight.runwayEntryStart;
      }
      return timeCursor >= (flight.secondTaxiStart ?? flight.taxiStart) + flight.taxiMinutes * 60_000 && timeCursor < flight.runwayEntryStart;
    })
    .sort((a, b) => a.order - b.order);
  function toggleWeather() {
    const next = !badWeather;
    trace('weather.changed', { adverse: next, minute });
    setWeatherRequested(next);
    if (!proposed) return;
    // Editing weather after seeking discards events later than the cursor.
    setWeatherPeriods((previous) => [
      ...previous.filter((period) => period.start < timeCursor).map((period) =>
        period.end !== null && period.end <= timeCursor ? period : { ...period, end: timeCursor }),
      ...(next ? [{ start: timeCursor, end: null }] : []),
    ]);
  }
  function resetReplay() {
    dayJob.current?.abort(); dayJob.current = null; setBusy(false);
    setFlights([]); setArrivals([]); setProposed(null); setEvents([]); setPlaying(false);
    setMinute(0); setWeatherPeriods([]); setWeatherRequested(false); setSelectedFlight(null);
  }
  function runDay() {
    trace('simulation.started', { source: selectedSource, day, runway });
    if (!imported) { setMessage('Hãy chọn workbook trước khi chạy mô phỏng.'); return; }
    setBusy(true);
    dayJob.current?.abort();
    const controller = new AbortController(); dayJob.current = controller;
    window.setTimeout(async () => {
      try {
        const physical = await planAsync({ type: 'day', rows: dailySchedule, arrivals: dailyArrivals, runway }, controller.signal);
        if (controller.signal.aborted) return;
        const finite = physical.flights.filter(flight => Number.isFinite(flight.wheelsOff));
        const improved: SimulationResult = { flights: physical.flights, totalWaitMinutes: physical.flights.reduce((sum, flight) => sum + flight.waitMinutes, 0),
          missedCtot: physical.flights.filter(flight => flight.missedCtot).length, reissuedCtot: 0,
          completed: finite.length, durationMinutes: finite.length ? (Math.max(...finite.map(flight => flight.wheelsOff)) - Math.min(...finite.map(flight => flight.readyAt))) / 60_000 : 0 };
        const inbound = physical.arrivals;
        setProposed(improved); setFlights(improved.flights); setArrivals(inbound);

        const firstDepartureMovement = Math.min(...improved.flights.map((flight) => clearanceRequestTime(flight.tsat, dayStart)), Infinity);
        const firstArrivalMovement = Math.min(...inbound.map((flight) => flight.approachStart), Infinity);
        const firstMovement = Math.min(firstDepartureMovement, firstArrivalMovement);
        const playbackStart = Number.isFinite(firstMovement) ? Math.floor((firstMovement - dayStart) / 60_000) : 0;
        setWeatherPeriods(badWeather ? [{ start: dayStart + playbackStart * 60_000, end: null }] : []);
        setMinute(playbackStart); setPlaying(true);
        const allEvents = improved.flights.flatMap((flight, index) => {
          const clearanceTime = clearanceRequestTime(flight.tsat, dayStart);
          const clearanceEvents = createDclEvents(flight.callsign, clearanceTime, seeded(flight.id) + index, {
            origin: String(flight.row.AirportDeliveryCode || 'VVTS'),
            destination: String(flight.row.AirportReceiptCode || 'VVDN'),
            stand: flight.stand, aircraftType: flight.aircraftType, runway, tsat: flight.tsat,
          }).map((event) => ({ ...event, flightId: flight.id, id: `${flight.id}-${event.id}` }));
          if (flight.reissuedTsat === null || flight.returnEnd === null) return clearanceEvents;
          const updateTime = flight.returnEnd;
          const revisedTsat = new Date(flight.reissuedTsat);
          const revisedStamp = `${String(revisedTsat.getHours()).padStart(2, '0')}${String(revisedTsat.getMinutes()).padStart(2, '0')}`;
          const date = new Date(updateTime);
          const stamp = `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')} ${String(date.getDate()).padStart(2, '0')}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getFullYear()).slice(-2)}`;
          return [...clearanceEvents, {
            id: `${flight.id}-tsat-update`, time: updateTime, callsign: flight.callsign,
            direction: 'Hệ thống → Tổ lái',
            message: `FSM ${stamp} VVTS ${flight.callsign} TSAT REVISED ${revisedStamp} RETURNED TO STAND ${flight.returnStand}`,
            status: 'OK' as const,
          }];
        });
        allEvents.sort((a, b) => a.time - b.time);
        setEvents(allEvents); setSelectedFlight(improved.flights[0]?.callsign ?? inbound[0]?.callsign ?? null);
        setMessage(`Mô phỏng hoàn tất · ${improved.completed} chuyến đi · ${inbound.length} chuyến đến.`);
      } catch (error) {
        if (controller.signal.aborted) return;
        const id = captureError(error, 'day_planning');
        setMessage(`Lỗi mô phỏng: ${(error as Error).message} · Mã lỗi ${id}`);
        setPlaying(false);
      } finally {
        if (dayJob.current === controller && !controller.signal.aborted) setBusy(false);
      }
    }, 20);
  }


  useEffect(() => {
    if (!playing || !proposed || planningWeather || weatherPlan.error) return;
    let frameId = 0;
    let previous = performance.now();
    let elapsed = 0;
    // Limit React work to 30 Hz, advancing by actual elapsed time at every speed.
    const frame = (now: number) => {
      elapsed += now - previous;
      previous = now;
      if (elapsed >= 1000 / 30) {
        const advance = elapsed * speed / 60_000;
        elapsed = 0;
        setMinute(current => {
          const next = current + advance;
          if (next >= playbackEndMinute && !openWeather) { setPlaying(false); return playbackEndMinute; }
          return next;
        });
      }
      frameId = requestAnimationFrame(frame);
    };
    // A background tab resumes at its current position instead of jumping ahead.
    const resetClock = () => { previous = performance.now(); elapsed = 0; };
    document.addEventListener('visibilitychange', resetClock);
    frameId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(frameId);
      document.removeEventListener('visibilitychange', resetClock);
    };
  }, [playing, proposed, speed, playbackEndMinute, openWeather, planningWeather, weatherPlan.error]);

  const visibleFlights = flights.filter((flight) => {
    const matchesSearch = `${flight.callsign} ${flight.aircraftType} ${flight.stand}`.toLowerCase().includes(search.toLowerCase());
    return matchesSearch && (filter === 'all' || (filter === 'missed' && hasMissedCtotAt(flight, timeCursor))
      || (filter === 'moving' && /lăn|vào đường băng|cất cánh|quay về/.test(departurePosition(flight, timeCursor, 0, runway).phase) && timeCursor < flight.wheelsOff));
  });
  const displayEvents = useMemo(() => {
    return composeWeatherDclEvents(events, flights, weatherPeriods);
  }, [events, flights, weatherPeriods]);
  const pastEventCount = displayEvents.filter(event => event.time <= timeCursor).length;
  const activeEvents = useMemo(() => {
    const past = displayEvents.slice(0, pastEventCount);
    return (showDclHistory ? past : past.slice(-8)).reverse();
  }, [displayEvents, pastEventCount, showDclHistory]);
  const currentMissed = flights.filter((flight) => hasMissedCtotAt(flight, timeCursor)).length;
  const currentReissued = flights.filter((flight) => hasReissuedSlotAt(flight, timeCursor)).length;
  const departureRcdTimes = useMemo(() => {
    const times = new Map<string, number>();
    for (const event of displayEvents) if (event.flightId && event.message.startsWith('RCD ') && !times.has(event.flightId)) {
      times.set(event.flightId, event.time);
    }
    return times;
  }, [displayEvents]);
  const currentWait = flights.reduce((total, flight) => total + departureWaitMinutesAt(flight, timeCursor), 0);

  return (
    <main className={`app-shell ${focusMode ? 'focus-mode' : ''}`}>
      {message.startsWith('Lỗi mô phỏng:') && <div role="alert">{message}</div>}
      {(busy || planningWeather) && <div role="status" className="planning-status" style={{ position: 'fixed', top: 80, right: 24, zIndex: 1000, padding: '8px 14px', borderRadius: 8, background: '#14283d', color: 'white', pointerEvents: 'none' }}>Đang cập nhật lịch…</div>}
      {weatherPlan.error && <div role="alert">Không thể cập nhật lịch: {weatherPlan.error} Bấm Phát để thử lại. <button onClick={downloadDiagnostics}>Tải báo cáo lỗi</button></div>}
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Flight operations home">
          <span className="brand-mark"><Plane size={19} strokeWidth={2.3} /></span>
          <span><strong>FLIGHT OPS</strong><small>TSN · DEPARTURE FLOW</small></span>
        </a>
        <div className="airport-indicator"><span className="live-dot" />TÂN SƠN NHẤT <span className="code-pill">VVTS</span></div>
        <button className="focus-toggle" aria-pressed={focusMode} onClick={() => setFocusMode(value => { localStorage.setItem('tsn-focus-mode', String(!value)); return !value; })}>{focusMode ? 'Thoát tập trung' : 'Chế độ tập trung'}</button>
      </header>

      <div className="project-disclosure" id="top">
      <section className="project-hero" aria-label="Thông tin đồ án">
        <img className="project-art" src="/assets/flight-operations.svg" alt="" aria-hidden="true" width="400" height="220" loading="lazy" />
        <div className="project-hero-copy">
          <div className="project-heading-row"><div className="project-kicker"><span className="project-kicker-line" /> NHÓM 5</div><span className="project-class">LỚP <b>23ĐHKL01</b></span></div>
          <h1>ỨNG DỤNG CPDLC- DCL TRONG QUẢN LÝ LUỒNG KHÔNG LƯU TẠI CẢNG HÀNG KHÔNG SÂN BAY TÂN SƠN NHẤT</h1>
          <div className="project-advisor"><span>Giảng viên hướng dẫn:</span> <strong>Nguyễn Ngọc Hoàng Quân</strong></div>
          <div className="project-authors"><strong>Châu Ngọc Xuân <span>2331710004</span></strong><strong>Nguyễn Doãn Phương <span>2331710008</span></strong><strong>Phan Ngọc Trâm <span>2331710044</span></strong><strong>Dương Thị Hương Thảo <span>2331710038</span></strong></div>
        </div>

      </section>

      </div>
      <div className="settings-disclosure">
      <section className="control-panel" aria-label="Thiết lập mô phỏng">
        <div className="control-source">
          <div className="control-label">NGUỒN DỮ LIỆU <span className="tiny-info" title="Các bộ dữ liệu có sẵn; tệp mới được tải riêng">i</span></div>
          <div className="source-picker">
            <label className="select-wrap"><FileSpreadsheet size={16} /><select aria-label="Bộ dữ liệu mẫu" value={selectedSource} onChange={(event) => { if (event.target.value === 'custom' && customWorkbook.current) { ++activeLoad.current; useWorkbook(customWorkbook.current, 'custom'); } else void selectSample(event.target.value); }}>{SAMPLE_FILES.map((sample) => <option value={sample.id} key={sample.id}>{sample.label} · {sample.dates}</option>)}{customWorkbook.current && <option value="custom">Tệp mới: {customWorkbook.current.file.name}</option>}</select><ChevronDown size={15} /></label>
            <button className="button-secondary" onClick={() => void openWorkbook()} disabled={busy}>{busy ? <span className="spinner" /> : <FileSpreadsheet size={16} />} Tải tệp mới</button>
          </div>
          <input ref={fileInput} type="file" accept=".xls,.xlsx,.csv" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadWorkbook(file); event.currentTarget.value = ''; }} />
        </div>
        <div className="control-divider" />
        <label className="control-field"><span className="control-label">NGÀY KHAI THÁC</span><span className="select-wrap"><CalendarDays size={16} /><input aria-label="Ngày khai thác" type="date" value={day} onChange={(event) => { setDay(event.target.value); resetReplay(); }} /><ChevronDown size={15} /></span></label>
        <label className="control-field runway-field"><span className="control-label">CẤU HÌNH ĐƯỜNG BĂNG</span><span className="select-wrap"><Layers3 size={16} /><select aria-label="Cấu hình đường băng" value={runway} onChange={(event) => { setRunway(event.target.value); resetReplay(); }}>{RUNWAYS.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select><ChevronDown size={15} /></span></label>
        <button className="button-primary" onClick={runDay} disabled={!imported || busy}>{busy ? <span className="spinner light" /> : <Play size={16} fill="currentColor" />} Chạy mô phỏng</button>
      </section>
      </div>
      {(message.startsWith('Lỗi') || message.startsWith('Không thể') || message.startsWith('Không tải được') || message.startsWith('Không tìm thấy')) && <div className="notice notice-error" role="alert"><Info size={15} /><span>{message}</span></div>}

      <section className="playback-bar" aria-label="Điều khiển phát lại">
        <button type="button" className="icon-button" onClick={downloadDiagnostics} aria-label="Tải nhật ký" title="Tải nhật ký"><FileSpreadsheet size={16} /></button>
        <div className="playback-label"><span className={`playback-dot ${playing ? 'active' : ''}`} /><span>{playing ? 'ĐANG PHÁT' : 'PHÁT LẠI 24 GIỜ'}</span></div>
        <button className="play-button" disabled={busy} aria-label={playing ? 'Tạm dừng mô phỏng' : 'Phát mô phỏng'} onClick={() => { trace('playback.clicked', { minute, playing, planningWeather, retry: Boolean(weatherPlan.error) }); if (!proposed) runDay(); else if (weatherPlan.error) { setPlanningWeather(true); setWeatherAttempt(attempt => attempt + 1); setPlaying(true); } else setPlaying(!playing); }}><span>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</span>{playing ? 'Tạm dừng' : 'Phát'}</button>
        <button className="play-button" aria-label="Lùi 30 giây" title="Lùi 30 giây" disabled={!proposed} onClick={() => { trace('playback.rewind', { minute, seconds: 30 }); setMinute(current => Math.max(playbackStartMinute, current - 30 / 60)); }}>↶ 30s</button>
        <div className="timeline-control"><span className="timeline-start">{fmtShort(dayStart + playbackStartMinute * 60_000)}</span><input aria-label="Tua thời gian mô phỏng" type="range" min={playbackStartMinute} max={playbackEndMinute} step={1} value={minute} style={{ '--progress': String((minute - playbackStartMinute) / (playbackEndMinute - playbackStartMinute) * 100) + '%' } as React.CSSProperties} onChange={(event) => { const next = Number(event.target.value); trace('playback.seek', { from: minute, to: next }); setMinute(next); }} /><span className="timeline-end">{playbackEndLabel}</span></div>
        <div className="clock-display"><Clock3 size={15} /><strong>{Math.floor(clockMinute / 60).toString().padStart(2, '0')}:{Math.floor(clockMinute % 60).toString().padStart(2, '0')}</strong><span>LT{minute >= 1440 ? ' +1' : minute < 0 ? ' −1' : ''}</span></div>
        <span className="playback-divider" />
        <div className="speed-control" aria-label="Tốc độ phát lại">{speeds.map((value) => <button key={value} onClick={() => { trace('playback.speed', { speed: value }); setSpeed(value); }} className={speed === value ? 'active' : ''} aria-pressed={speed === value}>{value}×</button>)}</div>
      </section>


      <div className="workspace-grid">
        <section className="panel map-panel" aria-label="PARKING CHART">
          <div className="panel-heading"><div><div className="panel-kicker">SƠ ĐỒ ĐƯỜNG LĂN</div><span className="heading-count">{flights.length || arrivals.length ? `${fmtNumber(flights.length)} đi · ${fmtNumber(arrivals.length)} đến${arrivals.some(arrival => (arrival.divertedAt ?? Infinity) <= timeCursor) ? ` · ${arrivals.filter(arrival => (arrival.divertedAt ?? Infinity) <= timeCursor).length} chuyển hướng` : ''}` : '—'}</span></div><div className="map-actions"><button type="button" role="switch" aria-checked={badWeather} aria-label="Thời tiết xấu" className={`map-weather-switch ${badWeather ? 'is-adverse' : ''}`} onClick={toggleWeather} disabled={busy}>{badWeather ? <CloudRain size={15} /> : <Sun size={15} />}<span>Thời tiết xấu</span><span className="weather-toggle"><i /></span></button><div className="map-view-controls" role="group" aria-label="Điều khiển bản đồ"><button className="expand-panel" aria-label="Phóng rộng bản đồ" title="Phóng rộng bản đồ · Esc để thoát" onClick={event => { const panel = event.currentTarget.closest('.map-panel'); if (document.fullscreenElement) void document.exitFullscreen(); else if (panel) void panel.requestFullscreen(); }}><Maximize2 size={16} /></button><button className="icon-button" aria-label="Thu nhỏ bản đồ" onClick={() => setZoom(Math.max(.8, zoom - .15))}><ZoomOut size={16} /></button><span className="zoom-value">{Math.round(zoom * 100)}%</span><button className="icon-button" aria-label="Phóng to bản đồ" onClick={() => setZoom(Math.min(1.5, zoom + .15))}><ZoomIn size={16} /></button><span className="map-action-sep" /><button className="icon-button" aria-label="Đặt lại bản đồ" onClick={() => { setZoom(1); mapScroller.current?.scrollTo({ left: 0, top: 0 }); }}><RotateCcw size={16} /></button></div></div></div>
          <div className="map-stage">
          <div className="map-wrap" ref={mapScroller}>
            <div className="map-canvas" style={{ transform: `scale(${zoom})` }}>
              <img src="/assets/PARKING_CHART_clean.png" alt="Sơ đồ đường băng, đường lăn và vị trí đỗ Tân Sơn Nhất" draggable={false} />
              <svg className="map-overlay" viewBox={MAP_VIEWBOX} role="img" aria-label="Sơ đồ tàu bay đi và đến">
                <g className="holding-marker" aria-label="Điểm chờ S1 trước đường băng 25L">
                  <circle cx={holdingPoint.x} cy={holdingPoint.y} r="10" />
                  <text x={holdingPoint.x - 65} y={holdingPoint.y - 16}>S1 · 25L</text>
                </g>
                <g className="runway-end"><circle cx={runwaySegment.threshold.x} cy={runwaySegment.threshold.y} r="6" />
                  <text x={runwaySegment.threshold.x - 95} y={runwaySegment.threshold.y + 25}>CẤT CÁNH · 25L</text></g>
                {flights.filter((flight) => !flight.weather?.offApron && timeCursor >= (departureRcdTimes.get(flight.id) ?? Infinity) && timeCursor < flight.wheelsOff + TAKEOFF_VISIBLE_AFTER_MS).map((flight) => {
                  const queueIndex = holdingQueue.findIndex((queued) => queued.id === flight.id);
                  const position = departurePosition(flight, timeCursor, queueIndex, runway);
                  const chosen = selectedFlight === flight.callsign;
                  const weather = weatherStatus(flight, timeCursor);
                  const delayed = weather ? weather.missed : flight.missedCtot && timeCursor >= (flight.returnStart ?? Infinity) && timeCursor < (flight.returnEnd ?? Infinity);
                  return <g key={flight.id} className={`aircraft-marker departure ${chosen ? 'selected' : ''} ${delayed ? 'delayed' : ''}`}
                    transform={`translate(${position.point.x} ${position.point.y}) rotate(${position.rotation})`}
                    onClick={() => setSelectedFlight(flight.callsign)}
                    onKeyDown={(event) => { if (event.key === 'Enter') setSelectedFlight(flight.callsign); }}
                    role="button" aria-label={`${flight.callsign}, tàu đi hạng ${flight.wakeCategory}, ${position.phase}`} tabIndex={0}>
                    <title>{`${flight.callsign} · ${position.phase}`}</title>
                    {chosen && <circle className="marker-pulse" r="16" />}
                    <circle className="marker-halo" r="10" />
                    <path d="M0-9 2-1 7 2 7 4 2 3 2 8 0 9-2 8-2 3-7 4-7 2-2-1Z" />
                    <circle className="marker-core" r="2.5" />
                    {chosen && <g className="marker-label"><rect x="12" y="-16" width="92" height="23" rx="5" /><text x="20" y="0">{flight.callsign}</text></g>}
                  </g>;
                })}
                {arrivals.filter((flight) => timeCursor < (flight.divertedAt ?? Infinity) && timeCursor >= (flight.weather?.surfacePlan?.visibleFrom ?? flight.weather?.previous.approachStart ?? flight.approachStart) && timeCursor <= (flight.weather?.surfacePlan?.visibleUntil ?? (flight.weather ? dayStart + playbackEndMinute * 60_000 : flight.surfacePlan?.visibleUntil ?? dayStart + playbackEndMinute * 60_000))).map((flight) => {
                  const position = arrivalPosition(flight, timeCursor);
                  const chosen = selectedFlight === flight.callsign;
                  return <g key={flight.id} className={`aircraft-marker arrival ${chosen ? 'selected' : ''}`}
                    transform={`translate(${position.point.x} ${position.point.y}) rotate(${position.rotation})`}
                    onClick={() => setSelectedFlight(flight.callsign)}
                    onKeyDown={(event) => { if (event.key === 'Enter') setSelectedFlight(flight.callsign); }}
                    role="button" aria-label={`${flight.callsign}, tàu đến hạng ${flight.wakeCategory}, ${position.phase}`} tabIndex={0}>
                    <title>{`${flight.callsign} · ${position.phase}`}</title>
                    {chosen && <circle className="marker-pulse" r="16" />}
                    <circle className="marker-halo" r="10" />
                    <path d="M0-9 2-1 7 2 7 4 2 3 2 8 0 9-2 8-2 3-7 4-7 2-2-1Z" />
                    <circle className="marker-core" r="2.5" />
                    {chosen && <g className="marker-label"><rect x="12" y="-16" width="92" height="23" rx="5" /><text x="20" y="0">{flight.callsign}</text></g>}
                  </g>;
                })}
              </svg>
            </div>
          </div>
          <WeatherEffects active={badWeather} />
          </div>
          <div className="map-legend"><span><i className="legend-dot aircraft" />Tàu đi · 25L</span><span><i className="legend-dot arrival-aircraft" />Tàu đến · 25R</span><span><i className="legend-dot delayed-aircraft" />Không tuân thủ CTOT</span><span><i className="legend-ring" />Chờ tại S1/P5</span></div>
        </section>

        <div className="communications-column">
          <section className={`weather-bulletin ${badWeather ? 'adverse' : ''}`} aria-label="Bản tin thời tiết">
            <div><strong>BẢN TIN THỜI TIẾT</strong></div>
            <p role="status">{badWeather ? 'ADVERSE WEATHER' : weatherPeriods.some(period => period.end !== null && period.end <= timeCursor) ? 'WEATHER IMPROVED · OPERATIONS RESUMED' : 'Thời tiết tốt'}</p>
            <time>{fmtTime(weatherPeriods.flatMap(period => [period.start, ...(period.end === null ? [] : [period.end])]).filter(at => at <= timeCursor).at(-1) ?? dayStart)} LT</time>
          </section>
        <section className="panel dcl-panel" aria-label="Bản tin DCL"><button className="expand-panel dcl-expand" aria-label="Phóng rộng bản tin DCL" title="Phóng rộng DCL · Esc để thoát" onClick={event => { const panel = event.currentTarget.closest('.dcl-panel'); if (document.fullscreenElement) void document.exitFullscreen(); else if (panel) void panel.requestFullscreen(); }}><Maximize2 size={16} /></button>
          <div className="panel-heading"><div><h2>Bản tin DCL</h2></div><button className="dcl-history-toggle" aria-pressed={showDclHistory} onClick={() => setShowDclHistory(value => !value)}>{showDclHistory ? '8 tin mới nhất' : 'Xem lịch sử'}</button></div>
          <div className="dcl-body">
            <table className="dcl-board" aria-label="Bảng điện văn DCL">
              <thead><tr><th>GIỜ LT</th><th>LUỒNG</th><th>ĐIỆN VĂN</th><th>KẾT QUẢ</th></tr></thead>
              <tbody>
                {activeEvents.length ? activeEvents.map(event => <DclMessageRow key={event.id} event={event} onSelect={setSelectedFlight} />) : <tr><td colSpan={4} className="dcl-empty-cell"><Radio size={16} />Bản tin sẽ xuất hiện đồng bộ theo thời gian mô phỏng.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="dcl-footer"><span><span className="live-dot" />{fmtNumber(activeEvents.length)} / {fmtNumber(pastEventCount)} bản tin đã phát</span><span>RCD <i>→</i> FSM <i>→</i> CLD <i>→</i> CDA</span></div>
        </section>
        </div>
      </div>

      <section className="kpi-grid" aria-label="Chỉ số mô phỏng">
        <article className="kpi-card"><div className="kpi-top"><span>TỔNG CHUYẾN</span><span className="kpi-icon blue"><Plane size={17} /></span></div><div className="kpi-value">{fmtNumber(proposed?.completed ?? dailySchedule.length)}</div></article>
        <article className="kpi-card"><div className="kpi-top"><span>TỔNG THỜI GIAN CHỜ</span><span className="kpi-icon amber"><Clock3 size={17} /></span></div><div className="kpi-value">{fmtNumber(currentWait)}<small> phút</small></div></article>
        <article className="kpi-card"><div className="kpi-top"><span>KHÔNG TUÂN THỦ CTOT</span><span className="kpi-icon red"><AlertTriangle size={17} /></span></div><div className="kpi-value">{fmtNumber(currentMissed)}</div></article>
      </section>

      <div className="queue-grid">
        <section className="panel queue-panel" aria-label="Hàng chờ cất cánh">
          <div className="panel-heading queue-heading"><div><h2>Hàng chờ cất cánh</h2></div><span className={`queue-live ${playing ? 'on' : ''}`}><span />{playing ? 'LIVE' : 'ĐANG CHỜ'}</span></div>
          <div className="queue-toolbar"><div className="search-box"><Search size={15} /><input aria-label="Tìm chuyến bay" placeholder="Tìm callsign, stand…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><select aria-label="Lọc hàng chờ" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Tất cả chuyến</option><option value="moving">Đang lăn</option><option value="missed">Không tuân thủ CTOT</option></select></div>
          <div className="table-scroll" style={showAllFlights ? { height: 'auto', maxHeight: 'none', overflow: 'visible' } : undefined}><table><thead><tr><th>#</th><th>CALLSIGN / LOẠI TÀU BAY</th><th>STAND</th><th>CTOT</th><th>THỜI GIAN LĂN</th><th>TSAT</th><th>TRẠNG THÁI</th></tr></thead><tbody>
            {visibleFlights.slice(0, showAllFlights ? undefined : 10).map((plannedFlight) => {
              const flight = departureAtTime(plannedFlight, timeCursor);
              const weather = weatherStatus(flight, timeCursor);
              const missed = hasMissedCtotAt(flight, timeCursor);
              const revisedSlot = flight.reissuedTsat ?? flight.reissuedCtot;
              const awaitingWeatherTimes = badWeather && missed && timeCursor < flight.wheelsOff;
              const tsat = weather ? weather.tsat : departureTsatAt(flight, timeCursor);
              const status = !badWeather && timeCursor < flight.wheelsOff && (planningWeather || weatherPlan.error)
                ? weatherPlan.error ? 'Chưa cập nhật lịch' : 'Đang cập nhật lịch'
                : badWeather && timeCursor < flight.takeoffRollStart ? missed ? 'Không tuân thủ CTOT' : 'Chờ thời tiết tốt' : departureStatusAt(flight, timeCursor, runway);
              return <tr key={flight.id} className={selectedFlight === flight.callsign ? 'selected-row' : ''} onClick={() => setSelectedFlight(flight.callsign)}>
                <td className="order-cell">{flight.order.toString().padStart(2, '0')}</td>
                <td><div className="flight-call">{flight.callsign}</div><div className="flight-type">{flight.aircraftType}</div></td>
                <td><span className="stand-pill">{flight.weather?.offApron ? 'Chờ vị trí đỗ' : departureStandAt(flight, timeCursor)}</span></td>
                <td className="time-cell" title={`CTOT gốc ${fmtShort(flight.ctot)}`}>{awaitingWeatherTimes ? 'Đang chờ CTOT' : fmtShort(departureCtotAt(flight, timeCursor))}</td>
                <td className="time-cell" title="Từ lúc rời stand đến khi bay lên; không gồm thời gian đứng chờ">{fmtTravelTime(flight)}</td>
                <td className="time-cell" title={`CTOT gốc ${fmtShort(flight.ctot)}${revisedSlot !== null && Number.isFinite(revisedSlot) ? ` · ${flight.reissuedTsat !== null ? 'TSAT' : 'CTOT'} mới ${fmtShort(revisedSlot)}` : ''}`}>{awaitingWeatherTimes ? 'Đang chờ TSAT' : tsat === null || !Number.isFinite(tsat) ? 'Chờ cấp lại' : fmtShort(tsat)}</td>
                <td><span className={`status-pill ${missed ? 'status-late' : weather?.pending || (!weather && flight.waitMinutes > .1) ? 'status-wait' : 'status-ok'}`}><i />{status}</span></td>
              </tr>;
            })}
            {!visibleFlights.length && <tr><td colSpan={7} className="empty-row">{flights.length ? 'Không có chuyến phù hợp bộ lọc.' : 'Nạp dữ liệu và chạy mô phỏng để hiển thị hàng chờ.'}</td></tr>}
          </tbody></table></div>
          <div className="queue-footer"><span>Hiển thị <b>{fmtNumber(showAllFlights ? visibleFlights.length : Math.min(visibleFlights.length, 10))}</b> / {fmtNumber(visibleFlights.length)} chuyến</span>{visibleFlights.length > 10 && <button onClick={() => setShowAllFlights(value => !value)}>{showAllFlights ? 'Thu gọn' : 'Xem toàn bộ'} <ArrowRight size={14} /></button>}</div>
        </section>
      </div>
    </main>
  );
}

export default App;




