import readline from 'node:readline';
import { errorDetails } from '../core/lib/errors.mjs';

export function toolResult(result) {
  const content = [{ type: 'text', text: result.text ?? '' }];
  if (result.image) content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType });
  for (const image of result.images ?? []) {
    if (image.title) content.push({ type: 'text', text: image.title });
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  }
  return { content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(result.meta ? { _meta: result.meta } : {}) };
}

// The integration resolves trusted session/file context. The MCP transport never
// guesses identity from process state or user-supplied tool arguments.
export function createMcpHandler({ serverInfo, tools, resources = [], instructions, capabilities = {}, readResource, callTool }) {
  return async message => {
    switch (message.method) {
      case 'initialize': return {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, resources: {}, ...capabilities }, serverInfo, instructions,
      };
      case 'ping': return {};
      case 'tools/list': return { tools };
      case 'resources/list': return { resources };
      case 'resources/read': return { contents: [await readResource(message.params?.uri ?? '')] };
      case 'tools/call': {
        const { name, arguments: args = {}, _meta: meta } = message.params ?? {};
        if (!tools.some(tool => tool.name === name)) throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
        try { return toolResult(await callTool(name, args, meta)); }
        catch (error) {
          const detail = errorDetails(error);
          return { content: [{ type: 'text', text: `[${detail.code}] ${error.message}` }], structuredContent: { error: detail }, isError: true };
        }
      }
      default: throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    }
  };
}

export function serveMcp(handle, { input = process.stdin, output = process.stdout } = {}) {
  const send = value => output.write(`${JSON.stringify(value)}\n`);
  return readline.createInterface({ input }).on('line', async line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (message.id === undefined) return;
    try { send({ jsonrpc: '2.0', id: message.id, result: await handle(message) }); }
    catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message,
      ...(error.diagnosticCode ? { data: errorDetails(error) } : {}) } }); }
  });
}
