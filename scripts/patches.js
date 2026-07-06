/**
 * Patch infrastructure.
 *
 * The system's weapon methods are attached to each item instance as OWN
 * properties inside `CPRItem#loadMixins()`, which the system re-runs on every
 * `prepareDerivedData()`. That means we cannot patch them once on the prototype
 * — the system would overwrite our patch on the next data-prep cycle.
 *
 * Strategy:
 *  - Wrap the prototype `loadMixins`. After the system finishes (re)attaching
 *    its mixin methods, we re-apply our per-instance wrappers. This keeps our
 *    behaviour in place across every re-prep.
 *  - Prototype-level methods (`confirmRoll`, `createRoll`) are wrapped once
 *    directly on the prototype.
 *
 * Each feature registers "instance wrappers" (functions that decorate the
 * freshly-attached mixin methods on an item) and/or is wired directly to the
 * prototype from its own module.
 */

import { MODULE_ID } from "./constants.js";

// Registry of per-instance wrapper installers, keyed by an id so re-registration
// is idempotent. Each installer receives the item and re-wraps its own methods.
const instanceWrappers = new Map();

/**
 * Register a function that (re)installs wrappers on a weapon item instance.
 * Called after every loadMixins() run for eligible items.
 *
 * @param {String} id - unique id for this wrapper set
 * @param {(item: Item) => void} installer
 */
export function registerInstanceWrapper(id, installer) {
  instanceWrappers.set(id, installer);
}

/**
 * A tiny helper for instance wrappers: replace `item[method]` with a wrapper
 * that receives the original bound function as its first argument. Marks the
 * method so we don't double-wrap within a single loadMixins pass.
 *
 * @param {Item} item
 * @param {String} method - method name on the item instance
 * @param {(original: Function, ...args) => any} wrapper - `this` is the item
 */
export function wrapInstanceMethod(item, method, wrapper) {
  const original = item[method];
  if (typeof original !== "function") return;
  item[method] = function cprWaWrapped(...args) {
    return wrapper.call(this, original.bind(this), ...args);
  };
}

/**
 * Install the loadMixins wrapper on CPRItem's prototype. Idempotent.
 */
export function installLoadMixinsHook() {
  const ItemClass = CONFIG.Item.documentClass;
  const proto = ItemClass.prototype;
  if (proto._cprWaLoadMixinsPatched) return;

  const originalLoadMixins = proto.loadMixins;
  proto.loadMixins = function cprWaLoadMixins(...args) {
    const result = originalLoadMixins.apply(this, args);
    // Only weapons (and weapon-type upgrades) get attackable/loadable mixins.
    if (this.type === "weapon") {
      for (const installer of instanceWrappers.values()) {
        try {
          installer(this);
        } catch (err) {
          console.error(`${MODULE_ID} | instance wrapper failed`, err);
        }
      }
    }
    return result;
  };
  proto._cprWaLoadMixinsPatched = true;
}

// Track which (class, method, wrapperId) combinations we have already installed
// so re-running registration (e.g. on a soft reload) does not double-wrap, while
// still allowing DIFFERENT features to stack wrappers on the same method.
const wrappedProtoKeys = new Set();

/**
 * Generic prototype wrapper: replaces `Class.prototype[method]` with a wrapper
 * that receives the current (possibly already-wrapped) function first. Multiple
 * features may stack on the same method; each `wrapperId` is installed once.
 *
 * @param {Function} klass
 * @param {String} method
 * @param {(original: Function, ...args) => any} wrapper - `this` is the instance
 * @param {String} [wrapperId] - unique id for this wrapper (defaults to method)
 */
export function wrapPrototype(klass, method, wrapper, wrapperId = method) {
  const proto = klass.prototype;
  const key = `${klass.name}#${method}#${wrapperId}`;
  if (wrappedProtoKeys.has(key)) return;
  wrappedProtoKeys.add(key);
  const original = proto[method];
  proto[method] = function cprWaProtoWrapped(...args) {
    return wrapper.call(this, original, ...args);
  };
}
