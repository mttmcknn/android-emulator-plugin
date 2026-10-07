// Stable diagnostics use fixed public copy. Never put arbitrary exception text or tool input into UI metadata.
const MESSAGES = {
  AE_HELPER_START: 'The emulator helper did not start. Check daemon.log in the plugin state directory.',
  AE_HELPER_CONNECT: 'The emulator helper connection failed. Check the device before retrying; the action may have completed.',
  AE_THREAD_REQUIRED: 'The host did not supply a chat identity. Open Android Emulator from the chat you want to use.',
  AE_RESOURCE_LOAD: 'The emulator panel files could not be read. Reinstall the plugin and reopen the panel.',
  AE_ACTION_FAILED: 'The device action failed. Inspect the device and the tool result before trying again.',
};

export function diagnosticError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { diagnosticCode: code });
}

export function errorDetails(error) {
  const code = Object.hasOwn(MESSAGES, error.diagnosticCode) ? error.diagnosticCode : 'AE_ACTION_FAILED';
  return { code, message: MESSAGES[code] };
}
