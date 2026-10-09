import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { serveMcpWithClient } from '../runtime/hosts/cursor/stdio.mjs';

function harness(handle, onMessage) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', chunk => lines.push(...chunk.toString().trim().split('\n').map(line => JSON.parse(line))));
  serveMcpWithClient(handle, { input, output, onMessage });
  const write = message => input.write(`${JSON.stringify(message)}\n`);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { lines, write, settle };
}

test('answers client requests and ignores notifications', async () => {
  const { lines, write, settle } = harness(async message => ({ echoed: message.method }));
  write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  write({ jsonrpc: '2.0', id: 1, method: 'ping' });
  await settle();
  assert.deepEqual(lines, [{ jsonrpc: '2.0', id: 1, result: { echoed: 'ping' } }]);
});

test('lets the server ask the client for roots and resolves the reply', async () => {
  let reply;
  const { lines, write, settle } = harness(async () => ({}), (message, request) => {
    if (message.method === 'notifications/initialized') reply = request('roots/list');
  });
  write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await settle();
  assert.equal(lines[0].method, 'roots/list');
  write({ jsonrpc: '2.0', id: lines[0].id, result: { roots: [{ uri: 'file:///projects/app' }] } });
  assert.deepEqual(await reply, { roots: [{ uri: 'file:///projects/app' }] });
});

test('reports handler failures as JSON-RPC errors', async () => {
  const { lines, write, settle } = harness(async () => { throw Object.assign(new Error('nope'), { code: -32601 }); });
  write({ jsonrpc: '2.0', id: 7, method: 'missing' });
  await settle();
  assert.deepEqual(lines, [{ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'nope' } }]);
});
