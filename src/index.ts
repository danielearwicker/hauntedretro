import { routePartykitRequest, Server, type Connection } from "partyserver";

/**
 * Cloudflare Worker + Durable Object version of the retro game.
 *
 * `Main` is a Durable Object (via partyserver's Server base class): one
 * instance per room, holding the authoritative game state. The Worker's fetch
 * handler routes `/parties/main/<room>` WebSocket upgrades to it; everything
 * else is served from ./public as static assets. Deploys to your own
 * Cloudflare account — no shared partykit.dev zone involved.
 *
 * THE MAP is the single source of truth here: a floor plan of rooms +
 * corridors with doorway gaps, from which we generate solid wall rectangles.
 * Clients receive it on `init` and use it to render + collide locally.
 *
 * THE RETRO: the three column rooms (Workshop, Garden, Library) each carry a
 * retro prompt. Players write notes at the writing desks in the Scriptorium
 * (needs a quill + a blank parchment), carry them out, and pin them in the
 * room whose prompt they answer. Then everyone votes by pressing wax seals
 * onto notes: VOTES_PER_PLAYER each, at most one per note. Ringing the bell
 * in the Lobby shows the results: voting closes and each room's notes line
 * up in order of votes. Ringing it again reopens voting.
 *
 * PROPS: most decor is solid (COLLIDERS gives each kind a footprint), and a
 * few kinds (MOVER_KINDS) roll away when nudged. The server runs their
 * physics, ticking only while something is moving, and saves where they rest.
 *
 * PERSISTENCE: the board (pinned notes) is saved to Durable Object storage on
 * every change and reloaded in onStart, so a retro survives the room going
 * idle, redeploys and — under `wrangler dev` — code reloads. Players, quills
 * and loose parchments are not saved; they come and go with connections.
 */

type Player = {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  carrying: string | null;
  parchments: number;
  note: { id: string; text: string } | null; // a written note being carried
  voter: string | null; // stable per-tab id from the client, so a refresh keeps your ballot
};

type Quill = { id: string; x: number; y: number; heldBy: string | null };
type Parchment = { id: string; x: number; y: number };
// x, y is the card's centre; scale shrinks cards when a room fills up.
// x, y is where the note was pinned (its slot). While results are showing,
// rx, ry is where it sits in vote order and rank is its place in its room.
type Note = {
  id: string; text: string; room: string; slot: number; x: number; y: number; scale: number; votes: number;
  rx?: number; ry?: number; rank?: number;
};
type Rect = { x: number; y: number; w: number; h: number };
type Door = { side: "top" | "bottom" | "left" | "right"; from: number; to: number };
type Area = Rect & { name?: string; prompt?: string; doors: Door[] };

const WORLD = { w: 3000, h: 2500 };
const WALL_T = 16;

const PLAYER_COLORS = [
  "#ff6b6b", "#feca57", "#1dd1a1", "#54a0ff",
  "#5f27cd", "#ff9ff3", "#00d2d3", "#f368e0",
];

const GRAB_RANGE = 64;
const DESK_RANGE = 40;     // how close (to the desk's edge) you must be to write
const NOTE_MAX_LEN = 140;
const NOTE_W = 170, NOTE_H = 120; // full-size note card; must match the client
const NOTE_GAP = 12;
const NOTE_TOP = 64;       // leave room for the room's name + prompt
const NOTE_MARGIN = 12;
const NOTE_SHRINK = 0.85;  // scale step when a room runs out of slots
const NOTE_REACH = 20;     // how far outside a card you can be and still vote on it
const VOTES_PER_PLAYER = 3;
const BELL = { x: 1460, y: 1052 }; // in the Lobby, by the Scriptorium door
const BELL_RANGE = 48;

// Card slots in a column room at a given scale, as centre points in row-major order.
function noteSlots(a: Rect, scale: number) {
  const w = NOTE_W * scale, h = NOTE_H * scale, g = NOTE_GAP * scale;
  const uw = a.w - 2 * NOTE_MARGIN, uh = a.h - NOTE_TOP - NOTE_MARGIN;
  const cols = Math.max(1, Math.floor((uw + g) / (w + g)));
  const rows = Math.max(1, Math.floor((uh + g) / (h + g)));
  const x0 = a.x + NOTE_MARGIN + (uw - (cols * (w + g) - g)) / 2 + w / 2;
  const y0 = a.y + NOTE_TOP + (uh - (rows * (h + g) - g)) / 2 + h / 2;
  const out: { x: number; y: number }[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: x0 + c * (w + g), y: y0 + r * (h + g) });
  return out;
}

function nearestFreeSlot(slots: { x: number; y: number }[], taken: Set<number>, p: { x: number; y: number }) {
  let best = -1, bestD = Infinity;
  slots.forEach((sl, i) => {
    const d = dist(sl, p);
    if (!taken.has(i) && d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// Sized so ~20 players plus 20 quills + 60 parchments fit on walkable floor.
const LAYOUT: Area[] = [
  { name: "Lobby", x: 1280, y: 1000, w: 640, h: 640, doors: [
    { side: "top", from: 1504, to: 1696 }, { side: "bottom", from: 1504, to: 1696 },
    { side: "left", from: 1224, to: 1416 }, { side: "right", from: 1224, to: 1416 },
  ]},
  { name: "Scriptorium", x: 1200, y: 240, w: 800, h: 360, doors: [{ side: "bottom", from: 1504, to: 1696 }] },
  { name: "Garden", prompt: "What have you grown (in tools or product)?",
    x: 1200, y: 2000, w: 800, h: 360, doors: [{ side: "top", from: 1504, to: 1696 }] },
  { name: "Library", prompt: "What have you learned?",
    x: 400, y: 1040, w: 480, h: 560, doors: [{ side: "right", from: 1224, to: 1416 }] },
  { name: "Workshop", prompt: "Things that need fixing",
    x: 2320, y: 1000, w: 560, h: 600, doors: [{ side: "left", from: 1224, to: 1416 }] },
  { x: 1504, y: 600, w: 192, h: 400, doors: [{ side: "top", from: 1504, to: 1696 }, { side: "bottom", from: 1504, to: 1696 }] },
  { x: 1504, y: 1640, w: 192, h: 360, doors: [{ side: "top", from: 1504, to: 1696 }, { side: "bottom", from: 1504, to: 1696 }] },
  { x: 880, y: 1224, w: 400, h: 192, doors: [{ side: "left", from: 1224, to: 1416 }, { side: "right", from: 1224, to: 1416 }] },
  { x: 1920, y: 1224, w: 400, h: 192, doors: [{ side: "left", from: 1224, to: 1416 }, { side: "right", from: 1224, to: 1416 }] },
];

// Writing desks along the Scriptorium's back wall. Not solid — just furniture.
const DESKS: Rect[] = [1260, 1460, 1660, 1860].map((x) => ({ x, y: 300, w: 80, h: 44 }));

// Cosmetic props, drawn from public/decor/<kind>.svg centred on (x, y) and
// rotated by rot degrees. Not solid. Kept clear of each room's title corner.
type Decor = { kind: string; x: number; y: number; rot?: number };
const DECOR: Decor[] = [
  // Lobby
  { kind: "rug", x: 1600, y: 1320 },
  { kind: "candelabra", x: 1380, y: 1160 }, { kind: "candelabra", x: 1820, y: 1160 },
  { kind: "candelabra", x: 1380, y: 1480 }, { kind: "candelabra", x: 1820, y: 1480 },
  { kind: "fern", x: 1312, y: 1608 }, { kind: "fern", x: 1888, y: 1608 },
  { kind: "cobweb", x: 1892, y: 1028, rot: 90 },
  // Scriptorium (the desks themselves come from DESKS)
  { kind: "window", x: 1400, y: 232 }, { kind: "window", x: 1600, y: 232 }, { kind: "window", x: 1800, y: 232 },
  { kind: "scroll-rack", x: 1220, y: 470 }, { kind: "scroll-rack", x: 1980, y: 470 },
  { kind: "lectern", x: 1360, y: 500 }, { kind: "chest", x: 1840, y: 510 },
  { kind: "candelabra", x: 1600, y: 450 },
  { kind: "cobweb", x: 1972, y: 268, rot: 90 }, { kind: "cobweb", x: 1228, y: 572, rot: 270 },
  // Library
  { kind: "bookshelf", x: 420, y: 1190 }, { kind: "bookshelf", x: 420, y: 1355 }, { kind: "bookshelf", x: 420, y: 1520 },
  { kind: "bookshelf", x: 780, y: 1060, rot: 90 }, { kind: "bookshelf", x: 560, y: 1580, rot: 90 },
  { kind: "globe", x: 690, y: 1560 },
  { kind: "armchair", x: 800, y: 1520, rot: 140 }, { kind: "lamp", x: 856, y: 1470 },
  // Workshop
  { kind: "workbench", x: 2848, y: 1180 },
  { kind: "crate", x: 2854, y: 1028 }, { kind: "crate", x: 2806, y: 1030, rot: 12 },
  { kind: "anvil", x: 2790, y: 1370 },
  { kind: "barrel", x: 2344, y: 1576 }, { kind: "barrel", x: 2386, y: 1580 }, { kind: "barrel", x: 2348, y: 1536 },
  { kind: "cogs", x: 2600, y: 1566, rot: 15 },
  { kind: "lantern", x: 2620, y: 1016 }, { kind: "lantern", x: 2760, y: 1580 },
  { kind: "cobweb", x: 2852, y: 1572, rot: 180 },
  // Garden
  { kind: "stepstone", x: 1590, y: 2024 }, { kind: "stepstone", x: 1616, y: 2062, rot: 20 },
  { kind: "stepstone", x: 1588, y: 2100, rot: -15 }, { kind: "stepstone", x: 1612, y: 2138 },
  { kind: "tree", x: 1268, y: 2290 }, { kind: "tree", x: 1932, y: 2290 },
  { kind: "flowerbed", x: 1490, y: 2340 }, { kind: "flowerbed", x: 1710, y: 2340 },
  { kind: "pond", x: 1880, y: 2112 },
  { kind: "sprouts", x: 1400, y: 2160 },
  { kind: "pumpkin", x: 1244, y: 2140 }, { kind: "pumpkin", x: 1282, y: 2166, rot: 30 }, { kind: "pumpkin", x: 1240, y: 2190, rot: -20 },
  { kind: "lantern", x: 1470, y: 2016 }, { kind: "lantern", x: 1730, y: 2016 },
];

// ---- Solid props and rollable props ----------------------------------------

// A collision shape centred on (x, y): a circle if r is set, otherwise a
// w x h rectangle rotated by rot degrees.
type Shape = { x: number; y: number; r?: number; w?: number; h?: number; rot?: number };

// Footprint of each solid prop kind, relative to the prop's centre (before
// rotation). Kinds not listed are flat and can be walked over.
const COLLIDERS: Record<string, { r?: number; w?: number; h?: number; dx?: number; dy?: number }> = {
  desk: { w: 80, h: 42 },
  bell: { w: 44, h: 18, dy: 18 },
  candelabra: { r: 14 }, fern: { r: 16 }, lantern: { r: 10 },
  "scroll-rack": { w: 34, h: 146 }, lectern: { w: 50, h: 30, dy: 4 }, chest: { w: 62, h: 38 },
  bookshelf: { w: 38, h: 156 }, armchair: { r: 24 }, lamp: { r: 12 }, globe: { r: 16 },
  workbench: { w: 56, h: 196 }, anvil: { w: 58, h: 36 }, crate: { w: 42, h: 42 },
  tree: { r: 48 }, pond: { w: 136, h: 74 }, flowerbed: { w: 200, h: 38 }, sprouts: { w: 118, h: 56 },
};

// Props that roll away when nudged. Heavier ones budge less.
const MOVER_KINDS: Record<string, { r: number; mass: number }> = {
  pumpkin: { r: 15, mass: 1 },
  barrel: { r: 18, mass: 3 },
};

type Mover = { id: string; kind: string; x: number; y: number; a: number; r: number; mass: number; vx: number; vy: number };

const MOVER_FRICTION = 0.15;  // fraction of speed kept per second
const MOVER_BOUNCE = 0.5;     // restitution off walls, props and people
const MOVER_REST = 5;         // below this speed (px/s) a mover stops
const MOVER_TICK_MS = 33;
const PLAYER_R = 14;          // must match the client

function shapeFor(d: { kind: string; x: number; y: number; rot?: number }): Shape | null {
  const c = COLLIDERS[d.kind];
  if (!c) return null;
  const a = ((d.rot ?? 0) * Math.PI) / 180, dx = c.dx ?? 0, dy = c.dy ?? 0;
  const x = d.x + dx * Math.cos(a) - dy * Math.sin(a);
  const y = d.y + dx * Math.sin(a) + dy * Math.cos(a);
  return c.r ? { x, y, r: c.r } : { x, y, w: c.w, h: c.h, rot: d.rot ?? 0 };
}

const STATIC_DECOR = DECOR.filter((d) => !MOVER_KINDS[d.kind]);
const SOLIDS: Shape[] = [
  ...STATIC_DECOR,
  ...DESKS.map((d) => ({ kind: "desk", x: d.x + d.w / 2, y: d.y + d.h / 2 })),
  { kind: "bell", ...BELL },
].map(shapeFor).filter((s): s is Shape => s !== null);

// If a circle overlaps shape s, the direction to push the circle out of it
// (unit normal) and how far. Mirrored in the client for player collision.
function contact(cx: number, cy: number, r: number, s: Shape) {
  if (s.r !== undefined) {
    const dx = cx - s.x, dy = cy - s.y, d = Math.hypot(dx, dy);
    if (d >= r + s.r) return null;
    return d ? { nx: dx / d, ny: dy / d, depth: r + s.r - d } : { nx: 1, ny: 0, depth: r + s.r };
  }
  const t = ((s.rot ?? 0) * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  // into the rectangle's own frame
  const lx = (cx - s.x) * cos + (cy - s.y) * sin, ly = -(cx - s.x) * sin + (cy - s.y) * cos;
  const hw = s.w! / 2, hh = s.h! / 2;
  let nlx, nly, depth;
  if (Math.abs(lx) < hw && Math.abs(ly) < hh) {
    // centre is inside: leave by the nearest side
    const ox = hw - Math.abs(lx), oy = hh - Math.abs(ly);
    if (ox < oy) { nlx = Math.sign(lx) || 1; nly = 0; depth = ox + r; }
    else { nlx = 0; nly = Math.sign(ly) || 1; depth = oy + r; }
  } else {
    const qx = clamp(lx, -hw, hw), qy = clamp(ly, -hh, hh);
    const d = Math.hypot(lx - qx, ly - qy);
    if (d >= r) return null;
    nlx = (lx - qx) / d; nly = (ly - qy) / d; depth = r - d;
  }
  return { nx: nlx * cos - nly * sin, ny: nlx * sin + nly * cos, depth };
}

const OBSTACLES: Shape[] = [
  ...SOLIDS,
  ...buildWalls(LAYOUT, WALL_T).map((w) => ({ x: w.x + w.w / 2, y: w.y + w.h / 2, w: w.w, h: w.h })),
];

function initialMovers(): Mover[] {
  const count: Record<string, number> = {};
  return DECOR.filter((d) => MOVER_KINDS[d.kind]).map((d) => {
    const i = (count[d.kind] = (count[d.kind] ?? -1) + 1);
    return { id: d.kind + i, kind: d.kind, x: d.x, y: d.y, a: d.rot ?? 0, ...MOVER_KINDS[d.kind], vx: 0, vy: 0 };
  });
}

const AREAS = LAYOUT.map(({ name, prompt, x, y, w, h }) => ({ name, prompt, x, y, w, h }));
const WALLS: Rect[] = buildWalls(LAYOUT, WALL_T);

function namedAreaAt(p: { x: number; y: number }) {
  return LAYOUT.find((a) => a.name && p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h);
}

function nearDesk(p: { x: number; y: number }) {
  return DESKS.some((d) => {
    const nx = clamp(p.x, d.x, d.x + d.w), ny = clamp(p.y, d.y, d.y + d.h);
    return Math.hypot(p.x - nx, p.y - ny) <= DESK_RANGE;
  });
}

function buildWalls(layout: Area[], t: number): Rect[] {
  const out: Rect[] = [];
  const opens = (doors: Door[], side: Door["side"]) =>
    doors.filter((d) => d.side === side).map((d) => [d.from, d.to] as [number, number]).sort((a, b) => a[0] - b[0]);

  const buildH = (x0: number, x1: number, yy: number, gaps: [number, number][]) => {
    let cx = x0;
    for (const [g0, g1] of gaps) {
      const a = Math.max(x0, g0), b = Math.min(x1, g1);
      if (b <= a) continue;
      if (a > cx) out.push({ x: cx, y: yy, w: a - cx, h: t });
      cx = Math.max(cx, b);
    }
    if (cx < x1) out.push({ x: cx, y: yy, w: x1 - cx, h: t });
  };
  const buildV = (y0: number, y1: number, xx: number, gaps: [number, number][]) => {
    let cy = y0;
    for (const [g0, g1] of gaps) {
      const a = Math.max(y0, g0), b = Math.min(y1, g1);
      if (b <= a) continue;
      if (a > cy) out.push({ x: xx, y: cy, w: t, h: a - cy });
      cy = Math.max(cy, b);
    }
    if (cy < y1) out.push({ x: xx, y: cy, w: t, h: y1 - cy });
  };

  for (const a of layout) {
    const x2 = a.x + a.w, y2 = a.y + a.h;
    buildH(a.x - t, x2 + t, a.y - t, opens(a.doors, "top"));
    buildH(a.x - t, x2 + t, y2, opens(a.doors, "bottom"));
    buildV(a.y, y2, a.x - t, opens(a.doors, "left"));
    buildV(a.y, y2, x2, opens(a.doors, "right"));
  }
  return out;
}

// What's saved in Durable Object storage under the "board" key.
// ballots maps voter id -> ids of the notes they've sealed. Only totals are
// broadcast; each voter is sent their own ballot privately.
type Board = {
  notes: Note[]; roomScale: Record<string, number>; nextId: number; ballots: Record<string, string[]>;
  results: boolean;
  movers?: Record<string, { x: number; y: number; a: number }>; // where rollable props came to rest
};

interface Env {
  Main: DurableObjectNamespace;
}

export class Main extends Server<Env> {
  players: Record<string, Player> = {};
  quills: Quill[] = [];
  parchments: Parchment[] = [];
  notes: Note[] = []; // pinned retro notes; they outlive the players who wrote them
  roomScale: Record<string, number> = {}; // current note scale per column room
  ballots: Record<string, string[]> = {};
  results = false; // true while the bell has been rung: voting closed, notes in vote order
  movers: Mover[] = initialMovers();
  moverTicker: ReturnType<typeof setInterval> | null = null;
  lastMove: Record<string, { x: number; y: number; t: number }> = {}; // for players' push speed
  nextId = 1;

  async onStart() {
    const board = await this.ctx.storage.get<Board>("board");
    if (!board) return;
    for (const m of this.movers) Object.assign(m, board.movers?.[m.id]);
    this.notes = board.notes;
    this.roomScale = board.roomScale;
    this.nextId = board.nextId;
    this.ballots = board.ballots ?? {};
    this.results = board.results ?? false;
    for (const n of this.notes) n.votes ??= 0;
    // Re-fit every room to the current layout, in case rooms or the note
    // grid changed since the board was saved.
    for (const a of LAYOUT) if (a.prompt) this.fitRoom(a, 0);
    this.layoutResults();
  }

  saveBoard() {
    // Not awaited: Durable Object output gates hold outgoing messages until
    // the write is durable, so nobody sees a pin that could be lost.
    const board: Board = {
      notes: this.notes, roomScale: this.roomScale, nextId: this.nextId, ballots: this.ballots, results: this.results,
      movers: Object.fromEntries(this.movers.map((m) => [m.id, { x: m.x, y: m.y, a: m.a }])),
    };
    this.ctx.storage.put("board", board);
  }

  onConnect(conn: Connection) {
    const color = PLAYER_COLORS[Object.keys(this.players).length % PLAYER_COLORS.length];
    this.players[conn.id] = {
      id: conn.id,
      name: "Guest",
      color,
      x: 1600 + (Math.random() * 200 - 100),
      y: 1320 + (Math.random() * 200 - 100),
      carrying: null,
      parchments: 0,
      note: null,
      voter: null,
    };

    // Supply scales with the group.
    this.quills.push({ id: this.mkId("quill"), ...this.spawnPos(), heldBy: null });
    for (let i = 0; i < 3; i++) this.parchments.push({ id: this.mkId("parch"), ...this.spawnPos() });

    // Map (static geometry) sent only on init; snapshots don't resend it.
    conn.send(JSON.stringify({
      type: "init",
      you: conn.id,
      map: { world: WORLD, walls: WALLS, areas: AREAS, desks: DESKS, decor: STATIC_DECOR, bell: BELL, solids: SOLIDS },
      ...this.snapshot(),
    }));
    this.broadcast(JSON.stringify({ type: "snapshot", ...this.snapshot() }), [conn.id]);
  }

  // NOTE: partyserver order is (connection, message) — reversed from PartyKit.
  onMessage(sender: Connection, raw: string | ArrayBuffer) {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const player = this.players[sender.id];
    if (!player) return;

    switch (msg.type) {
      case "hello": {
        player.voter = String(msg.voter ?? "").slice(0, 64) || null;
        this.sendBallot(sender, player);
        break;
      }

      case "vote": {
        // Toggle your seal on the note you're standing at.
        const note = !this.results && player.voter && this.noteAt(player);
        if (!note) break;
        const mine = (this.ballots[player.voter!] ??= []);
        const i = mine.indexOf(note.id);
        if (i >= 0) { mine.splice(i, 1); note.votes--; }
        else if (mine.length < VOTES_PER_PLAYER) { mine.push(note.id); note.votes++; }
        else break;
        this.saveBoard();
        this.sendBallot(sender, player);
        this.pushSnapshot();
        break;
      }

      case "ring": {
        if (dist(player, BELL) > BELL_RANGE) break;
        this.results = !this.results;
        this.layoutResults();
        this.saveBoard();
        this.broadcast(JSON.stringify({ type: "bell", by: player.name, results: this.results }));
        this.pushSnapshot();
        break;
      }

      case "setName": {
        player.name = String(msg.name ?? "Guest").slice(0, 24) || "Guest";
        this.pushSnapshot();
        break;
      }

      case "move": {
        player.x = clamp(msg.x, 0, WORLD.w);
        player.y = clamp(msg.y, 0, WORLD.h);
        this.nudgeMovers(player);
        if (player.carrying) {
          const q = this.quills.find((q) => q.id === player.carrying);
          if (q) { q.x = player.x; q.y = player.y - 24; }
        }
        this.broadcast(
          JSON.stringify({ type: "playerMoved", id: player.id, x: player.x, y: player.y }),
          [sender.id]
        );
        break;
      }

      case "grab": {
        let best: any = null;
        let bestD = GRAB_RANGE + 1;
        let kind: "quill" | "parch" | "steal" | null = null;

        if (!player.carrying) {
          for (const q of this.quills) {
            if (q.heldBy) continue;
            const d = dist(q, player);
            if (d <= GRAB_RANGE && d < bestD) { bestD = d; best = q; kind = "quill"; }
          }
        }
        for (const pc of this.parchments) {
          const d = dist(pc, player);
          if (d <= GRAB_RANGE && d < bestD) { bestD = d; best = pc; kind = "parch"; }
        }
        for (const id in this.players) {
          if (id === player.id) continue;
          const other = this.players[id];
          if (other.parchments > player.parchments) {
            const d = dist(other, player);
            if (d <= GRAB_RANGE && d < bestD) { bestD = d; best = other; kind = "steal"; }
          }
        }

        if (kind === "quill") { best.heldBy = player.id; player.carrying = best.id; }
        else if (kind === "parch") { this.parchments = this.parchments.filter((p) => p !== best); player.parchments++; }
        else if (kind === "steal") { best.parchments--; player.parchments++; }
        if (kind) this.pushSnapshot();
        break;
      }

      case "write": {
        // At a Scriptorium desk, with a quill in hand and a blank parchment.
        const text = String(msg.text ?? "").trim().slice(0, NOTE_MAX_LEN);
        if (!text || player.note || !player.carrying || player.parchments < 1) break;
        if (namedAreaAt(player)?.name !== "Scriptorium" || !nearDesk(player)) break;
        player.parchments--;
        player.note = { id: this.mkId("note"), text };
        this.pushSnapshot();
        break;
      }

      case "pin": {
        // Pin the carried note in whichever column room you're standing in.
        const area = namedAreaAt(player);
        if (this.results || !player.note || !area?.prompt) break;
        this.pinNote(area, player.note, player);
        player.note = null;
        this.saveBoard();
        this.pushSnapshot();
        break;
      }

      case "drop": {
        if (!player.carrying) break;
        const q = this.quills.find((q) => q.id === player.carrying);
        if (q) { q.heldBy = null; q.x = player.x; q.y = player.y; }
        player.carrying = null;
        this.pushSnapshot();
        break;
      }
    }
  }

  // A player walking into a rollable prop shoves it out of the way and sets it
  // rolling, faster the faster they were going, slower the heavier it is.
  nudgeMovers(player: Player) {
    const now = Date.now();
    const prev = this.lastMove[player.id] ?? { x: player.x, y: player.y, t: now - 60 };
    const dt = clamp((now - prev.t) / 1000, 0.016, 0.3);
    const pvx = (player.x - prev.x) / dt, pvy = (player.y - prev.y) / dt;
    this.lastMove[player.id] = { x: player.x, y: player.y, t: now };
    let nudged = false;
    for (const m of this.movers) {
      const c = contact(m.x, m.y, m.r, { x: player.x, y: player.y, r: PLAYER_R });
      if (!c) continue;
      m.x += c.nx * c.depth; m.y += c.ny * c.depth;
      const kick = (Math.max(0, pvx * c.nx + pvy * c.ny) * 1.5 + 80) / m.mass;
      const vn = m.vx * c.nx + m.vy * c.ny;
      if (vn < kick) { m.vx += (kick - vn) * c.nx; m.vy += (kick - vn) * c.ny; }
      nudged = true;
    }
    if (nudged && !this.moverTicker) this.moverTicker = setInterval(() => this.tickMovers(), MOVER_TICK_MS);
  }

  tickMovers() {
    const dt = MOVER_TICK_MS / 1000;
    const keep = Math.pow(MOVER_FRICTION, dt);
    const bounce = (m: Mover, c: { nx: number; ny: number; depth: number }) => {
      m.x += c.nx * c.depth; m.y += c.ny * c.depth;
      const vn = m.vx * c.nx + m.vy * c.ny;
      if (vn < 0) { m.vx -= (1 + MOVER_BOUNCE) * vn * c.nx; m.vy -= (1 + MOVER_BOUNCE) * vn * c.ny; }
    };
    for (const m of this.movers) {
      const speed = Math.hypot(m.vx, m.vy);
      if (!speed) continue;
      m.x += m.vx * dt; m.y += m.vy * dt;
      // spin as it rolls, clockwise when heading right
      m.a = (m.a + ((speed * dt) / m.r) * (180 / Math.PI) * (m.vx >= 0 ? 1 : -1)) % 360;
      m.vx *= keep; m.vy *= keep;
      if (Math.hypot(m.vx, m.vy) < MOVER_REST) { m.vx = 0; m.vy = 0; }
    }
    for (let pass = 0; pass < 2; pass++) {
      for (const m of this.movers) {
        for (const s of OBSTACLES) { const c = contact(m.x, m.y, m.r, s); if (c) bounce(m, c); }
        for (const p of Object.values(this.players)) {
          const c = contact(m.x, m.y, m.r, { x: p.x, y: p.y, r: PLAYER_R });
          if (c) bounce(m, c);
        }
      }
      // movers knock into each other, sharing momentum by mass
      for (let i = 0; i < this.movers.length; i++) {
        for (let j = i + 1; j < this.movers.length; j++) {
          const a = this.movers[i], b = this.movers[j];
          const c = contact(b.x, b.y, b.r, { x: a.x, y: a.y, r: a.r });
          if (!c) continue;
          const ia = 1 / a.mass, ib = 1 / b.mass;
          a.x -= (c.nx * c.depth * ia) / (ia + ib); a.y -= (c.ny * c.depth * ia) / (ia + ib);
          b.x += (c.nx * c.depth * ib) / (ia + ib); b.y += (c.ny * c.depth * ib) / (ia + ib);
          const vrel = (b.vx - a.vx) * c.nx + (b.vy - a.vy) * c.ny;
          if (vrel >= 0) continue;
          const j2 = (-(1 + MOVER_BOUNCE) * vrel) / (ia + ib);
          a.vx -= j2 * ia * c.nx; a.vy -= j2 * ia * c.ny;
          b.vx += j2 * ib * c.nx; b.vy += j2 * ib * c.ny;
        }
      }
    }
    for (const m of this.movers) { m.x = clamp(m.x, 0, WORLD.w); m.y = clamp(m.y, 0, WORLD.h); }
    this.broadcast(JSON.stringify({
      type: "movers",
      m: this.movers.map((m) => [m.id, Math.round(m.x * 10) / 10, Math.round(m.y * 10) / 10, Math.round(m.a)]),
    }));
    if (this.movers.every((m) => !m.vx && !m.vy)) {
      clearInterval(this.moverTicker!);
      this.moverTicker = null;
      this.saveBoard();
    }
  }

  onClose(conn: Connection) {
    const player = this.players[conn.id];
    if (player) {
      // An unpinned note goes back to being a blank parchment.
      const blanks = player.parchments + (player.note ? 1 : 0);
      for (let i = 0; i < blanks; i++) {
        this.parchments.push({
          id: this.mkId("parch"),
          x: clamp(player.x + (Math.random() * 44 - 22), 20, WORLD.w - 20),
          y: clamp(player.y + (Math.random() * 44 - 22), 20, WORLD.h - 20),
        });
      }
      if (player.carrying) {
        this.quills = this.quills.filter((q) => q.id !== player.carrying);
      } else {
        const idx = this.quills.findIndex((q) => !q.heldBy);
        if (idx >= 0) this.quills.splice(idx, 1);
      }
    }
    delete this.players[conn.id];
    delete this.lastMove[conn.id];
    this.pushSnapshot();
  }

  // Put a note in the free slot nearest to `at`, making room first if needed.
  pinNote(area: Area, note: { id: string; text: string }, at: { x: number; y: number }) {
    const slots = this.fitRoom(area, 1);
    const inRoom = this.notes.filter((n) => n.room === area.name);
    const slot = nearestFreeSlot(slots, new Set(inRoom.map((n) => n.slot)), at);
    this.notes.push({ ...note, room: area.name!, slot, ...slots[slot], scale: this.roomScale[area.name!], votes: 0 });
  }

  // While results are showing, line each room's notes up in its slots in
  // order of votes (ties keep pinning order); otherwise clear that layout.
  layoutResults() {
    for (const a of LAYOUT) {
      if (!a.prompt) continue;
      const inRoom = this.notes.filter((n) => n.room === a.name);
      if (!this.results) {
        for (const n of inRoom) { delete n.rx; delete n.ry; delete n.rank; }
        continue;
      }
      const slots = noteSlots(a, this.roomScale[a.name!] ?? 1);
      inRoom.sort((p, q) => q.votes - p.votes || p.slot - q.slot).forEach((n, i) => {
        n.rx = slots[i].x; n.ry = slots[i].y; n.rank = i + 1;
      });
    }
  }

  // The note card nearest to p, if p is on or just beside it.
  noteAt(p: { x: number; y: number }) {
    let best: Note | null = null, bestD = Infinity;
    for (const n of this.notes) {
      if (Math.abs(p.x - n.x) > (NOTE_W * n.scale) / 2 + NOTE_REACH) continue;
      if (Math.abs(p.y - n.y) > (NOTE_H * n.scale) / 2 + NOTE_REACH) continue;
      const d = dist(p, n);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  sendBallot(conn: Connection, player: Player) {
    const notes = (player.voter && this.ballots[player.voter]) || [];
    conn.send(JSON.stringify({ type: "ballot", notes, max: VOTES_PER_PLAYER }));
  }

  // Make sure a room's grid has space for its notes plus `extra` more,
  // shrinking every card a step at a time until it does. Each note is then
  // re-slotted near where it was, so the board keeps its rough shape rather
  // than being reshuffled. Returns the room's slots.
  fitRoom(area: Area, extra: number) {
    const room = area.name!;
    const inRoom = this.notes.filter((n) => n.room === room);
    const oldScale = this.roomScale[room] ?? 1;
    let scale = oldScale;
    let slots = noteSlots(area, scale);
    while (slots.length < inRoom.length + extra) slots = noteSlots(area, (scale *= NOTE_SHRINK));
    this.roomScale[room] = scale;
    const moved = scale !== oldScale ||
      inRoom.some((n) => !slots[n.slot] || slots[n.slot].x !== n.x || slots[n.slot].y !== n.y);
    if (moved) {
      const taken = new Set<number>();
      for (const n of [...inRoom].sort((a, b) => a.slot - b.slot)) {
        n.slot = nearestFreeSlot(slots, taken, n);
        taken.add(n.slot);
        Object.assign(n, slots[n.slot], { scale });
      }
    }
    return slots;
  }

  // ---- helpers ------------------------------------------------------------
  mkId(prefix: string) {
    return prefix + this.nextId++;
  }

  // A random spot on some floor, clear of solid props so it can be reached.
  spawnPos() {
    let pos = { x: 0, y: 0 };
    for (let tries = 0; tries < 30; tries++) {
      const a = LAYOUT[Math.floor(Math.random() * LAYOUT.length)];
      const m = 28;
      pos = {
        x: a.x + m + Math.random() * Math.max(1, a.w - 2 * m),
        y: a.y + m + Math.random() * Math.max(1, a.h - 2 * m),
      };
      if (!SOLIDS.some((s) => contact(pos.x, pos.y, 16, s))) break;
    }
    return pos;
  }

  snapshot() {
    return {
      world: WORLD, players: this.players, quills: this.quills, parchments: this.parchments,
      notes: this.notes, results: this.results,
      movers: this.movers.map(({ id, kind, x, y, a, r }) => ({ id, kind, x, y, a, r })),
    };
  }

  pushSnapshot() {
    this.broadcast(JSON.stringify({ type: "snapshot", ...this.snapshot() }));
  }
}

// Worker entry: route /parties/main/<room> to the Main Durable Object;
// anything else falls through to static assets in ./public.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env as any)) ||
      new Response("Not Found", { status: 404 })
    );
  },
};

function clamp(n: number, lo: number, hi: number) {
  n = Number(n) || 0;
  return Math.max(lo, Math.min(hi, n));
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
