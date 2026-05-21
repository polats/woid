import { useDropToasts } from '../lib/dropToast.js';

/**
 * Renders the queue of drop toasts produced by `dropToastApi`. One
 * stack at the top-center of the viewport — same position on desktop
 * (just under the phone notch) and mobile (top of screen). Mount this
 * once at the app root.
 */
export default function DropToast() {
  const toasts = useDropToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="drop-toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`drop-toast drop-toast-${t.status}`}>
          <DropToastIcon status={t.status} />
          <span className="drop-toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function DropToastIcon({ status }) {
  if (status === 'pending') return <span className="drop-toast-spinner" aria-hidden="true" />;
  if (status === 'success') return <span className="drop-toast-check" aria-hidden="true">✓</span>;
  if (status === 'error') return <span className="drop-toast-x" aria-hidden="true">×</span>;
  return null;
}
