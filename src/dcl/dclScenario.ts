export type DclEvent = { id: string; flightId?: string; time: number; callsign: string; direction: string; message: string; status: 'OK' | 'TỪ CHỐI' | 'TIMEOUT' };
export type DclContext = { origin?: string; destination?: string; stand?: string; aircraftType?: string; runway?: string; tsat?: number };

/** Lay out each simulated telegram in the same field groups as the DCL examples. */
export function formatDclMessage(message: string): string[] {
  const text = message.trim().replace(/\s+/g, ' ');
  let match = text.match(/^CDA (\d{4}) (\d{6}) ([A-Z]{4}) (\S+) CDA RECEIVED CLEARANCE CONFIRMED$/);
  if (match) return [`CDA ${match[1]} ${match[2]} ${match[3]}`, `${match[4]} CDA RECEIVED`, 'CLEARANCE CONFIRMED'];

  match = text.match(/^FSM (\d{4}) (\d{6}) ([A-Z]{4}) (\S+) (.+)$/);
  if (match) {
    const header = `FSM ${match[1]} ${match[2]} ${match[3]}`;
    const body = match[5];
    if (body === 'RCD RECEIVED REQUEST BEING PROCESSED STANDBY') return [header, `${match[4]} RCD RECEIVED`, 'REQUEST BEING PROCESSED', 'STANDBY'];
    if (body === 'RCD REJECTED REVERT TO VOICE PROCEDURES') return [header, `${match[4]} RCD REJECTED`, 'REVERT TO VOICE PROCEDURES'];
    if (body.startsWith('TSAT REVISED ')) return [header, `${match[4]} TSAT REVISED ${body.slice('TSAT REVISED '.length, 'TSAT REVISED '.length + 4)}`, ...body.slice('TSAT REVISED '.length + 4).trim().split(/ (?=CLEARANCE CONFIRMED|RETURNED TO STAND)/).filter(Boolean)];
    if (body === 'CTOT EXPIRED' || body.startsWith('CTOT EXPIRED ')) return [header, `${match[4]} CTOT EXPIRED`];
    if (body === 'ADVERSE WEATHER DEPARTURE CLEARANCES SUSPENDED STANDBY') return [header, 'ALL · ADVERSE WEATHER', 'DEPARTURE CLEARANCES SUSPENDED', 'STANDBY'];
    if (body === 'WEATHER IMPROVED DEPARTURE CLEARANCES RESUMED') return [header, 'ALL · WEATHER IMPROVED', 'DEPARTURE CLEARANCES RESUMED'];
    return [header, `${match[4]} ${body}`];
  }

  match = text.match(/^CLD (\d{4}) (\d{6}) ([A-Z]{4}) (PDC \d+) (\S+) CLRD TO (\S+) OFF (\S+) VIA (.+?) SQUAWK (\d+)(?: (TSAT|CTOT)( REVISED)? (\d{4}))?$/);
  if (match) return [
    `CLD ${match[1]} ${match[2]} ${match[3]} ${match[4]}`,
    `${match[5]} CLRD TO ${match[6]} OFF`,
    `${match[7]} VIA ${match[8]}`,
    `SQUAWK ${match[9]}`,
    ...(match[10] ? [`${match[10]}${match[11] ?? ''} ${match[12]}`] : []),
  ];

  match = text.match(/^RCD (\S+)-([A-Z]{4})-STAND (\S+)-([A-Z]{4}) ATIS ([A-Z])-TYP\/(.+?)-RMK\/(.*)$/);
  if (match) return [
    `RCD ${match[1]}-${match[2]}`,
    `STAND ${match[3]}-${match[4]}`,
    `ATIS ${match[5]}  TYP/${match[6]}`,
    `RMK/${match[7]}`,
  ];
  return [text];
}

const hhmm = (time: number) => { const date = new Date(time); return `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`; };
const ddmmyy = (time: number) => { const date = new Date(time); return `${String(date.getDate()).padStart(2, '0')}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getFullYear()).slice(-2)}`; };

export function createDclEvents(callsign: string, baseTime: number, seed: number, context: DclContext = {}): DclEvent[] {
  const origin = context.origin || 'VVTS';
  const destination = context.destination || 'VVDN';
  const aircraftType = context.aircraftType || 'A320';
  const stand = context.stand || '12';
  const runway = context.runway?.split('-')[0] || '25L';
  const slot = context.tsat ? hhmm(context.tsat) : hhmm(baseTime);
  void seed;
  const events: DclEvent[] = [
    { id: `${callsign}-rcd`, time: baseTime, callsign, direction: 'Tổ lái → Hệ thống', message: `RCD ${callsign}-${origin}-STAND ${stand}-${destination} ATIS B-TYP/${aircraftType}-RMK/`, status: 'OK' },
    { id: `${callsign}-fsm`, time: baseTime + 15_000, callsign, direction: 'Hệ thống → Tổ lái', message: `FSM ${hhmm(baseTime + 15_000)} ${ddmmyy(baseTime)} ${origin} ${callsign} RCD RECEIVED REQUEST BEING PROCESSED STANDBY`, status: 'OK' },
  ];

  const clearanceTime = baseTime + 40_000;
  events.push(
    { id: `${callsign}-cld`, time: clearanceTime, callsign, direction: 'Hệ thống → Tổ lái', message: `CLD ${hhmm(clearanceTime)} ${ddmmyy(baseTime)} ${origin} PDC 001 ${callsign} CLRD TO ${destination} OFF ${runway} VIA SID DEMO1 SQUAWK 2201 TSAT ${slot}`, status: 'OK' },
    { id: `${callsign}-cda`, time: clearanceTime + 25_000, callsign, direction: 'Tổ lái → Hệ thống', message: `CDA ${hhmm(clearanceTime + 25_000)} ${ddmmyy(baseTime)} ${origin} ${callsign} CDA RECEIVED CLEARANCE CONFIRMED`, status: 'OK' },
  );
  return events;
}
