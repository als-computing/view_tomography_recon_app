/**
 * useTabsStore.ts
 *
 * Zustand store for the multi-tab reconstruction viewer (client state). Holds the open tabs, the
 * active tab, and which tabs are "live" (their `<ItkVtkNative>` is mounted / holding a WebGL
 * context). Implements a 45s keep-alive: when you switch away from a tab it stays live for a grace
 * window so switching back is instant; if untouched for 45s it drops from `liveIds`, unmounting the
 * viewer and freeing its GPU context.
 *
 * This is the first of the store set the app is standardizing on (Zustand 5).
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
  /** Tabs whose viewer is currently mounted (active + those inside the 45s grace window). */
  liveIds: Set<string>;
  /** Open a url as a tab (focus it if already open) and activate it. */
  openTab: (url: string) => void;
  /** Close a tab, disposing its viewer; activates a neighbor if it was active. */
  closeTab: (id: string) => void;
  /** Make a tab active (starts the grace timer on the previously-active tab). */
  setActive: (id: string) => void;
  /** Move a tab from one index to another. */
  reorderTabs: (fromIndex: number, toIndex: number) => void;
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
      if (!s.liveIds.has(id) || s.activeId === id) return s; // never drop the active tab
      const liveIds = new Set(s.liveIds);
      liveIds.delete(id);
      return { liveIds };
    });
  };

  const startGrace = (id: string) => {
    clearGrace(id);
    graceTimers.set(id, setTimeout(() => dropFromLive(id), TAB_GRACE_MS));
  };

  return {
    tabs: [],
    activeId: null,
    liveIds: new Set<string>(),

    openTab: (url) => {
      const existing = get().tabs.find((t) => t.url === url);
      if (existing) {
        get().setActive(existing.id);
        return;
      }
      const tab: ReconTab = { id: makeId(), url, name: nameFromUrl(url) };
      const prev = get().activeId;
      if (prev) startGrace(prev);
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeId: tab.id,
        liveIds: new Set(s.liveIds).add(tab.id),
      }));
    },

    setActive: (id) => {
      const prev = get().activeId;
      if (prev === id) return;
      clearGrace(id);
      if (prev) startGrace(prev);
      set((s) => ({
        activeId: id,
        liveIds: new Set(s.liveIds).add(id),
      }));
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
        if (activeId === id) {
          // Activate the tab that shifts into this slot, else the previous one, else none.
          const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
          activeId = neighbor ? neighbor.id : null;
          if (activeId) {
            clearGrace(activeId);
            liveIds.add(activeId);
          }
        }
        return { tabs, activeId, liveIds };
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
  };
});
