import type { MapPoint } from './parkingGeometry';

export type SurfaceRoute = { id: string; label: string; points: MapPoint[] };
export const CHART_WIDTH = 2048;
export const CHART_HEIGHT = 1413;
export const S_Y = 495;
export const V_Y = 559;
export const HOLD_S1: MapPoint = { x: 1973, y: 476 };
export const P5_HOLD: MapPoint = { x: 440, y: 332 };
export const RUNWAY_ENTRY: MapPoint = { x: 1936, y: 411 };
export const RUNWAY_END: MapPoint = { x: 54, y: 411 };

export const STAND_POINTS: Record<string, MapPoint> = {};
const upperColumns = [692, 715, 738, 843, 866, 889, 912, 934, 957, 979, 1040, 1063, 1086, 1109, 1132, 1155];
const upperNames = ['86', '85', '84', '83', '82', '81', '80', '79', '78', '77', '76', '75', '74', '73', '72', '71'];
const lowerNames = ['104B', '104A', '103B', '103A', '102', '101', '100', '99', '98', '97', '96', '95', '94', '93', '92', '91'];
const lowerColumns = [764, 790, 813, 836, 859, 882, 905, 928, 963, 986, 1009, 1032, 1055, 1078, 1101, 1124];
upperNames.forEach((stand, index) => { STAND_POINTS[stand] = { x: upperColumns[index], y: 590 }; });
lowerNames.forEach((stand, index) => { STAND_POINTS[stand] = { x: lowerColumns[index], y: 665 }; });
Object.assign(STAND_POINTS, {
  '81A': { x: 904, y: 604 }, '79A': { x: 956, y: 604 }, '77A': { x: 1001, y: 604 },
  '17': { x: 1395, y: 654 }, '18': { x: 1383, y: 688 }, '19': { x: 1366, y: 720 },
  '20': { x: 1347, y: 757 }, '21': { x: 1329, y: 793 }, '22': { x: 1311, y: 830 },
  '23': { x: 1325, y: 852 }, '24': { x: 1301, y: 839 }, '25': { x: 1280, y: 826 },
  '26': { x: 1296, y: 906 }, '27': { x: 1273, y: 892 }, '28': { x: 1250, y: 879 },
  '29': { x: 1284, y: 646 }, '30': { x: 1267, y: 682 }, '31': { x: 1248, y: 718 }, '32': { x: 1232, y: 753 },
  '33': { x: 1257, y: 618 }, '34': { x: 1239, y: 655 }, '35': { x: 1223, y: 691 }, '36': { x: 1207, y: 729 },
  '37': { x: 1204, y: 810 }, '38': { x: 1183, y: 797 }, '39': { x: 1160, y: 784 }, '40': { x: 1140, y: 771 },
});
for (let stand = 9; stand <= 16; stand += 1) STAND_POINTS[String(stand)] = { x: 1704 - (stand - 9) * 40, y: 621 };
export const DOMESTIC_BAYS = [...upperNames, ...lowerNames, '81A', '79A', '77A', ...Array.from({ length: 24 }, (_, index) => String(index + 17))];
export const INTERNATIONAL_BAYS = Array.from({ length: 8 }, (_, index) => String(index + 9));

export function curve(a: MapPoint, b: MapPoint, c: MapPoint, d: MapPoint, steps = 12): MapPoint[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps, u = 1 - t;
    return { x: u ** 3 * a.x + 3 * u ** 2 * t * b.x + 3 * u * t ** 2 * c.x + t ** 3 * d.x,
      y: u ** 3 * a.y + 3 * u ** 2 * t * b.y + 3 * u * t ** 2 * c.y + t ** 3 * d.y };
  });
}

const pathLengthCache = new WeakMap<MapPoint[], number>();
export function pathLength(points: MapPoint[]): number {
  const cached = pathLengthCache.get(points);
  if (cached !== undefined) return cached;
  const length = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
  pathLengthCache.set(points, length);
  return length;
}


/** Distance along a chart taxi route to the marked CTOT commitment point near S1. */
export const CTOT_COMMIT_POINT: MapPoint = { x: 1880, y: S_Y };
export function distanceAlongPathToPoint(points: MapPoint[], target = CTOT_COMMIT_POINT, tolerance = 36): number | null {
  let traversed = 0;
  let bestDistance = Infinity;
  let bestProgress: number | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1], end = points[index];
    const dx = end.x - start.x, dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const ratio = Math.max(0, Math.min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / (length * length)));
    const distance = Math.hypot(start.x + ratio * dx - target.x, start.y + ratio * dy - target.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestProgress = traversed + ratio * length;
    }
    traversed += length;
  }
  return bestDistance <= tolerance ? bestProgress : null;
}

type Edge = { to: string; points: MapPoint[]; length: number; key: string };
const points = new Map<string, MapPoint>();
const edges = new Map<string, Edge[]>();
function node(name: string, point: MapPoint) { points.set(name, point); edges.set(name, edges.get(name) ?? []); }
function edge(from: string, to: string, via: MapPoint[] = []) {
  const path = [points.get(from)!, ...via, points.get(to)!];
  const key = [from, to].sort().join('|');
  edges.get(from)!.push({ to, points: path, length: pathLength(path), key });
  edges.get(to)!.push({ to: from, points: [...path].reverse(), length: pathLength(path), key });
}

// Surveyed junctions and stand spurs. Lane anchors split shared pavement into
// the same edges; alternate routes cannot silently cut across the apron.
const vAnchors = new Set([110, 475, 580, 668, 786, 1024, 1180, 1220, 1355, 1440, 1540, 1710, 1810, 1880]);
const yAnchors = new Set([668, 786, 1024, 1175]);
for (const name of upperNames) vAnchors.add(STAND_POINTS[name].x + 17);
for (const name of lowerNames) yAnchors.add(STAND_POINTS[name].x + 16);
for (let stand = 9; stand <= 16; stand += 1) vAnchors.add(STAND_POINTS[String(stand)].x + 18);
[866, 918, 963].forEach((x) => vAnchors.add(x));
const vXs = [...vAnchors].sort((a, b) => a - b);
for (const x of vXs) node(`V:${x}`, { x, y: V_Y });
for (let index = 1; index < vXs.length; index += 1) edge(`V:${vXs[index - 1]}`, `V:${vXs[index]}`);
const sXs = [110, 475, 786, 1170, 1440, 1540, 1710, 1810, 1880, 1945];
for (const x of sXs) node(`S:${x}`, { x, y: S_Y });
for (let index = 1; index < sXs.length; index += 1) edge(`S:${sXs[index - 1]}`, `S:${sXs[index]}`);
node('S1', HOLD_S1);
edge('S:1945', 'S1', curve({ x: 1945, y: S_Y }, { x: 1963, y: S_Y }, { x: 1973, y: 489 }, HOLD_S1).slice(1, -1));
edge('V:1880', 'S1', [{ x: 1915, y: 538 }, { x: 1945, y: 520 }, { x: 1968, y: 503 }]);
const RETURN_1A = curve(CTOT_COMMIT_POINT, { x: 1880, y: 520 }, { x: 1850, y: V_Y }, { x: 1810, y: V_Y });
edge('S:1880', 'V:1810', RETURN_1A.slice(1, -1));
edge('V:580', 'S:475', [{ x: 550, y: 559 }, { x: 520, y: 545 }, { x: 488, y: 522 }]);
edge('V:786', 'S:786', [{ x: 786, y: 532 }]);
edge('V:1180', 'S:1170', [{ x: 1202, y: 550 }, { x: 1216, y: 530 }, { x: 1216, y: 516 }, { x: 1195, y: 500 }]);
edge('V:1355', 'S:1440', [{ x: 1380, y: 550 }, { x: 1402, y: 525 }, { x: 1410, y: 510 }]);
edge('V:1540', 'S:1540', [{ x: 1557, y: 542 }, { x: 1560, y: 518 }, { x: 1550, y: 501 }]);
edge('V:1710', 'S:1710', [{ x: 1728, y: 541 }, { x: 1730, y: 517 }, { x: 1720, y: 501 }]);
const yXs = [...yAnchors].sort((a, b) => a - b);
for (const x of yXs) node(`Y:${x}`, { x, y: 631 });
for (let index = 1; index < yXs.length; index += 1) edge(`Y:${yXs[index - 1]}`, `Y:${yXs[index]}`);
for (const x of [668, 786, 1024]) edge(`Y:${x}`, `V:${x}`, [{ x, y: 603 }]);
edge('Y:1175', 'V:1180', [{ x: 1194, y: 621 }, { x: 1204, y: 599 }, { x: 1198, y: 577 }]);

for (const name of upperNames) {
  const start = STAND_POINTS[name], join = { x: start.x + 17, y: V_Y };
  node(`B:${name}`, start); edge(`B:${name}`, `V:${join.x}`, curve(start, { x: start.x, y: 575 }, { x: start.x, y: V_Y }, join).slice(1, -1));
}
for (const name of lowerNames) {
  const start = STAND_POINTS[name], join = { x: start.x + 16, y: 631 };
  node(`B:${name}`, start); edge(`B:${name}`, `Y:${join.x}`, curve(start, { x: start.x, y: 647 }, { x: start.x, y: 631 }, join).slice(1, -1));
}
for (const [name, x] of [['81A', 866], ['79A', 918], ['77A', 963]] as const) {
  node(`B:${name}`, STAND_POINTS[name]); edge(`B:${name}`, `V:${x}`);
}
for (let stand = 9; stand <= 16; stand += 1) {
  const name = String(stand), start = STAND_POINTS[name];
  node(`B:${name}`, start); edge(`B:${name}`, `V:${start.x + 18}`,
    curve(start, { x: start.x, y: 577 }, { x: start.x, y: V_Y }, { x: start.x + 18, y: V_Y }).slice(1, -1));
}

const eastSpine: MapPoint[] = [
  { x: 1370, y: 605 }, { x: 1360, y: 630 }, { x: 1342, y: 667 }, { x: 1324, y: 704 },
  { x: 1306, y: 741 }, { x: 1288, y: 778 }, { x: 1270, y: 815 }, { x: 1255, y: 850 },
  { x: 1265, y: 853 }, { x: 1287, y: 866 }, { x: 1310, y: 879 },
];
eastSpine.forEach((point, index) => { node(`E:${index}`, point); if (index) edge(`E:${index - 1}`, `E:${index}`); });
edge('E:0', 'V:1355', [{ x: 1380, y: 583 }, { x: 1375, y: 568 }]);
const westSpine = [{ x: 1204, y: 592 }, { x: 1186, y: 629 }, { x: 1168, y: 666 }, { x: 1150, y: 703 },
  { x: 1150, y: 727 }, { x: 1185, y: 745 }, { x: 1205, y: 755 }, { x: 1225, y: 765 }, { x: 1245, y: 775 }, { x: 1288, y: 797 }];
westSpine.forEach((point, index) => { node(`W:${index}`, point); if (index) edge(`W:${index - 1}`, `W:${index}`); });
edge('W:0', 'V:1220', [{ x: 1214, y: 577 }]);
edge('W:9', 'E:6');
for (let stand = 17; stand <= 40; stand += 1) {
  const name = String(stand); node(`B:${name}`, STAND_POINTS[name]);
  let anchor: string;
  if (stand <= 22) anchor = `E:${stand - 16}`;
  else if (stand <= 25) anchor = `E:${10 - (stand - 23)}`;
  else if (stand <= 28) anchor = `E:${10 - (stand - 26)}`;
  else if (stand <= 32) anchor = `E:${stand - 27}`;
  else if (stand <= 36) anchor = `W:${stand - 33}`;
  else anchor = `W:${8 - (stand - 37)}`;
  edge(`B:${name}`, anchor);
}
node('P5-SOUTH', { x: 475, y: 495 }); edge('P5-SOUTH', 'S:475');

function shortest(from: string, to: string, penalties: Map<string, number>, blocked = new Set<string>()): { points: MapPoint[]; keys: string[] } {
  const distances = new Map([[from, 0]]), previous = new Map<string, { from: string; edge: Edge }>(), visited = new Set<string>();
  while (true) {
    let current: string | undefined, lowest = Infinity;
    for (const [name, distance] of distances) if (!visited.has(name) && distance < lowest) { current = name; lowest = distance; }
    if (!current) throw new Error(`Không có đường lăn nối ${from} với ${to}.`);
    if (current === to) break;
    visited.add(current);
    for (const next of edges.get(current) ?? []) {
      if (blocked.has(next.key)) continue;
      if (next.to.startsWith('B:') && next.to !== to) continue;
      const distance = lowest + next.length * (penalties.get(next.key) ?? 1);
      if (distance < (distances.get(next.to) ?? Infinity)) { distances.set(next.to, distance); previous.set(next.to, { from: current, edge: next }); }
    }
  }
  const paths: MapPoint[][] = [], keys: string[] = [];
  let current = to;
  while (current !== from) { const item = previous.get(current)!; paths.unshift(item.edge.points); keys.unshift(item.edge.key); current = item.from; }
  return { points: paths.flatMap((path, index) => index ? path.slice(1) : path), keys };
}
const cache = new Map<string, SurfaceRoute[]>();
export function taxiRoutes(stand: string, from: 'stand' | 'S1' | 'P5' = 'stand'): SurfaceRoute[] {
  const normalized = stand.trim().toUpperCase();
  if (!STAND_POINTS[normalized]) throw new Error(`Stand ${stand} không có vị trí đã đo trên parking chart.`);
  const key = `${normalized}:${from}`;
  if (cache.has(key)) return cache.get(key)!;
  const start = from === 'stand' ? `B:${normalized}` : from === 'S1' ? 'S1' : 'P5-SOUTH';
  const end = from === 'stand' ? 'S1' : `B:${normalized}`;
  const penalties = new Map<string, number>(), routes: SurfaceRoute[] = [];
  for (let index = 0; index < 3; index += 1) {
    const route = shortest(start, end, penalties, from === 'stand'
      ? new Set(['S1|V:1880', 'S:1880|V:1810']) : new Set());
    const id = route.keys.join('>');
    if (!routes.some((candidate) => candidate.id === id)) routes.push({ id, label: route.keys.filter((part) => /\|S:|S:\d+\|V:|S1/.test(part)).join(' → '), points: route.points });
    for (const edge of route.keys) if (!edge.includes('B:')) penalties.set(edge, (penalties.get(edge) ?? 1) * 2.5);
  }
  cache.set(key, routes); return routes;
}

/** Follow the active taxi centreline to the lamp, curve through 1A, then join V. */
export function weatherReturnVia1A(from: MapPoint, outbound: MapPoint[], stand: string): MapPoint[] {
  const turn = outbound.findIndex(point => Math.hypot(point.x - CTOT_COMMIT_POINT.x, point.y - CTOT_COMMIT_POINT.y) < 1);
  if (turn < 0) throw new Error('Tuyến lăn không đi qua điểm đèn S1.');
  let nearest = 0, projected = outbound[0], best = Infinity;
  for (let index = 0; index < turn; index++) {
    const a = outbound[index], b = outbound[index + 1], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((from.x - a.x) * dx + (from.y - a.y) * dy) / Math.max(.001, dx * dx + dy * dy)));
    const point = { x: a.x + t * dx, y: a.y + t * dy };
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    if (distance < best) { best = distance; nearest = index; projected = point; }
  }
  const home = shortest('V:1810', 'B:' + stand, new Map(), new Set(['S:1880|V:1810', 'S1|V:1880']));
  return [from, projected, ...outbound.slice(nearest + 1, turn + 1), ...RETURN_1A.slice(1), ...home.points.slice(1)];
}

export function runwayEntryPath(): MapPoint[] {
  return curve(HOLD_S1, { x: 1984, y: 445 }, { x: 1975, y: 424 }, RUNWAY_ENTRY);
}

export function arrivalExitPaths(branch: 'P4' | 'P5') {
  // Surveyed centrelines on PARKING_CHART_clean.png. Both exits lead
  // westbound onto P4/P5 and stop north of the P5 runway holding markings.
  const exit = branch === 'P4' ? { x: 735, y: 227 } : { x: 590, y: 227 };
  const path = branch === 'P4'
    ? [...curve(exit, { x: 718, y: 227 }, { x: 701, y: 233 }, { x: 680, y: 244 }),
      ...curve({ x: 680, y: 244 }, { x: 620, y: 277 }, { x: 573, y: 315 }, { x: 520, y: 315 }).slice(1),
      { x: 475, y: 315 },
      ...curve({ x: 475, y: 315 }, { x: 457, y: 315 }, { x: 440, y: 321 }, P5_HOLD).slice(1)]
    : [...curve(exit, { x: 560, y: 227 }, { x: 525, y: 245 }, { x: 480, y: 273 }),
      ...curve({ x: 480, y: 273 }, { x: 455, y: 294 }, { x: 440, y: 314 }, P5_HOLD).slice(1)];
  return { exit, path };
}
