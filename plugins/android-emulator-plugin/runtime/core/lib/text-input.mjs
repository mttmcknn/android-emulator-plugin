import { setTimeout as pause } from 'node:timers/promises';
import { findNode } from './device.mjs';

function sameField(candidate, original) {
  if (!candidate?.editable || !candidate.enabled || candidate.className !== original.className) return false;
  return original.resourceId ? candidate.resourceId === original.resourceId : candidate.bounds.join(',') === original.bounds.join(',');
}

function focusedField(nodes, original) {
  const matches = nodes.filter((node) => node.focused && node.editable && node.enabled && (!original || sameField(node, original)));
  return matches.length === 1 ? matches[0] : null;
}

// No replay: a timeout or unreadable postcondition can still follow successful input.
export async function typeIntoDevice(device, mirror, { text, target, replace = false, submit = false }) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 262144 - 14) {
    throw new Error('text must be a string of at most 262130 UTF-8 bytes.');
  }
  if (typeof replace !== 'boolean' || typeof submit !== 'boolean') throw new Error('replace and submit must be booleans.');
  let nodes = await device.uiNodes();
  let field;
  if (target) {
    const result = findNode(nodes.filter((node) => node.editable && node.enabled), target);
    if (result.matches !== 1) throw new Error('Target must match exactly one enabled editable field. Inspect emulator_observe and refine the target.');
    field = result.node;
    if (!field.focused) {
      await device.tap(...field.center);
      const focusDeadline = Date.now() + 5000;
      do {
        nodes = await device.uiNodes({ timeoutMs: Math.max(1, focusDeadline - Date.now()) });
        if (focusedField(nodes, field)) break;
        await pause(100);
      } while (Date.now() < focusDeadline);
    }
  }
  field = focusedField(nodes, field);
  if (!field) throw new Error('No unique focused editable field was confirmed. Focus a text field or supply its target. No text was sent.');
  if (replace) mirror.pressKey(29, 0x1000); // Ctrl+A, ordered with paste on the same socket.
  if (text) await mirror.setClipboard(text);
  else if (replace) {
    mirror.pressKey(67); // Delete the selected text.
    await mirror.setClipboard('', { paste: false }); // Processing barrier for the preceding keys.
  }

  const result = { characters: [...text].length, replaced: replace, verified: false, submitted: false };
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    let current;
    try {
      current = focusedField(await device.uiNodes({ timeoutMs: Math.max(1, deadline - Date.now()) }), field);
    } catch {
      result.reason = 'Input was sent, but the field could not be read afterwards. Inspect before retrying.';
      break;
    }
    if (!current) {
      result.reason = 'Input was sent, but focus moved or the field disappeared. Inspect before retrying.';
      break;
    }
    if (current.password) {
      result.reason = 'Input was sent; password fields cannot be verified from the UI hierarchy.';
      break;
    }
    if (replace ? current.text === text : (!text || (current.text !== field.text && current.text.includes(text)))) {
      result.verified = true;
      break;
    }
    await pause(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  if (!result.verified) result.reason ??= 'Input was sent, but the visible text did not confirm it. The app may transform text. Inspect before retrying.';
  // Do not submit a possibly incomplete or redirected entry.
  if (submit && result.verified) {
    mirror.pressKey(66);
    result.submitted = true;
  } else if (submit) result.reason += ' Enter was not pressed because the text was not verified.';
  return result;
}
