/**
 * Feature 3: mixed-type magazine — firing & reload integration.
 *
 * When a weapon's "mixed magazine" toggle is on:
 *  - Reloading opens the MagazineLoader UI (drag ammo into slots) instead of the
 *    single-ammo dialog.
 *  - The chambered rounds live in `flags.<module>.magazineStack` (LIFO: index 0
 *    fires first). `magazine.value` mirrors the stack length.
 *  - Firing pops the next round(s) and stamps their ammo type/variety/ablation on
 *    the damage card, so armour ablation and lethality reflect the actual round.
 *  - A burst pops N rounds and uses the first (top) round's type for the card.
 *
 * We wrap: reload/load (open loader), dischargeItem (pop stack), and
 * _getLoadedAmmoProp (read from the top round) — all per-instance because the
 * system re-attaches them each prepare.
 */

import { MODULE_ID, FLAGS, getFlag } from "../constants.js";
import { registerInstanceWrapper, wrapInstanceMethod, wrapPrototype } from "../patches.js";
import MagazineLoader from "../apps/magazine-loader.js";
import { getRolls } from "../system-api.js";

let Rolls = null;

/**
 * Is the mixed-magazine mode enabled for this weapon?
 *
 * @param {Item} item
 * @returns {Boolean}
 */
export function isMixedMag(item) {
  return !!getFlag(item, FLAGS.MIXED_MAGAZINE, false);
}

/**
 * Get the ordered chambered-round stack for a weapon.
 *
 * @param {Item} item
 * @returns {Array<Object>}
 */
export function getStack(item) {
  return getFlag(item, FLAGS.MAGAZINE_STACK, []) || [];
}

/**
 * Register the mixed-magazine behaviour. Call once at ready.
 */
export async function registerMixedMagazine() {
  Rolls = await getRolls();
  const ItemClass = CONFIG.Item.documentClass;

  registerInstanceWrapper("mixed-magazine", (item) => {
    // Only mixed-magazine weapons need any of these wraps. Skipping here avoids
    // 5 closure allocations per prepareDerivedData for every normal weapon (perf).
    if (!isMixedMag(item)) return;

    // --- reload / load: open our loader when mixed mode is active ---
    wrapInstanceMethod(item, "reload", function reload(original) {
      if (isMixedMag(this)) return openLoader(this);
      return original();
    });
    wrapInstanceMethod(item, "load", function load(original) {
      if (isMixedMag(this)) return openLoader(this);
      return original();
    });

    // --- _getLoadedAmmoProp: read from the round being fired (during an attack)
    //     or the current top of the stack otherwise. Preferring the transient
    //     `_cprWaFiringRound` makes the attack card deterministic and immune to
    //     the async timing of the stack write in dischargeItem. ---
    wrapInstanceMethod(item, "_getLoadedAmmoProp", function _getLoadedAmmoProp(original, prop) {
      if (!isMixedMag(this)) return original(prop);
      const round = this._cprWaFiringRound || getStack(this)[0];
      if (!round) return original(prop);
      return foundry.utils.getProperty(topAsSystem(round), prop);
    });

    // --- dischargeItem: pop the fired rounds off the stack ---
    wrapInstanceMethod(item, "dischargeItem", function dischargeItem(original, cprRoll) {
      if (!isMixedMag(this)) return original(cprRoll);
      return dischargeMixed(this, cprRoll);
    });

    // --- hasAmmo: check against the stack length ---
    wrapInstanceMethod(item, "hasAmmo", function hasAmmo(original, cprRoll) {
      if (!isMixedMag(this)) return original(cprRoll);
      const need = this.bulletConsumption(cprRoll);
      return getStack(this).length - need >= 0;
    });
  });

  // Damage rolls must reflect the round that was JUST fired by the preceding
  // attack, not the current top of the stack. The attack's dischargeItem records
  // the fired round in `flags.<module>.lastFired`; here we stamp the damage card
  // from it. We wrap createRoll for the DAMAGE type in mixed mode.
  wrapPrototype(ItemClass, "createRoll", function createRoll(original, type, actor, extraData = []) {
    const cprRoll = original.call(this, type, actor, extraData);
    if (
      type === Rolls.rollTypes.DAMAGE &&
      isMixedMag(this) &&
      cprRoll instanceof Rolls.CPRDamageRoll
    ) {
      applyLastFiredAmmo(this, cprRoll);
    }
    return cprRoll;
  }, "mixedmag-createRoll");
}

/**
 * Overwrite a damage roll's ammo metadata with the last-fired mixed round.
 *
 * @param {Item} weapon
 * @param {CPRDamageRoll} cprRoll
 */
function applyLastFiredAmmo(weapon, cprRoll) {
  // Burst rolls manage their own (possibly substituted) ammo type — don't clobber.
  if (cprRoll.rollCardExtraArgs?.cprWaBurst) return;
  const last = getFlag(weapon, FLAGS.LAST_FIRED, null);
  const round = Array.isArray(last) ? last[0] : last;
  if (!round) return;
  cprRoll.rollCardExtraArgs.ammoType = round.type;
  cprRoll.rollCardExtraArgs.ammoVariety = round.variety;
  cprRoll.rollCardExtraArgs.ablationValue = round.ablationValue ?? 1;
}

/**
 * Present the loader and, when confirmed, the flags are already written by the
 * loader's commit step. We just return its promise.
 *
 * @param {Item} weapon
 * @returns {Promise}
 */
async function openLoader(weapon) {
  const loader = new MagazineLoader(weapon);
  await loader.wait();
}

/**
 * Represent a stored round as a fake ammo "system" object so getProperty works
 * for the props the system reads: type, variety, ablationValue, overrides.
 *
 * @param {Object} round
 * @returns {Object}
 */
function topAsSystem(round) {
  return {
    type: round.type,
    variety: round.variety,
    ablationValue: round.ablationValue ?? 1,
    // Mixed rounds do not carry per-round damage/autofire overrides; the system
    // reads overrides?.damage/?.autofire and safely treats "none"/undefined.
    overrides: round.overrides ?? undefined,
  };
}

/**
 * Pop the fired rounds off the mixed stack and sync magazine.value.
 *
 * @param {Item} weapon
 * @param {CPRRoll} cprRoll
 * @returns {Promise}
 */
async function dischargeMixed(weapon, cprRoll) {
  const need = weapon.bulletConsumption(cprRoll);
  const stack = foundry.utils.duplicate(getStack(weapon));
  const fired = stack.splice(0, Math.min(need, stack.length));

  // Set the transient "firing round" synchronously so the system's subsequent
  // (non-awaited) _getLoadedAmmoProp("type") read stamps the ATTACK card with the
  // round we just fired, deterministically, regardless of the async update below.
  const firedTop = fired[0];
  if (firedTop) {
    weapon._cprWaFiringRound = firedTop;
    if (cprRoll?.rollCardExtraArgs) cprRoll.rollCardExtraArgs.ammoType = firedTop.type;
  }

  // Persist the new stack, sync the count, and remember the fired rounds so the
  // subsequent damage roll can stamp the correct ammo type on its card.
  await weapon.update({
    [`flags.${MODULE_ID}.${FLAGS.MAGAZINE_STACK}`]: stack,
    [`flags.${MODULE_ID}.${FLAGS.LAST_FIRED}`]: fired,
    "system.magazine.value": stack.length,
  });

  // Clear the transient marker after the roll pipeline has read it.
  delete weapon._cprWaFiringRound;
  return fired;
}
