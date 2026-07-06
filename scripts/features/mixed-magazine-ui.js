/**
 * Feature 3 (UI): show mixed-magazine contents on the actor sheet weapon row.
 *
 * The system's weapon row prints the loaded ammo from `system.loadedAmmo` /
 * `system.magazine.value`. For a mixed magazine there is no single installed
 * ammo item, so we rewrite the `.weapon-ammo` cell to summarise the stack (the
 * next round to fire and the counts per type).
 */

import { CPR_SYSTEM_ID, L } from "../constants.js";
import { isMixedMag, getStack } from "./mixed-magazine.js";
import { getCPRConfig } from "../system-api.js";

let CPR = null;

/**
 * @param {Application} app - actor sheet
 * @param {jQuery} html
 */
export async function injectMixedMagStatus(app, html) {
  const actor = app.actor ?? app.object;
  if (!actor) return;
  if (!CPR) CPR = await getCPRConfig();
  const $html = html instanceof jQuery ? html : $(html);

  $html.find(".weapon-grid").each((_i, el) => {
    const $row = $(el);
    const weaponId = $row.attr("data-item-id");
    const item = actor.items.get(weaponId);
    if (!item || item.type !== "weapon" || !isMixedMag(item)) return;

    const stack = getStack(item);
    const max = item.system.magazine?.max ?? 0;
    const $cell = $row.find(".weapon-ammo").first();
    if (!$cell.length) return;

    if (stack.length === 0) {
      $cell.html(`<span class="cpr-wa-mag-empty">${L("mixedMag.unloaded")}</span>`);
      return;
    }

    // Next round (top of the LIFO stack).
    const next = stack[0];
    const nextLabel = game.i18n.localize(CPR.ammoTypes[next.type] || next.type);

    // Per-type counts.
    const counts = {};
    for (const r of stack) counts[r.type] = (counts[r.type] || 0) + 1;
    const breakdown = Object.entries(counts)
      .map(([type, n]) => `${game.i18n.localize(CPR.ammoTypes[type] || type)}×${n}`)
      .join(", ");

    // Wrap in a column so the "next round" line and the count sit on separate
    // lines with real spacing (the system's .weapon-ammo cell is flex-row, so
    // bare sibling spans would otherwise share one line).
    $cell.html(`
      <div class="cpr-wa-mag-status">
        <span class="cpr-wa-mag-next" data-tooltip="${breakdown}">
          <i class="fas fa-layer-group"></i>
          ${L("mixedMag.next")}: ${nextLabel}
        </span>
        <span class="cpr-wa-mag-count">${stack.length} / ${max}</span>
      </div>
    `);
  });
}
