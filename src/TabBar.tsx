import { useRef, useState } from 'react';
import type { ReconTab } from './stores/useTabsStore';
import './tabbar.css';

export interface TabBarProps {
  tabs: ReconTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Move the tab at `fromIndex` to `toIndex`. */
  onReorder: (fromIndex: number, toIndex: number) => void;
}

/**
 * Browser/Finch-style tab strip: each open reconstruction is a tab showing its file name, with a
 * close button and native HTML5 drag-to-reorder. Renders nothing when there are no tabs.
 */
export const TabBar = ({ tabs, activeId, onActivate, onClose, onReorder }: TabBarProps) => {
  const dragIndexRef = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  if (tabs.length === 0) return null;

  return (
    <div className="tabbar" role="tablist">
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
          title={tab.name}
          className={[
            'tabbar__tab',
            tab.id === activeId ? 'tabbar__tab--active' : '',
            overIndex === index ? 'tabbar__tab--drop' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          draggable
          onClick={() => onActivate(tab.id)}
          onDragStart={(e) => {
            dragIndexRef.current = index;
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (overIndex !== index) setOverIndex(index);
          }}
          onDragLeave={() => setOverIndex((cur) => (cur === index ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            const from = dragIndexRef.current;
            if (from != null && from !== index) onReorder(from, index);
            dragIndexRef.current = null;
            setOverIndex(null);
          }}
          onDragEnd={() => {
            dragIndexRef.current = null;
            setOverIndex(null);
          }}
        >
          <span className="tabbar__name">{tab.name}</span>
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
      ))}
    </div>
  );
};
