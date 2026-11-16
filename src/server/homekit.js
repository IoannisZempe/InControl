import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  Accessory,
  Bridge,
  Categories,
  Characteristic,
  HAPStorage,
  Service,
  uuid,
} from 'hap-nodejs';
import { buildActionPayload, pickTargetAgent } from './voice.js';

const INVALID_HAP_PINS = new Set([
  '000-00-000',
  '111-11-111',
  '222-22-222',
  '333-33-333',
  '444-44-444',
  '555-55-555',
  '666-66-666',
  '777-77-777',
  '888-88-888',
  '999-99-999',
  '123-45-678',
  '876-54-321',
]);

function getHomeKitDir() {
  return process.env.INCONTROL_HOME || path.join(os.homedir(), '.incontrol');
}

function getCredentialsPath() {
  return path.join(getHomeKitDir(), 'homekit.json');
}

function generateHomeKitCredentials() {
  // Valid unicast locally-administered MAC address (bit 1 set, bit 0 clear in first byte)
  const macBytes = crypto.randomBytes(6);
  macBytes[0] = (macBytes[0] & 0xfc) | 0x02;
  const username = Array.from(macBytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');

  let pincode = '000-00-000';
  while (INVALID_HAP_PINS.has(pincode)) {
    const n = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
    pincode = `${n.slice(0, 3)}-${n.slice(3, 5)}-${n.slice(5, 8)}`;
  }

  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const setupId = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');

  return { username, pincode, setupId };
}

function loadOrCreateHomeKitCredentials({ reset = false } = {}) {
  const filePath = getCredentialsPath();
  if (!reset) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed.username && parsed.pincode && parsed.setupId) {
        return parsed;
      }
    } catch {}
  }

  const creds = generateHomeKitCredentials();
  try {
    fs.mkdirSync(getHomeKitDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  } catch {}
  return creds;
}

/**
 * Builds an AccessoryInformation helper for the bridge and each bridged accessory.
 */
function configureAccessoryInfo(acc, model, serial) {
  acc
    .getService(Service.AccessoryInformation)
    ?.setCharacteristic(Characteristic.Manufacturer, 'InControl')
    .setCharacteristic(Characteristic.Model, model)
    .setCharacteristic(Characteristic.SerialNumber, serial);
}

/**
 * Local Apple HomeKit (HAP) bridge exposing two separate accessories/tiles:
 *  - "Agent Needs Input" MotionSensor (lights up Home / HomeView notifications when an agent waits)
 *  - "Approve Waiting Agent" Switch (momentary switch to approve the oldest waiting agent via Home/Siri)
 */
export function createHomeKitBridge(store, { getSettings, advertise = true } = {}) {
  const persistDir = path.join(getHomeKitDir(), 'homekit-persist');
  fs.mkdirSync(persistDir, { recursive: true, mode: 0o700 });
  try {
    HAPStorage.setCustomStoragePath(persistDir);
  } catch {
    // hap-nodejs throws if storage path was already initialized earlier in the same process
  }

  let creds = loadOrCreateHomeKitCredentials();
  let bridge = null;
  let motionService = null;
  let approveSwitch = null;
  let approveActive = false;
  let approveResetTimer = null;
  let running = false;
  let lastError = null;
  let setupUri = null;
  let setupQrSvg = '';

  const onStoreChange = () => syncCharacteristics();

  function syncCharacteristics() {
    if (!motionService || !running) return;
    const counts = store.getSummaryCounts();
    motionService.updateCharacteristic(Characteristic.MotionDetected, counts.needs_input > 0);
    motionService.updateCharacteristic(Characteristic.StatusActive, true);
  }

  async function start() {
    if (running) return getStatus();
    lastError = null;
    try {
      creds = loadOrCreateHomeKitCredentials();
      const serialBase = creds.username.replace(/:/g, '');

      bridge = new Bridge('InControl Agents', uuid.generate(`incontrol:hk:bridge:${creds.username}`));
      bridge.username = creds.username;
      bridge.pincode = creds.pincode;
      bridge.category = Categories.BRIDGE;
      configureAccessoryInfo(bridge, 'Mission Control Bridge', serialBase);

      // 1. Bridged Accessory: Motion sensor triggers Apple Home notifications when an agent waits
      const waitingSensorAcc = new Accessory(
        'Agent Needs Input',
        uuid.generate(`incontrol:hk:waiting:${creds.username}`)
      );
      waitingSensorAcc.category = Categories.SENSOR;
      configureAccessoryInfo(waitingSensorAcc, 'Waiting Agent Sensor', `${serialBase}-WAIT`);
      motionService = waitingSensorAcc.addService(Service.MotionSensor, 'Agent Needs Input');
      motionService
        .getCharacteristic(Characteristic.MotionDetected)
        .onGet(() => store.getSummaryCounts().needs_input > 0);
      motionService.getCharacteristic(Characteristic.StatusActive).onGet(() => true);
      bridge.addBridgedAccessory(waitingSensorAcc);

      // 2. Bridged Accessory: Momentary switch gets its own tile & Siri name to approve oldest waiting agent
      const approveSwitchAcc = new Accessory(
        'Approve Waiting Agent',
        uuid.generate(`incontrol:hk:approve:${creds.username}`)
      );
      approveSwitchAcc.category = Categories.SWITCH;
      configureAccessoryInfo(approveSwitchAcc, 'Approve Switch', `${serialBase}-APPR`);
      approveSwitch = approveSwitchAcc.addService(Service.Switch, 'Approve Waiting Agent');
      approveSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => approveActive)
        .onSet((value) => {
          if (!value) {
            approveActive = false;
            return;
          }
          const settings = getSettings ? getSettings() : {};
          if (settings.allowHomekitApproval === false) {
            approveActive = false;
            approveResetTimer = setTimeout(
              () => approveSwitch?.updateCharacteristic(Characteristic.On, false),
              150
            );
            approveResetTimer.unref?.();
            return;
          }
          const waiting = pickTargetAgent(store, { preferWaiting: true });
          if (waiting) {
            const payload = buildActionPayload(waiting, 'approve', '', 'Apple HomeKit');
            store.respondToAgent(waiting.id, payload);
          }
          approveActive = true;
          clearTimeout(approveResetTimer);
          approveResetTimer = setTimeout(() => {
            approveActive = false;
            approveSwitch?.updateCharacteristic(Characteristic.On, false);
          }, 700);
          approveResetTimer.unref?.();
        });
      bridge.addBridgedAccessory(approveSwitchAcc);

      await bridge.publish({
        username: creds.username,
        pincode: creds.pincode,
        category: Categories.BRIDGE,
        setupID: creds.setupId,
        advertiser: advertise ? 'ciao' : undefined,
      });

      setupUri = bridge.setupURI();
      setupQrSvg = await QRCode.toString(setupUri, {
        type: 'svg',
        margin: 1,
        color: { dark: '#f8fafc', light: '#00000000' },
      });

      running = true;
      store.on('change', onStoreChange);
      syncCharacteristics();
    } catch (err) {
      lastError = err?.message || 'Failed to start HomeKit bridge';
      running = false;
    }
    return getStatus();
  }

  async function stop({ destroyPairing = false } = {}) {
    store.off('change', onStoreChange);
    clearTimeout(approveResetTimer);
    approveActive = false;
    if (bridge) {
      try {
        if (destroyPairing) {
          await bridge.destroy();
        } else {
          await bridge.unpublish();
        }
      } catch {}
      bridge = null;
      motionService = null;
      approveSwitch = null;
    }
    running = false;
  }

  async function resetPairing() {
    await stop({ destroyPairing: true });
    creds = loadOrCreateHomeKitCredentials({ reset: true });
    setupUri = null;
    setupQrSvg = '';
    const settings = getSettings ? getSettings() : {};
    if (settings.homekitEnabled) {
      return start();
    }
    return getStatus();
  }

  function isPaired() {
    if (!bridge?._accessoryInfo) return false;
    try {
      return Boolean(bridge._accessoryInfo.paired());
    } catch {
      return false;
    }
  }

  function getStatus() {
    const settings = getSettings ? getSettings() : {};
    return {
      enabled: Boolean(settings.homekitEnabled),
      allowApproval: settings.allowHomekitApproval !== false,
      running,
      paired: isPaired(),
      accessoryName: 'InControl Agents',
      pincode: creds.pincode,
      setupUri,
      setupQrSvg,
      waitingCount: store.getSummaryCounts().needs_input,
      error: lastError,
    };
  }

  return {
    start,
    stop,
    resetPairing,
    syncCharacteristics,
    getStatus,
    getBridge: () => bridge,
  };
}
