import { useEffect, useMemo, useRef } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import type { ExcalidrawInitialDataState, ExcalidrawProps } from '@excalidraw/excalidraw/types';
import { loadScene, saveScene, type SavedScene } from './storage';

const SAVE_DELAY_MS = 400;

async function initialData(): Promise<ExcalidrawInitialDataState> {
  const saved = await loadScene().catch((error) => {
    console.warn('Could not load the saved drawing', error);
    return null;
  });
  if (saved) return { ...saved, scrollToContent: false };
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return { appState: { theme: dark ? 'dark' : 'light', name: 'Design Canvas' } };
}

export default function App() {
  // Created once so StrictMode's double render doesn't read the database twice.
  const initial = useMemo(initialData, []);
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

  // Don't lose the last few strokes when the tab is closed or backgrounded.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  return <Excalidraw initialData={initial} onChange={onChange} />;
}
