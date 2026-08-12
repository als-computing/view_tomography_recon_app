import { useRef, useState } from 'react';
import type { PaneSide, ReconTab } from './stores/useTabsStore';
import './tabbar.css';

/** dataTransfer MIME type carrying a dragged tab's id, so a tab group can accept it as a pane move. */
export const TAB_DND_MIME = 'application/x-recon-tab-id';

export interface TabBarProps {
  tabs: ReconTab[];
  activeLeftId: string | null;
  activeRightId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Reorder a tab within its pane, placing it before `beforeId` (or at the end when null). */
  onReorder: (draggedId: string, beforeId: string | null) => void;
  /** Move a tab into a pane, optionally positioned before `beforeId`. */
  onMoveToPane: (id: string, pane: PaneSide, beforeId?: string | null) => void;
}

/**
 * Browser/Finch-style tab strip. In split view the strip is two left-aligned groups sitting directly
 * above their panes (left group over the left pane, right group over the right pane), so it's obvious
 * which reconstruction is where.
 *
 * Move a tab to the other pane with its ⇥/⇤ button (this is what opens side-by-side), or by dragging
 * it onto the other group; drag within a group to reorder. Renders nothing when there are no tabs.
 */
export const TabBar = ({
  tabs,
  activeLeftId,
  activeRightId,
  onActivate,
  onClose,
  onReorder,
  onMoveToPane,
}: TabBarProps) => {
  const draggedIdRef = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  if (tabs.length === 0) return null;

  const leftTabs = tabs.filter((t) => t.pane === 'left');
  const rightTabs = tabs.filter((t) => t.pane === 'right');
  const inSplit = leftTabs.length > 0 && rightTabs.length > 0;

  // Route a drop of `draggedId` relative to `target`: same pane → reorder; different pane → move.
  const handleDropOnTab = (targetPane: PaneSide, targetId: string | null, draggedId: string) => {
    const dragged = tabs.find((t) => t.id === draggedId);
    if (!dragged) return;
    if (dragged.pane === targetPane) onReorder(draggedId, targetId);
    else onMoveToPane(draggedId, targetPane, targetId);
  };

  const renderTab = (tab: ReconTab) => {
    const isShown = tab.id === activeLeftId || tab.id === activeRightId;
    const toPane: PaneSide = tab.pane === 'left' ? 'right' : 'left';
    const moveLabel = tab.pane === 'left' ? 'Move to right pane' : 'Move to left pane';
    return (
      <div
        key={tab.id}
        role="tab"
        aria-selected={isShown}
        title={tab.name}
        className={[
          'tabbar__tab',
          isShown ? 'tabbar__tab--shown' : '',
          inSplit ? `tabbar__tab--pane-${tab.pane}` : '',
          overId === tab.id ? 'tabbar__tab--drop' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        draggable
        onClick={() => onActivate(tab.id)}
        onDragStart={(e) => {
          draggedIdRef.current = tab.id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(TAB_DND_MIME, tab.id);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (overId !== tab.id) setOverId(tab.id);
        }}
        onDragLeave={() => setOverId((cur) => (cur === tab.id ? null : cur))}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const draggedId = e.dataTransfer.getData(TAB_DND_MIME) || draggedIdRef.current;
          if (draggedId && draggedId !== tab.id) handleDropOnTab(tab.pane, tab.id, draggedId);
          draggedIdRef.current = null;
          setOverId(null);
        }}
        onDragEnd={() => {
          draggedIdRef.current = null;
          setOverId(null);
        }}
      >
        {inSplit && (
          <span className="tabbar__pane-badge" aria-hidden="true" title={`${tab.pane} pane`}>
            {tab.pane === 'left' ? '◧' : '◨'}
          </span>
        )}
        <span className="tabbar__name">{tab.name}</span>
        <button
          type="button"
          className="tabbar__move"
          aria-label={moveLabel}
          title={moveLabel}
          onClick={(e) => {
            e.stopPropagation();
            onMoveToPane(tab.id, toPane);
          }}
        >
          {tab.pane === 'left' ? '⇥' : '⇤'}
        </button>
        <button
          type="button"
          className="tabbar__close"
          aria-label={`Close ${tab.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
        >
          ×
        </button>
      </div>
    );
  };

  // A pane's group: also accepts drops on its empty area (append into that pane).
  const renderGroup = (pane: PaneSide, paneTabs: ReconTab[]) => (
    <div
      className={`tabbar__group tabbar__group--${pane}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        const draggedId = e.dataTransfer.getData(TAB_DND_MIME) || draggedIdRef.current;
        if (draggedId) handleDropOnTab(pane, null, draggedId);
        draggedIdRef.current = null;
        setOverId(null);
      }}
    >
      {paneTabs.map(renderTab)}
    </div>
  );

  if (!inSplit) {
    // Single strip: everything is one pane. Wrap in a group so empty-area drops still work.
    const pane: PaneSide = rightTabs.length > 0 ? 'right' : 'left';
    return (
      <div className="tabbar" role="tablist">
        {renderGroup(pane, tabs)}
      </div>
    );
  }

  return (
    <div className="tabbar tabbar--split" role="tablist">
      {renderGroup('left', leftTabs)}
      {renderGroup('right', rightTabs)}
    </div>
  );
};
