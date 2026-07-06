/**
 * Thin accessor for the Cyberpunk RED CORE system internals we need.
 *
 * The system does not expose its roll classes or config on a global, but it is
 * an ES module we can import by path. We import lazily (on first use, after the
 * system has loaded) and cache the result. Using the system's OWN class objects
 * is important: our `instanceof` checks must match the classes the system builds.
 */

import { CPR_SYSTEM_ID } from "./constants.js";

const base = `/systems/${CPR_SYSTEM_ID}/modules`;

let _rolls = null;
let _config = null;
let _systemUtils = null;
let _chat = null;
let _diwakoUtils = null;

/**
 * The system's roll module (CPRAttackRoll, CPRDamageRoll, rollTypes, ...).
 *
 * @returns {Promise<Object>}
 */
export async function getRolls() {
  if (!_rolls) {
    _rolls = await import(`${base}/rolls/cpr-rolls.js`);
  }
  return _rolls;
}

/**
 * The system's config object (ammoTypes, weaponTypes, ...).
 *
 * @returns {Promise<Object>}
 */
export async function getCPRConfig() {
  if (!_config) {
    const mod = await import(`${base}/system/config.js`);
    _config = mod.default;
  }
  return _config;
}

/**
 * The system's SystemUtils static helper class.
 *
 * @returns {Promise<Object>}
 */
export async function getSystemUtils() {
  if (!_systemUtils) {
    const mod = await import(`${base}/utils/cpr-systemUtils.js`);
    _systemUtils = mod.default;
  }
  return _systemUtils;
}

/**
 * The system's CPRChat static helper class.
 *
 * @returns {Promise<Object>}
 */
export async function getCPRChat() {
  if (!_chat) {
    const mod = await import(`${base}/chat/cpr-chat.js`);
    _chat = mod.default;
  }
  return _chat;
}

/**
 * Is the diwako-cpred-additions module installed and active?
 *
 * @returns {Boolean}
 */
export function isDiwakoActive() {
  return game.modules.get("diwako-cpred-additions")?.active === true;
}

/**
 * diwako-cpred-additions' Utils class (getDV / getDistance). Returns null if the
 * module isn't active or its internals can't be imported.
 *
 * @returns {Promise<Object|null>}
 */
export async function getDiwakoUtils() {
  if (!isDiwakoActive()) return null;
  if (!_diwakoUtils) {
    try {
      const mod = await import("/modules/diwako-cpred-additions/scripts/utils.js");
      _diwakoUtils = mod.Utils;
    } catch (e) {
      return null;
    }
  }
  return _diwakoUtils;
}
