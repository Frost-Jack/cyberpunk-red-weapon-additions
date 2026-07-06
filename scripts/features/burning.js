/**
 * Feature 6: three tiers of Burning.
 *
 * Adds Mild / Strong / Deadly Burning status effects. They are mutually
 * exclusive (applying a higher tier clears any lower one). At the END of a
 * combatant's turn, the active tier deals flat damage (2 / 4 / 6 by default)
 * straight to HP, ignoring armour.
 *
 * The system registers no custom status effects and no end-of-turn combat hook,
 * so we own both: we push our effects onto CONFIG.statusEffects and listen to
 * combat turn changes, applying the tick on the single active-GM client.
 */

import { MODULE_ID, CPR_SYSTEM_ID, L } from "../constants.js";
import { SETTINGS, getSetting } from "../settings.js";

// Status effect ids. Order matters: index = severity (0 lowest).
export const BURNING_TIERS = [
  { id: "cpr-wa-burning-mild", tier: 1, setting: SETTINGS.BURNING_MILD, labelKey: "burning.mild" },
  { id: "cpr-wa-burning-strong", tier: 2, setting: SETTINGS.BURNING_STRONG, labelKey: "burning.strong" },
  { id: "cpr-wa-burning-deadly", tier: 3, setting: SETTINGS.BURNING_DEADLY, labelKey: "burning.deadly" },
];

const BURNING_IDS = new Set(BURNING_TIERS.map((t) => t.id));

// Icons shipped with Foundry core so the module has no image dependencies.
const ICONS = {
  "cpr-wa-burning-mild": "icons/magic/fire/flame-burning-embers-yellow.webp",
  "cpr-wa-burning-strong": "icons/magic/fire/flame-burning-fist-strike.webp",
  "cpr-wa-burning-deadly": "icons/magic/fire/flame-burning-skull-orange.webp",
};

/**
 * Register the three Burning status effects. Must run at `init`, before actors
 * prepare, so the token HUD shows them.
 */
export function registerBurningEffects() {
  for (const t of BURNING_TIERS) {
    CONFIG.statusEffects.push({
      id: t.id,
      name: `CPR-WA.${t.labelKey}`,
      img: ICONS[t.id],
      // Group them so Foundry treats them as related (v12 statuses array).
      statuses: [t.id],
      flags: { [MODULE_ID]: { burningTier: t.tier } },
    });
  }
}

/**
 * Enforce mutual exclusivity: when a Burning effect is created on an actor,
 * remove any other Burning tier already present. Runs on the GM.
 *
 * @param {ActiveEffect} effect
 */
export async function enforceExclusiveBurning(effect) {
  if (!game.users.activeGM?.isSelf) return;
  const parent = effect.parent; // Actor
  if (!parent || !(parent instanceof Actor)) return;
  const thisTier = effectBurningId(effect);
  if (!thisTier) return;

  const toRemove = parent.effects
    .filter((e) => e.id !== effect.id && effectBurningId(e))
    .map((e) => e.id);
  if (toRemove.length) {
    await parent.deleteEmbeddedDocuments("ActiveEffect", toRemove);
  }
}

/**
 * Return the Burning status id an effect represents, or null.
 *
 * @param {ActiveEffect} effect
 * @returns {String|null}
 */
function effectBurningId(effect) {
  // v12 effects expose `statuses` (a Set). Fall back to legacy flags.core.statusId.
  for (const id of BURNING_IDS) {
    if (effect.statuses?.has?.(id)) return id;
  }
  const legacy = effect.getFlag?.("core", "statusId");
  return BURNING_IDS.has(legacy) ? legacy : null;
}

/**
 * The active Burning tier config on an actor (highest severity), or null.
 *
 * @param {Actor} actor
 * @returns {Object|null}
 */
function activeBurningTier(actor) {
  let best = null;
  for (const effect of actor.effects) {
    if (effect.disabled) continue;
    const id = effectBurningId(effect);
    if (!id) continue;
    const cfg = BURNING_TIERS.find((t) => t.id === id);
    if (cfg && (!best || cfg.tier > best.tier)) best = cfg;
  }
  return best;
}

/**
 * Apply the burning tick to one actor (ignores armour, direct HP).
 *
 * @param {Actor} actor
 */
async function tickActor(actor) {
  const cfg = activeBurningTier(actor);
  if (!cfg) return;
  const amount = Number(getSetting(cfg.setting)) || 0;
  if (amount <= 0) return;

  const hp = actor.system?.derivedStats?.hp;
  if (!hp || typeof hp.value !== "number") return;
  const newValue = Math.max(hp.value - amount, 0);
  if (newValue === hp.value) return;

  await actor.update({ "system.derivedStats.hp.value": newValue });

  const tierName = L(cfg.labelKey);
  ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="cpr-wa-burning-tick">
        <strong>${tierName}</strong>: ${actor.name} ${L("burning.takes", { amount })}
      </div>`,
  });
}

/**
 * Combat turn-change handler. When the turn advances, the combatant whose turn
 * JUST ended takes their burning tick. Only the active GM applies it.
 *
 * We support both the v12 `combatTurnChange` hook and a fallback via
 * `updateCombat`, whichever fires.
 *
 * @param {Combat} combat
 * @param {Object} prior - { round, turn } before the change (combatTurnChange)
 * @param {Object} current - { round, turn } after the change
 */
export async function onCombatTurnChange(combat, prior, current) {
  if (!game.users.activeGM?.isSelf) return;
  if (!combat?.started) return;

  // Identify the combatant that just finished. `prior.combatantId` is provided
  // by combatTurnChange; otherwise derive from the prior turn index.
  let finishedCombatant = null;
  if (prior?.combatantId) {
    finishedCombatant = combat.combatants.get(prior.combatantId);
  } else if (typeof prior?.turn === "number") {
    const ordered = combat.turns ?? [];
    finishedCombatant = ordered[prior.turn] ?? null;
  }
  if (!finishedCombatant) return;

  const actor = finishedCombatant.actor;
  if (actor) await tickActor(actor);
}
