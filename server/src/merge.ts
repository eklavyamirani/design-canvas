import { LIMITS, type SyncedElement } from '../../shared/protocol.ts';

export { wins } from '../../shared/protocol.ts';

// Elements come from the browser, so only shape and size are trusted here;
// the editor restores (repairs) whatever it receives.
export function isSyncedElement(value: unknown): value is SyncedElement {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    e.id.length <= 64 &&
    Number.isSafeInteger(e.version) &&
    Number.isSafeInteger(e.versionNonce)
  );
}

export function elementSize(element: SyncedElement): number {
  return Buffer.byteLength(JSON.stringify(element));
}

export function fitsLimit(element: SyncedElement): boolean {
  return elementSize(element) <= LIMITS.elementBytes;
}
