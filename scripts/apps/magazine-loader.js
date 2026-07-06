/**
 * Mixed-magazine loading interface (Feature 3).
 *
 * An ApplicationV2 window that shows the weapon's magazine as a grid of slots.
 * The user drags ammo items (from inventory, a compendium, or another slot) into
 * slots to chamber rounds; slots can be freely rearranged and cleared. On
 * Confirm we deduct the loaded rounds from the source inventory ammo stacks and
 * persist the ordered magazine stack on the weapon. On Cancel nothing is written
 * (inventory is only touched on confirm), so rounds are effectively "returned".
 *
 * Storage: `weapon.flags.<module>.magazineStack` = ordered array (index 0 = top,
 * fired first). Each entry: { type, variety, name, img, ammoId, ablationValue }.
 */

import { MODULE_ID, FLAGS, L, getFlag } from "../constants.js";
import { getCPRConfig } from "../system-api.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export default class MagazineLoader extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {Item} weapon
   * @param {Object} options
   */
  constructor(weapon, options = {}) {
    super(options);
    this.weapon = weapon;
    this.actor = weapon.actor;
    this._settled = false;
    // Working copy of the magazine, an array of slot entries or null (empty).
    this.slots = this.#initSlots();
    // Per-ammo loading budget = current inventory stock PLUS the rounds of that
    // ammo already chambered in the initial (committed) magazine, because those
    // were already debited from inventory by the previous commit. Without this
    // credit, reopening a partially-loaded magazine would double-count them and
    // block legitimate top-offs.
    this.budgets = this.#initBudgets();
    this._resolve = null;
    this._promise = new Promise((res) => {
      this._resolve = res;
    });
  }

  /**
   * Build the per-ammo budget map (see constructor note).
   *
   * @returns {Map<String, Number>}
   */
  #initBudgets() {
    const budgets = new Map();
    for (const ammo of this.actor?.itemTypes?.ammo || []) {
      budgets.set(ammo.id, ammo.system.amount ?? 0);
    }
    // Credit back rounds already chambered in the initial stack.
    for (const slot of this.slots) {
      if (slot?.ammoId && budgets.has(slot.ammoId)) {
        budgets.set(slot.ammoId, budgets.get(slot.ammoId) + 1);
      }
    }
    return budgets;
  }

  static DEFAULT_OPTIONS = {
    id: "cpr-wa-magazine-loader",
    classes: ["cpr", "sheet", "cpr-wa-magazine-loader"],
    tag: "form",
    window: {
      title: "CPR-WA.mixedMag.title",
      resizable: true,
    },
    position: { width: 520, height: "auto" },
    actions: {
      confirm: MagazineLoader.onConfirm,
      cancel: MagazineLoader.onCancel,
      clearSlot: MagazineLoader.onClearSlot,
      autofill: MagazineLoader.onAutofill,
    },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/magazine-loader.hbs` },
  };

  /**
   * The magazine capacity (respects the system's upgrade-aware getter).
   *
   * @returns {Number}
   */
  get capacity() {
    try {
      const space = this.weapon.getMagazineSpace?.();
      const value = this.weapon.system.magazine.value;
      // getMagazineSpace returns free space; capacity = free + current.
      if (Number.isFinite(space)) return space + value;
    } catch (e) {
      /* fall through */
    }
    return this.weapon.system.magazine.max;
  }

  /**
   * Build the initial slot list from the existing stack, padded to capacity.
   *
   * @returns {Array<Object|null>}
   */
  #initSlots() {
    // Use the upgrade-aware capacity so extended-magazine upgrades expose their
    // extra slots, matching the system's getMagazineSpace() sizing.
    const cap = Math.max(this.capacity || 0, this.weapon.system.magazine.max || 0);
    const stack = foundry.utils.duplicate(getFlag(this.weapon, FLAGS.MAGAZINE_STACK, []));
    const slots = new Array(cap).fill(null);
    for (let i = 0; i < Math.min(stack.length, cap); i += 1) {
      slots[i] = stack[i];
    }
    return slots;
  }

  /** @override */
  async _prepareContext() {
    const CPR = await getCPRConfig();
    const slots = this.slots.map((entry, index) => ({
      index,
      filled: !!entry,
      entry,
      typeLabel: entry ? game.i18n.localize(CPR.ammoTypes[entry.type] || entry.type) : "",
    }));
    // Ammo available in the actor's inventory, matching the weapon's varieties.
    // `remaining` reflects stock minus rounds already placed into slots, so the
    // count visibly decreases as the magazine is filled.
    const varieties = this.weapon.system.ammoVariety || [];
    const inventory = (this.actor?.itemTypes?.ammo || [])
      .filter((a) => varieties.length === 0 || varieties.includes(a.system.variety))
      .map((a) => {
        const budget = this.budgets.get(a.id) ?? a.system.amount ?? 0;
        const remaining = budget - this.#placedCount(a.id);
        return {
          id: a.id,
          name: a.name,
          img: a.img,
          amount: budget, // budget = stock + rounds already in the magazine
          remaining: Math.max(0, remaining),
          depleted: remaining <= 0,
          type: a.system.type,
          typeLabel: game.i18n.localize(CPR.ammoTypes[a.system.type] || a.system.type),
        };
      });

    const filledCount = this.slots.filter(Boolean).length;
    return {
      weaponName: this.weapon.name,
      slots,
      inventory,
      capacity: this.capacity,
      filledCount,
      L: {
        confirm: L("mixedMag.confirm"),
        cancel: L("mixedMag.cancel"),
        autofill: L("mixedMag.autofill"),
        magazine: L("mixedMag.magazineLabel"),
        inventory: L("mixedMag.inventoryLabel"),
        empty: L("mixedMag.emptySlot"),
        dragHint: L("mixedMag.dragHint"),
      },
    };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;

    // Make inventory ammo entries draggable.
    root.querySelectorAll("[data-ammo-id]").forEach((el) => {
      el.setAttribute("draggable", "true");
      el.addEventListener("dragstart", (ev) => this.#onDragStartInventory(ev));
    });

    // Make filled slots draggable (for rearranging) and all slots drop targets.
    root.querySelectorAll(".cpr-wa-slot").forEach((el) => {
      const idx = Number(el.dataset.slot);
      if (this.slots[idx]) {
        el.setAttribute("draggable", "true");
        el.addEventListener("dragstart", (ev) => this.#onDragStartSlot(ev, idx));
      }
      el.addEventListener("dragover", (ev) => ev.preventDefault());
      el.addEventListener("drop", (ev) => this.#onDropSlot(ev, idx));
    });
  }

  /**
   * Begin dragging an inventory ammo item into the magazine.
   *
   * @param {DragEvent} ev
   */
  #onDragStartInventory(ev) {
    const ammoId = ev.currentTarget.dataset.ammoId;
    ev.dataTransfer.setData(
      "text/plain",
      JSON.stringify({ cprWaSource: "inventory", ammoId })
    );
  }

  /**
   * Begin dragging a chambered round from one slot to another.
   *
   * @param {DragEvent} ev
   * @param {Number} fromIndex
   */
  #onDragStartSlot(ev, fromIndex) {
    ev.dataTransfer.setData(
      "text/plain",
      JSON.stringify({ cprWaSource: "slot", fromIndex })
    );
  }

  /**
   * Handle a drop on a magazine slot (from inventory, another slot, or a
   * standard Foundry item drag e.g. from a compendium).
   *
   * @param {DragEvent} ev
   * @param {Number} slotIndex
   */
  async #onDropSlot(ev, slotIndex) {
    ev.preventDefault();
    let data;
    try {
      data = JSON.parse(ev.dataTransfer.getData("text/plain"));
    } catch (e) {
      return;
    }

    // Rearrange between slots (swap).
    if (data.cprWaSource === "slot") {
      const from = data.fromIndex;
      const tmp = this.slots[slotIndex];
      this.slots[slotIndex] = this.slots[from];
      this.slots[from] = tmp;
      this.render();
      return;
    }

    // From our inventory list.
    if (data.cprWaSource === "inventory") {
      const ammo = this.actor?.items?.get(data.ammoId);
      if (ammo) this.#placeRound(ammo, slotIndex);
      this.render();
      return;
    }

    // Standard Foundry drop (compendium / sidebar / other actor).
    if (data.type === "Item" || data.uuid) {
      const doc = await Item.implementation.fromDropData(data);
      if (doc && doc.type === "ammo") {
        this.#placeRound(doc, slotIndex);
        this.render();
      } else {
        ui.notifications.warn(L("mixedMag.notAmmo"));
      }
    }
  }

  /**
   * How many rounds of a given inventory ammo item are already chambered in the
   * working slots, optionally excluding one slot (the target of a placement).
   *
   * @param {String} ammoId
   * @param {Number} [excludeSlot]
   * @returns {Number}
   */
  #placedCount(ammoId, excludeSlot = -1) {
    let n = 0;
    for (let i = 0; i < this.slots.length; i += 1) {
      if (i === excludeSlot) continue;
      if (this.slots[i]?.ammoId === ammoId) n += 1;
    }
    return n;
  }

  /**
   * Rounds of an inventory ammo item still available to load: the per-ammo budget
   * (stock + rounds already in the initial magazine) minus what's currently
   * chambered in the working slots. Compendium/foreign ammo has no inventory id
   * (or no budget entry) and is treated as unlimited — nothing is debited on
   * confirm for those.
   *
   * @param {String} ammoId
   * @param {Number} [excludeSlot]
   * @returns {Number}
   */
  #availableFor(ammoId, excludeSlot = -1) {
    if (!ammoId || !this.budgets?.has(ammoId)) return Infinity;
    return this.budgets.get(ammoId) - this.#placedCount(ammoId, excludeSlot);
  }

  /**
   * Put one round of an ammo item into a slot, enforcing variety compatibility
   * and available stock (so a single round can't fill the whole magazine).
   *
   * @param {Item} ammo
   * @param {Number} slotIndex
   */
  #placeRound(ammo, slotIndex) {
    // Respect variety compatibility.
    const varieties = this.weapon.system.ammoVariety || [];
    if (varieties.length && !varieties.includes(ammo.system.variety)) {
      ui.notifications.warn(L("mixedMag.wrongVariety"));
      return;
    }
    // Enforce inventory stock: placing into this slot consumes one more round of
    // this ammo (unless the slot already holds the same ammo). Exclude the target
    // slot from the "already placed" count so replacing same-ammo is free.
    const ammoId = ammo.id ?? null;
    if (ammoId && this.#availableFor(ammoId, slotIndex) <= 0) {
      ui.notifications.warn(L("mixedMag.outOfStock", { name: ammo.name }));
      return;
    }
    this.slots[slotIndex] = {
      type: ammo.system.type,
      variety: ammo.system.variety,
      name: ammo.name,
      img: ammo.img,
      ammoId,
      ablationValue: ammo.system.ablationValue ?? 1,
    };
  }

  /**
   * Wait for the user's confirm/cancel decision.
   *
   * @returns {Promise<Boolean>} true if loaded, false if cancelled
   */
  async wait() {
    this.render(true);
    return this._promise;
  }

  /**
   * Ensure the promise always resolves, even if the window is dismissed via the
   * title-bar close button or Escape (which don't route through our actions).
   *
   * @override
   */
  _onClose(options) {
    super._onClose?.(options);
    if (!this._settled) {
      this._settled = true;
      this._resolve(false);
    }
  }

  // --- Static action handlers (invoked with `this` = the app instance) ---

  static onClearSlot(event, target) {
    const idx = Number(target.dataset.slot);
    this.slots[idx] = null;
    this.render();
  }

  static onAutofill() {
    // Fill empty slots (top-down) with whatever compatible ammo is still
    // available, using the same budget the manual placement respects.
    const varieties = this.weapon.system.ammoVariety || [];
    const available = (this.actor?.itemTypes?.ammo || []).filter(
      (a) => varieties.length === 0 || varieties.includes(a.system.variety)
    );
    if (!available.length) {
      ui.notifications.warn(L("mixedMag.noAmmo"));
      return;
    }
    let placedAny = false;
    for (let i = 0; i < this.slots.length; i += 1) {
      if (this.slots[i]) continue;
      // Pick the first ammo that still has budget once current slots are counted.
      const next = available.find((a) => this.#availableFor(a.id, i) > 0);
      if (!next) break;
      this.#placeRound(next, i);
      placedAny = true;
    }
    if (!placedAny) ui.notifications.warn(L("mixedMag.noAmmo"));
    this.render();
  }

  static async onCancel() {
    this._settled = true;
    this._resolve(false);
    this.close();
  }

  static async onConfirm() {
    await this.#commit();
    this._settled = true;
    this._resolve(true);
    this.close();
  }

  /**
   * Persist the loaded magazine: reconcile inventory counts vs the previous
   * stack (deduct newly-loaded rounds, return removed rounds) and save the stack.
   */
  async #commit() {
    const previous = getFlag(this.weapon, FLAGS.MAGAZINE_STACK, []);
    const newStack = this.slots.filter(Boolean);

    // Net change per ammo item: (loaded now) - (loaded before) => deduct from inventory.
    const delta = new Map();
    for (const entry of newStack) {
      if (!entry.ammoId) continue;
      delta.set(entry.ammoId, (delta.get(entry.ammoId) || 0) + 1);
    }
    for (const entry of previous) {
      if (!entry.ammoId) continue;
      delta.set(entry.ammoId, (delta.get(entry.ammoId) || 0) - 1);
    }

    const updates = [];
    for (const [ammoId, count] of delta.entries()) {
      if (count === 0) continue;
      const ammo = this.actor?.items?.get(ammoId);
      if (!ammo) continue; // ammo item gone (e.g. dragged from compendium) — skip stock change
      // count > 0 => we consumed `count` rounds from inventory; < 0 => returned.
      const newAmount = Math.max(0, (ammo.system.amount ?? 0) - count);
      updates.push({ _id: ammo.id, "system.amount": newAmount });
    }
    if (updates.length) {
      await this.actor.updateEmbeddedDocuments("Item", updates);
    }

    await this.weapon.update({
      [`flags.${MODULE_ID}.${FLAGS.MAGAZINE_STACK}`]: newStack,
      "system.magazine.value": newStack.length,
    });
  }
}
