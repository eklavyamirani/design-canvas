import { wins } from '../../shared/protocol.ts';

type Element = { id: string; version: number; versionNonce: number; isDeleted: boolean };

// The newest version of each element the server is known to have, by id:
// what this editor sent it, or what it sent this editor. A local element is
// sent only when it wins against that.
//
// It keeps copies, never the scene's own objects. Excalidraw applies some
// edits in place (a drag bumps version and moves x/y on the same object), so
// a stored scene object would change along with the scene, and every later
// edit to that element would look as if the server already had it.
export class SyncedRecord<T extends Element> {
  private known = new Map<string, T>();

  // A fresh connection: nothing is known until the server says.
  clear(): void {
    this.known.clear();
  }

  // Elements the server sent.
  received(elements: readonly T[]): void {
    for (const element of elements) {
      if (wins(element, this.known.get(element.id))) this.known.set(element.id, { ...element });
    }
  }

  // Elements the server now has because this editor sent them.
  sent(elements: readonly T[]): void {
    for (const element of elements) this.known.set(element.id, { ...element });
  }

  // What to send: every local element that wins against the server's (not
  // just newer versions: the same version with a lower versionNonce also wins
  // there), and a deletion for each element the server has that left the
  // scene without being deleted, as when opening a file replaces the scene.
  changes(scene: readonly T[], now = Date.now()): T[] {
    const changed = scene.filter((element) => wins(element, this.known.get(element.id)));
    const present = new Set(scene.map((element) => element.id));
    for (const [id, known] of this.known) {
      if (present.has(id) || known.isDeleted) continue;
      changed.push({
        ...known,
        isDeleted: true,
        version: known.version + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        updated: now,
      });
    }
    return changed;
  }
}
