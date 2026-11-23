import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SyncedRecord } from './synced.ts';

type Element = { id: string; version: number; versionNonce: number; isDeleted: boolean; x: number };

function element(id: string, version: number, versionNonce: number, x = 0): Element {
  return { id, version, versionNonce, isDeleted: false, x };
}

// Excalidraw's mutateElement: the same object, a new version.
function editInPlace(target: Element, x: number): void {
  target.x = x;
  target.version += 1;
  target.versionNonce = Math.floor(Math.random() * 2 ** 31);
}

describe('SyncedRecord', () => {
  it('sends nothing the server already has', () => {
    const record = new SyncedRecord<Element>();
    const box = element('box', 1, 500);
    record.sent([box]);
    assert.deepEqual(record.changes([box]), []);
  });

  it('sends an in-place edit to an element it sent earlier', () => {
    const record = new SyncedRecord<Element>();
    const box = element('box', 1, 500, 100);
    record.sent(record.changes([box]));
    editInPlace(box, 400); // a drag
    const changes = record.changes([box]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].version, 2);
    assert.equal(changes[0].x, 400);
  });

  it('sends an in-place edit to an element the server sent', () => {
    const record = new SyncedRecord<Element>();
    const box = element('box', 5, 500, 384);
    record.received([box]); // the scene ends up holding this same object
    editInPlace(box, 538);
    assert.deepEqual(record.changes([box]).map((e) => e.x), [538]);
  });

  it('keeps the newest version the server sent', () => {
    const record = new SyncedRecord<Element>();
    record.received([element('box', 3, 1)]);
    record.received([element('box', 2, 1)]);
    assert.deepEqual(record.changes([element('box', 3, 1)]), []);
    assert.equal(record.changes([element('box', 3, 9)]).length, 0);
    assert.equal(record.changes([element('box', 3, 0)]).length, 1);
  });

  it('deletes an element that left the scene without being deleted', () => {
    const record = new SyncedRecord<Element>();
    record.sent([element('box', 4, 500)]);
    const [deletion] = record.changes([], 1234);
    assert.equal(deletion.id, 'box');
    assert.equal(deletion.isDeleted, true);
    assert.equal(deletion.version, 5);
    assert.equal((deletion as Element & { updated: number }).updated, 1234);
  });

  it('sends everything again after clear', () => {
    const record = new SyncedRecord<Element>();
    const box = element('box', 1, 500);
    record.sent([box]);
    record.clear();
    assert.equal(record.changes([box]).length, 1);
  });
});
