// Which build this is, fixed at build time:
//
// - Platform (deploy/web.Dockerfile, VITE_COLLAB=on): served next to the
//   collab server behind the platform sign-in. Drawings can be shared as rooms.
// - GitHub Pages (VITE_COLLAB_URL): public and solo. "Collaborate" opens the
//   platform build and hands it the current drawing.
// - Neither (plain `npm run dev`): solo only.
export const COLLAB = import.meta.env.VITE_COLLAB === 'on';
export const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ? new URL(import.meta.env.VITE_COLLAB_URL) : null;
// The only page allowed to hand a drawing to the platform build (/new).
export const PAGES_ORIGIN = import.meta.env.VITE_PAGES_ORIGIN || null;
