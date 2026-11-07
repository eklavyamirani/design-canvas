import { useEffect, useMemo, useRef, useState } from 'react';
import { Excalidraw, LiveCollaborationTrigger, MainMenu } from '@excalidraw/excalidraw';
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from '@excalidraw/excalidraw/types';
import { ROOM_ID } from '../shared/protocol';
import { Collab, createRoom, roomUrl, type Status } from './collab/Collab';
import { COLLAB, COLLAB_URL } from './config';
import { openOnPlatform, receiveFromPages } from './handoff';
import { loadScene, saveScene, type SavedScene } from './storage';

const SAVE_DELAY_MS = 400;

// Pages of the platform build, relative to the base path: "" is the solo
// drawing, r/<id> a shared room, new starts a room (from the Pages build).
type Route = { kind: 'solo' } | { kind: 'room'; id: string } | { kind: 'new' };

function currentRoute(): Route {
  if (!COLLAB) return { kind: 'solo' };
  const path = location.pathname.slice(import.meta.env.BASE_URL.length);
  if (path === 'new') return { kind: 'new' };
  const room = /^r\/([^/]+)$/.exec(path);
  if (room && ROOM_ID.test(room[1])) return { kind: 'room', id: room[1] };
  return { kind: 'solo' };
}

function go(path: string, replace = false): void {
  const url = new URL(path, new URL(import.meta.env.BASE_URL, location.origin)).href;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function preferredTheme(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

async function soloData(): Promise<ExcalidrawInitialDataState> {
  const saved = await loadScene().catch((error) => {
    console.warn('Could not load the saved drawing', error);
    return null;
  });
  if (saved) return { ...saved, scrollToContent: false };
  return { appState: { theme: preferredTheme(), name: 'Design Canvas' } };
}

// What a new room starts with: the drawing it was shared from.
function snapshot(api: ExcalidrawImperativeAPI): SavedScene {
  const appState = api.getAppState();
  return {
    elements: api.getSceneElements(),
    appState: { theme: appState.theme, viewBackgroundColor: appState.viewBackgroundColor, name: appState.name },
    files: api.getFiles(),
  };
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);
  // Handed from the solo drawing (or the Pages build) to the room it starts.
  const [seed, setSeed] = useState<{ roomId: string; scene: SavedScene | null } | null>(null);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const startRoom = async (scene: SavedScene | null) => {
    const id = await createRoom();
    setSeed({ roomId: id, scene });
    go(`r/${id}`, route.kind === 'new');
  };

  if (route.kind === 'new') return <NewRoom start={startRoom} />;
  if (route.kind === 'room') {
    const scene = seed?.roomId === route.id ? seed.scene : null;
    return <RoomEditor key={route.id} roomId={route.id} seed={scene} />;
  }
  return <SoloEditor share={COLLAB ? startRoom : null} />;
}

// The drawing kept in this browser (IndexedDB), as before rooms existed.
function SoloEditor({ share }: { share: ((scene: SavedScene) => Promise<void>) | null }) {
  // Created once so StrictMode's double render doesn't read the database twice.
  const initial = useMemo(soloData, []);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const pending = useRef<SavedScene | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const flush = () => {
    window.clearTimeout(timer.current);
    const scene = pending.current;
    if (!scene) return;
    pending.current = null;
    saveScene(scene).catch((error) => console.warn('Could not save the drawing', error));
  };

  const onChange: NonNullable<ExcalidrawProps['onChange']> = (elements, appState, files) => {
    pending.current = {
      elements,
      // Only what is worth restoring. The rest of appState is transient UI
      // state, and parts of it (collaborators) can't be stored at all.
      appState: {
        theme: appState.theme,
        viewBackgroundColor: appState.viewBackgroundColor,
        gridModeEnabled: appState.gridModeEnabled,
        zenModeEnabled: appState.zenModeEnabled,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: appState.zoom,
        name: appState.name,
      },
      files,
    };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };

  // Don't lose the last few strokes when the tab is closed or backgrounded,
  // or when the drawing is left for a room.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  const onCollaborate = () => {
    if (!api) return;
    if (COLLAB_URL) return openOnPlatform(api);
    share?.(snapshot(api)).catch((error) => {
      console.warn(error);
      api.setToast({ message: 'Could not start a shared drawing. Try again.', closable: true });
    });
  };

  const canCollaborate = share !== null || COLLAB_URL !== null;

  return (
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={initial}
      onChange={onChange}
      renderTopRightUI={() =>
        canCollaborate ? (
          <LiveCollaborationTrigger
            isCollaborating={false}
            onSelect={onCollaborate}
            title={COLLAB_URL ? 'Sign in and draw together' : 'Share this drawing as a room'}
          />
        ) : null
      }
    >
      <Menu />
    </Excalidraw>
  );
}

const STATUS_TEXT: Record<Status, string | null> = {
  connecting: 'Connecting…',
  online: null,
  offline: 'Offline, reconnecting…',
  'signed-out': 'Signed out. Reload to sign in again.',
  'not-found': 'This room does not exist.',
};

// A shared room: the scene lives on the collab server, not in IndexedDB.
function RoomEditor({ roomId, seed }: { roomId: string; seed: SavedScene | null }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const collab = useRef<Collab | null>(null);
  const initial = useMemo<ExcalidrawInitialDataState>(
    () =>
      seed
        ? { ...seed, scrollToContent: true }
        : { appState: { theme: preferredTheme(), name: 'Shared drawing' } },
    [seed],
  );

  useEffect(() => {
    if (!api) return;
    const session = new Collab(roomId, api, setStatus);
    collab.current = session;
    session.start();
    return () => {
      session.stop();
      collab.current = null;
    };
  }, [api, roomId]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(roomUrl(roomId));
      api?.setToast({ message: 'Link copied. Anyone signed in to the platform can join.', duration: 4000 });
    } catch {
      api?.setToast({ message: roomUrl(roomId), closable: true });
    }
  };

  const text = STATUS_TEXT[status];

  return (
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={initial}
      isCollaborating
      onChange={(_elements, _appState, files) => collab.current?.onChange(files)}
      onPointerUpdate={(payload) => collab.current?.onPointerUpdate(payload)}
      renderTopRightUI={() => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {text && (
            <span role="status" data-status={status} style={{ fontSize: '0.8rem', opacity: 0.8 }}>
              {text}
            </span>
          )}
          <LiveCollaborationTrigger isCollaborating onSelect={copyLink} title="Copy the link to this room" />
        </div>
      )}
    >
      <Menu leave={() => go('')} />
    </Excalidraw>
  );
}

// Excalidraw's own menu, without its social links, plus leaving a room.
function Menu({ leave }: { leave?: () => void }) {
  return (
    <MainMenu>
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      {leave && <MainMenu.Item onSelect={leave}>Leave room</MainMenu.Item>}
      <MainMenu.Separator />
      <MainMenu.DefaultItems.ToggleTheme />
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  );
}

// /new: starts a room from the drawing handed over by the Pages build.
function NewRoom({ start }: { start: (scene: SavedScene | null) => Promise<void> }) {
  const [failed, setFailed] = useState(false);
  // StrictMode runs effects twice; one room is enough.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    receiveFromPages()
      .then(start)
      .catch((error) => {
        console.warn(error);
        setFailed(true);
      });
  }, []);

  return (
    <main style={{ display: 'grid', placeItems: 'center', height: '100%', fontFamily: 'system-ui, sans-serif' }}>
      {failed ? (
        <p>
          Could not start a shared drawing. <a href={import.meta.env.BASE_URL}>Back to the canvas</a>
        </p>
      ) : (
        <p role="status">Starting a shared drawing…</p>
      )}
    </main>
  );
}
