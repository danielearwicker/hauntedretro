# Haunted Retro 🎈

A realtime, multiplayer, explorable world — a starting point for a gamified
"end of sprint retro". Walk around a shared walled building, see other players
move in real time, collect quills and parchments, write retro notes at the
Scriptorium's desks and pin them in the room whose question they answer.

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
- Walk into a pumpkin or barrel to send it rolling
- **Air hockey** in the Library: walk into an end of the table to take its
  mallet, steer it with your movement keys, and push it back off your end to
  stop. With two players a score is kept (reset when the second player joins).
  After a goal the puck goes to whoever conceded — or, playing alone, back to you.
- **R** — write a note (at a desk in the Scriptorium, holding a quill and a
  blank parchment)
- **F** — pin the note you're carrying in the room you're standing in
- **V** — press one of your wax seals onto the note you're standing at, or
  take it back
- **E** at the bell in the Lobby — show the results; ring again to reopen voting

On phones and tablets the game switches to touch controls: put your thumb
anywhere in the lower left and slide to walk (further for faster), and tap the
button on the right for whatever you can do where you're standing. The
instructions fold away behind the **?** in the corner. Whichever you use last
wins — touch the screen for touch controls, press a game key for the keyboard.
Add `?controls=touch` or `?controls=keys` to the URL to force either (handy for
trying touch mode in a desktop browser, where the stick works with the mouse).

## The retro

The Scriptorium is where the writing desks and ink are kept, so it's the only
place you can write. Each other room asks a question; carry your note to the
one it answers and pin it there:

| Room | Question |
|------|----------|
| Workshop | Things that need fixing |
| Garden   | What have you grown (in tools or product)? |
| Library  | What have you learned? |

Then vote: everyone has 3 wax seals, at most one per note, and can move them
around freely. Cards show their total; a gold ring marks your own seal. Votes
are anonymous — only totals are broadcast — and your ballot is tied to your
browser tab, so a refresh keeps it (a new tab is a new voter).

When everyone's done, someone rings the **bell** in the Lobby. Voting closes,
each room's notes glide into order of votes, and the top three get
1st/2nd/3rd rosettes. Writing still works but pinning waits until someone
rings the bell again, which reopens voting and puts every note back where it
was pinned.

Notes are anonymous. An unpinned note turns back into a blank parchment if
its carrier leaves.

Each room's board of pinned notes is saved in its Durable Object's storage, so
it survives everyone leaving, redeploys and (under `wrangler dev`) code
reloads. Locally that storage lives in `.wrangler/state`; delete it to wipe
every board, or just use a new `#roomname`.

To clear one room's board — locally or deployed — open it with `?reset=1`,
e.g. `https://…/?reset=1#sprint-42` (or `…/#sprint-42?reset=1`, or just
`…/?reset=1` for the default room). Its notes, seals and results are deleted
and the rolling props go back to their places; anyone in the room stays, along
with any note they're carrying. The parameter is dropped from the address
straight away, so refreshing won't clear it again. There's no in-game button
for it, but anyone who knows the trick can use it.

## How it fits together

| File | Role |
|------|------|
| `src/index.ts`     | The Worker. `Main` is a Durable Object (one per room) holding authoritative game state; the fetch handler routes `/parties/main/<room>` WebSocket upgrades to it. Also defines the map (rooms/corridors → generated walls). |
| `public/index.html`| The whole client: a `<canvas>` renderer with a follow-camera, interpolation of other players, wall collision, and a WebSocket into the room. No build step. |
| `public/decor/`    | SVG sprites: tiling floors (`floor-*.svg`) and room props. Each is drawn at its own `width`/`height` in world pixels; where props go is `DECOR` in `src/index.ts`, and which floor each room uses is `ROOM_STYLE` in the client. Solid props get a footprint in `COLLIDERS`; kinds in `MOVER_KINDS` (pumpkins, barrels) roll away when walked into, with physics run by the server. |
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

