import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../runtime/core/web/app.js', import.meta.url), 'utf8');
const sharing = source.slice(source.indexOf('let lastCapture ='), source.indexOf('// ---- Logcat'));
function panel({ failCopy = false, failHost = false, selection = [] } = {}) {
  const nodes = new Map();
  const requests = [];
  const context = vm.createContext({
    embedded: true, capabilities: { captureContext: true, contextResourceLink: true },
    $: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
    host: {
      label: 'Test host',
      updateContext: async (content) => { if (failHost) throw new Error('Host refused context'); requests.push({ content }); },
      contextImage: (image) => [
        { type: 'text', text: image.title },
        { type: 'image', data: image.data, mimeType: image.mimeType, title: image.title },
      ],
    },
    call: async (tool, { action, captureId, captureIds } = {}) => {
      if (tool === 'emulator_capture_selection') {
        if (captureIds) selection.splice(0, selection.length, ...captureIds);
        return { captureIds: [...selection] };
      }
      if (action === 'copy') { if (failCopy) throw new Error('Clipboard unavailable'); return {}; }
      return { text: `Capture ${captureId}`, images: [{ data: captureId, mimeType: 'image/png', title: `Frame ${captureId}` }],
        structuredContent: { resource: captureId === 'video' ? { type: 'resource_link', uri: 'file:///owned/video.mp4', name: 'video.mp4', mimeType: 'video/mp4' } : null } };
    },
  });
  vm.runInContext(sharing, context);
  return { context, nodes, requests };
}

test('adding screenshot then video preserves both contexts and labels the sample frames', async () => {
  const { context, requests } = panel();
  await vm.runInContext("addCaptureContext({id:'screen',mimeType:'image/png'})", context);
  await vm.runInContext("addCaptureContext({id:'video',mimeType:'video/mp4'})", context);
  const content = requests[1].content;
  assert.deepEqual(Array.from(content.filter(block => block.type === 'image'), block => block.data), ['screen', 'video']);
  assert.equal(content.find(block => block.type === 'resource_link').uri, 'file:///owned/video.mp4');
  assert.ok(content.some(block => block.text === 'Frame video'));
  await vm.runInContext('clearCaptureContext()', context);
  assert.equal(requests.at(-1).content.length, 0);
  assert.equal(vm.runInContext('chatCaptures.size', context), 0);
});

test('copy failure does not suppress a successful context add or falsely report copied media', async () => {
  const { context, nodes, requests } = panel({ failCopy: true });
  await vm.runInContext("lastCapture={id:'video',mimeType:'video/mp4'}; shareCapture({copy:true,chat:true})", context);
  assert.equal(requests.length, 1);
  assert.match(nodes.get('capture-feedback').textContent, /Clipboard unavailable/);
  assert.match(nodes.get('capture-feedback').textContent, /sample frames and saved file path added/);
  assert.doesNotMatch(nodes.get('capture-feedback').textContent, /Copied to clipboard/);
  assert.equal(nodes.get('capture-copy').disabled, false);
});

test('failed host updates preserve pending context state and never report attached media', async () => {
  const { context, nodes } = panel({ failHost: true });
  await vm.runInContext("lastCapture={id:'screen',mimeType:'image/png'}; shareCapture({chat:true})", context);
  assert.equal(vm.runInContext('chatCaptures.size', context), 0);
  assert.equal(nodes.get('capture-feedback').textContent, 'Host refused context');
});

test('the context limit refuses extra captures instead of silently dropping previous evidence', async () => {
  const { context, requests } = panel();
  for (const id of ['a', 'b', 'c', 'd']) await vm.runInContext(`addCaptureContext({id:'${id}',mimeType:'image/png'})`, context);
  await assert.rejects(vm.runInContext("addCaptureContext({id:'e',mimeType:'image/png'})", context), /four captures/);
  assert.equal(requests.length, 4);
  assert.equal(vm.runInContext('chatCaptures.size', context), 4);
});


test('reopened panels restore prior capture IDs before replacing the host context', async () => {
  const selection = [];
  const original = panel({ selection });
  await vm.runInContext("addCaptureContext({id:'screen',mimeType:'image/png'})", original.context);
  const reopened = panel({ selection });
  await vm.runInContext("addCaptureContext({id:'video',mimeType:'video/mp4'})", reopened.context);
  assert.deepEqual(Array.from(reopened.requests[0].content.filter(block => block.type === 'image'), block => block.data), ['screen', 'video']);
  await vm.runInContext('clearCaptureContext()', reopened.context);
  assert.deepEqual(selection, []);
});
