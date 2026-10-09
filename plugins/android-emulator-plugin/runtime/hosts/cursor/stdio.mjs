// Line-delimited JSON-RPC over stdio that, unlike the shared serveMcp, also lets the server send requests
// to the client (needed for MCP roots/list) and observe client notifications.
import readline from 'node:readline';
import { errorDetails } from '../../core/lib/errors.mjs';

export function serveMcpWithClient(handle, { input = process.stdin, output = process.stdout, onMessage = () => {} } = {}) {
  const send = value => output.write(`${JSON.stringify(value)}\n`);
  const pending = new Map();
  let nextId = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = `server-${++nextId}`;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  readline.createInterface({ input }).on('line', async line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (message.method === undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
      return;
    }
    onMessage(message, request);
    if (message.id === undefined) return;
    try { send({ jsonrpc: '2.0', id: message.id, result: await handle(message) }); }
    catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message,
      ...(error.diagnosticCode ? { data: errorDetails(error) } : {}) } }); }
  });
}
