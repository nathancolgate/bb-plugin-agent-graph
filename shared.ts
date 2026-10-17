// Values shared by the backend (server.ts) and the frontend (app.tsx,
// graph.tsx). Keep this file free of server-only imports: the frontend
// bundle includes it.
import type { ThreadFilter } from "./filters";

/** Realtime channel the server publishes on when the graph may have changed. */
export const GRAPH_CHANGED = "graph-changed";

export interface GraphChangedPayload {
  /** Threads that changed; empty means "anything may have changed". */
  threadIds: string[];
}

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode); the choice just won't stick.
  }
}

/** How nodes without a per-node choice start: the default policy, or all open or closed. */
export type Baseline = "default" | "expanded" | "collapsed";
export type ColorMode = "type" | "status";

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

/**
 * How the user left one graph view. Saved on the server, so it follows
 * them between the desktop app and a browser.
 */
export interface ViewState {
  baseline: Baseline;
  /** Per-node collapse choices (node id → collapsed), plus `::all` unfolds. */
  overrides: Record<string, boolean>;
  activeOnly: boolean;
  colorMode: ColorMode;
  /** Overview threads to hide. Missing in views saved before filters. */
  filter?: ThreadFilter;
  /** Null: fit the graph on open. */
  viewport: Viewport | null;
}

export interface Preset {
  name: string;
  state: ViewState;
  savedAt: number;
}

/** Most saved views kept; the oldest are dropped first. */
export const MAX_SAVED_VIEWS = 60;
export const MAX_PRESETS = 30;
/** Per-node choices kept per view, newest first. */
export const MAX_OVERRIDES = 2000;
