/**
 * Feature 5: automatic critical-injury linking.
 *
 * Two behaviours:
 *  1. When an item's description mentions the name of a Critical Injury from the
 *     system compendia, that mention is turned into a live @UUID[...] content
 *     link (case-insensitive, whole-word). This runs on item create/update and
 *     is idempotent (already-linked names are skipped).
 *  2. On a damage roll's critical block, we surface links to any critical
 *     injuries named in the firing item's description, so the GM can click
 *     straight through to the relevant injury.
 */

import { MODULE_ID, CPR_SYSTEM_ID, FLAGS, getFlag } from "../constants.js";
import { SETTINGS, getSetting } from "../settings.js";
import { getCPRChat, getRolls } from "../system-api.js";
import { isMixedMag } from "./mixed-magazine.js";

const INJURY_PACKS = [
  `${CPR_SYSTEM_ID}.core_critical-injuries-body`,
  `${CPR_SYSTEM_ID}.core_critical-injuries-head`,
];

// Cache: array of { name, uuid, lower } sorted by name length desc (so longer,
// more specific names match before shorter substrings).
let injuryIndex = null;

/**
 * Build (once) the index of critical-injury names → uuids from the compendia.
 *
 * @returns {Promise<Array<{name:String, uuid:String, lower:String}>>}
 */
export async function buildInjuryIndex() {
  if (injuryIndex) return injuryIndex;
  const entries = [];
  for (const packId of INJURY_PACKS) {
    const pack = game.packs.get(packId);
    if (!pack) continue;
    const index = await pack.getIndex({ fields: ["img"] });
    for (const doc of index) {
      const name = doc.name;
      entries.push({
        name,
        uuid: `Compendium.${packId}.Item.${doc._id}`,
        img: doc.img || "icons/svg/aura.svg",
        lower: name.toLowerCase(),
        // Precompiled once and reused by linkInjuriesInHtml / injuriesReferencedBy
        // (perf: avoids re-compiling a RegExp per injury on every call).
        linkRe: new RegExp(`(^|[^\\w\\[{])(${escapeRegExp(name)})(?![\\w}\\]])`, "i"),
        wordRe: new RegExp(`\\b${escapeRegExp(name)}\\b`, "i"),
      });
    }
  }
  // Longest names first to avoid a short name matching inside a longer one.
  entries.sort((a, b) => b.name.length - a.name.length);
  injuryIndex = entries;
  return injuryIndex;
}

/**
 * Escape a string for safe use inside a RegExp.
 *
 * @param {String} str
 * @returns {String}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace bare mentions of injury names in an HTML description with @UUID links.
 * Skips text that is already inside an anchor / existing @UUID reference by
 * operating only on text nodes outside of tags.
 *
 * @param {String} html
 * @param {Array} index
 * @returns {String} - possibly modified html
 */
export function linkInjuriesInHtml(html, index) {
  if (!html || typeof html !== "string") return html;

  // Cheap pre-check: if none of the injury names appear at all, do nothing.
  // Replaces up to ~20 regex+split passes with one toLowerCase + N includes.
  const lowerHtml = html.toLowerCase();
  const candidates = index.filter(
    (inj) => lowerHtml.includes(inj.lower) && !html.includes(inj.uuid)
  );
  if (candidates.length === 0) return html;

  // Split the HTML ONCE into tag / @UUID-link / text segments, then link within
  // the text segments only (never inside tags or existing links).
  const parts = html.split(/(<[^>]+>|@UUID\[[^\]]+\]\{[^}]*\})/g);
  const linked = new Set(); // injuries already linked (link first mention only)

  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    if (!seg || seg.startsWith("<") || seg.startsWith("@UUID[")) continue;
    let text = seg;
    for (const injury of candidates) {
      if (linked.has(injury.uuid)) continue;
      const m = text.match(injury.linkRe);
      if (m) {
        const [full, pre, matched] = m;
        text = text.replace(full, `${pre}@UUID[${injury.uuid}]{${matched}}`);
        linked.add(injury.uuid);
      }
    }
    parts[i] = text;
    if (linked.size === candidates.length) break;
  }
  return parts.join("");
}

/**
 * Hook: on item create/update, enrich the description with injury links.
 * We update the stored description so the links persist and render everywhere.
 *
 * @param {Item} item
 * @param {Object} changed - the update diff (for updateItem) or full data (create)
 * @param {Object} options
 * @param {String} userId
 * @param {Boolean} isCreate
 */
export async function onItemDescriptionMaybeLink(item, changed, options, userId, isCreate) {
  if (!getSetting(SETTINGS.AUTO_LINK_INJURIES)) return;
  if (game.userId !== userId) return; // only the acting user writes back
  if (options?.[MODULE_ID]?.skipInjuryLink) return; // guard against our own write

  // Only proceed if the description actually changed (or on create).
  const descChanged =
    isCreate || foundry.utils.hasProperty(changed ?? {}, "system.description.value");
  if (!descChanged) return;

  await processItemDescription(item);
}

/**
 * Link injuries in a single item's description and write the result back, if the
 * user can edit the item. Idempotent (skips when nothing changes / already
 * linked). Shared by the create/update hook and the sheet-render pass so that
 * pre-existing items (which never fired create/update since the module loaded)
 * also get linked the first time their sheet is opened.
 *
 * @param {Item} item
 * @returns {Promise<Boolean>} true if a write was made
 */
export async function processItemDescription(item) {
  if (!getSetting(SETTINGS.AUTO_LINK_INJURIES)) return false;
  if (!item) return false;
  // Never touch compendium items — their packs are typically locked, and even an
  // unlocked pack is not something we should silently rewrite. Only act on world
  // items and actor-embedded items the current user can actually update.
  if (item.pack) return false;
  if (typeof item.canUserModify === "function" && !item.canUserModify(game.user, "update")) {
    return false;
  }
  if (!item.isOwner) return false;

  const current = item.system?.description?.value;
  if (!current || typeof current !== "string") return false;

  const index = await buildInjuryIndex();
  if (!index.length) return false;

  const linked = linkInjuriesInHtml(current, index);
  if (linked === current) return false;

  await item.update(
    { "system.description.value": linked },
    { [MODULE_ID]: { skipInjuryLink: true } }
  );
  return true;
}

// Items whose description we've already scanned this session on sheet render.
// Item sheets re-render on every field edit; the create/update hooks already
// handle live description changes, so the render pass only needs to run ONCE per
// item (to catch pre-existing items). This avoids a full injury scan per render.
const scannedOnRender = new WeakSet();

/**
 * Hook: when an item sheet renders, run the linking pass once for that item.
 * This is what makes linking apply to items that already existed before the
 * module was installed/enabled.
 *
 * @param {Application} app - the item sheet
 */
export async function onRenderItemSheetLinkInjuries(app) {
  const item = app?.item ?? app?.object;
  if (!item) return;
  if (scannedOnRender.has(item)) return;
  scannedOnRender.add(item);
  // If we rewrote the description, the sheet re-renders itself via updateItem,
  // so the enriched links appear without any extra work here.
  await processItemDescription(item);
}

/**
 * Find injury links referenced by an item's description (for the damage card).
 *
 * @param {Item} item
 * @returns {Array<{name:String, uuid:String}>}
 */
export function injuriesReferencedBy(item) {
  const desc = item?.system?.description?.value;
  if (!desc || !injuryIndex) return [];
  const lower = desc.toLowerCase();
  const found = [];
  for (const injury of injuryIndex) {
    // Cheap `includes` gate before the (precompiled) regex.
    if (!lower.includes(injury.lower) && !desc.includes(injury.uuid)) continue;
    // Use the lookaround-based linkRe (not a \b regex) so names ending in ')'
    // — e.g. "Foreign Object (H)" — are matched; \b fails after a paren.
    if (desc.includes(injury.uuid) || injury.linkRe.test(desc)) {
      found.push({ name: injury.name, uuid: injury.uuid, img: injury.img });
    }
  }
  return found;
}

/**
 * Gather injuries referenced by a fired weapon AND by the projectile/ammo loaded
 * in it. Grenades, rockets, and special ammo carry the injury text on the AMMO
 * item, not the weapon, so we must scan both. Deduplicated by uuid.
 *
 * @param {Item} weapon
 * @returns {Array<{name:String, uuid:String, img:String}>}
 */
export function injuriesForWeapon(weapon) {
  const byUuid = new Map();
  const add = (list) => {
    for (const inj of list) if (!byUuid.has(inj.uuid)) byUuid.set(inj.uuid, inj);
  };

  // The weapon's own description.
  add(injuriesReferencedBy(weapon));

  // The ammo/projectile that produced this shot.
  add(injuriesReferencedBy(firedAmmoItem(weapon)));

  return Array.from(byUuid.values());
}

/**
 * Resolve the ammo item that produced the most recent shot, so we can scan its
 * description for injuries.
 *
 * - Standard single-ammo weapons: the installed ammo (`system.loadedAmmo`).
 * - Mixed magazines: the round just fired is recorded in `flags.lastFired`; each
 *   stored round keeps its source `ammoId`, so we look that ammo item up on the
 *   actor. (If the source stack was fully depleted and removed, no ammo scan.)
 *
 * @param {Item} weapon
 * @returns {Item|null}
 */
function firedAmmoItem(weapon) {
  if (!weapon) return null;
  try {
    if (isMixedMag(weapon)) {
      const lastFired = getFlag(weapon, FLAGS.LAST_FIRED, null);
      const round = Array.isArray(lastFired) ? lastFired[0] : lastFired;
      const ammoId = round?.ammoId;
      if (ammoId) return weapon.actor?.items?.get(ammoId) ?? null;
      // Fall back to matching by the stored round name if the id is gone.
      if (round?.name) {
        return weapon.actor?.items?.find((i) => i.type === "ammo" && i.name === round.name) ?? null;
      }
      return null;
    }
    return weapon.system?.loadedAmmo ?? null;
  } catch (e) {
    return null;
  }
}

/**
 * Hook: handle dropping an injury chip onto the canvas over a token.
 *
 * Core Foundry does not create arbitrary items from a canvas drop, so we handle
 * it: if the dropped Item is a criticalInjury from our compendia and it lands on
 * a token, create it on that token's actor.
 *
 * @param {Canvas} canvas
 * @param {Object} data - the drop data ({type:"Item", uuid})
 * @returns {Boolean|undefined} false to stop core handling when we consumed it
 */
export async function onDropCanvasInjury(canvas, data) {
  if (data?.type !== "Item" || !data.uuid) return undefined;
  // Only act on our critical-injury compendium items.
  if (!/core_critical-injuries-(body|head)/.test(data.uuid)) return undefined;

  const doc = await fromUuid(data.uuid);
  if (!doc || doc.type !== "criticalInjury") return undefined;

  // Find the token under the drop point.
  const token = canvas.tokens.placeables.find((t) => {
    const { x, y } = data;
    return (
      x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h
    );
  });
  if (!token?.actor) return undefined;

  // Copy the compendium injury onto the actor, matching the system's own
  // critical-injury creation (cpr-actor-sheet.js _drawCriticalInjuryTable).
  await token.actor.createEmbeddedDocuments("Item", [
    {
      name: doc.name,
      type: doc.type,
      img: doc.img,
      system: foundry.utils.duplicate(doc.system),
      effects: foundry.utils.duplicate(doc.effects),
    },
  ]);
  ui.notifications.info(
    game.i18n.format("CPR-WA.injury.applied", { name: doc.name, target: token.name })
  );
  return false; // consumed
}

/**
 * Register the damage-card injury stamper. Wraps CPRChat.RenderRollCard so that
 * a damage roll fired from an item referencing critical injuries records their
 * UUIDs on the created message's flags. The render hook then reads that flag —
 * this avoids depending on the damage card DOM (which carries no item id).
 *
 * Call once at ready.
 */
export async function registerInjuryDamageStamp() {
  const CPRChat = await getCPRChat();
  const Rolls = await getRolls();
  if (CPRChat._cprWaInjuryStampPatched) return;

  const originalRender = CPRChat.RenderRollCard.bind(CPRChat);
  CPRChat.RenderRollCard = function cprWaRenderRollCardInjury(cprRoll) {
    const promise = originalRender(cprRoll);
    try {
      if (
        getSetting(SETTINGS.AUTO_LINK_INJURIES) &&
        cprRoll instanceof Rolls.CPRDamageRoll &&
        cprRoll.entityData?.item &&
        cprRoll.entityData?.actor
      ) {
        const actor = game.actors.get(cprRoll.entityData.actor);
        const item = actor?.items?.get(cprRoll.entityData.item);
        if (item) {
          const injuries = injuriesForWeapon(item);
          if (injuries.length) {
            promise
              .then((message) => message?.setFlag(MODULE_ID, "injuries", injuries))
              .catch(() => {
                /* best-effort */
              });
          }
        }
      }
    } catch (e) {
      /* stamping is best-effort */
    }
    return promise;
  };
  CPRChat._cprWaInjuryStampPatched = true;
}

/**
 * Hook: after a damage rollcard is rendered, if the firing item referenced
 * critical injuries (recorded on the message flag by registerInjuryDamageStamp),
 * append them as DRAGGABLE chips (image + name). Dragging a chip onto a token
 * applies that critical-injury item; clicking it opens the injury.
 *
 * @param {ChatMessage} message
 * @param {jQuery} html
 */
export async function onRenderDamageCardInjuries(message, html) {
  if (!getSetting(SETTINGS.AUTO_LINK_INJURIES)) return;
  const $html = html instanceof jQuery ? html : $(html);

  const injuries = message.getFlag?.(MODULE_ID, "injuries");
  if (!injuries || !injuries.length) return;

  // Build draggable chips. We reuse Foundry's `.content-link` structure so the
  // chips are natively drag-to-apply AND click-to-open, then enrich once.
  const chips = injuries
    .map(
      (inj) => `
      <a class="cpr-wa-injury-chip" draggable="true" data-uuid="${inj.uuid}"
         data-tooltip="${inj.name}">
        <img class="cpr-wa-injury-chip-img" src="${inj.img}" alt="${inj.name}"/>
        <span class="cpr-wa-injury-chip-name">${inj.name}</span>
      </a>`
    )
    .join("");

  // Just the list of draggable injury chips under a dashed separator — no header,
  // no explanatory text.
  const block = `
    <div class="cpr-wa-injury-block">
      <div class="cpr-wa-injury-chips">${chips}</div>
    </div>`;

  const $block = $(block);
  $html.find(".rollcard, .rollcard-bottom, .cpr-block").last().append($block);

  // Wire drag-to-apply and click-to-open on each chip.
  $block.find(".cpr-wa-injury-chip").each((_i, el) => {
    el.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData(
        "text/plain",
        JSON.stringify({ type: "Item", uuid: el.dataset.uuid })
      );
    });
    el.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const doc = await fromUuid(el.dataset.uuid);
      doc?.sheet?.render(true);
    });
  });
}
