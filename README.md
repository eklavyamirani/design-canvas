# design-canvas

A whiteboard for sketching diagrams, built on
[Excalidraw](https://github.com/excalidraw/excalidraw) with Vite and React.
It comes in two builds:

- **Public, solo** at <https://github.ekkylab.uk/design-canvas/> (GitHub
  Pages). Drawings stay in your browser: the scene is saved to IndexedDB as
  you draw and restored on the next visit. Nothing is uploaded. **Collaborate**
  opens the platform build and takes the current drawing along.
- **Shared rooms** at <https://canvas.app.ekkylab.uk/>, on the
  [app platform](https://github.com/eklavyamirani/app-platform) behind its
  sign-in (app-platform record 0050). **Share** turns the drawing into a room
  at `/r/<id>`; anyone signed in to the platform with the link can join and
  draw along, with live cursors. Rooms are saved in Postgres.

Clearing site data for `github.ekkylab.uk` deletes the solo drawing. That
storage is shared with every other app on the domain, so export anything you
want to keep (menu: *Save to…*, *Open*). Excalidraw's fonts are copied into
the build (`scripts/copy-fonts.mjs`) and served from the same origin; there is
no runtime CDN.

## How rooms sync

`src/collab/Collab.ts` (editor) and `server/` (collab server) exchange the
messages in `shared/protocol.ts` over a WebSocket at `/collab/rooms/<id>/ws`.
Both sides merge with Excalidraw's own rule (`wins`: the higher `version`,
then the lower `versionNonce`), so everyone converges whatever order edits
arrive in. The server keeps open rooms in memory, relays the edits that win,
and saves them to Postgres in batches with the same rule in SQL. Each editor
sends only elements newer than what the server is known to have, so nothing
echoes back. Cursors are relayed, not stored; images are stored per room and
fetched when an editor lacks them.

The server trusts the platform's sign-in headers (`X-Auth-Request-User`,
`-Preferred-Username`, `-Email`; Traefik replaces client copies) and accepts
WebSockets and new rooms only from its own origin (`ALLOWED_ORIGIN`).

## Commands

```sh
npm install
npm run dev          # solo editor, http://localhost:5173
npm run check        # type-check
npm run build        # static site in dist/

# rooms, locally: the collab server on :8787 (in memory without DATABASE_URL)
(cd server && npm install && npm run dev)
npm run dev:collab   # editor with rooms; everyone is the user "dev"

cd server
npm run check && npm test       # TEST_DATABASE_URL=<runtime role URL> to test on Postgres
DATABASE_URL=<owner URL> DATABASE_RUNTIME_ROLE=<role> npm run migrate
```

## Deploy

- **Pages** (`.github/workflows/deploy.yml`): every push to `main`
  type-checks, tests the server against Postgres, builds and deploys. Pull
  requests run the same checks without deploying. The base path
  (`/design-canvas`) comes from Pages through `BASE_PATH`. The repository
  variable `CANVAS_URL` (e.g. `https://canvas.app.ekkylab.uk/`) turns on the
  Collaborate button; without it the Pages build is solo only.
- **Platform** (`.github/workflows/platform-images.yml`): pushes to `main` (and
  pull requests labelled `preview`) build `canvas-web` (`deploy/web.Dockerfile`)
  and `canvas-collab` (`server/Dockerfile`) into the platform's registry,
  tagged by commit SHA. A release is promoted in app-platform
  (`scripts/promote azure canvas <sha>`), whose migrate Job runs the collab
  image with `--migrate` first.
