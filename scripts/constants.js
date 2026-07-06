/**
 * Shared constants and small helpers used across the module.
 */

export const MODULE_ID = "cyberpunk-red-weapon-additions";

// The Cyberpunk RED CORE system id. Everything we patch lives under this system.
export const CPR_SYSTEM_ID = "cyberpunk-red-core";

/**
 * Flag keys we store on weapon items. All live under
 * `item.flags[MODULE_ID].<key>` so we never touch the system datamodel.
 */
export const FLAGS = {
  AUTOFIRE_AMMO_COST: "autofireAmmoCost",
  BURST_MULTIPLIER: "burstMultiplier",
  BURST_DAMAGE_FORMULA: "burstDamageFormula",
  BURST_AMMO_TYPE: "burstAmmoType",
  MIXED_MAGAZINE: "mixedMagazine",
  // Ordered list of chambered rounds when a mixed magazine is in use.
  // LIFO: index 0 is fired first (top of the stack).
  MAGAZINE_STACK: "magazineStack",
  // The round(s) fired by the most recent attack, used to stamp the damage card.
  LAST_FIRED: "lastFired",
};

// Fire-mode value we add alongside the system's aimed/autofire/suppressive.
export const BURST_FIRE_MODE = "burst";

/**
 * Read a module flag off any Document, returning a default when unset.
 *
 * @param {Document} doc
 * @param {String} key - one of FLAGS
 * @param {*} fallback
 * @returns {*}
 */
export function getFlag(doc, key, fallback = undefined) {
  const value = doc?.getFlag?.(MODULE_ID, key);
  return value === undefined || value === null ? fallback : value;
}

/**
 * Persist a module flag on a Document.
 *
 * @param {Document} doc
 * @param {String} key
 * @param {*} value
 * @returns {Promise}
 */
export function setFlag(doc, key, value) {
  return doc.setFlag(MODULE_ID, key, value);
}

/**
 * Localize helper that prefixes our namespace.
 *
 * @param {String} key - key relative to "CPR-WA."
 * @param {Object} data - interpolation data
 * @returns {String}
 */
export function L(key, data) {
  const full = `CPR-WA.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

/**
 * Convenience: is this item a weapon we care about (real weapon item)?
 *
 * @param {Item} item
 * @returns {Boolean}
 */
export function isWeapon(item) {
  return item?.type === "weapon";
}
