// Copies Excalidraw's fonts into public/ so the app serves them itself instead
// of fetching them from a CDN at runtime. See src/asset-path.ts.
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(
  new URL('../node_modules/@excalidraw/excalidraw/dist/prod/fonts', import.meta.url),
);
const to = fileURLToPath(new URL('../public/fonts', import.meta.url));

rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
