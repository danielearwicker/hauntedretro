# Retro Game 🎈

A realtime, multiplayer, explorable world — a starting point for a gamified
"end of sprint retro". Walk around a shared map, see other players move in
real time, pick up and drop gems, and solve a simple co-op puzzle together.

Built on [PartyKit](https://www.partykit.io/) (a thin layer over Cloudflare
Durable Objects + WebSockets). **Runs entirely locally** — no cloud account
needed until you decide to deploy.

## Run it locally

```bash
npm install
npm run dev
```

Then open **http://127.0.0.1:1999** in two or more browser tabs (or share your
LAN IP with a colleague). Each tab is a player in the same world.

Use `#roomname` in the URL to create separate rooms, e.g.
`http://127.0.0.1:1999/#sprint-42` — everyone using that exact link shares a world.

## Controls

- **WASD** / arrow keys — move
- **E** — pick up the nearest gem (highlighted with a dashed ring)
- **Q** — drop what you're carrying
- Carry a gem to one of the three **pedestals** in the Puzzle Room (top-right)
  and drop it there. Fill all three together to solve the puzzle.

## How it fits together

| File | Role |
|------|------|
| `src/server.ts`   | Authoritative game state. One PartyKit "room" = one Durable Object holding all players, gems and pedestals. Handles join/leave, movement, pickup/drop, and the puzzle-solved check. |
| `public/index.html` | The whole client: a `<canvas>` renderer with a follow-camera, keyboard input, and a raw WebSocket into the room. No build step. |
| `partykit.json`   | Points PartyKit at the server entry and tells it to serve `public/` as static assets. |

The client keeps a local mirror of the server's state and updates it from
broadcast messages (`playerMoved`, `objectPicked`, `objectDropped`, …). The
server is the single source of truth, so nobody can desync the shared world.

## Deploy to your Cloudflare account (when ready)

```bash
npx partykit login    # opens a browser to authorise with Cloudflare
npm run deploy         # publishes to <project>.<your-account>.partykit.dev
```

That's the only step that touches the cloud. Everything above runs offline.

## Where to take it next (toward a real retro)

- **Rooms as retro columns** — "Went well" / "Didn't go well" / "Actions" zones;
  gems become sticky-notes players write on and drop into a column.
- **Voting** — players drop tokens on notes; server tallies and broadcasts.
- **Persistence** — store the board in Durable Object storage (`this.room.storage`)
  so a retro survives a refresh, or push results to Supabase/a DB at the end.
- **Identity** — swap the free-text name box for your SSO so it's tied to real
  team members.
