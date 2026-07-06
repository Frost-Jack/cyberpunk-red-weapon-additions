/**
 * Feature 2: Burst Fire mode.
 *
 * A weapon may define a Burst Multiplier (rounds fired in one burst). When the
 * burst fire-mode is selected on the actor sheet:
 *   - The attack is a single normal attack roll (RED-style), but firing consumes
 *     `burstMultiplier` rounds from the magazine.
 *   - Damage is a single roll of the weapon's Burst Damage Formula (if set),
 *     replacing the normal weapon+ammo damage.
 *   - If a substitute ammo type is configured and the currently-fired round is a
 *     basic round, the damage card reports/behaves as the substitute type
 *     (affects armour ablation / lethality), without changing the round consumed.
 *
 * Implementation: we register the "burst" fire mode + roll type, wrap the
 * prototype `createRoll`/`confirmRoll` to special-case it, and add the toggle to
 * the weapon row on the actor sheet.
 */

import {
  MODULE_ID,
  FLAGS,
  BURST_FIRE_MODE,
  CPR_SYSTEM_ID,
  L,
  getFlag,
} from "../constants.js";
import { wrapPrototype, registerInstanceWrapper, wrapInstanceMethod } from "../patches.js";
import { getRolls, getCPRChat } from "../system-api.js";

let Rolls = null;

/**
 * How many rounds a burst consumes for this weapon (min 1).
 *
 * @param {Item} item
 * @returns {Number}
 */
export function burstRounds(item) {
  const n = Number(getFlag(item, FLAGS.BURST_MULTIPLIER, 0));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Is the actor currently set to fire this weapon in burst mode?
 *
 * @param {Actor} actor
 * @param {String} weaponId
 * @returns {Boolean}
 */
export function isBurstSelected(actor, weaponId) {
  return actor?.getFlag(CPR_SYSTEM_ID, `firetype-${weaponId}`) === BURST_FIRE_MODE;
}

/**
 * Register burst-fire behaviour. Call once at ready.
 */
export async function registerBurstFire() {
  Rolls = await getRolls();
  const ItemClass = CONFIG.Item.documentClass;
  const CPRChat = await getCPRChat();

  // Wrap RenderRollCard so a burst attack card gets a module flag on its
  // message; the render hook then adds data-attack-type to the damage link.
  if (!CPRChat._cprWaRenderPatched) {
    const originalRender = CPRChat.RenderRollCard.bind(CPRChat);
    CPRChat.RenderRollCard = function cprWaRenderRollCard(cprRoll) {
      const promise = originalRender(cprRoll);
      if (cprRoll?.rollCardExtraArgs?.cprWaBurstAttack) {
        promise
          .then((message) => message?.setFlag(MODULE_ID, "burstAttack", true))
          .catch(() => {
            /* non-owner or transient message: burst tag is best-effort */
          });
      }
      return promise;
    };
    CPRChat._cprWaRenderPatched = true;
  }

  // Per-instance wrapper: make bulletConsumption / hasAmmo scale to a full burst
  // while a burst attack roll is being built or confirmed. We use a transient
  // per-item marker (`_cprWaPendingBurstRounds`) because `_createAttackRoll`
  // runs its own hasAmmo() check internally, before we can tag the roll.
  registerInstanceWrapper("burst-consumption", (item) => {
    // Only weapons with a burst multiplier need burst-aware consumption. Skip the
    // per-prepare wrap for everything else (perf).
    if (burstRounds(item) <= 0) return;
    wrapInstanceMethod(item, "bulletConsumption", function bulletConsumption(original, cprRoll) {
      const pending = this._cprWaPendingBurstRounds;
      if (Number.isFinite(pending) && pending > 0) return pending;
      if (cprRoll?.cprWaBurst && cprRoll.cprWaBurstRounds > 0) return cprRoll.cprWaBurstRounds;
      return original(cprRoll);
    });
  });

  // --- createRoll: intercept the "burst" attack / damage types ---
  wrapPrototype(ItemClass, "createRoll", function createRoll(original, type, actor, extraData = []) {
    // Burst ATTACK: build a normal attack roll, then tag it as a burst so that
    // confirmRoll consumes the right number of rounds and hasAmmo checks scale.
    if (type === BURST_FIRE_MODE) {
      const rounds = burstRounds(this);
      // Signal the in-flight hasAmmo() check inside _createAttackRoll.
      this._cprWaPendingBurstRounds = rounds;
      let cprRoll;
      try {
        cprRoll = this._createAttackRoll(Rolls.rollTypes.ATTACK, actor);
      } finally {
        delete this._cprWaPendingBurstRounds;
      }
      cprRoll.cprWaBurst = true;
      cprRoll.cprWaBurstRounds = rounds;
      // Tag the card so the "roll damage" link from chat also fires a burst
      // (the base attack card omits data-attack-type).
      cprRoll.rollCardExtraArgs.cprWaBurstAttack = true;
      return cprRoll;
    }

    // Burst DAMAGE: the damageType arrives via extraData.damageType.
    if (type === Rolls.rollTypes.DAMAGE && extraData?.damageType === BURST_FIRE_MODE) {
      const cprRoll = this._createDamageRoll(Rolls.rollTypes.ATTACK, actor);
      applyBurstDamage(this, cprRoll);
      return cprRoll;
    }

    return original.call(this, type, actor, extraData);
  }, "burst-createRoll");

  // Burst ammo consumption is handled entirely by the base dischargeItem(), which
  // calls our burst-aware bulletConsumption(). No confirmRoll override needed for
  // consumption; the base confirmRoll runs unchanged for burst attack rolls.
}

/**
 * Swap a freshly-built damage roll over to burst behaviour: replace the formula
 * with the burst formula (if configured) and, when a substitute ammo type is set
 * and a basic round is loaded, override the ammoType metadata on the card.
 *
 * @param {Item} item
 * @param {CPRDamageRoll} cprRoll
 */
export function applyBurstDamage(item, cprRoll) {
  const formula = getFlag(item, FLAGS.BURST_DAMAGE_FORMULA, "");
  const raw = String(formula || "").trim().toLowerCase();
  // Only accept a valid dice formula (XdY optionally +/-Z) or a flat number.
  const isValid = raw !== "" && (/^\d+d\d+(\s*[+-]\s*\d+)?$/.test(raw) || /^\d+$/.test(raw));
  if (isValid) {
    // The constructor already ran _processFormula on the weapon's base damage,
    // which may have pushed a trailing +X/-X into this.mods (source = rollFormula).
    // Drop those before re-processing so the burst formula fully replaces the base.
    const rollFormulaSource = "CPR.rolls.modifiers.sources.rollFormula";
    const localizedSource = game.i18n.localize(rollFormulaSource);
    cprRoll.mods = cprRoll.mods.filter(
      (m) => m.source !== rollFormulaSource && m.source !== localizedSource
    );
    // Route through the roll's own processor so the burst formula's own +X/-X
    // becomes a fresh mod.
    cprRoll.formula = cprRoll._processFormula(raw);
  } else if (raw !== "") {
    ui.notifications.warn(`${item.name}: invalid Burst damage formula "${formula}".`);
  }

  // Substitute ammo type: only when the loaded round is "basic".
  const subType = getFlag(item, FLAGS.BURST_AMMO_TYPE, "");
  if (subType) {
    const loadedType = cprRoll.rollCardExtraArgs.ammoType;
    if (loadedType === undefined || loadedType === "basic") {
      cprRoll.rollCardExtraArgs.ammoType = subType;
    }
  }

  // Mark the card so it can show a "Burst" tag.
  cprRoll.rollCardExtraArgs.cprWaBurst = true;
}

/**
 * When a burst attack card is rendered, make its "roll damage" link carry the
 * burst attack type so damage rolled from chat is also a burst.
 *
 * @param {ChatMessage} message
 * @param {jQuery} html
 */
export function onRenderBurstAttackCard(message, html) {
  const $html = html instanceof jQuery ? html : $(html);
  const $link = $html.find('a[data-action="rollDamage"]');
  if (!$link.length) return;
  // Only tag cards we produced as bursts. We detect via a marker span we add
  // to the card content, or via the message flag set below.
  const isBurst = message.getFlag?.(MODULE_ID, "burstAttack");
  if (isBurst) {
    $link.attr("data-attack-type", BURST_FIRE_MODE);
  }
}

/**
 * Inject the Burst fire-mode toggle into a weapon row on the actor sheet.
 * Mirrors the system's aimed/autofire/suppressive toggles.
 *
 * @param {Application} app - actor sheet
 * @param {jQuery} html
 */
export function injectBurstToggle(app, html) {
  const actor = app.actor ?? app.object;
  if (!actor) return;
  const $html = html instanceof jQuery ? html : $(html);

  $html.find(".weapon-grid").each((_i, el) => {
    const $row = $(el);
    const weaponId = $row.attr("data-item-id");
    if (!weaponId) return;
    const item = actor.items.get(weaponId);
    if (!item || item.type !== "weapon") return;
    if (burstRounds(item) <= 0) return;
    // Avoid duplicate injection on re-render.
    if ($row.find(".cpr-wa-burst-toggle").length) return;

    const selected = isBurstSelected(actor, weaponId);
    const dot = selected ? "far fa-circle-dot" : "far fa-circle";
    const $li = $(`
      <li class="cpr-wa-burst-li">
        <span class="text-padding-right-small">${L("burst.short")}</span>
        <a class="fire-checkbox cpr-wa-burst-toggle" data-fire-mode="${BURST_FIRE_MODE}" data-item-id="${weaponId}">
          <i class="${dot} text-padding-right-smallest"></i>
        </a>
      </li>`);

    // The system binds `.fire-checkbox` clicks with a NON-delegated jQuery
    // handler during activateListeners, which runs before this render hook — so
    // our late-injected element would receive no handler. Bind it ourselves,
    // delegating to the sheet's own toggle (which sets the firetype flag).
    $li.find(".cpr-wa-burst-toggle").on("click", (ev) => {
      ev.preventDefault();
      app._fireCheckboxToggle(ev).then(() => app.render(false));
    });

    // Mark the fire-mode container so our CSS can make room for the 4th mode
    // (works without relying on :has()).
    $row.find(".weapon-mode").addClass("cpr-wa-has-burst");
    $row.find(".weapon-mode ul").first().append($li);
  });
}
