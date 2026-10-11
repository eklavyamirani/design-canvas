# design-canvas

A whiteboard for sketching diagrams, live at
<https://github.ekkylab.uk/design-canvas/>. It is a thin wrapper around
[Excalidraw](https://github.com/excalidraw/excalidraw), built with Vite and
React.

- **Drawings stay in your browser.** The scene is saved to IndexedDB as you
  draw and restored on the next visit. Nothing is uploaded, and there is no
  live collaboration or sharing link.
- **No runtime CDN.** Excalidraw's fonts are copied into the build
  (`scripts/copy-fonts.mjs`) and served from the same origin.
- **To move a drawing between browsers,** use the menu's *Save to…* and *Open*
  to export and import a `.excalidraw` file.

Clearing site data for `github.ekkylab.uk` deletes the saved drawing. That
storage is shared with every other app on the domain, so export anything you
want to keep.

## Commands

```sh
npm install
npm run dev      # http://localhost:5173
npm run check    # type-check
npm run build    # static site in dist/
```

## Deploy

Every push to `main` type-checks, builds and deploys to GitHub Pages
(`.github/workflows/deploy.yml`). Pull requests run the same checks without
deploying. The base path (`/design-canvas`) comes from Pages through
`BASE_PATH`, so nothing in the source hard-codes it.
