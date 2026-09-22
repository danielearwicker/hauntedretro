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
 * room whose prompt they answer.
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
};

type Quill = { id: string; x: number; y: number; heldBy: string | null };
type Parchment = { id: string; x: number; y: number };
// x, y is the card's centre; scale shrinks cards when a room fills up.
type Note = { id: string; text: string; room: string; slot: number; x: number; y: number; scale: number };
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

interface Env {
  Main: DurableObjectNamespace;
}

export class Main extends Server<Env> {
  players: Record<string, Player> = {};
  quills: Quill[] = [];
  parchments: Parchment[] = [];
  notes: Note[] = []; // pinned retro notes; they outlive the players who wrote them
  roomScale: Record<string, number> = {}; // current note scale per column room
  nextId = 1;

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
    };

    // Supply scales with the group.
    this.quills.push({ id: this.mkId("quill"), ...this.spawnPos(), heldBy: null });
    for (let i = 0; i < 3; i++) this.parchments.push({ id: this.mkId("parch"), ...this.spawnPos() });

    // Map (static geometry) sent only on init; snapshots don't resend it.
    conn.send(JSON.stringify({
      type: "init",
      you: conn.id,
      map: { world: WORLD, walls: WALLS, areas: AREAS, desks: DESKS, decor: DECOR },
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
      case "setName": {
        player.name = String(msg.name ?? "Guest").slice(0, 24) || "Guest";
        this.pushSnapshot();
        break;
      }

      case "move": {
        player.x = clamp(msg.x, 0, WORLD.w);
        player.y = clamp(msg.y, 0, WORLD.h);
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
        if (!player.note || !area?.prompt) break;
        this.pinNote(area, player.note, player);
        player.note = null;
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
    this.pushSnapshot();
  }

  // Put a note in the free slot nearest to `at`. If the room is full, shrink
  // every card in it a step and re-slot them near where they were, so the
  // board keeps its rough shape rather than being reshuffled.
  pinNote(area: Area, note: { id: string; text: string }, at: { x: number; y: number }) {
    const room = area.name!;
    const inRoom = this.notes.filter((n) => n.room === room);
    let scale = this.roomScale[room] ?? 1;
    let slots = noteSlots(area, scale);
    if (slots.length <= inRoom.length) {
      while (slots.length <= inRoom.length) slots = noteSlots(area, (scale *= NOTE_SHRINK));
      const taken = new Set<number>();
      for (const n of [...inRoom].sort((a, b) => a.slot - b.slot)) {
        n.slot = nearestFreeSlot(slots, taken, n);
        taken.add(n.slot);
        Object.assign(n, slots[n.slot], { scale });
      }
      this.roomScale[room] = scale;
    }
    const slot = nearestFreeSlot(slots, new Set(inRoom.map((n) => n.slot)), at);
    this.notes.push({ ...note, room, slot, ...slots[slot], scale });
  }

  // ---- helpers ------------------------------------------------------------
  mkId(prefix: string) {
    return prefix + this.nextId++;
  }

  spawnPos() {
    const a = LAYOUT[Math.floor(Math.random() * LAYOUT.length)];
    const m = 28;
    return {
      x: a.x + m + Math.random() * Math.max(1, a.w - 2 * m),
      y: a.y + m + Math.random() * Math.max(1, a.h - 2 * m),
    };
  }

  snapshot() {
    return { world: WORLD, players: this.players, quills: this.quills, parchments: this.parchments, notes: this.notes };
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
