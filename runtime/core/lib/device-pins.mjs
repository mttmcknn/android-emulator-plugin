import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// A pin is a device session, independent of its owning chat. Every operation and
// stream uses the pin ID, so concurrent devices never share mutable input state.
export class DevicePins {
  constructor({ dir, leases }) {
    this.file = path.join(dir, 'pins.json');
    this.leases = leases;
    this.requests = new Map();
    this.starts = new Map();
    try { this.owners = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(this.file, 'utf8')).owners); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.owners = Object.create(null); }
    // Preserve running devices and created AVDs from the single-device format.
    for (const id of [...Object.keys(leases.leases), ...Object.values(leases.createdAvds ?? {}).map(v => v.threadId)]) {
      this.owners[id] ??= id;
    }
    this.save();
  }

  save() {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ owners: this.owners }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  owner(id) { return this.owners[id] ?? id; }
  ids(threadId) { return Object.keys(this.owners).filter(id => this.owners[id] === threadId && this.leases.get(id)); }
  allIds(threadId) { return Object.keys(this.owners).filter(id => this.owners[id] === threadId); }
  allocate(threadId) {
    const id = !Object.hasOwn(this.owners, threadId) ? threadId : crypto.randomUUID();
    this.owners[id] = threadId;
    this.save();
    return id;
  }

  resolve(threadId, deviceId, { allowEmpty = false } = {}) {
    if (deviceId !== undefined) {
      if (typeof deviceId !== 'string' || this.owners[deviceId] !== threadId || !this.leases.get(deviceId)) throw new Error('That device is not pinned to this chat. Refresh the device list.');
      return deviceId;
    }
    const ids = this.ids(threadId);
    if (ids.length > 1) throw new Error('This chat has multiple pinned devices. List devices, then pass deviceId to choose the target.');
    if (ids.length) return ids[0];
    if (!allowEmpty) throw new Error('No device is pinned to this chat. Start an emulator or pin a connected device first.');
    // A root without a device remains usable for diagnostics, captures and setup.
    if (this.owner(threadId) !== threadId) throw new Error('Choose a device pinned to this chat.');
    return threadId;
  }

  async start(threadId, options = {}) {
    const previous = this.starts.get(threadId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.startOne(threadId, options));
    this.starts.set(threadId, pending);
    try { return await pending; }
    finally { if (this.starts.get(threadId) === pending) this.starts.delete(threadId); }
  }

  async startOne(threadId, options) {
    let id;
    if (options.deviceId !== undefined) {
      id = this.resolve(threadId, options.deviceId);
      if (this.leases.get(id).kind === 'physical') throw new Error('That pin is a connected phone. Use its device controls or start a new emulator.');
    }
    else if (!options.newInstance) {
      const matches = this.ids(threadId).filter(id => this.leases.get(id).kind !== 'physical' && (!options.avd || this.leases.get(id).avd === options.avd));
      if (matches.length > 1) throw new Error('Several emulators match. Pass deviceId or newInstance: true.');
      id = matches[0];
    }
    id ??= this.allocate(threadId);
    const lease = await this.leases.start(id, options);
    return { id, lease };
  }

  findConnected(device) {
    return Object.entries(this.leases.leases).find(([, lease]) => lease.kind === 'physical' &&
      (lease.serial === device.serial || (device.hardwareId && lease.hardwareId === device.hardwareId)))?.[0];
  }

  async pin(threadId, device) {
    if (device.state !== 'device') throw new Error(device.state === 'unauthorized' ? 'Unlock the device and allow USB debugging, then refresh.' : 'The device is unavailable. Reconnect it, then refresh.');
    const existing = this.findConnected(device);
    if (existing && this.owner(existing) !== threadId) {
      for (const [key, value] of this.requests) if (value.id === existing && value.to === threadId) this.requests.delete(key);
      const requestId = crypto.randomUUID();
      this.requests.set(requestId, { id: existing, from: this.owner(existing), to: threadId, serial: device.serial, hardwareId: device.hardwareId, expires: Date.now() + 120_000 });
      for (const [key, value] of this.requests) if (value.expires < Date.now()) this.requests.delete(key);
      return { confirmationRequired: { requestId, id: existing, label: device.label, ownerThreadId: this.owner(existing) } };
    }
    if (existing) {
      if (this.leases.get(existing).serial !== device.serial) throw new Error('This phone is already pinned through another connection. Unpin it before changing its connection.');
      return { id: existing, lease: this.leases.get(existing) };
    }
    const id = this.allocate(threadId);
    const lease = this.leases.attach(id, device);
    return { id, lease };
  }

  transfer(threadId, requestId, device) {
    const request = this.requests.get(requestId);
    this.requests.delete(requestId);
    if (!request || request.to !== threadId || request.expires < Date.now() || this.owner(request.id) !== request.from || !this.leases.get(request.id)) throw new Error('This move request expired or the device owner changed. Select the device again.');
    if (!device || device.state !== 'device' || device.serial !== request.serial || device.hardwareId !== request.hardwareId) throw new Error('The device connection changed. Refresh and select it again.');
    // A new session keeps the old chat's captures, navigation, and channel keys
    // private. Never reuse another chat's operation/stream identity.
    const id = this.allocate(threadId);
    this.leases.remove(request.id);
    return { id, from: request.from, lease: this.leases.attach(id, device) };
  }
}
