import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { COLLAB_URL, PAGES_ORIGIN } from './config';
import type { SavedScene } from './storage';

// Moving a drawing from the public Pages build to the platform build, which
// is another origin and can't read this one's IndexedDB. The Pages tab opens
// <platform>/new and keeps a handle to it. Once /new has loaded (after the
// platform sign-in) it says it is ready, and only then is the drawing posted,
// to that window and origin only. /new accepts it only from PAGES_ORIGIN.

type Ready = { type: 'canvas-ready' };
type Scene = { type: 'canvas-scene'; scene: SavedScene };

const WAIT_MS = 3_000;

// Pages side.
export function openOnPlatform(api: ExcalidrawImperativeAPI): void {
  if (!COLLAB_URL) return;
  const target = new URL('new', COLLAB_URL);
  const win = window.open(target.href, '_blank');
  if (!win) {
    // Pop-up blocked: go there without the drawing.
    location.href = target.href;
    return;
  }
  const onMessage = (event: MessageEvent) => {
    if (event.source !== win || event.origin !== target.origin || (event.data as Ready)?.type !== 'canvas-ready') return;
    window.removeEventListener('message', onMessage);
    const appState = api.getAppState();
    const message: Scene = {
      type: 'canvas-scene',
      scene: {
        elements: api.getSceneElements(),
        appState: { theme: appState.theme, viewBackgroundColor: appState.viewBackgroundColor, name: appState.name },
        files: api.getFiles(),
      },
    };
    win.postMessage(message, target.origin);
  };
  window.addEventListener('message', onMessage);
  // Signing in can take a while, but not forever.
  window.setTimeout(() => window.removeEventListener('message', onMessage), 15 * 60_000);
}

// Platform side (/new): the drawing from the Pages tab that opened this one,
// or null if there is none (opened directly, or the sign-in pages cut the
// link between the tabs).
export function receiveFromPages(): Promise<SavedScene | null> {
  const opener = window.opener as Window | null;
  if (!opener || !PAGES_ORIGIN) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (scene: SavedScene | null) => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
      resolve(scene);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as Scene | undefined;
      if (event.source !== opener || event.origin !== PAGES_ORIGIN || data?.type !== 'canvas-scene') return;
      done(data.scene && typeof data.scene === 'object' ? data.scene : null);
    };
    window.addEventListener('message', onMessage);
    const timer = window.setTimeout(() => done(null), WAIT_MS);
    const ready: Ready = { type: 'canvas-ready' };
    opener.postMessage(ready, PAGES_ORIGIN);
  });
}
