/**
 * Feature 1: configurable autofire / suppressive ammo cost.
 *
 * The system hardcodes a 10-round cost for Autofire and Suppressive fire in
 * `bulletConsumption()`. We let each weapon override that via a flag, falling
 * back to a world-default setting (also 10 by default), so behaviour is
 * unchanged until a GM configures a weapon.
 *
 * Because `bulletConsumption` is re-attached per instance on every prepare, we
 * install this as a per-instance wrapper (see patches.js).
 */

import { FLAGS, getFlag } from "../constants.js";
import { registerInstanceWrapper, wrapInstanceMethod } from "../patches.js";
import { getRolls } from "../system-api.js";
import { SETTINGS, getSetting } from "../settings.js";

let Rolls = null;

/**
 * Wire the per-instance wrapper. Call once at ready (after roll classes load).
 */
export async function registerAutofireAmmoCost() {
  Rolls = await getRolls();

  registerInstanceWrapper("autofire-ammo-cost", (item) => {
    // Only install when this weapon actually overrides the cost, or the world
    // default differs from the system's built-in 10. Otherwise there's nothing
    // to change, so skip the per-prepare wrap entirely (perf: avoids a closure
    // allocation on every prepareDerivedData for vanilla weapons).
    const perWeapon = Number(getFlag(item, FLAGS.AUTOFIRE_AMMO_COST, 0));
    const worldDefault = Number(getSetting(SETTINGS.DEFAULT_AUTOFIRE_COST));
    if (!(perWeapon > 0) && worldDefault === 10) return;

    wrapInstanceMethod(item, "bulletConsumption", function bulletConsumption(original, cprRoll) {
      const isBurst =
        cprRoll instanceof Rolls.CPRAutofireRoll ||
        cprRoll instanceof Rolls.CPRSuppressiveFireRoll;
      if (!isBurst) {
        // Non-autofire shots keep the system's per-shot behaviour (usually 1,
        // but burst fire overrides its own consumption elsewhere).
        return original(cprRoll);
      }

      // Weapon-specific override wins; otherwise the world default.
      const perWeapon = Number(getFlag(this, FLAGS.AUTOFIRE_AMMO_COST, 0));
      if (Number.isFinite(perWeapon) && perWeapon > 0) {
        return perWeapon;
      }
      const worldDefault = Number(getSetting(SETTINGS.DEFAULT_AUTOFIRE_COST));
      return Number.isFinite(worldDefault) && worldDefault > 0 ? worldDefault : original(cprRoll);
    });
  });
}
