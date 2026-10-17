// Saved graph views and presets, read from and written to the server so
// they follow the user between the desktop app and a browser.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Preset, ViewState } from "./shared";

export interface SavedView {
  /** False until the saved state (or its absence) is known. */
  ready: boolean;
  /** How the view was left, or null for a first visit. */
  initial: ViewState | null;
  save: (state: ViewState) => void;
  presets: Preset[];
  savePreset: (name: string, state: ViewState) => void;
  deletePreset: (name: string) => void;
}

/**
 * `key` names one view (the overview page, one thread's panel). A view seen
 * for the first time starts from `fallbackKey`, minus its pan and zoom, so a
 * new thread's panel opens with the settings the last one was left in.
 */
export function useSavedView(key: string, fallbackKey: string | null = null): SavedView {
  const rpc = useRpc<typeof rpcContract>();
  const [loaded, setLoaded] = useState<{ key: string; state: ViewState | null } | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);

  useEffect(() => {
    let cancelled = false;
    rpc.call("viewGet", { key, fallbackKey }).then(
      ({ state, fromFallback }) => {
        if (cancelled) return;
        setLoaded({ key, state: state && fromFallback ? { ...state, viewport: null } : state });
      },
      () => {
        // Storage failed: open with defaults rather than not at all.
        if (!cancelled) setLoaded({ key, state: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, key, fallbackKey]);

  useEffect(() => {
    let cancelled = false;
    rpc.call("presetsList", {}).then(
      (list) => {
        if (!cancelled) setPresets(list);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  // Bound to its key: a view that closes as the key changes still saves to
  // its own key, not the next one.
  const save = useCallback(
    (state: ViewState) => {
      rpc.call("viewSet", { key, alsoKey: fallbackKey, state }).catch(() => {});
    },
    [rpc, key, fallbackKey],
  );
  const savePreset = useCallback(
    (name: string, state: ViewState) => {
      rpc.call("presetSave", { name, state }).then(setPresets, () => {});
    },
    [rpc],
  );
  const deletePreset = useCallback(
    (name: string) => {
      rpc.call("presetDelete", { name }).then(setPresets, () => {});
    },
    [rpc],
  );

  const ready = loaded !== null && loaded.key === key;
  return {
    ready,
    initial: ready ? loaded.state : null,
    save,
    presets,
    savePreset,
    deletePreset,
  };
}
