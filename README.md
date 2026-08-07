# Haunted Retro 🎈

A realtime, multiplayer, explorable world — a starting point for a gamified
"end of sprint retro". Walk around a shared walled building, see other players
move in real time, collect quills and parchments, and (soon) write and vote on
retro thoughts together.

Built on **Cloudflare Workers + Durable Objects** via
[`partyserver`](https://github.com/cloudflare/partykit/tree/main/packages/partyserver).
Runs entirely locally for development; deploys to your own Cloudflare account.

## Run it locally

```bash
npm install
npm run dev
```

`wrangler dev` runs the Worker + Durable Object locally (no Cloudflare login
needed) and serves the client. Open **http://127.0.0.1:8787** in two or more
browser tabs — each tab is a player in the same world. Use `#roomname` in the
URL (e.g. `http://127.0.0.1:8787/#sprint-42`) to create separate rooms.

> Tip: after editing `public/index.html`, hard-refresh (Ctrl+Shift+R) — dev
> asset serving can otherwise hand you a cached page.

## Controls

- **WASD** / arrow keys — move (walls block you; use the doorways)
- **E** — grab the nearest quill, parchment, or one parchment from a player who
  holds more than you
- **Q** — drop your quill

## How it fits together

| File | Role |
|------|------|
| `src/index.ts`     | The Worker. `Main` is a Durable Object (one per room) holding authoritative game state; the fetch handler routes `/parties/main/<room>` WebSocket upgrades to it. Also defines the map (rooms/corridors → generated walls). |
| `public/index.html`| The whole client: a `<canvas>` renderer with a follow-camera, interpolation of other players, wall collision, and a WebSocket into the room. No build step. |
| `wrangler.jsonc`   | Cloudflare config: Durable Object binding, SQLite migration, and `./public` served as static assets. |

## Deploy to Cloudflare

Deploys automatically via GitHub Actions on every push to `main`
(`.github/workflows/deploy.yml`). It needs two repository secrets:

- `CLOUDFLARE_API_TOKEN` — an API token created with the **Edit Cloudflare
  Workers** template
- `CLOUDFLARE_ACCOUNT_ID` — your account id (Workers & Pages → right sidebar)

To deploy by hand instead:

```bash
npx wrangler login
npm run deploy
```

The game goes live at `https://hauntedretro.<your-subdomain>.workers.dev`.

## Where to take it next (toward a real retro)

- **Rooms as retro columns** — "Went well" / "Didn't go well" / "Actions";
  parchments become the notes players write on and place in a room.
- **Writing** — use a quill + parchment to pen a thought and drop it in the world.
- **Voting** — players spend tokens on notes; the Durable Object tallies live.
- **Persistence** — store the board in Durable Object storage so a retro
  survives a refresh.
