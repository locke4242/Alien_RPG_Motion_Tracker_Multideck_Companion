/**
 * Alien RPG - Motion Tracker Multideck Companion
 * ------------------------------------------------
 *
 * PURPOSE
 * This module lets the Alien RPG Motion Tracker treat several Foundry Scenes as
 * different physical levels of the same ship, station, or facility. The original
 * Motion Tracker normally scans only the Scene the user is looking at. This
 * companion temporarily gives it a combined view containing the current Scene
 * plus "stand-in" copies of tokens from linked Scenes.
 *
 * IMPORTANT DESIGN CHOICES
 * 1. The original Motion Tracker files are never edited. This makes updates to
 *    the original module much less likely to impact this companion's work.
 * 2. No real tokens are copied, moved, or saved. Remote tokens are represented by
 *    short-lived plain JavaScript objects that exist only while one tracker scan
 *    is being calculated.
 *
 * HOW MAP MATCHING WORKS
 * A "matching point" is the same physical place marked once on Scene A and once
 * on Scene B, such as the center of a ladder or lift.
 *   - 0 points: assume both maps already use the same coordinates.
 *   - 1 point: move one map so that point lines up.
 *   - 2 points: also allow rotation and proportional resizing.
 *   - 3+ points: allow a more general map correction if one image is stretched.
 *
 * HOW RANGE BETWEEN LEVELS WORKS
 * The motion tracker is two-dimensional. For contacts on another Scene, this
 * module combines the horizontal map distance with the configured vertical
 * separation using the Pythagorean theorem. It then places the temporary stand-in
 * farther from the center so the original Motion Tracker reports that 3D range.
 */

const MODULE_ID = "motion-tracker-multideck";
const LINKS_SETTING = "links";
const PATCH_FLAG = Symbol.for("motion-tracker-multideck.update-patched");

const IDENTITY = Object.freeze({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });

/**
 * Make a separate copy of a value.
 *
 * Why: the settings screen edits a draft copy. We do not want typing in the
 * window to change the saved settings until the GM presses Save.
 */
function clone(value) {
  if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Turn a value into a usable number. If it is missing or invalid, return a safe
 * fallback instead of letting NaN spread through distance calculations.
 */
function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Check that a saved map point has valid X and Y numbers.
 * Returns a clean {x, y} object, or null when the point is incomplete.
 */
function finitePoint(point) {
  if (!point) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Put one matching-point pair into the exact shape the rest of the module expects.
 * Blank coordinates stay blank so the GM can fill them in later.
 */
function normalizeAnchor(anchor = {}) {
  return {
    a: finitePoint(anchor.a) ?? { x: "", y: "" },
    b: finitePoint(anchor.b) ?? { x: "", y: "" }
  };
}

/**
 * Clean one saved Scene link.
 *
 * This also supplies defaults for older or incomplete settings, which is why the
 * module can be updated without forcing the GM to rebuild existing links.
 */
function normalizeLink(link = {}) {
  return {
    id: String(link.id || foundry.utils.randomID()),
    name: String(link.name || ""),
    enabled: link.enabled !== false,
    sceneA: String(link.sceneA || ""),
    sceneB: String(link.sceneB || ""),
    elevationDelta: finiteNumber(link.elevationDelta, 0),
    verticalBearing: link.verticalBearing === "center" ? "center" : "deterministic",
    anchors: Array.isArray(link.anchors) ? link.anchors.slice(0, 8).map(normalizeAnchor) : []
  };
}

/**
 * Read all saved Scene links from Foundry world settings and normalize them.
 * The code accepts both the current wrapper object and an older plain-array form.
 */
function getStoredLinks() {
  const stored = game.settings.get(MODULE_ID, LINKS_SETTING) ?? { version: 1, links: [] };
  const links = Array.isArray(stored) ? stored : stored.links;
  return Array.isArray(links) ? links.map(normalizeLink) : [];
}

/**
 * Return only matching points where BOTH Scene A and Scene B have valid numbers.
 * Half-finished rows are ignored until the GM completes them.
 */
function completeAnchorPairs(link) {
  return (link.anchors || [])
    .map(anchor => ({ a: finitePoint(anchor.a), b: finitePoint(anchor.b) }))
    .filter(anchor => anchor.a && anchor.b);
}

/**
 * Convert a point from one Scene's map coordinates into another Scene's map
 * coordinates using the six numbers stored in a 2D transform.
 *
 * You can think of the transform as a recipe for moving, rotating, resizing, or
 * gently stretching the remote map until its marked points line up with this map.
 */
function applyTransform(t, p) {
  return {
    x: t.a * p.x + t.c * p.y + t.tx,
    y: t.b * p.x + t.d * p.y + t.ty
  };
}

// Compose transforms as outer(inner(point)).
/**
 * Combine two map-conversion recipes into one.
 *
 * This matters when more than two Scenes are linked, such as A <-> B <-> C. A
 * token on C may need to be converted C->B and then B->A. Combining the recipes
 * lets us calculate that final C->A position cleanly.
 */
function composeTransforms(outer, inner) {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty
  };
}

/**
 * Build the simplest map conversion: move every point by the same X/Y amount.
 * This is used when the GM supplied exactly one matching point.
 */
function translationTransform(from, to) {
  return { a: 1, b: 0, c: 0, d: 1, tx: to.x - from.x, ty: to.y - from.y };
}

/**
 * Build a map conversion from two matching points.
 *
 * Two points tell us enough to correct position, rotation, and uniform scale.
 * "Uniform scale" means the map can become larger or smaller, but is not stretched
 * differently from side to side.
 */
function similarityTransform(from0, from1, to0, to1) {
  const px = from1.x - from0.x;
  const py = from1.y - from0.y;
  const qx = to1.x - to0.x;
  const qy = to1.y - to0.y;
  const den = px * px + py * py;
  if (den < 1e-8) return translationTransform(from0, to0);

  const re = (qx * px + qy * py) / den;
  const im = (qy * px - qx * py) / den;
  const t = {
    a: re,
    b: im,
    c: -im,
    d: re,
    tx: 0,
    ty: 0
  };
  const mapped = applyTransform(t, from0);
  t.tx = to0.x - mapped.x;
  t.ty = to0.y - mapped.y;
  return t;
}

/**
 * Small math helper used by the three-point alignment below. It calculates the
 * determinant of a 3x3 matrix. A normal GM never needs to interact with this; it
 * is simply the math used to determine whether three points can define a map.
 */
function det3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
       - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
       + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

/**
 * Solve a three-equation system using Cramer's rule.
 *
 * Why: three matching points can define a full 2D affine transform. If the points
 * accidentally fall on one straight line, there is not enough information, so
 * this returns null and the caller falls back to the safer two-point method.
 */
function solve3(m, rhs) {
  const determinant = det3(m);
  if (Math.abs(determinant) < 1e-8) return null;

  const mx = [
    [rhs[0], m[0][1], m[0][2]],
    [rhs[1], m[1][1], m[1][2]],
    [rhs[2], m[2][1], m[2][2]]
  ];
  const my = [
    [m[0][0], rhs[0], m[0][2]],
    [m[1][0], rhs[1], m[1][2]],
    [m[2][0], rhs[2], m[2][2]]
  ];
  const mz = [
    [m[0][0], m[0][1], rhs[0]],
    [m[1][0], m[1][1], rhs[1]],
    [m[2][0], m[2][1], rhs[2]]
  ];

  return [det3(mx) / determinant, det3(my) / determinant, det3(mz) / determinant];
}

/**
 * Build the most flexible map conversion from three or more matching points.
 *
 * It searches for any three points that are not all on one straight line. Those
 * three pairs can account for movement, rotation, resizing, and uneven stretching.
 */
function affineTransform(from, to) {
  // Find any non-collinear triplet, not necessarily the first three anchors.
  for (let i = 0; i < from.length - 2; i++) {
    for (let j = i + 1; j < from.length - 1; j++) {
      for (let k = j + 1; k < from.length; k++) {
        const m = [
          [from[i].x, from[i].y, 1],
          [from[j].x, from[j].y, 1],
          [from[k].x, from[k].y, 1]
        ];
        const sx = solve3(m, [to[i].x, to[j].x, to[k].x]);
        const sy = solve3(m, [to[i].y, to[j].y, to[k].y]);
        if (sx && sy) {
          return { a: sx[0], c: sx[1], tx: sx[2], b: sy[0], d: sy[1], ty: sy[2] };
        }
      }
    }
  }
  return null;
}

/**
 * Choose the correct map-matching method for one Scene link.
 *
 * 0 complete pairs -> maps are assumed already aligned.
 * 1 pair           -> shift only.
 * 2 pairs          -> shift + rotate + resize.
 * 3 or more        -> full affine correction when possible.
 */
function transformBetween(link, fromSide, toSide) {
  const pairs = completeAnchorPairs(link);
  if (!pairs.length) return { ...IDENTITY };

  const from = pairs.map(pair => pair[fromSide]);
  const to = pairs.map(pair => pair[toSide]);

  if (pairs.length === 1) return translationTransform(from[0], to[0]);
  if (pairs.length === 2) return similarityTransform(from[0], from[1], to[0], to[1]);

  return affineTransform(from, to) ?? similarityTransform(from[0], from[1], to[0], to[1]);
}

/**
 * Turn a token identity into a repeatable angle around the tracker.
 *
 * A contact exactly above or below the user has no real 2D direction. When the GM
 * chooses the "consistent direction" option, this gives that contact an arbitrary
 * but stable direction so its blip does not jump around from scan to scan.
 */
function hashAngle(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
}

/**
 * Find every linked Scene reachable from the Scene currently being scanned.
 *
 * The links form a small network. For example, Scene A may link to B, and B to C.
 * This function walks that network once, avoiding loops, and records for each remote
 * Scene: (a) how to map its coordinates back to the current Scene and (b) how far
 * above/below it is.
 */
function buildTraversal(baseSceneId) {
  const links = getStoredLinks().filter(link =>
    link.enabled && link.sceneA && link.sceneB && link.sceneA !== link.sceneB
  );
  if (!links.length) return [];

  // Build a lookup table that says, for each Scene, which linked Scenes can be
  // reached directly from it. We store both directions because a link must work
  // whether the tracker user happens to be on Scene A or Scene B.
  const adjacency = new Map();
  const addEdge = (sceneId, edge) => {
    if (!adjacency.has(sceneId)) adjacency.set(sceneId, []);
    adjacency.get(sceneId).push(edge);
  };

  for (const link of links) {
    // Calculate both coordinate directions once. A->B maps positions from Scene A
    // onto Scene B; B->A does the reverse. The scan later uses whichever direction
    // leads back toward the Scene the player is currently viewing.
    const aToB = transformBetween(link, "a", "b");
    const bToA = transformBetween(link, "b", "a");
    const dz = finiteNumber(link.elevationDelta, 0);

    addEdge(link.sceneA, {
      neighbor: link.sceneB,
      neighborToCurrent: bToA,
      dzFromCurrentToNeighbor: dz,
      verticalBearing: link.verticalBearing
    });
    addEdge(link.sceneB, {
      neighbor: link.sceneA,
      neighborToCurrent: aToB,
      dzFromCurrentToNeighbor: -dz,
      verticalBearing: link.verticalBearing
    });
  }

  // Breadth-first search is used here because it is simple, predictable, and avoids
  // following a circular chain forever (for example A->B->C->A). "visited" ensures
  // every Scene is processed at most once.
  const visited = new Set([baseSceneId]);
  const queue = [{ sceneId: baseSceneId, toBase: { ...IDENTITY }, z: 0, verticalBearing: "deterministic" }];
  const results = [];

  while (queue.length) {
    const current = queue.shift();
    for (const edge of adjacency.get(current.sceneId) ?? []) {
      if (visited.has(edge.neighbor)) continue;
      visited.add(edge.neighbor);

      // Carry forward both kinds of information through the chain:
      // - toBase converts this newly found Scene all the way back to the user's Scene.
      // - z adds the vertical separation from every link crossed so far.
      const next = {
        sceneId: edge.neighbor,
        toBase: composeTransforms(current.toBase, edge.neighborToCurrent),
        z: current.z + edge.dzFromCurrentToNeighbor,
        verticalBearing: edge.verticalBearing === "center" ? "center" : current.verticalBearing
      };
      results.push(next);
      queue.push(next);
    }
  }

  return results;
}

/**
 * Return the center point of a token.
 */
function tokenCenter(device, token) {
  if (typeof device.computeTokenCenter === "function") return device.computeTokenCenter(token);
  return { x: finiteNumber(token.x) + finiteNumber(token.width) * 0.5, y: finiteNumber(token.y) + finiteNumber(token.height) * 0.5 };
}

/**
 * Build the temporary combined Scene that is the heart of how this module works.
 *
 * The returned object contains:
 *   - every real token from the current Scene, unchanged; and
 *   - temporary token-like stand-ins for contacts on linked Scenes.
 *
 * Those stand-ins are placed where the original Motion Tracker expects to find them
 * after map alignment and vertical-distance correction. Nothing is saved to Foundry.
 */
function buildAugmentedScene(device) {
  const baseSceneId = device.viewedSceneId;
  const baseScene = game.scenes.get(baseSceneId);
  if (!baseScene || !device.tokenReference) return null;

  const traversal = buildTraversal(baseSceneId);
  if (!traversal.length) return null;

  // Keep the current Scene's real tokens exactly as they are. Remote contacts will
  // be added separately as temporary stand-ins called "proxies" below.
  const baseTokens = Array.from(baseScene.tokens ?? []);
  const proxies = [];
  // The reference token is the character holding/using the Motion Tracker. Every
  // contact position and range is measured from this token's center.
  const reference = tokenCenter(device, device.tokenReference);
  const referenceActorId = device.tokenReference.actorId ?? device.tokenReference.actor?.id ?? null;

  const gridSize = finiteNumber(baseScene.grid?.size, 100) || 100;
  const gridDistance = finiteNumber(baseScene.grid?.distance, 1) || 1;

  for (const state of traversal) {
    const remoteScene = game.scenes.get(state.sceneId);
    if (!remoteScene) continue;

    for (const token of remoteScene.tokens ?? []) {
      const actorId = token.actorId ?? token.actor?.id ?? null;

      // Teleporter setups sometimes leave a copy of the same player Actor on both
      // Scenes. Ignoring the tracker user's own Actor prevents a false self-contact.
      if (referenceActorId && actorId === referenceActorId) continue;

      // First translate the remote token's map position into the coordinate system of
      // the Scene the player is currently viewing. After this line, "mapped" can be
      // compared directly with the tracker user's position.
      const remoteCenter = tokenCenter(device, token);
      const mapped = applyTransform(state.toBase, remoteCenter);
      let dx = mapped.x - reference.x;
      let dy = mapped.y - reference.y;
      // Foundry map positions are pixels, while Motion Tracker range is expressed in
      // Scene distance units such as meters. Convert horizontal distance first, then
      // combine it with the physical vertical separation: sqrt(horizontal²+vertical²).
      const horizontalPx = Math.hypot(dx, dy);
      const horizontalUnits = horizontalPx / gridSize * gridDistance;
      const verticalUnits = Math.abs(finiteNumber(state.z, 0));
      const totalUnits = Math.hypot(horizontalUnits, verticalUnits);

      let projectedX = mapped.x;
      let projectedY = mapped.y;

      if (verticalUnits > 0) {
        if (horizontalPx > 1e-6 && horizontalUnits > 1e-6) {
          // The base Motion Tracker knows only 2D distance. To make it display the
          // correct 3D range without rewriting it, push the stand-in farther outward
          // along the SAME horizontal bearing until its 2D radius equals totalUnits.
          const projectedRadiusPx = totalUnits / gridDistance * gridSize;
          const scale = projectedRadiusPx / horizontalPx;
          projectedX = reference.x + dx * scale;
          projectedY = reference.y + dy * scale;
        } else if (state.verticalBearing === "deterministic") {
          // If horizontal distance is zero, there is no genuine compass direction.
          // Use a repeatable artificial direction so the blip still communicates the
          // correct distance without revealing "this is directly above/below you."
          const angle = hashAngle(`${state.sceneId}:${token.id ?? actorId ?? "token"}`);
          const projectedRadiusPx = totalUnits / gridDistance * gridSize;
          projectedX = reference.x + Math.cos(angle) * projectedRadiusPx;
          projectedY = reference.y + Math.sin(angle) * projectedRadiusPx;
        }
        // "center" intentionally leaves exact-overlap contacts at the center.
      }

      // The base Motion Tracker only needs these token-like properties. Width and height
      // are set to zero so its computeTokenCenter() returns the already-transformed center.
      proxies.push({
        id: `md:${state.sceneId}:${token.id ?? foundry.utils.randomID()}`,
        actorId,
        actor: token.actor,
        x: projectedX,
        y: projectedY,
        width: 0,
        height: 0,
        hidden: token.hidden,
        _motionTrackerMultiDeckSource: token,
        _motionTrackerMultiDeckSceneId: state.sceneId,
        _motionTrackerMultiDeckVerticalDistance: verticalUnits
      });
    }
  }

  if (!proxies.length) return null;

  // The base module's update loop currently reads only scene.tokens and scene.grid.
  return {
    id: baseScene.id,
    name: baseScene.name,
    tokens: [...baseTokens, ...proxies],
    grid: baseScene.grid
  };
}

/**
 * Extend the Motion Tracker device's update function without editing its source file.
 *
 * During each scan we briefly make game.scenes.get(currentScene) return our temporary
 * combined Scene. The original Motion Tracker runs normally against that object. As
 * soon as that single update finishes, game.scenes.get is restored in a finally block
 * even if an error occurs. This narrow, temporary change is what keeps the companion
 * isolated from the rest of Foundry.
 */
function patchDevicePrototype(device) {
  if (!device) return false;
  const proto = Object.getPrototypeOf(device);
  if (!proto || proto[PATCH_FLAG]) return true;

  // Save the original function before replacing it. Almost all tracker behavior stays
  // inside that original function; this companion only changes the Scene data it sees.
  const originalUpdate = proto.update;
  if (typeof originalUpdate !== "function") return false;

  const patchedUpdate = function(delta) {
    const syntheticScene = buildAugmentedScene(this);
    if (!syntheticScene) return originalUpdate.call(this, delta);

    const scenes = game.scenes;

    // Save Foundry's real Collection#get method so it can be restored immediately
    // after this single scan calculation.
    const originalGet = scenes.get;
    const viewedSceneId = this.viewedSceneId;

    // Synchronously shadow Collection#get only while the base Motion Tracker performs
    // this one update. No Foundry documents are changed or persisted.
    scenes.get = function(id, options) {
      if (id === viewedSceneId) return syntheticScene;
      return originalGet.call(this, id, options);
    };

    try {
      return originalUpdate.call(this, delta);
    } finally {
      scenes.get = originalGet;
    }
  };

  // Mark the prototype so opening the tracker again does not wrap the same function
  // a second time. Double-wrapping would waste work and could create confusing bugs.
  Object.defineProperty(proto, PATCH_FLAG, { value: true, configurable: false });
  Object.defineProperty(proto, "_motionTrackerMultiDeckOriginalUpdate", { value: originalUpdate, configurable: false });
  proto.update = patchedUpdate;

  // If PIXI already registered the old callback before we patched the prototype,
  // replace that callback on the current instance.
  const ticker = device.pixi?.app?.ticker;
  if (ticker) {
    try {
      ticker.remove(originalUpdate, device);
      ticker.add(patchedUpdate, device);
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not replace already-registered ticker callback`, err);
    }
  }

  console.log(`${MODULE_ID} | Motion Tracker scan extended to linked Scenes.`);
  return true;
}

/**
 * Try several times to find and patch the tracker device after its window opens.
 *
 * The Motion Tracker creates its PIXI display asynchronously, so the device may not
 * exist on the very first millisecond. Short retries avoid race conditions without
 * making the user wait or requiring changes to the original module.
 */
function patchCurrentDeviceWithRetries() {
  // These short delays cover the normal window-creation timing observed in the base
  // module while still stopping after one second.
  const delays = [0, 25, 100, 300, 1000];
  for (const delay of delays) {
    setTimeout(() => {
      const device = game.motion_tracker?.window?.device;
      if (device) patchDevicePrototype(device);
    }, delay);
  }
}

/**
 * Wrap the original Motion Tracker open() method.
 *
 * We let the original module open exactly as it normally would, then make sure its
 * newly-created device is using our extended scan behavior.
 */
function patchMotionTrackerOpen() {
  const tracker = game.motion_tracker;
  if (!tracker || tracker._motionTrackerMultiDeckOpenPatched) return false;

  const originalOpen = tracker.open;
  if (typeof originalOpen !== "function") return false;

  tracker.open = async function(...args) {
    // Never interfere with opening the tracker itself. Wait for the original open()
    // operation to finish, then attach our scan extension to the device it created.
    const result = await originalOpen.apply(this, args);
    patchCurrentDeviceWithRetries();
    return result;
  };
  tracker._motionTrackerMultiDeckOpenPatched = true;
  patchCurrentDeviceWithRetries();
  console.log(`${MODULE_ID} | Motion Tracker open() patched.`);
  return true;
}

/**
 * GM settings window for creating and editing Scene links.
 *
 * This is deliberately an old-style FormApplication because Alien RPG - Motion
 * Tracker 1.5.5 also uses Foundry's appv1 compatibility API on Foundry v14. Keeping
 * the companion in the same application family reduces unnecessary compatibility
 * risk.
 */
class SceneLinkManager extends foundry.appv1.api.FormApplication {
  /**
   * Start the window with a draft copy of the saved links. The draft lets the GM
   * make several edits and cancel/close without changing the world setting.
   */
  constructor(object = {}, options = {}) {
    super(object, options);
    this._draft = getStoredLinks();
    this._capture = null;
  }

  /**
   * Standard Foundry window options: title, template, size, and CSS class.
   */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "motion-tracker-multideck-link-manager",
      title: "Alien RPG - Motion Tracker Multideck Companion — Scene Links",
      template: `modules/${MODULE_ID}/templates/link-manager.hbs`,
      width: 760,
      height: "auto",
      closeOnSubmit: false,
      submitOnChange: false,
      classes: ["motion-tracker-multideck-app"]
    });
  }

  /**
   * Prepare simple data for the Handlebars template. Human-friendly row numbers are
   * added here only for display; they are not saved into the actual configuration.
   */
  getData() {
    const links = this._draft.map((link, li) => ({
      ...link,
      number: li + 1,
      anchors: (link.anchors || []).map((anchor, ai) => ({ ...anchor, number: ai + 1 }))
    }));
    return {
      links,
      scenes: game.scenes.contents.map(scene => ({ id: scene.id, name: scene.name }))
    };
  }

  /**
   * Connect buttons and input fields in the settings window to their actions.
   * Every edit changes only the draft until the Save button submits the form.
   */
  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-field]").on("change input", event => this._updateDraftField(event.currentTarget));
    html.find("[data-axis]").on("change input", event => this._updateAnchorCoordinate(event.currentTarget));

    // Add/remove buttons always sync the current form first so text typed just before
    // clicking a button is retained in the draft.
    html.find(".md-add-link").on("click", () => {
      this._syncFromForm();
      this._draft.push(normalizeLink({ name: "", enabled: true, elevationDelta: 3, anchors: [] }));
      this.render(true);
    });

    html.find(".md-delete-link").on("click", event => {
      this._syncFromForm();
      const li = Number(event.currentTarget.dataset.linkIndex);
      if (Number.isInteger(li)) this._draft.splice(li, 1);
      this.render(true);
    });

    html.find(".md-add-anchor").on("click", event => {
      this._syncFromForm();
      const li = Number(event.currentTarget.dataset.linkIndex);
      if (!this._draft[li]) return;
      this._draft[li].anchors.push({ a: { x: "", y: "" }, b: { x: "", y: "" } });
      this.render(true);
    });

    html.find(".md-delete-anchor").on("click", event => {
      this._syncFromForm();
      const li = Number(event.currentTarget.dataset.linkIndex);
      const ai = Number(event.currentTarget.dataset.anchorIndex);
      if (this._draft[li]?.anchors?.[ai]) this._draft[li].anchors.splice(ai, 1);
      this.render(true);
    });

    html.find(".md-capture").on("click", event => this._startCapture(event.currentTarget));
  }

  /**
   * Copy one ordinary form field (name, enabled, Scene choice, elevation, etc.) into
   * the in-memory draft, converting number and checkbox fields to the right type.
   */
  _updateDraftField(element) {
    const li = Number(element.dataset.linkIndex);
    const field = element.dataset.field;
    if (!this._draft[li] || !field) return;

    if (element.type === "checkbox") this._draft[li][field] = element.checked;
    else if (field === "elevationDelta") this._draft[li][field] = finiteNumber(element.value, 0);
    else this._draft[li][field] = element.value;
  }

  /**
   * Copy one X or Y coordinate from a matching-point row into the draft. Blank or
   * invalid values remain blank rather than becoming a bad number.
   */
  _updateAnchorCoordinate(element) {
    const li = Number(element.dataset.linkIndex);
    const ai = Number(element.dataset.anchorIndex);
    const side = element.dataset.side;
    const axis = element.dataset.axis;
    const anchor = this._draft[li]?.anchors?.[ai];
    if (!anchor || !["a", "b"].includes(side) || !["x", "y"].includes(axis)) return;

    anchor[side] ??= { x: "", y: "" };
    const n = Number(element.value);
    anchor[side][axis] = Number.isFinite(n) ? n : "";
  }

  /**
   * Read every visible form control before adding/removing rows or saving. This makes
   * sure recent typing is not lost just because the user did not click elsewhere first.
   */
  _syncFromForm() {
    const root = this.element;
    if (!root?.length) return;
    root.find("[data-field]").each((_i, el) => this._updateDraftField(el));
    root.find("[data-axis]").each((_i, el) => this._updateAnchorCoordinate(el));
  }

  /**
   * Let the GM mark a matching point directly on a Scene.
   *
   * The module opens the chosen Scene, waits until its canvas is ready, listens for
   * one click, converts that click into Scene X/Y coordinates, saves it in the draft,
   * and immediately removes the click listener.
   */
  async _startCapture(button) {
    this._syncFromForm();
    const li = Number(button.dataset.linkIndex);
    const ai = Number(button.dataset.anchorIndex);
    const side = button.dataset.side;
    const link = this._draft[li];
    if (!link || !link.anchors?.[ai] || !["a", "b"].includes(side)) return;

    const sceneId = side === "a" ? link.sceneA : link.sceneB;
    const scene = game.scenes.get(sceneId);
    if (!scene) {
      ui.notifications.warn(`Select Scene ${side.toUpperCase()} before marking a matching point.`);
      return;
    }

    this._capture = { li, ai, side, sceneId };
    ui.notifications.info(`Opening ${scene.name}. Click matching point ${ai + 1} for Scene ${side.toUpperCase()}.`);

    const attachCapture = () => {
      // Scene.view() is asynchronous. Only attach the click listener after Foundry's
      // canvas is definitely showing the requested Scene.
      if (!canvas?.ready || canvas.scene?.id !== sceneId) return;
      const stage = canvas.stage;
      if (!stage) return;

      const handler = event => {
        try {
          const globalPoint = event.global ?? event.data?.global;
          if (!globalPoint) throw new Error("Pointer event did not provide global coordinates.");
          // Pointer events arrive in screen coordinates. stage.toLocal converts the
          // click into actual Scene coordinates, which are what token positions use.
          const p = stage.toLocal(globalPoint);
          const x = Math.round(p.x * 100) / 100;
          const y = Math.round(p.y * 100) / 100;
          const capture = this._capture;
          if (!capture) return;

          const anchor = this._draft[capture.li]?.anchors?.[capture.ai];
          if (anchor) anchor[capture.side] = { x, y };
          this._capture = null;
          ui.notifications.info(`Saved matching point on ${scene.name}: (${x}, ${y}).`);
          this.render(true);
        } catch (err) {
          console.error(`${MODULE_ID} | Anchor capture failed`, err);
          ui.notifications.error("That point could not be saved. You can type the X and Y coordinates manually instead.");
        } finally {
          stage.off("pointerdown", handler);
        }
      };

      stage.once("pointerdown", handler);
    };

    if (canvas?.ready && canvas.scene?.id === sceneId) {
      attachCapture();
    } else {
      Hooks.once("canvasReady", () => setTimeout(attachCapture, 25));
      await scene.view();
    }
  }

  /**
   * Save the current draft to the world setting. Before saving, reject the one setup
   * error that doesn't make sense: using the exact same Foundry Scene as both A and B.
   */
  async _updateObject(_event, _formData) {
    this._syncFromForm();
    const normalized = this._draft.map(normalizeLink);

    for (const link of normalized) {
      if (!link.sceneA || !link.sceneB) continue;
      if (link.sceneA === link.sceneB) {
        ui.notifications.error(`Scene link "${link.name || link.id}" uses the same Scene for both Scene A and Scene B.`);
        return;
      }
    }

    await game.settings.set(MODULE_ID, LINKS_SETTING, { version: 1, links: normalized });
    this._draft = normalized;
    ui.notifications.info("Motion Tracker Multideck Companion Scene links saved.");
    this.render(true);
  }
}

/**
 * Foundry "init" hook: register the hidden storage setting and the GM-facing
 * configuration menu before the world finishes loading.
 */
Hooks.once("init", () => {
  // The small "eq" helper lets the template mark the currently selected Scene and
  // option in ordinary Handlebars conditionals. Reuse it if another module already
  // registered one under the same name.
  if (!Handlebars.helpers.eq) {
    Handlebars.registerHelper("eq", (a, b) => a === b);
  }

  // The actual link data is hidden from Foundry's normal settings list because it is
  // easier and safer to edit through the dedicated Scene Links window.
  game.settings.register(MODULE_ID, LINKS_SETTING, {
    name: "Scene Links",
    hint: "Saved information about which Foundry Scenes are connected as levels of the same location.",
    scope: "world",
    config: false,
    type: Object,
    default: { version: 1, links: [] }
  });

  game.settings.registerMenu(MODULE_ID, "linkManager", {
    name: "Configure Scene Links",
    label: "Configure Scene Links",
    hint: "Choose which Scenes belong to the same location so the Motion Tracker can detect contacts across them.",
    icon: "fa-solid fa-layer-group",
    type: SceneLinkManager,
    restricted: true
  });
});

/**
 * Foundry "ready" hook: once all modules are active, confirm the original Motion
 * Tracker exists and attach the companion behavior.
 */
Hooks.once("ready", () => {
  // Fail clearly if the required base module is not active. The companion has no
  // standalone tracker of its own.
  const motionTrackerModule = game.modules.get("motion_tracker");
  if (!motionTrackerModule?.active) {
    ui.notifications.error("Alien RPG - Motion Tracker Multideck Companion requires Alien RPG - Motion Tracker to be active.");
    return;
  }

  if (!patchMotionTrackerOpen()) {
    console.error(`${MODULE_ID} | Could not find game.motion_tracker. The base Motion Tracker API may have changed.`);
    ui.notifications.error("The Multideck Companion could not connect to the Motion Tracker. Check the browser console for details.");
    return;
  }

  if (game.user.isGM) {
    const links = getStoredLinks().filter(link => link.enabled && link.sceneA && link.sceneB);
    console.log(`${MODULE_ID} | Ready with ${links.length} enabled Scene link(s).`);
  }
});
