/**
 * Feature: weapon-sheet configuration UI.
 *
 * Injects our extra weapon settings into the item sheet's Settings tab, matching
 * the system's own `li.item.flexrow` / `.setting-name` / `.setting-value` layout.
 * Values are stored under `flags.<module>.*` via `name="flags.<module>.<key>"`
 * inputs, which the core ItemSheet form submission persists automatically.
 *
 * Fields:
 *  - Autofire ammo cost        (shown when the weapon has an Autofire max > 0)
 *  - Mixed-type magazine toggle (shown for ranged weapons)
 *  - Burst multiplier           (any weapon)
 *  - Burst damage formula       (shown when Burst multiplier > 0)
 *  - Burst substitute ammo type (shown when Burst multiplier > 0)
 */

import { MODULE_ID, FLAGS, L, getFlag } from "../constants.js";
import { getCPRConfig } from "../system-api.js";

/**
 * Build one settings row.
 *
 * @param {String} labelHtml
 * @param {String} valueHtml
 * @returns {String}
 */
function row(labelHtml, valueHtml) {
  return `
    <li class="item flexrow cpr-wa-setting">
      <div class="item flexrow setting-name text-nowrap">${labelHtml}</div>
      <div class="item flexrow setting-value text-nowrap item-end">${valueHtml}</div>
    </li>`;
}

/**
 * Pseudo-checkbox toggle.
 *
 * We deliberately do NOT reuse the system's `.item-checkbox` handler: it only
 * toggles a target that already exists on the item (`hasProperty` guard), so a
 * brand-new flag path would never turn on. Instead we use our own class and bind
 * a handler that calls `setFlag` directly.
 *
 * @param {String} flagKey - the FLAGS key to toggle
 * @param {Boolean} checked
 * @param {Boolean} editable
 * @returns {String}
 */
function checkbox(flagKey, checked, editable) {
  const icon = checked ? "far fa-circle-check" : "far fa-circle";
  if (!editable) return `<i class="${icon}"></i>`;
  return `<a class="cpr-wa-flag-toggle" data-flag="${flagKey}"><i class="${icon}"></i></a>`;
}

/**
 * @param {Application} app - the CPRItemSheet instance
 * @param {jQuery} html
 */
export async function onRenderItemSheet(app, html) {
  const item = app.item ?? app.object;
  if (!item || item.type !== "weapon") return;

  const editable = app.isEditable;
  const CPR = await getCPRConfig();

  const system = item.system;
  const hasAutofire = Number(system?.fireModes?.autoFire ?? 0) > 0;
  const isRanged = !!system?.isRanged;

  const autofireCost = getFlag(item, FLAGS.AUTOFIRE_AMMO_COST, "");
  const burstMult = getFlag(item, FLAGS.BURST_MULTIPLIER, 0);
  const burstFormula = getFlag(item, FLAGS.BURST_DAMAGE_FORMULA, "");
  const burstAmmoType = getFlag(item, FLAGS.BURST_AMMO_TYPE, "");
  const mixedMag = !!getFlag(item, FLAGS.MIXED_MAGAZINE, false);

  const rows = [];

  // --- Autofire ammo cost (only meaningful when the weapon can autofire) ---
  if (hasAutofire) {
    const input = editable
      ? `<input type="number" min="0" step="1" name="flags.${MODULE_ID}.${FLAGS.AUTOFIRE_AMMO_COST}"
              value="${autofireCost}" placeholder="10"/>`
      : `<span class="text-flex-end">${autofireCost || 10}</span>`;
    rows.push(row(L("settings.autofireCostField"), input));
  }

  // --- Burst multiplier ---
  const burstInput = editable
    ? `<input type="number" min="0" step="1" name="flags.${MODULE_ID}.${FLAGS.BURST_MULTIPLIER}" value="${burstMult}"/>`
    : `<span class="text-flex-end">${burstMult}</span>`;
  rows.push(row(L("burst.multiplierField"), burstInput));

  // --- Burst damage formula + ammo type (only when a burst is configured) ---
  if (Number(burstMult) > 0) {
    const formulaInput = editable
      ? `<input type="text" name="flags.${MODULE_ID}.${FLAGS.BURST_DAMAGE_FORMULA}"
              value="${burstFormula}" placeholder="${system.damage || "1d6"}"/>`
      : `<span class="text-flex-end">${burstFormula || "—"}</span>`;
    rows.push(row(L("burst.formulaField"), formulaInput));

    // Ammo type select: "(base type)" plus all system ammo types.
    const options = [`<option value=""${burstAmmoType ? "" : " selected"}>${L("burst.ammoTypeNone")}</option>`];
    for (const [key, locKey] of Object.entries(CPR.ammoTypes)) {
      const sel = burstAmmoType === key ? " selected" : "";
      options.push(`<option value="${key}"${sel}>${game.i18n.localize(locKey)}</option>`);
    }
    const ammoSelect = editable
      ? `<select name="flags.${MODULE_ID}.${FLAGS.BURST_AMMO_TYPE}">${options.join("")}</select>`
      : `<span class="text-flex-end">${burstAmmoType || "—"}</span>`;
    rows.push(row(L("burst.ammoTypeField"), ammoSelect));
  }

  // --- Mixed magazine toggle (ranged only) ---
  if (isRanged) {
    rows.push(row(L("mixedMag.toggleField"), checkbox(FLAGS.MIXED_MAGAZINE, mixedMag, editable)));
  }

  if (rows.length === 0) return;

  const block = `
    <li class="item flexrow cpr-wa-section-header">
      <div class="item flexrow setting-name text-nowrap text-semi">${L("settings.sectionHeader")}</div>
      <div class="item flexrow setting-value text-nowrap item-end"></div>
    </li>
    ${rows.join("")}`;

  // Append into the settings list. The settings tab renders its rows inside an
  // <ol> within .item-settings-grid; fall back gracefully if the DOM shifts.
  const $html = html instanceof jQuery ? html : $(html);
  const $list = $html.find(".item-settings-grid ol").first();
  if ($list.length) {
    $list.append(block);
  } else {
    $html.find(".item-settings-grid").first().append(`<ol class="items-list">${block}</ol>`);
  }

  // Bind our own flag toggles (setFlag works even when the flag path is new).
  if (editable) {
    $html.find(".cpr-wa-flag-toggle").off("click.cprwa").on("click.cprwa", async (ev) => {
      ev.preventDefault();
      const key = ev.currentTarget.dataset.flag;
      const current = !!getFlag(item, key, false);
      await item.setFlag(MODULE_ID, key, !current);
    });
  }
}
