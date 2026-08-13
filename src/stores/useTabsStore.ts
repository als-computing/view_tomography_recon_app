/**
 * useTabsStore.ts
 *
 * Zustand store for the multi-tab reconstruction viewer (client state). Tabs are organized into two
 * side-by-side panes: every tab is assigned to the `left` or `right` pane, and each pane shows its
 * own active tab. This mirrors the on-screen layout — the left group of tabs sits above the left
 * pane, the right group above the right pane — so it's obvious which reconstruction is where.
 *
 * Split view is implicit: it's "on" whenever both panes have at least one tab. New reconstructions
 * open in the left pane; a tab is moved to the other pane by dragging (onto the other tab group or
 * onto that pane in the viewer).
 *
 * Keep-alive: a tab whose viewer is mounted but no longer shown (not the active tab of either pane)
 * stays live for a 45s grace window so switching back is instant; if untouched for 45s it drops from
 * `liveIds`, unmounting the viewer and freeing its GPU context.
 */

import { create } from 'zustand';

export type PaneSide = 'left' | 'right';

/** The volume renderer used by all viewers (app-wide toggle). */
export type RendererKind = 'itk' | 'webgpu';

export interface ReconTab {
  id: string;
  /** Zarr URL loaded into the viewer. */
  url: string;
  /** Display name shown on the tab (last path segment of the url). */
  name: string;
  /** Which pane this tab belongs to. */
  pane: PaneSide;
}

export interface TabsState {
  tabs: ReconTab[];
  /** Active (shown) tab of the left pane. */
  activeLeftId: string | null;
  /** Active (shown) tab of the right pane. */
  activeRightId: string | null;
  /** Tabs whose viewer is currently mounted (the two pane actives + those inside the 45s grace window). */
  liveIds: Set<string>;
  /** Sync camera (rotation/pan/zoom) between the two split panes. */
  linkCamera: boolean;
  /** Sync rendering (colormap, color range, transfer function, gradient opacity, blend, etc.). */
  linkRendering: boolean;
  /** Sync the cropping (ROI) planes between the two split panes. */
  linkCropping: boolean;
  /** Which volume renderer every viewer uses (app-wide, not per tab). */
  renderer: RendererKind;

  /** Open a url as a tab in the left pane (focus it if already open) and activate it. */
  openTab: (url: string) => void;
  /** Close a tab, disposing its viewer; activates a neighbor in the same pane as needed. */
  closeTab: (id: string) => void;
  /** Make a tab the active (shown) tab of its own pane. */
  setActive: (id: string) => void;
  /** Move a tab into a pane (activating it there), optionally positioned before `beforeId`. */
  moveTabToPane: (id: string, pane: PaneSide, beforeId?: string | null) => void;
  /** Reorder a tab within its pane, placing it before `beforeId` (or at the end when null). */
  reorderTab: (draggedId: string, beforeId: string | null) => void;
  /** Collapse the split: move every right-pane tab back into the left pane. */
  exitSplit: () => void;
  setLinkCamera: (value: boolean) => void;
  setLinkRendering: (value: boolean) => void;
  setLinkCropping: (value: boolean) => void;
  /** Set the app-wide volume renderer. */
  setRenderer: (renderer: RendererKind) => void;
  /** Flip the app-wide volume renderer between itk and webgpu. */
  toggleRenderer: () => void;
}

/** Grace period a hidden tab's viewer stays mounted before being disposed. */
export const TAB_GRACE_MS = 45_000;

// Non-reactive per-tab disposal timers for the keep-alive window (kept out of React state).
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const nameFromUrl = (url: string): string => url.split('/').pop() || url;

let idCounter = 0;
const makeId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab-${++idCounter}`;

/** Reposition `moving` within `list`: remove it, then insert before `beforeId` (or append). */
const reposition = (list: ReconTab[], moving: ReconTab, beforeId: string | null): ReconTab[] => {
  const without = list.filter((t) => t.id !== moving.id);
  if (beforeId && beforeId !== moving.id) {
    const idx = without.findIndex((t) => t.id === beforeId);
    if (idx !== -1) return [...without.slice(0, idx), moving, ...without.slice(idx)];
  }
  return [...without, moving];
};

export const useTabsStore = create<TabsState>()((set, get) => {
  const clearGrace = (id: string) => {
    const timer = graceTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      graceTimers.delete(id);
    }
  };

  const dropFromLive = (id: string) => {
    graceTimers.delete(id);
    set((s) => {
      // Never drop a tab that's currently shown (active in either pane).
      if (!s.liveIds.has(id) || s.activeLeftId === id || s.activeRightId === id) return s;
      const liveIds = new Set(s.liveIds);
      liveIds.delete(id);
      return { liveIds };
    });
  };

  const startGrace = (id: string) => {
    clearGrace(id);
    graceTimers.set(id, setTimeout(() => dropFromLive(id), TAB_GRACE_MS));
  };

  // Idempotently align grace timers with the current state: shown tabs keep their viewer (no timer),
  // every other live tab is on the 45s countdown. Call after any action that changes which tabs are
  // shown or live.
  const reconcileGrace = () => {
    const { liveIds, activeLeftId, activeRightId } = get();
    liveIds.forEach((id) => {
      const shown = id === activeLeftId || id === activeRightId;
      if (shown) clearGrace(id);
      else if (!graceTimers.has(id)) startGrace(id);
    });
  };

  return {
    tabs: [],
    activeLeftId: null,
    activeRightId: null,
    liveIds: new Set<string>(),
    linkCamera: true,
    linkRendering: true,
    linkCropping: true,
    renderer: 'itk',

    openTab: (url) => {
      const existing = get().tabs.find((t) => t.url === url);
      if (existing) {
        get().setActive(existing.id);
        return;
      }
      const tab: ReconTab = { id: makeId(), url, name: nameFromUrl(url), pane: 'left' };
      set((s) => {
        const liveIds = new Set(s.liveIds);
        liveIds.add(tab.id);
        return { tabs: [...s.tabs, tab], activeLeftId: tab.id, liveIds };
      });
      reconcileGrace();
    },

    setActive: (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      clearGrace(id);
      set((s) => {
        const liveIds = new Set(s.liveIds);
        liveIds.add(id);
        return tab.pane === 'left' ? { activeLeftId: id, liveIds } : { activeRightId: id, liveIds };
      });
      reconcileGrace();
    },

    moveTabToPane: (id, pane, beforeId = null) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      clearGrace(id);
      set((s) => {
        const tabs = reposition(
          s.tabs.map((t) => (t.id === id ? { ...t, pane } : t)),
          { ...tab, pane },
          beforeId,
        );
        let activeLeftId = s.activeLeftId;
        let activeRightId = s.activeRightId;
        // Activate the moved tab in its destination pane.
        if (pane === 'left') activeLeftId = id;
        else activeRightId = id;
        // If it was the active tab of the pane it just left, promote a neighbor there.
        if (tab.pane !== pane) {
          if (tab.pane === 'left' && s.activeLeftId === id) {
            activeLeftId = tabs.find((t) => t.pane === 'left')?.id ?? null;
          } else if (tab.pane === 'right' && s.activeRightId === id) {
            activeRightId = tabs.find((t) => t.pane === 'right')?.id ?? null;
          }
        }
        const liveIds = new Set(s.liveIds);
        liveIds.add(id);
        if (activeLeftId) liveIds.add(activeLeftId);
        if (activeRightId) liveIds.add(activeRightId);
        return { tabs, activeLeftId, activeRightId, liveIds };
      });
      reconcileGrace();
    },

    reorderTab: (draggedId, beforeId) => {
      set((s) => {
        const moving = s.tabs.find((t) => t.id === draggedId);
        if (!moving) return s;
        return { tabs: reposition(s.tabs, moving, beforeId) };
      });
    },

    closeTab: (id) => {
      clearGrace(id);
      set((s) => {
        const tab = s.tabs.find((t) => t.id === id);
        if (!tab) return s;
        const idxInPane = s.tabs.filter((t) => t.pane === tab.pane).findIndex((t) => t.id === id);
        const tabs = s.tabs.filter((t) => t.id !== id);
        const liveIds = new Set(s.liveIds);
        liveIds.delete(id);
        let activeLeftId = s.activeLeftId;
        let activeRightId = s.activeRightId;
        if (tab.pane === 'left' && activeLeftId === id) {
          const rem = tabs.filter((t) => t.pane === 'left');
          const neighbor = rem[idxInPane] ?? rem[idxInPane - 1] ?? null;
          activeLeftId = neighbor?.id ?? null;
          if (activeLeftId) liveIds.add(activeLeftId);
        }
        if (tab.pane === 'right' && activeRightId === id) {
          const rem = tabs.filter((t) => t.pane === 'right');
          const neighbor = rem[idxInPane] ?? rem[idxInPane - 1] ?? null;
          activeRightId = neighbor?.id ?? null;
          if (activeRightId) liveIds.add(activeRightId);
        }
        return { tabs, activeLeftId, activeRightId, liveIds };
      });
      reconcileGrace();
    },

    exitSplit: () => {
      set((s) => {
        const tabs = s.tabs.map((t) => (t.pane === 'right' ? { ...t, pane: 'left' as PaneSide } : t));
        const activeLeftId = s.activeLeftId ?? s.activeRightId ?? tabs[0]?.id ?? null;
        const liveIds = new Set(s.liveIds);
        if (activeLeftId) liveIds.add(activeLeftId);
        return { tabs, activeLeftId, activeRightId: null, liveIds };
      });
      reconcileGrace();
    },

    setLinkCamera: (value) => set({ linkCamera: value }),
    setLinkRendering: (value) => set({ linkRendering: value }),
    setLinkCropping: (value) => set({ linkCropping: value }),
    setRenderer: (renderer) => set({ renderer }),
    toggleRenderer: () => set((s) => ({ renderer: s.renderer === 'itk' ? 'webgpu' : 'itk' })),
  };
});
