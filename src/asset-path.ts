// Excalidraw reads this when it first loads fonts, so this module must be
// imported before the library. The fonts are copied by scripts/copy-fonts.mjs.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

window.EXCALIDRAW_ASSET_PATH = new URL(import.meta.env.BASE_URL, window.location.origin).href;

export {};
