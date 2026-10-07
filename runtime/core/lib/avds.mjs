// Create, delete, and describe Android Virtual Devices without avdmanager.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sdk } from './sdk.mjs';

// Hardware profiles from the Android SDK device catalog (sdklib nexus.xml and devices.xml).
export const PROFILES = [
  ['pixel_10', 'Pixel 10', 1080, 2424, 420],
  ['pixel_10_pro', 'Pixel 10 Pro', 1280, 2856, 480],
  ['pixel_10_pro_xl', 'Pixel 10 Pro XL', 1344, 2992, 480],
  ['pixel_10_pro_fold', 'Pixel 10 Pro Fold', 2076, 2152, 390],
  ['pixel_10a', 'Pixel 10a', 1080, 2424, 420],
  ['pixel_9', 'Pixel 9', 1080, 2424, 420],
  ['pixel_9_pro', 'Pixel 9 Pro', 1280, 2856, 480],
  ['pixel_9_pro_xl', 'Pixel 9 Pro XL', 1344, 2992, 480],
  ['pixel_9_pro_fold', 'Pixel 9 Pro Fold', 2076, 2152, 390],
  ['pixel_9a', 'Pixel 9a', 1080, 2424, 420],
  ['pixel_8', 'Pixel 8', 1080, 2400, 420],
  ['pixel_8a', 'Pixel 8a', 1080, 2400, 420],
  ['pixel_7', 'Pixel 7', 1080, 2400, 420],
  ['pixel_tablet', 'Pixel Tablet', 2560, 1600, 320],
  ['medium_phone', 'Medium Phone', 1080, 2400, 420],
  ['small_phone', 'Small Phone', 720, 1280, 320],
  ['medium_tablet', 'Medium Tablet', 2560, 1600, 320],
].map(([id, name, width, height, density]) => ({
  id,
  name,
  width,
  height,
  density,
  form: id.includes('tablet') ? 'tablet' : id.includes('fold') ? 'foldable' : 'phone',
}));

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function avdHome() {
  if (process.env.ANDROID_AVD_HOME) return process.env.ANDROID_AVD_HOME;
  return path.join(process.env.ANDROID_USER_HOME ?? path.join(os.homedir(), '.android'), 'avd');
}

export function parseProperties(text) {
  const props = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (match) props[match[1]] = match[2];
  }
  return props;
}

function hostAbi() {
  return process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

// Installed system images for this host's CPU, newest API first.
export function systemImages(root = sdk().root) {
  const base = path.join(root, 'system-images');
  const images = [];
  for (const platform of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    for (const tag of fs.readdirSync(path.join(base, platform), { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const abiDir = path.join(base, platform, tag.name, hostAbi());
      const propsFile = path.join(abiDir, 'source.properties');
      if (!fs.existsSync(propsFile)) continue;
      const props = parseProperties(fs.readFileSync(propsFile, 'utf8'));
      const tags = (props['SystemImage.TagId'] ?? tag.name).split(',');
      const labels = (props['SystemImage.TagDisplay'] ?? tag.name).split(',');
      const api = props['AndroidVersion.ApiLevel'] ?? platform.replace(/^android-/, '');
      images.push({
        id: `${platform}/${tag.name}/${hostAbi()}`,
        api,
        platform,
        tags,
        tagLabels: labels,
        label: `Android ${api} · ${labels.join(' · ')}`,
      });
    }
  }
  return images.sort((a, b) => Number.parseFloat(b.api) - Number.parseFloat(a.api));
}

export function defaultImage(images, profile) {
  const suited = images.filter((image) => (profile.form === 'tablet') === image.tags.includes('tablet'));
  return suited.find((image) => image.tags.includes('google_apis_playstore')) ?? suited[0] ?? images[0] ?? null;
}

function uniqueName(base, existing) {
  let name = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const taken = new Set(existing);
  if (!taken.has(name)) return name;
  for (let n = 2; ; n += 1) if (!taken.has(`${name}_${n}`)) return `${name}_${n}`;
}

function avdPaths(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new Error(`Invalid AVD name "${name}". Use letters, digits, ".", "_", or "-".`);
  const home = avdHome();
  return { home, ini: path.join(home, `${name}.ini`), dir: path.join(home, `${name}.avd`) };
}

// Read the configured hardware, including AVDs stored outside the default directory.
export function avdPostures(name) {
  const { ini, dir } = avdPaths(name);
  try {
    const location = parseProperties(fs.readFileSync(ini, 'utf8')).path ?? dir;
    const props = parseProperties(fs.readFileSync(path.join(location, 'config.ini'), 'utf8'));
    if (props['hw.sensor.hinge'] !== 'yes') return [];
    const names = { 1: 'folded', 2: 'half-folded', 3: 'unfolded' };
    return [...new Set((props['hw.sensor.posture_list'] ?? '').split(',').map((id) => names[id.trim()]).filter(Boolean))];
  } catch {
    return [];
  }
}

export function createAvd({ profileId, imageId, name, existingNames }) {
  const profile = PROFILES.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`Unknown device profile "${profileId}". Use one of: ${PROFILES.map(({ id }) => id).join(', ')}.`);
  const images = systemImages();
  const image = imageId ? images.find((candidate) => candidate.id === imageId) : defaultImage(images, profile);
  if (!image) {
    throw new Error(
      imageId
        ? `System image "${imageId}" is not installed. Installed: ${images.map(({ id }) => id).join(', ') || 'none'}.`
        : `No ${hostAbi()} system images are installed. Install one with Android Studio's SDK Manager or sdkmanager "system-images;android-36;google_apis_playstore;${hostAbi()}".`,
    );
  }
  const avdName = name ? name : uniqueName(`${profile.name} API ${image.api}`, existingNames);
  const { home, ini, dir } = avdPaths(avdName);
  if (fs.existsSync(ini) || fs.existsSync(dir)) throw new Error(`An AVD named ${avdName} already exists.`);

  const skinDir = path.join(sdk().root, 'skins', profile.id);
  const skin = fs.existsSync(skinDir)
    ? { 'skin.name': profile.id, 'skin.path': skinDir, 'skin.dynamic': 'yes', showDeviceFrame: 'yes' }
    : { 'skin.name': `${profile.width}x${profile.height}`, 'skin.dynamic': 'no', showDeviceFrame: 'no' };
  const config = {
    AvdId: avdName,
    'PlayStore.enabled': String(image.tags.includes('google_apis_playstore')),
    'abi.type': hostAbi(),
    'avd.ini.displayname': avdName.replaceAll('_', ' '),
    'avd.ini.encoding': 'UTF-8',
    'disk.dataPartition.size': '6G',
    'fastboot.forceColdBoot': 'no',
    'fastboot.forceFastBoot': 'yes',
    'hw.accelerometer': 'yes',
    'hw.audioInput': 'yes',
    'hw.battery': 'yes',
    'hw.camera.back': 'virtualscene',
    'hw.camera.front': 'emulated',
    'hw.cpu.arch': hostAbi() === 'arm64-v8a' ? 'arm64' : 'x86_64',
    'hw.cpu.ncore': '4',
    'hw.device.manufacturer': 'Google',
    'hw.device.name': profile.id,
    'hw.gps': 'yes',
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': 'auto',
    'hw.gyroscope': 'yes',
    'hw.initialOrientation': profile.width > profile.height ? 'landscape' : 'portrait',
    'hw.keyboard': 'yes',
    'hw.lcd.density': String(profile.density),
    'hw.lcd.height': String(profile.height),
    'hw.lcd.width': String(profile.width),
    'hw.mainKeys': 'no',
    'hw.ramSize': profile.form === 'phone' ? '2048' : '4096',
    'hw.sdCard': 'yes',
    'hw.sensors.light': 'yes',
    'hw.sensors.magnetic_field': 'yes',
    'hw.sensors.orientation': 'yes',
    'hw.sensors.pressure': 'yes',
    'hw.sensors.proximity': 'yes',
    'image.sysdir.1': `system-images/${image.id}/`,
    'runtime.network.latency': 'none',
    'runtime.network.speed': 'full',
    'sdcard.size': '512M',
    ...(profile.form === 'foldable' ? {
      'hw.sensor.hinge': 'yes',
      'hw.sensor.hinge.count': '1',
      'hw.sensor.hinge.type': '1',
      'hw.sensor.hinge.sub_type': '1',
      'hw.sensor.hinge.areas': `${profile.width / 2}-0-0-${profile.height}`,
      'hw.sensor.hinge.ranges': '0-180',
      'hw.sensor.hinge.defaults': '180',
      'hw.sensor.posture_list': '1, 2, 3',
      'hw.sensor.hinge_angles_posture_definitions': '0-30, 30-150, 150-180',
      'hw.displayRegion.0.1.width': '1080',
      'hw.displayRegion.0.1.height': profile.id === 'pixel_10_pro_fold' ? '2364' : '2424',
      'hw.displayRegion.0.1.xOffset': '0',
      'hw.displayRegion.0.1.yOffset': '0',
    } : {}),
    ...skin,
    'tag.display': image.tagLabels[0],
    'tag.displaynames': image.tagLabels.join(','),
    'tag.id': image.tags[0],
    'tag.ids': image.tags.join(','),
    target: image.platform,
    'vm.heapSize': '228',
  };
  const serialize = (props) => `${Object.entries(props).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.ini'), serialize(config));
  fs.writeFileSync(ini, serialize({ 'avd.ini.encoding': 'UTF-8', path: dir, 'path.rel': `avd/${avdName}.avd`, target: image.platform }));
  return { name: avdName, profile: profile.name, image: image.label, home };
}

// Callers must confirm deletion and check that no instance is using this AVD.
export function deleteAvd(name) {
  const { ini, dir } = avdPaths(name);
  if (!fs.existsSync(ini) && !fs.existsSync(dir)) return;
  if (!fs.existsSync(ini) || !fs.lstatSync(ini).isFile()) throw new Error('The device definition is missing or is not a regular file. Remove it through Android Studio.');
  const location = parseProperties(fs.readFileSync(ini, 'utf8')).path ?? dir;
  // Studio supports custom storage locations. Only remove an identifiable AVD
  // directory, never an arbitrary directory referenced by a malformed definition.
  if (!path.isAbsolute(location) || !location.endsWith('.avd')) throw new Error('The device has an unsupported storage location. Remove it through Android Studio.');
  if (fs.existsSync(location)) {
    if (!fs.lstatSync(location).isDirectory()) throw new Error('The device data directory is a symbolic link or special file. Remove it through Android Studio.');
    const config = path.join(location, 'config.ini');
    if (!fs.existsSync(config) || !fs.lstatSync(config).isFile() || parseProperties(fs.readFileSync(config, 'utf8')).AvdId !== name) {
      throw new Error('The device data does not match its definition. Remove it through Android Studio.');
    }
    const canonical = fs.realpathSync(location);
    for (const other of fs.readdirSync(path.dirname(ini)).filter(file => file.endsWith('.ini') && file !== path.basename(ini))) {
      const definition = path.join(path.dirname(ini), other);
      const otherPath = parseProperties(fs.readFileSync(definition, 'utf8')).path;
      if (otherPath && fs.existsSync(otherPath) && fs.realpathSync(otherPath) === canonical) throw new Error('Another device shares this data directory. Remove it through Android Studio.');
    }
    fs.rmSync(location, { recursive: true });
  }
  fs.rmSync(ini, { force: true });
}

// Bytes an AVD uses on disk (its data directory). Symlinks are excluded so an
// AVD cannot make the manager scan data outside its directory.
export async function avdDiskBytes(name) {
  const { ini, dir } = avdPaths(name);
  const missing = (error) => error?.code === 'ENOENT';
  const lstat = async (target) => {
    try {
      return await fs.promises.lstat(target);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  };
  const iniText = await fs.promises.readFile(ini, 'utf8').catch((error) => {
    if (missing(error)) return null;
    throw error;
  });
  const location = iniText ? parseProperties(iniText).path : null;
  const configured = location ? await lstat(location) : null;
  const root = configured?.isDirectory() ? location : dir;

  const walk = async (current) => {
    const currentStat = await lstat(current);
    if (!currentStat?.isDirectory()) return 0;

    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return 0;
      throw error;
    }

    let total = 0;
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) total += await walk(full);
      else if (entry.isFile()) {
        const stat = await lstat(full);
        if (stat?.isFile()) total += stat.blocks * 512;
      }
    }
    return total;
  };

  return walk(root);
}
