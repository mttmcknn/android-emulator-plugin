import crypto from 'node:crypto';

export const scopedKey = (secret, scope) => crypto.createHmac('sha256', secret).update(scope).digest('hex').slice(0, 32);

export function matchesKey(supplied, expected) {
  const a = Buffer.from(String(supplied ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function assertPanelAction(thread, action) {
  if (action.startsWith('manager_') !== (thread === 'manager')) {
    throw new Error(action.startsWith('manager_') ? 'Open Android Emulators in the sidebar to manage other chats.' : 'Open an emulator in its chat to control it.');
  }
}
