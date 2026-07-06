/**
 * Feature 4: area-of-effect target selection for grenades & rockets.
 *
 * When an attack is initiated with an area weapon (grenade launcher, rocket
 * launcher, thrown grenade, or a weapon loaded with grenade/rocket ammo), a
 * SQUARE blast template is attached to the cursor. It follows the mouse (like
 * the native Foundry template-placement flow, so clicking over a token places
 * the area rather than selecting the token), rotates with the mouse wheel, and
 * places on left-click / cancels on right-click. Every token inside is then set
 * as the user's target and the normal attack/damage flow proceeds.
 *
 * The area is a square measured in grid tiles (default 3x3), configurable.
 */

import { SETTINGS, getSetting } from "../settings.js";
import { wrapPrototype } from "../patches.js";
import { getRolls } from "../system-api.js";
import { registerAreaDvCheck, areaDvAt, measureToPoint } from "./diwako-aoe-dv.js";

let Rolls = null;

const AOE_WEAPON_TYPES = new Set(["grenadeLauncher", "rocketLauncher"]);
const AOE_AMMO_VARIETIES = new Set(["grenade", "rocket"]);

/**
 * Decide whether firing this weapon should prompt for an area.
 *
 * @param {Item} item
 * @returns {Boolean}
 */
export function isAreaWeapon(item) {
  if (!item || item.type !== "weapon") return false;
  const sys = item.system;
  if (AOE_WEAPON_TYPES.has(sys.weaponType)) return true;
  const loaded = sys.loadedAmmo;
  if (loaded && AOE_AMMO_VARIETIES.has(loaded.system?.variety)) return true;
  if (sys.weaponType === "thrownWeapon" && /grenade/i.test(item.name)) return true;
  return false;
}

/**
 * Register AoE targeting. Wraps the actor sheet's _onRoll. Call at ready.
 *
 * @param {Function} CPRActorSheet - the base actor sheet class
 */
export async function registerAoETargeting(CPRActorSheet) {
  Rolls = await getRolls();

  wrapPrototype(
    CPRActorSheet,
    "_onRoll",
    async function _onRoll(original, event) {
      try {
        const rollType = event?.currentTarget?.getAttribute?.("data-roll-type");
        if (rollType === Rolls.rollTypes.ATTACK) {
          const itemId =
            event.currentTarget.getAttribute("data-item-id") ||
            event.currentTarget.closest("[data-item-id]")?.getAttribute("data-item-id");
          const item = itemId ? this.actor.getOwnedItem(itemId) : null;
          if (item && isAreaWeapon(item)) {
            const placed = await promptAreaAndTarget(this, item);
            if (placed === false) return undefined; // cancelled → abort attack
          }
        }
      } catch (err) {
        console.error("cyberpunk-red-weapon-additions | AoE targeting failed", err);
      }
      return original.call(this, event);
    },
    "aoe-onRoll"
  );
}

/**
 * Draw a draggable square blast preview, place it, and target tokens inside.
 *
 * @param {Application} sheet - the actor sheet initiating the attack
 * @param {Item} [item] - the firing weapon (for the optional diwako DV check)
 * @returns {Promise<Boolean>} - false if cancelled, true otherwise
 */
export async function promptAreaAndTarget(sheet, item) {
  if (!canvas?.ready) return true;

  const tiles = Math.max(1, Number(getSetting(SETTINGS.AOE_SIZE_TILES)) || 3);
  const sideDistance = tiles * (canvas.scene.grid.distance || 2); // scene units across one side

  // A grid-aligned square is a "rect" template whose `distance` is the diagonal
  // and `direction` is 45°, exactly like the native square-AoE placement.
  const templateData = {
    t: "rect",
    user: game.user.id,
    x: 0,
    y: 0,
    distance: Math.hypot(sideDistance, sideDistance),
    direction: 45,
    fillColor: game.user.color,
    flags: { "cyberpunk-red-weapon-additions": { aoe: true } },
  };

  const cls = CONFIG.MeasuredTemplate.documentClass;
  const doc = new cls(templateData, { parent: canvas.scene });
  const template = new BlastTemplate(doc);
  // NOTE: `sheet` is a getter-only accessor on PlaceableObject (returns the
  // template's own config app), so we must stash the actor sheet under a
  // different name — exactly as dnd5e's AbilityTemplate uses `actorSheet`.
  template.actorSheet = sheet;
  // Half the square's side, in pixels — used to centre the square on the cursor
  // (a rect template's origin is a corner, so we offset by half a side each way).
  template.halfSidePx = (sideDistance / 2 / (canvas.scene.grid.distance || 2)) * canvas.grid.size;
  // For the live DV label on the preview (mirrors diwako's on-token DV display).
  template.dvItem = item ?? null;
  template.dvAttacker =
    sheet?.token?.object ?? sheet?.actor?.getActiveTokens?.()[0] ?? null;

  let created;
  try {
    created = await template.drawPreview();
  } catch (e) {
    return false; // right-click / Esc cancel rejects the promise
  }
  const placed = Array.isArray(created) ? created[0] : created;
  if (!placed) return false;

  // The placeable object may need a tick to be drawn on the canvas; its shape is
  // what we test tokens against. Yield once so `placed.object.shape` is ready.
  await new Promise((r) => requestAnimationFrame(r));

  const targets = tokensInTemplate(placed);

  // The geometric CENTRE of the placed square (the rect origin is a corner).
  const centre = { x: placed.x + template.halfSidePx, y: placed.y + template.halfSidePx };

  // Stash the DV + the blast targets. We deliberately do NOT target now: the
  // targets are applied AFTER the attack card is posted (in the createChatMessage
  // handler), so diwako's per-target attack message doesn't fire for a blast and
  // only our single area hit/miss message appears. If diwako isn't active the
  // stash simply carries the targets to be applied post-card.
  try {
    const attacker = sheet?.token?.object ?? sheet?.actor?.getActiveTokens?.()[0] ?? null;
    if (item && attacker) {
      await registerAreaDvCheck({ item, actor: sheet.actor, attacker, centre, targets });
    } else if (getSetting(SETTINGS.AOE_AUTO_TARGET)) {
      // No attacker token (e.g. unlinked): fall back to immediate targeting.
      game.user.updateTokenTargets(targets.map((t) => t.id));
    }
  } catch (e) {
    console.error("cyberpunk-red-weapon-additions | AoE DV check registration failed", e);
  }
  return true;
}

/**
 * Return the tokens whose center lies inside a placed template's shape.
 *
 * @param {MeasuredTemplateDocument} templateDoc
 * @returns {Array<Token>}
 */
export function tokensInTemplate(templateDoc) {
  const object = templateDoc.object;
  const result = [];
  for (const token of canvas.tokens.placeables) {
    const cx = token.center.x;
    const cy = token.center.y;
    // Prefer precise PIXI shape containment (shape is relative to the template origin).
    if (object?.shape?.contains) {
      if (object.shape.contains(cx - templateDoc.x, cy - templateDoc.y)) result.push(token);
    } else {
      // Fallback: bounding-box test around the template centre.
      const half = (templateDoc.distance / Math.SQRT2 / canvas.grid.distance) * canvas.grid.size;
      if (Math.abs(cx - templateDoc.x) <= half && Math.abs(cy - templateDoc.y) <= half) {
        result.push(token);
      }
    }
  }
  return result;
}

/**
 * A self-contained draggable blast template preview, following the canonical
 * Foundry v12 "AbilityTemplate" placement pattern (as used by dnd5e). It draws a
 * preview attached to the cursor, follows the mouse, rotates on wheel, and
 * resolves with the created template document on click.
 */
class BlastTemplate extends (foundry.canvas?.placeables?.MeasuredTemplate ?? MeasuredTemplate) {
  #moveTime = 0;

  #initialLayer;

  #events;

  // Live DV label state (mirrors diwako's on-token DV display).
  #dvText = null;

  #dvCache = new Map(); // distance -> dv (avoids re-querying the RollTable)

  #dvToken = 0; // guards against out-of-order async DV updates

  /**
   * Draw the preview and begin the placement workflow.
   *
   * @returns {Promise<MeasuredTemplateDocument[]>}
   */
  drawPreview() {
    const initialLayer = canvas.activeLayer;
    this.draw();
    this.layer.activate();
    this.layer.preview.addChild(this);
    this.#initDvLabel();
    this.actorSheet?.minimize?.();
    return this.#activatePreviewListeners(initialLayer);
  }

  /**
   * Whether the DV label should be shown for this placement.
   *
   * @returns {Boolean}
   */
  #dvEnabled() {
    return !!(this.dvItem && this.dvAttacker && getSetting(SETTINGS.DIWAKO_AOE_DV));
  }

  /**
   * Create the DV text label. We attach it to the template layer's PREVIEW
   * container (not to the template placeable itself) so the template's own draw /
   * refresh cycle can never destroy it. It is positioned in world coordinates and
   * removed when placement ends.
   */
  #initDvLabel() {
    if (!this.#dvEnabled()) return;
    const style = CONFIG.canvasTextStyle.clone();
    style.fontSize = 24;
    this.#dvText = new PreciseText("", style);
    this.#dvText.anchor.set(0.5, 1);
    (this.layer?.preview ?? this.parent)?.addChild(this.#dvText);
  }

  /**
   * Update the DV label for the template's current centre. Throttled by the move
   * handler; the RollTable lookup is cached per distance and guarded so a slow
   * async result can't overwrite a newer one.
   */
  async #updateDvLabel() {
    if (!this.#dvEnabled()) return;
    if (!this.#dvText || this.#dvText.destroyed) return;

    // Centre of the placed square, in WORLD (canvas) coordinates.
    const centre = { x: this.document.x + this.halfSidePx, y: this.document.y + this.halfSidePx };
    this.#dvText.position.set(centre.x, centre.y - 4);

    const dist = measureToPoint(this.dvAttacker, centre);
    let dv = this.#dvCache.get(dist);
    if (dv === undefined) {
      const token = ++this.#dvToken;
      dv = await areaDvAt(this.dvItem, dist);
      this.#dvCache.set(dist, dv);
      if (token !== this.#dvToken) return; // a newer move superseded this lookup
    }
    if (!this.#dvText || this.#dvText.destroyed) return; // destroyed during await
    this.#dvText.text = dv === null || dv === undefined ? `${dist}m` : `DV ${dv} @ ${dist}m`;
  }

  /**
   * Remove the DV label. Called when placement finishes or cancels.
   */
  #destroyDvLabel() {
    if (this.#dvText && !this.#dvText.destroyed) {
      this.#dvText.parent?.removeChild(this.#dvText);
      this.#dvText.destroy();
    }
    this.#dvText = null;
  }

  #activatePreviewListeners(initialLayer) {
    return new Promise((resolve, reject) => {
      this.#initialLayer = initialLayer;
      this.#events = {
        cancel: this.#onCancel.bind(this),
        confirm: this.#onConfirm.bind(this),
        move: this.#onMove.bind(this),
        rotate: this.#onRotate.bind(this),
        resolve,
        reject,
      };
      canvas.stage.on("mousemove", this.#events.move);
      canvas.stage.on("mouseup", this.#events.confirm);
      canvas.app.view.oncontextmenu = this.#events.cancel;
      canvas.app.view.onwheel = this.#events.rotate;
    });
  }

  async #finish(event) {
    this.#destroyDvLabel();
    this.layer._onDragLeftCancel(event);
    canvas.stage.off("mousemove", this.#events.move);
    canvas.stage.off("mouseup", this.#events.confirm);
    canvas.app.view.oncontextmenu = null;
    canvas.app.view.onwheel = null;
    this.#initialLayer?.activate();
    await this.actorSheet?.maximize?.();
  }

  #onMove(event) {
    event.stopPropagation();
    const now = Date.now();
    if (now - this.#moveTime <= 20) return;
    const center = event.data.getLocalPosition(this.layer);
    // Offset the corner-origin so the square is centred on the cursor.
    const corner = { x: center.x - this.halfSidePx, y: center.y - this.halfSidePx };
    const updates = this.getSnappedPosition
      ? this.getSnappedPosition(corner)
      : corner;
    this.document.updateSource(updates);
    this.refresh();
    // Update the live DV label (cached per distance; fire-and-forget).
    this.#updateDvLabel();
    this.#moveTime = now;
  }

  #onRotate(event) {
    if (event.ctrlKey) event.preventDefault();
    event.stopPropagation();
    const delta = canvas.grid.type > CONST.GRID_TYPES.SQUARE ? 30 : 15;
    const snap = event.shiftKey ? delta : 5;
    this.document.updateSource({
      direction: this.document.direction + snap * Math.sign(event.deltaY),
    });
    this.refresh();
  }

  async #onConfirm(event) {
    await this.#finish(event);
    const dest = canvas.templates.getSnappedPoint
      ? canvas.templates.getSnappedPoint({ x: this.document.x, y: this.document.y })
      : { x: this.document.x, y: this.document.y };
    this.document.updateSource(dest);
    this.#events.resolve(
      canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [this.document.toObject()])
    );
  }

  async #onCancel(event) {
    await this.#finish(event);
    this.#events.reject();
  }
}
