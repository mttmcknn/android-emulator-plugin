import assert from 'node:assert/strict';
import test from 'node:test';
import { typeIntoDevice } from '../runtime/core/lib/text-input.mjs';

const field = { editable: true, enabled: true, focused: true, className: 'EditText', resourceId: 'app:id/query', text: 'old', bounds: [0, 0, 100, 50], center: [50, 25] };
function fixture(reads) {
  const events = [];
  const device = { uiNodes: async () => reads.length > 1 ? reads.shift() : reads[0], tap: async (...point) => events.push(['tap', ...point]) };
  const mirror = { pressKey: (...args) => events.push(['key', ...args]), setClipboard: async (...args) => events.push(['clipboard', ...args]) };
  return { events, device, mirror };
}

test('named Unicode replacement focuses an editable field and verifies before Enter', async () => {
  const f = fixture([
    [{ ...field, editable: false, clickable: true }, { ...field, focused: false }],
    [field],
    [{ ...field, text: 'café 🙂' }],
  ]);
  const result = await typeIntoDevice(f.device, f.mirror, { text: 'café 🙂', target: { resourceId: 'query' }, replace: true, submit: true });
  assert.deepEqual(f.events, [['tap', 50, 25], ['key', 29, 4096], ['clipboard', 'café 🙂'], ['key', 66]]);
  assert.deepEqual(result, { characters: 6, replaced: true, verified: true, submitted: true });
});

test('ambiguous targets or lost focus never send destructive selection or text', async () => {
  for (const reads of [[[field, field]], [[{ ...field, focused: false }], [{ ...field, resourceId: 'other' }]]]) {
    const f = fixture(reads);
    await assert.rejects(typeIntoDevice(f.device, f.mirror, { text: 'x', target: { resourceId: 'query' }, replace: true }));
    assert.ok(f.events.every(([type]) => type === 'tap'));
  }
});

test('unverifiable text is not replayed or submitted; empty replacement clears', async () => {
  const f = fixture([[field], [{ ...field, password: true }]]);
  const result = await typeIntoDevice(f.device, f.mirror, { text: 'secret', submit: true });
  assert.equal(result.verified, false);
  assert.equal(result.submitted, false);
  assert.deepEqual(f.events, [['clipboard', 'secret']]);
  const empty = fixture([[field], [{ ...field, text: '' }]]);
  assert.equal((await typeIntoDevice(empty.device, empty.mirror, { text: '', replace: true })).verified, true);
  assert.deepEqual(empty.events, [['key', 29, 4096], ['key', 67], ['clipboard', '', { paste: false }]]);
});

test('waits for delayed focus and delayed text rendering without repeating input', async () => {
  const f = fixture([
    [{ ...field, focused: false }],
    [{ ...field, focused: false }],
    [field],
    [field],
    [{ ...field, text: 'new' }],
  ]);
  const result = await typeIntoDevice(f.device, f.mirror, { text: 'new', target: { resourceId: 'query' }, replace: true });
  assert.equal(result.verified, true);
  assert.equal(f.events.filter(([type]) => type === 'clipboard').length, 1);
});
