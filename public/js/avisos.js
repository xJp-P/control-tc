// public/js/avisos.js — Notificaciones y dialogos de confirmacion propios de la app.
//
// Convencion del proyecto: JAMAS window.confirm/alert/prompt en produccion; siempre este modal.
//
// CONTRATO NO OBVIO: ToastContainer y ConfirmDialog PUBLICAN window.__addToast y
// window.__showConfirm durante su render, y los helpers toast()/confirmDialog() los LEEN. Es una
// comunicacion por window, no por referencia directa, asi que sobrevive al reparto en archivos
// — pero se rompe si alguien envuelve estos archivos en una IIFE, porque entonces `toastId`
// (el unico estado mutable de modulo del frontend) dejaria de compartirse.


// ═══════════════════════════════════════════════════════════════════
// TOAST SYSTEM
// ═══════════════════════════════════════════════════════════════════
let toastId = 0;
function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  window.__addToast = (msg, type) => {
    const id = ++toastId;
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.map(x => x.id === id ? { ...x, out: true } : x)), 2200);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2500);
  };
  return e('div', { className: 'toast-container' },
    toasts.map(t => e('div', { key: t.id, className: 'toast toast-' + t.type + (t.out ? ' out' : '') }, t.msg))
  );
}
function toast(msg, type) { if (window.__addToast) window.__addToast(msg, type || 'success'); }
function toastErr(msg) { toast(msg, 'error'); }

// ═══════════════════════════════════════════════════════════════════
// CONFIRM DIALOG (replaces native confirm())
// ═══════════════════════════════════════════════════════════════════
function ConfirmDialog() {
  const [state, setState] = useState(null);
  window.__showConfirm = (message, opts) => {
    return new Promise(resolve => {
      setState({ message, resolve, opts: opts || {} });
    });
  };
  if (!state) return null;
  function respond(val) { state.resolve(val); setState(null); }
  const isInfo = state.opts.mode === 'info';
  const title = state.opts.title || 'Confirmar';
  const confirmText = state.opts.confirmText || 'Confirmar';
  // cancelText: cuando cancelar NO es "abortar" sino la otra mitad de una decisión legítima.
  // danger=false: no todo lo que se confirma es destructivo; pintar de rojo una elección normal miente.
  const cancelText = state.opts.cancelText || 'Cancelar';
  const confirmClass = state.opts.danger === false ? 'btn btn-primary' : 'btn btn-danger';
  return e('div', { className: 'modal-overlay', onClick: (ev) => { if (ev.target === ev.currentTarget && !isInfo) respond(false); } },
    e('div', { className: 'modal', style: { maxWidth: 420 } },
      e('div', { className: 'modal-title' }, title),
      e('div', { style: { padding: '16px 0', fontSize: 14, color: 'var(--text-secondary)', whiteSpace: 'pre-line' } }, state.message),
      e('div', { className: 'modal-actions' },
        isInfo
          ? e('button', { className: 'btn btn-primary', onClick: () => respond(true) }, 'Aceptar')
          : [
              e('button', { key: 'c', className: 'btn', onClick: () => respond(false) }, cancelText),
              e('button', { key: 'k', className: confirmClass, onClick: () => respond(true) }, confirmText)
            ]
      )
    )
  );
}
async function confirmDialog(msg, opts) { return window.__showConfirm ? window.__showConfirm(msg, opts) : confirm(msg); }
async function infoDialog(msg, title) { return confirmDialog(msg, { mode: 'info', title: title || 'Informacion' }); }
