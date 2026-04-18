/**
 * USB HID connector — delegates to the battle-tested legacy hidManager, which
 * already handles FiiO / WalkPlay / Moondrop / KT Micro protocols.
 */
import { hidManager } from '../../hidDevice.js';

export async function connect() {
  return hidManager.connect();
}

export async function disconnect() {
  return hidManager.disconnect();
}

export function isConnected() { return hidManager.isConnected(); }
export function getDevice()   { return hidManager.getDevice();   }

export function getAvailableSlots() { return hidManager.getAvailableSlots(); }
export async function getCurrentSlot() { return hidManager.getCurrentSlot(); }

export async function push(filters, preamp, slot) {
  return hidManager.push(filters, preamp, slot);
}

export async function pull() {
  return hidManager.pull();
}
