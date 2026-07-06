/**
 * Integration with `diwako-cpred-additions`: area-of-effect DV check.
 *
 * When an area weapon (grenade / rocket) is fired, we measure the distance from
 * the attacker's token to the CENTRE of the placed blast area, resolve the
 * weapon's ranged DV at that distance (via diwako's DV-table logic), and — once
 * the attack roll lands in chat — post a success/fail message comparing the roll
 * to that DV. Everything here is inert if diwako isn't installed.
 *
 * Rationale for owning this rather than letting diwako do it: diwako measures to
 * a single target token, but for a blast the meaningful distance is to the area
 * centre, so we compute it ourselves and reuse diwako's Utils.getDV.
 */

import { MODULE_ID, L } from "../constants.js";
import { SETTINGS, getSetting } from "../settings.js";
import { getDiwakoUtils, isDiwakoActive } from "../system-api.js";

// Pending area DV checks, keyed by `${actorId}:${itemId}`, consumed by the
// attack-card chat handler. Small and short-lived (one entry per pending shot).
const pending = new Map();

function key(actorId, itemId) {
  return `${actorId}:${itemId}`;
}

/**
 * Measure the grid distance (in scene units) from a token to a point, mirroring
 * diwako's own `measurePath(...).cost` approach and folding in elevation.
 *
 * @param {Token} token
 * @param {{x:Number,y:Number}} point - a canvas pixel coordinate
 * @returns {Number}
 */
function distanceToPoint(token, point) {
  // Measure from the token's centre to the area centre (both canvas pixels).
  const centre = token.center ?? { x: token.document?.x ?? 0, y: token.document?.y ?? 0 };
  const path = canvas.grid.measurePath([
    { x: centre.x, y: centre.y },
    { x: point.x, y: point.y },
  ]);
  const planar = path?.cost ?? path?.distance ?? 0;
  const dz = token.document?.elevation ?? 0;
  const dist = Math.round(Math.sqrt(planar * planar + dz * dz));
  // DV tables index from 1 (a point-blank throw still lands in the first band),
  // and getResultsForRoll(0) returns nothing, so never query below 1.
  return Math.max(1, dist);
}

/**
 * Public helper: compute the DV for an area weapon at a given distance. Returns
 * null if diwako isn't available or the DV can't be resolved (missing table /
 * out-of-range distance). Used both for the live preview and the stash.
 *
 * @param {Item} item - firing weapon
 * @param {Number} dist - distance in scene units
 * @returns {Promise<Number|null>}
 */
export async function areaDvAt(item, dist) {
  if (!isDiwakoActive()) return null;
  const dvTable = item?.system?.dvTable;
  if (!dvTable) return null;
  const Utils = await getDiwakoUtils();
  if (!Utils?.getDV) return null;
  const dv = await Utils.getDV(dvTable, dist);
  return dv === undefined || dv === null || dv < 0 ? null : dv;
}

/**
 * Distance (scene units) from a token to a canvas point. Exposed for the live
 * preview in the AoE placement flow.
 *
 * @param {Token} token
 * @param {{x:Number,y:Number}} point
 * @returns {Number}
 */
export function measureToPoint(token, point) {
  return distanceToPoint(token, point);
}

/**
 * Stash the area DV + the tokens to target for a pending shot. Called at
 * placement time. Targets are applied only AFTER the area hit/miss message is
 * posted (so diwako's per-target attack message doesn't fire for a blast).
 *
 * @param {Object} args
 * @param {Item} args.item - firing weapon
 * @param {Actor} args.actor
 * @param {Token} args.attacker - attacker's token placeable
 * @param {{x:Number,y:Number}} args.centre - area centre (canvas pixels)
 * @param {Array<Token>} args.targets - tokens inside the blast
 */
export async function registerAreaDvCheck({ item, actor, attacker, centre, targets }) {
  // The DV is only computed when the integration is enabled; the targets are
  // always stashed so they can be applied after the attack card is posted.
  const dvEnabled = getSetting(SETTINGS.DIWAKO_AOE_DV);
  const dist = dvEnabled ? distanceToPoint(attacker, centre) : 0;
  const dv = dvEnabled ? await areaDvAt(item, dist) : null;

  // Bound the map so a cancelled roll (placement without a resulting card) can't
  // accumulate stale entries. Entries are normally consumed on the next attack
  // card; this just caps worst-case growth.
  if (pending.size > 50) pending.clear();

  pending.set(key(actor.id, item.id), {
    dv, // may be null if disabled or the DV couldn't be resolved
    dist,
    attackerName: attacker.document?.name ?? attacker.name,
    targetIds: (targets || []).map((t) => t.id),
  });
}

/**
 * Chat hook: when an area weapon's attack card is created, compare its roll to
 * the stashed area DV and post a success/fail message.
 *
 * @param {ChatMessage} message
 */
export async function onAttackCardAreaDv(message) {
  // Cheap early-outs before any DOM parsing: only the author evaluates, there
  // must be a pending area shot at all, and the content must look like an attack
  // card (a plain `includes` avoids parsing every chat message into a DOM).
  if (pending.size === 0) return;
  if (game.userId !== (message.author?.id ?? message._source?.author)) return;
  const content = message.content;
  if (!content || !content.includes("rollDamage")) return;

  const div = document.createElement("div");
  div.innerHTML = content;

  // Is this an attack card with a rollDamage link (same detection diwako uses)?
  const data = div.querySelector("[data-action=rollDamage]")?.dataset;
  if (!data) return;
  const { actorId, itemId } = data;
  const entry = pending.get(key(actorId, itemId));
  if (!entry) return;
  pending.delete(key(actorId, itemId));

  // Post the area hit/miss message ONLY if the DV resolved. Missing/out-of-range
  // DV → no message (targeting for the blast still happens below).
  if (entry.dv !== null && entry.dv !== undefined) {
    const rollSpan = div.querySelector("span.clickable[data-action='toggleVisibility']");
    const attackRoll = rollSpan ? parseInt(rollSpan.innerHTML, 10) : NaN;
    if (!Number.isNaN(attackRoll)) {
      const hit = attackRoll >= entry.dv;
      const content = L(hit ? "aoe.dvHit" : "aoe.dvMiss", {
        attacker: entry.attackerName,
        dv: entry.dv,
        dist: entry.dist,
        diff: Math.abs(attackRoll - entry.dv),
      });
      // Match diwako's own hit/miss card: a `.cpr-block` with 10px padding and
      // the same success/failure background variables.
      const backgroundColor = hit
        ? "var(--cpr-text-chat-success, #2d9f36)"
        : "var(--cpr-text-chat-failure, #b90202ff)";
      await ChatMessage.create(
        {
          speaker: message.speaker,
          content: `<div class="cpr-block" style="padding:10px;background-color:${backgroundColor}">${content}</div>`,
          type: message.type,
          whisper: message.whisper,
          flags: { [MODULE_ID]: { aoeDv: true } },
        },
        { chatBubble: false }
      );
    }
  }

  // Apply the blast targets, but ALWAYS off the current (synchronous) hook frame.
  // createChatMessage runs every handler synchronously in registration order, and
  // diwako's per-target attack handler reads game.user.targets at that moment. If
  // we targeted synchronously (which happens on the DV-off path, where there's no
  // preceding await), diwako would see the targets and post spurious per-target
  // messages for a blast. Deferring to a microtask guarantees diwako reads an
  // empty target set first, leaving only our single area message.
  if (getSetting(SETTINGS.AOE_AUTO_TARGET) && entry.targetIds?.length) {
    const ids = entry.targetIds;
    Promise.resolve().then(() => game.user.updateTokenTargets(ids));
  }
}
