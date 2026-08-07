import type * as Party from "partykit/server";

/**
 * Authoritative game state for one retro room (one Cloudflare Durable Object).
 *
 * THE MAP is defined here as the single source of truth. It's a floor plan of
 * rooms + corridors, each with doorway gaps. We generate the solid wall
 * rectangles from that layout once at module load, and send them to clients on
 * `init`. The server uses the floor rects to spawn items only on walkable
 * ground; the client uses the walls to render the building and to collide the
 * local player. Because both sides read the same generated geometry, they
 * can't drift.
 *
 * Retro "collection" phase items:
 *   quills     - the writing TOOL. Carried, max one per player. Supply == players.
 *   parchments - the writing SURFACE. Scattered (3 x players) as a COUNT per
 *                player; a player with fewer can take one from a player with
 *                more, so hoards self-level.
 */

type Player = {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  carrying: string | null;
  parchments: number;
};

type Quill = { id: string; x: number; y: number; heldBy: string | null };
type Parchment = { id: string; x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Door = { side: "top" | "bottom" | "left" | "right"; from: number; to: number };
type Area = Rect & { name?: string; doors: Door[] };

const WORLD = { w: 3000, h: 2500 };
const WALL_T = 16; // wall thickness

const PLAYER_COLORS = [
  "#ff6b6b", "#feca57", "#1dd1a1", "#54a0ff",
  "#5f27cd", "#ff9ff3", "#00d2d3", "#f368e0",
];

const GRAB_RANGE = 64;

// ---- Floor plan ----------------------------------------------------------
// Central Lobby hub, four rooms around it, joined by four corridors. Doorway
// gaps are absolute coordinates along the relevant edge, and are chosen to line
// up exactly with the corridor that connects there.
// Sized so ~20 players plus their discoverable items (20 quills + 60
// parchments) fit comfortably on walkable floor. A central Lobby hub, four
// large rooms around it, joined by four wide corridors.
const LAYOUT: Area[] = [
  { name: "Lobby", x: 1280, y: 1000, w: 640, h: 640, doors: [
    { side: "top", from: 1504, to: 1696 }, { side: "bottom", from: 1504, to: 1696 },
    { side: "left", from: 1224, to: 1416 }, { side: "right", from: 1224, to: 1416 },
  ]},
  { name: "Scriptorium", x: 1200, y: 240, w: 800, h: 360, doors: [{ side: "bottom", from: 1504, to: 1696 }] },
  { name: "Garden", x: 1200, y: 2000, w: 800, h: 360, doors: [{ side: "top", from: 1504, to: 1696 }] },
  { name: "Library", x: 400, y: 1040, w: 480, h: 560, doors: [{ side: "right", from: 1224, to: 1416 }] },
  { name: "Workshop", x: 2320, y: 1000, w: 560, h: 600, doors: [{ side: "left", from: 1224, to: 1416 }] },
  // corridors: open at both connecting ends
  { x: 1504, y: 600, w: 192, h: 400, doors: [{ side: "top", from: 1504, to: 1696 }, { side: "bottom", from: 1504, to: 1696 }] },
  { x: 1504, y: 1640, w: 192, h: 360, doors: [{ side: "top", from: 1504, to: 1696 }, { side: "bottom", from: 1504, to: 1696 }] },
  { x: 880, y: 1224, w: 400, h: 192, doors: [{ side: "left", from: 1224, to: 1416 }, { side: "right", from: 1224, to: 1416 }] },
  { x: 1920, y: 1224, w: 400, h: 192, doors: [{ side: "left", from: 1224, to: 1416 }, { side: "right", from: 1224, to: 1416 }] },
];

// Areas sent to the client for drawing floors/labels (geometry only, no doors).
const AREAS = LAYOUT.map(({ name, x, y, w, h }) => ({ name, x, y, w, h }));

// Generate solid wall rectangles from the layout.
const WALLS: Rect[] = buildWalls(LAYOUT, WALL_T);

function buildWalls(layout: Area[], t: number): Rect[] {
  const out: Rect[] = [];
  const opens = (doors: Door[], side: Door["side"]) =>
    doors.filter((d) => d.side === side).map((d) => [d.from, d.to] as [number, number]).sort((a, b) => a[0] - b[0]);

  // horizontal wall band at y=yy, thickness t, from x0..x1, minus gaps (abs x)
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
    buildH(a.x - t, x2 + t, a.y - t, opens(a.doors, "top"));    // top (corners covered by extension)
    buildH(a.x - t, x2 + t, y2, opens(a.doors, "bottom"));       // bottom
    buildV(a.y, y2, a.x - t, opens(a.doors, "left"));            // left
    buildV(a.y, y2, x2, opens(a.doors, "right"));                // right
  }
  return out;
}

export default class GameServer implements Party.Server {
  players: Record<string, Player> = {};
  quills: Quill[] = [];
  parchments: Parchment[] = [];
  nextId = 1;

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection) {
    const color = PLAYER_COLORS[Object.keys(this.players).length % PLAYER_COLORS.length];
    this.players[conn.id] = {
      id: conn.id,
      name: "Guest",
      color,
      // spawn inside the Lobby (centre ~1600,1320)
      x: 1600 + (Math.random() * 200 - 100),
      y: 1320 + (Math.random() * 200 - 100),
      carrying: null,
      parchments: 0,
    };

    // Supply scales with the group.
    this.quills.push({ id: this.mkId("quill"), ...this.spawnPos(), heldBy: null });
    for (let i = 0; i < 3; i++) this.parchments.push({ id: this.mkId("parch"), ...this.spawnPos() });

    // The map (static geometry) is sent only on init; snapshots don't resend it.
    conn.send(JSON.stringify({
      type: "init",
      you: conn.id,
      map: { world: WORLD, walls: WALLS, areas: AREAS },
      ...this.snapshot(),
    }));
    this.broadcastExcept(conn.id, { type: "snapshot", ...this.snapshot() });
  }

  onMessage(raw: string, sender: Party.Connection) {
    let msg: any;
    try {
      msg = JSON.parse(raw as string);
    } catch {
      return;
    }
    const player = this.players[sender.id];
    if (!player) return;

    switch (msg.type) {
      case "setName": {
        player.name = String(msg.name ?? "Guest").slice(0, 24) || "Guest";
        this.broadcastSnapshot();
        break;
      }

      case "move": {
        // The client has already resolved wall collisions locally; we just
        // keep it inside the world and relay. (Trusted internal tool.)
        player.x = clamp(msg.x, 0, WORLD.w);
        player.y = clamp(msg.y, 0, WORLD.h);
        if (player.carrying) {
          const q = this.quills.find((q) => q.id === player.carrying);
          if (q) { q.x = player.x; q.y = player.y - 24; }
        }
        this.broadcastExcept(sender.id, { type: "playerMoved", id: player.id, x: player.x, y: player.y });
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
        if (kind) this.broadcastSnapshot();
        break;
      }

      case "drop": {
        if (!player.carrying) break;
        const q = this.quills.find((q) => q.id === player.carrying);
        if (q) { q.heldBy = null; q.x = player.x; q.y = player.y; }
        player.carrying = null;
        this.broadcastSnapshot();
        break;
      }
    }
  }

  onClose(conn: Party.Connection) {
    const player = this.players[conn.id];
    if (player) {
      for (let i = 0; i < player.parchments; i++) {
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
    this.broadcastSnapshot();
  }

  // ---- helpers ------------------------------------------------------------
  mkId(prefix: string) {
    return prefix + this.nextId++;
  }

  // Random point on walkable floor: pick an area, then a margin-inset point.
  spawnPos() {
    const a = LAYOUT[Math.floor(Math.random() * LAYOUT.length)];
    const m = 28;
    return {
      x: a.x + m + Math.random() * Math.max(1, a.w - 2 * m),
      y: a.y + m + Math.random() * Math.max(1, a.h - 2 * m),
    };
  }

  snapshot() {
    return { world: WORLD, players: this.players, quills: this.quills, parchments: this.parchments };
  }

  broadcastSnapshot() {
    this.broadcast({ type: "snapshot", ...this.snapshot() });
  }

  broadcast(obj: unknown) {
    this.room.broadcast(JSON.stringify(obj));
  }

  broadcastExcept(id: string, obj: unknown) {
    this.room.broadcast(JSON.stringify(obj), [id]);
  }
}

function clamp(n: number, lo: number, hi: number) {
  n = Number(n) || 0;
  return Math.max(lo, Math.min(hi, n));
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
