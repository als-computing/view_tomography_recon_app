/**
 * IframeModal.tsx
 *
 * Embeds an external page (currently just the Docs site) in an in-app overlay instead of opening a
 * new browser tab. Includes an "Open in new tab" fallback link for anyone who prefers that, or for a
 * target page that refuses to be framed (X-Frame-Options / frame-ancestors CSP).
 */
import './iframeModal.css';

export interface IframeModalProps {
  title: string;
  url: string;
  onClose: () => void;
}

export default function IframeModal({ title, url, onClose }: IframeModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content docs-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <div className="docs-modal-header-actions">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="docs-modal-open-new-tab"
              title="Open in a new tab"
            >
              Open in new tab ↗
            </a>
            <button type="button" className="close-button" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>
        <div className="modal-body docs-modal-body">
          <iframe src={url} title={title} className="docs-modal-iframe" />
        </div>
      </div>
    </div>
  );
}
