/**
 * useTabsStore.ts
 *
 * Zustand store for the multi-tab reconstruction viewer (client state). Holds the open tabs, the
 * active tab, the optional split (right-pane) tab, the link toggles, and which tabs are "live"
 * (their `<ItkVtkNative>` is mounted / holding a WebGL context).
 *
 * Keep-alive: when a tab stops being shown (not active and not the split pane) it stays live for a
 * 45s grace window so switching back is instant; if untouched for 45s it drops from `liveIds`,
 * unmounting the viewer and freeing its GPU context.
 */

import { create } from 'zustand';

export interface ReconTab {
  id: string;
  /** Zarr URL loaded into the viewer. */
  url: string;
  /** Display name shown on the tab (last path segment of the url). */
  name: string;
}

export interface TabsState {
  tabs: ReconTab[];
  activeId: string | null;
  /** Tab shown in the right (split) pane, or null for single-pane view. */
  splitId: string | null;
  /** Tabs whose viewer is currently mounted (active + split + those inside the 45s grace window). */
  liveIds: Set<string>;
  /** Sync camera (rotation/pan/zoom) between the two split panes. */
  linkCamera: boolean;
  /** Sync rendering (colormap, color range, transfer function, gradient opacity, blend, etc.). */
  linkRendering: boolean;
  /** Sync the cropping (ROI) planes between the two split panes. */
  linkCropping: boolean;

  /** Open a url as a tab (focus it if already open) and activate it. */
  openTab: (url: string) => void;
  /** Close a tab, disposing its viewer; activates a neighbor / clears split as needed. */
  closeTab: (id: string) => void;
  /** Make a tab active. If it's currently the split pane, swap the two panes. */
  setActive: (id: string) => void;
  /** Set (or clear, with null) the right split pane. Ignores the active tab. */
  setSplit: (id: string | null) => void;
  /** Move a tab from one index to another. */
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  setLinkCamera: (value: boolean) => void;
  setLinkRendering: (value: boolean) => void;
  setLinkCropping: (value: boolean) => void;
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
      // Never drop a tab that's currently shown (active or split pane).
      if (!s.liveIds.has(id) || s.activeId === id || s.splitId === id) return s;
      const liveIds = new Set(s.liveIds);
      liveIds.delete(id);
      return { liveIds };
    });
  };

  const startGrace = (id: string | null) => {
    if (!id) return;
    clearGrace(id);
    graceTimers.set(id, setTimeout(() => dropFromLive(id), TAB_GRACE_MS));
  };

  return {
    tabs: [],
    activeId: null,
    splitId: null,
    liveIds: new Set<string>(),
    linkCamera: true,
    linkRendering: true,
    linkCropping: true,

    openTab: (url) => {
      const existing = get().tabs.find((t) => t.url === url);
      if (existing) {
        get().setActive(existing.id);
        return;
      }
      const tab: ReconTab = { id: makeId(), url, name: nameFromUrl(url) };
      const prev = get().activeId;
      // The previous active tab keeps showing if it's the split pane; otherwise it starts its grace.
      if (prev && prev !== get().splitId) startGrace(prev);
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeId: tab.id,
        liveIds: new Set(s.liveIds).add(tab.id),
      }));
    },

    setActive: (id) => {
      const { activeId: prev, splitId } = get();
      if (prev === id) return;
      clearGrace(id);
      if (splitId === id) {
        // Clicking the split-pane's tab swaps the two panes (both stay live).
        set({ activeId: id, splitId: prev });
        return;
      }
      if (prev && prev !== splitId) startGrace(prev);
      set((s) => ({ activeId: id, liveIds: new Set(s.liveIds).add(id) }));
    },

    setSplit: (id) => {
      const { activeId, splitId: prev } = get();
      if (id === activeId) return; // can't compare a tab with itself
      if (id === prev) return;
      if (id) clearGrace(id);
      // The old split tab starts its grace unless it's the active one.
      if (prev && prev !== activeId) startGrace(prev);
      set((s) => {
        const liveIds = new Set(s.liveIds);
        if (id) liveIds.add(id);
        return { splitId: id, liveIds };
      });
    },

    closeTab: (id) => {
      clearGrace(id);
      set((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        if (idx === -1) return s;
        const tabs = s.tabs.filter((t) => t.id !== id);
        const liveIds = new Set(s.liveIds);
        liveIds.delete(id);
        let activeId = s.activeId;
        let splitId = s.splitId;
        if (splitId === id) splitId = null; // closing the split pane exits split view
        if (activeId === id) {
          const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
          activeId = neighbor ? neighbor.id : null;
          if (activeId) {
            clearGrace(activeId);
            liveIds.add(activeId);
          }
          // If the neighbor we picked is the split pane, clear split to avoid same-tab-in-both.
          if (activeId && activeId === splitId) splitId = null;
        }
        return { tabs, activeId, splitId, liveIds };
      });
    },

    reorderTabs: (fromIndex, toIndex) => {
      set((s) => {
        const n = s.tabs.length;
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= n || toIndex >= n) {
          return s;
        }
        const tabs = [...s.tabs];
        const [moved] = tabs.splice(fromIndex, 1);
        tabs.splice(toIndex, 0, moved);
        return { tabs };
      });
    },

    setLinkCamera: (value) => set({ linkCamera: value }),
    setLinkRendering: (value) => set({ linkRendering: value }),
    setLinkCropping: (value) => set({ linkCropping: value }),
  };
});
