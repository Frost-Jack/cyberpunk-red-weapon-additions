/**
 * Cyberpunk RED - Weapon Additions
 * Entry point. Wires up all features against the cyberpunk-red-core system.
 */

import { MODULE_ID, CPR_SYSTEM_ID } from "./constants.js";
import { registerSettings } from "./settings.js";
import { installLoadMixinsHook } from "./patches.js";

import { registerAutofireAmmoCost } from "./features/autofire-ammo-cost.js";
import {
  registerBurstFire,
  injectBurstToggle,
  onRenderBurstAttackCard,
} from "./features/burst-fire.js";
import { registerMixedMagazine } from "./features/mixed-magazine.js";
import { injectMixedMagStatus } from "./features/mixed-magazine-ui.js";
import { registerAoETargeting } from "./features/aoe-targeting.js";
import { onAttackCardAreaDv } from "./features/diwako-aoe-dv.js";
import {
  registerBurningEffects,
  enforceExclusiveBurning,
  onCombatTurnChange,
} from "./features/burning.js";
import {
  buildInjuryIndex,
  onItemDescriptionMaybeLink,
  onRenderDamageCardInjuries,
  onRenderItemSheetLinkInjuries,
  onDropCanvasInjury,
  registerInjuryDamageStamp,
} from "./features/critical-injuries.js";
import { onRenderItemSheet } from "./features/weapon-settings.js";

/**
 * Register a couple of small Handlebars helpers our templates use.
 */
function registerHelpers() {
  if (!Handlebars.helpers.cprInc) {
    Handlebars.registerHelper("cprInc", (n) => Number(n) + 1);
  }
}

Hooks.once("init", () => {
  console.info(`${MODULE_ID} | init`);
  registerSettings();
  registerHelpers();
  // Burning status effects must be registered at init so the token HUD shows them.
  registerBurningEffects();
});

Hooks.once("setup", () => {
  // The system must be the active system for us to patch it.
  if (game.system.id !== CPR_SYSTEM_ID) {
    console.warn(`${MODULE_ID} | active system is not ${CPR_SYSTEM_ID}; features disabled.`);
    return;
  }
  // Install the loadMixins hook early so instance wrappers apply to all weapons.
  installLoadMixinsHook();
});

Hooks.once("ready", async () => {
  if (game.system.id !== CPR_SYSTEM_ID) return;

  // Register the per-instance wrappers (they queue into the loadMixins hook).
  await registerAutofireAmmoCost();
  await registerBurstFire();
  await registerMixedMagazine();

  // Actor-sheet-level wrapper for AoE targeting needs the base sheet class.
  const CPRActorSheet = game.cpr?.apps?.CPRCharacterActorSheet
    ? Object.getPrototypeOf(game.cpr.apps.CPRCharacterActorSheet)
    : null;
  if (CPRActorSheet) {
    await registerAoETargeting(CPRActorSheet);
  } else {
    console.warn(`${MODULE_ID} | could not resolve CPRActorSheet base class; AoE targeting disabled.`);
  }

  // Pre-build the critical injury index (non-blocking best effort) and wire the
  // damage-card injury stamper.
  buildInjuryIndex().catch((e) => console.warn(`${MODULE_ID} | injury index`, e));
  await registerInjuryDamageStamp();

  // Force a re-prepare of existing weapons so wrappers attach immediately,
  // rather than only after the next data-prep cycle.
  for (const actor of game.actors) {
    for (const item of actor.items) {
      if (item.type === "weapon") item.prepareDerivedData?.();
    }
  }

  console.info(`${MODULE_ID} | ready`);
});

/* ------------------------------------------------------------------ *
 *  Item sheet: weapon settings UI
 * ------------------------------------------------------------------ */
Hooks.on("renderCPRItemSheet", (app, html) => {
  onRenderItemSheet(app, html).catch((e) => console.error(`${MODULE_ID} | item sheet`, e));
  onRenderItemSheetLinkInjuries(app).catch((e) =>
    console.error(`${MODULE_ID} | link injuries (sheet)`, e)
  );
});

/* ------------------------------------------------------------------ *
 *  Actor sheet: burst toggle + mixed-mag status injection
 * ------------------------------------------------------------------ */
function onRenderActorSheet(app, html) {
  try {
    injectBurstToggle(app, html);
    injectMixedMagStatus(app, html);
  } catch (e) {
    console.error(`${MODULE_ID} | actor sheet inject`, e);
  }
}
Hooks.on("renderCPRCharacterActorSheet", onRenderActorSheet);
Hooks.on("renderCPRMookActorSheet", onRenderActorSheet);

/* ------------------------------------------------------------------ *
 *  Chat cards: burst attack link + critical injury links
 * ------------------------------------------------------------------ */
Hooks.on("renderChatMessage", (message, html) => {
  try {
    onRenderBurstAttackCard(message, html);
  } catch (e) {
    console.error(`${MODULE_ID} | burst card`, e);
  }
  onRenderDamageCardInjuries(message, html).catch((e) =>
    console.error(`${MODULE_ID} | injury card`, e)
  );
});

// Area DV check (diwako integration): evaluate the attack card against the DV
// measured to the blast centre, and post the success/fail result.
Hooks.on("createChatMessage", (message) => {
  onAttackCardAreaDv(message).catch((e) =>
    console.error(`${MODULE_ID} | aoe dv`, e)
  );
});

/* ------------------------------------------------------------------ *
 *  Critical injury auto-linking on item create/update
 * ------------------------------------------------------------------ */
Hooks.on("createItem", (item, options, userId) => {
  onItemDescriptionMaybeLink(item, item, options, userId, true).catch((e) =>
    console.error(`${MODULE_ID} | link injuries (create)`, e)
  );
});
Hooks.on("updateItem", (item, changed, options, userId) => {
  onItemDescriptionMaybeLink(item, changed, options, userId, false).catch((e) =>
    console.error(`${MODULE_ID} | link injuries (update)`, e)
  );
});

/* ------------------------------------------------------------------ *
 *  Burning: exclusivity + end-of-turn ticks
 * ------------------------------------------------------------------ */
Hooks.on("createActiveEffect", (effect) => {
  enforceExclusiveBurning(effect).catch((e) =>
    console.error(`${MODULE_ID} | burning exclusivity`, e)
  );
});

// Drag an injury chip from the damage card onto a token to apply it. Core has no
// default handling for arbitrary Item-on-canvas drops, so a fire-and-forget async
// handler is safe (nothing else acts on the drop).
Hooks.on("dropCanvasData", (canvas, data) => {
  onDropCanvasInjury(canvas, data).catch((e) =>
    console.error(`${MODULE_ID} | drop injury`, e)
  );
});

// v12 fires combatTurnChange when the active combatant changes.
Hooks.on("combatTurnChange", (combat, prior, current) => {
  onCombatTurnChange(combat, prior, current).catch((e) =>
    console.error(`${MODULE_ID} | burning tick`, e)
  );
});
