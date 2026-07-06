/**
 * World/client settings for the module.
 */

import { MODULE_ID } from "./constants.js";

export const SETTINGS = {
  DEFAULT_AUTOFIRE_COST: "defaultAutofireAmmoCost",
  AOE_SIZE_TILES: "aoeSizeTiles",
  AOE_AUTO_TARGET: "aoeAutoTarget",
  DIWAKO_AOE_DV: "diwakoAoeDv",
  AUTO_LINK_INJURIES: "autoLinkCriticalInjuries",
  BURNING_MILD: "burningMildDamage",
  BURNING_STRONG: "burningStrongDamage",
  BURNING_DEADLY: "burningDeadlyDamage",
};

export function registerSettings() {
  // Fallback autofire/suppressive ammo cost when a weapon has none configured.
  // Matches the RED core rule (10) out of the box.
  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_AUTOFIRE_COST, {
    name: "CPR-WA.settings.defaultAutofireCost.name",
    hint: "CPR-WA.settings.defaultAutofireCost.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 10,
  });

  // Blast area is a square measured in grid tiles. RED grenades default to a
  // 3x3-tile blast.
  game.settings.register(MODULE_ID, SETTINGS.AOE_SIZE_TILES, {
    name: "CPR-WA.settings.aoeSize.name",
    hint: "CPR-WA.settings.aoeSize.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 3,
  });

  game.settings.register(MODULE_ID, SETTINGS.AOE_AUTO_TARGET, {
    name: "CPR-WA.settings.aoeAutoTarget.name",
    hint: "CPR-WA.settings.aoeAutoTarget.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // Area DV check via diwako-cpred-additions (measured to the blast centre).
  game.settings.register(MODULE_ID, SETTINGS.DIWAKO_AOE_DV, {
    name: "CPR-WA.settings.diwakoAoeDv.name",
    hint: "CPR-WA.settings.diwakoAoeDv.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTINGS.AUTO_LINK_INJURIES, {
    name: "CPR-WA.settings.autoLinkInjuries.name",
    hint: "CPR-WA.settings.autoLinkInjuries.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTINGS.BURNING_MILD, {
    name: "CPR-WA.settings.burningMild.name",
    scope: "world",
    config: true,
    type: Number,
    default: 2,
  });

  game.settings.register(MODULE_ID, SETTINGS.BURNING_STRONG, {
    name: "CPR-WA.settings.burningStrong.name",
    scope: "world",
    config: true,
    type: Number,
    default: 4,
  });

  game.settings.register(MODULE_ID, SETTINGS.BURNING_DEADLY, {
    name: "CPR-WA.settings.burningDeadly.name",
    scope: "world",
    config: true,
    type: Number,
    default: 6,
  });
}

/**
 * Get a module setting value.
 *
 * @param {String} key
 * @returns {*}
 */
export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}
