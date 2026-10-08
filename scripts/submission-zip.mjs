import assert from 'node:assert/strict';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Stored ZIP entries and a fixed DOS epoch keep bytes independent of local
// timestamps, timezone and compressor/library version. No shell ZIP tool needed.
export function createZip(entries) {
  const locals = []; const central = []; let offset = 0;
  const names = new Set();
  for (const entry of [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    assert(!names.has(entry.name), `Duplicate ZIP path: ${entry.name}`); names.add(entry.name);
    assert(!entry.name.startsWith('/') && !entry.name.includes('\\') && !entry.name.split('/').some(p => !p || p === '.' || p === '..'), `Unsafe ZIP path: ${entry.name}`);
    const name = Buffer.from(entry.name, 'utf8'); const bytes = entry.bytes;
    assert(name.length <= 0xffff && bytes.length <= 0xffffffff);
    const crc = crc32(bytes); const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.executable ? 0o100755 : 0o100644) * 0x10000) >>> 0, 38);
    directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += local.length + name.length + bytes.length;
  }
  assert(entries.length <= 0xffff && offset <= 0xffffffff);
  const centralBytes = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

export function inspectZip(zip) {
  assert(Buffer.isBuffer(zip) && zip.length >= 22, 'Missing ZIP end record');
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 4), 0, 'Split ZIP archives are unsupported');
  assert.equal(zip.readUInt16LE(end + 6), 0, 'Split ZIP archives are unsupported');
  assert.equal(zip.readUInt16LE(end + 20), 0);
  const count = zip.readUInt16LE(end + 10); let position = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt16LE(end + 8), count, 'ZIP entry count mismatch');
  const centralStart = position; const centralEnd = position + zip.readUInt32LE(end + 12);
  assert.equal(centralEnd, end, 'ZIP central directory boundary mismatch');
  const within = (offset, length, boundary, description) => {
    assert(Number.isInteger(offset) && offset >= 0 && offset <= boundary && length <= boundary - offset, description);
  };
  const files = new Map(); const localRanges = [];
  for (let i = 0; i < count; i++) {
    within(position, 46, centralEnd, 'Truncated ZIP central header');
    assert.equal(zip.readUInt32LE(position), 0x02014b50);
    assert.equal(zip.readUInt16LE(position + 8), 0x800, 'Expected only UTF-8 ZIP flags');
    assert.equal(zip.readUInt16LE(position + 10), 0, 'Expected stored entries');
    const size = zip.readUInt32LE(position + 24); const nameSize = zip.readUInt16LE(position + 28);
    assert.equal(zip.readUInt32LE(position + 20), size, 'Stored central size mismatch');
    assert.equal(zip.readUInt16LE(position + 34), 0, 'Split ZIP archives are unsupported');
    const extra = zip.readUInt16LE(position + 30); const comment = zip.readUInt16LE(position + 32);
    const recordSize = 46 + nameSize + extra + comment;
    within(position, recordSize, centralEnd, 'Truncated ZIP central entry');
    const nameBytes = zip.subarray(position + 46, position + 46 + nameSize); const name = nameBytes.toString('utf8');
    assert(Buffer.from(name, 'utf8').equals(nameBytes), 'Invalid UTF-8 ZIP path');
    assert(!files.has(name), `Duplicate central entry: ${name}`);
    const local = zip.readUInt32LE(position + 42);
    within(local, 30, centralStart, 'ZIP local header outside data region');
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt16LE(local + 6), 0x800, 'Expected only UTF-8 ZIP flags');
    assert.equal(zip.readUInt16LE(local + 8), 0, 'Expected stored entries');
    assert.equal(zip.readUInt32LE(local + 14), zip.readUInt32LE(position + 16), 'Local ZIP CRC mismatch');
    assert.equal(zip.readUInt32LE(local + 18), size, 'Stored local compressed size mismatch');
    assert.equal(zip.readUInt32LE(local + 22), size, 'Stored local uncompressed size mismatch');
    const localName = zip.readUInt16LE(local + 26); const localExtra = zip.readUInt16LE(local + 28);
    within(local, 30 + localName + localExtra, centralStart, 'Truncated ZIP local entry');
    assert(zip.subarray(local + 30, local + 30 + localName).equals(nameBytes), 'Local ZIP path mismatch');
    const start = local + 30 + localName + localExtra;
    within(start, size, centralStart, 'ZIP payload outside data region');
    const bytes = zip.subarray(start, start + size);
    assert.equal(bytes.length, size); assert.equal(crc32(bytes), zip.readUInt32LE(position + 16));
    files.set(name, { bytes, mode: zip.readUInt32LE(position + 38) >>> 16 });
    localRanges.push({ start: local, end: start + size });
    position += recordSize;
  }
  assert.equal(position, centralEnd);
  let localEnd = 0;
  for (const range of localRanges.sort((a, b) => a.start - b.start)) {
    assert.equal(range.start, localEnd, 'Overlapping or unreferenced ZIP local data');
    localEnd = range.end;
  }
  assert.equal(localEnd, centralStart, 'Unreferenced ZIP local data');
  return files;
}
