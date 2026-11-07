import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({ title, en, onClose, children }: { title: string; en: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="k-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="k-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={box}>
        <div className="k-modal-head">
          <h2>
            {title}
            <span className="k-card-en">{en}</span>
          </h2>
          <button className="k-btn k-btn-ghost k-btn-small" onClick={onClose} aria-label="閉じる">
            閉じる
          </button>
        </div>
        <div className="k-modal-body">{children}</div>
      </div>
    </div>
  );
}
