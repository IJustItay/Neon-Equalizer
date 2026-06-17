/**
 * Lightweight observable store primitives.
 *
 * Extracted from main.js so the renderer has one small, testable place that
 * owns: (1) a pub/sub bus other modules can subscribe to, (2) bounded
 * undo/redo history, and (3) a scoped-refresh dispatcher so a single edit
 * re-renders only the affected panels instead of the entire UI.
 */

/** Minimal synchronous event emitter. */
export class Emitter {
  constructor() {
    this._subs = new Map();
  }

  /** Subscribe to an event (use '*' for all). Returns an unsubscribe fn. */
  on(event, fn) {
    if (!this._subs.has(event)) this._subs.set(event, new Set());
    this._subs.get(event).add(fn);
    return () => this._subs.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this._subs.get(event)?.forEach((fn) => {
      try { fn(payload); } catch (e) { console.error(`listener for "${event}"`, e); }
    });
    if (event !== '*') {
      this._subs.get('*')?.forEach((fn) => {
        try { fn(event, payload); } catch (e) { console.error('wildcard listener', e); }
      });
    }
  }
}

/** Bounded undo/redo history over opaque (JSON-string) snapshots. */
export class History {
  constructor(limit = 50) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  push(snapshot) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  /** Returns the snapshot to restore, or undefined if nothing to undo. */
  undo(current) {
    if (!this.undoStack.length) return undefined;
    this.redoStack.push(current);
    return this.undoStack.pop();
  }

  /** Returns the snapshot to restore, or undefined if nothing to redo. */
  redo(current) {
    if (!this.redoStack.length) return undefined;
    this.undoStack.push(current);
    return this.redoStack.pop();
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/** Canonical refresh-scope names shared between dispatcher and callers. */
export const REFRESH = {
  PARAMETRIC: 'parametric',
  GRAPHIC: 'graphic',
  GRAPH: 'graph',
  PREAMP: 'preamp',
  DEVICE: 'device',
  ROUTING: 'routing',
  EFFECTS: 'effects',
  INCLUDES: 'includes',
  COUNT: 'count',
  RAW: 'raw',
  ALL: 'all',
};

/**
 * Build a scoped refresh dispatcher from a map of { scopeName: renderFn }.
 *   refresh('parametric', 'graph')  → runs only those renderers
 *   refresh('all') or refresh()     → runs every renderer (definition order)
 * Emits a 'refresh' event with the scopes that ran.
 */
export function createRefresher(refreshers, bus) {
  const allScopes = Object.keys(refreshers).filter((k) => k !== REFRESH.ALL);
  return function refresh(...scopes) {
    const run = scopes.length === 0 || scopes.includes(REFRESH.ALL) ? allScopes : scopes;
    const seen = new Set();
    for (const scope of run) {
      if (seen.has(scope)) continue;
      seen.add(scope);
      const fn = refreshers[scope];
      if (fn) {
        try { fn(); } catch (e) { console.error(`refresh[${scope}]`, e); }
      }
    }
    bus?.emit('refresh', run);
    return run;
  };
}

/** App-wide singletons. */
export const appBus = new Emitter();
export const history = new History(50);
