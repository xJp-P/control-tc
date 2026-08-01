// public/js/ui.js — Piezas de interfaz reutilizables y sin estado propio de negocio.
//
// personasTableBimon y bimonCard NO son componentes: devuelven arboles de React pero se invocan
// como funciones normales (bimonCard(...), nunca e(bimonCard, ...)). Ademas declaran su PROPIO
// `const e` dentro del cuerpo, un sombreado local inofensivo que se conserva tal cual.

// Parse formatted string back to raw number string
// MoneyInput component - shows formatted number with thousand separators, supports decimals
function MoneyInput({ value, onChange, className, required, placeholder, disabled, style }) {
  const [display, setDisplay] = useState(fmtNumInput(value));
  const ref = useRef(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDisplay(fmtNumInput(value));
  }, [value]);
  function handleChange(ev) {
    const input = ev.target.value;
    // Allow digits, dots (thousands), and one comma (decimal separator)
    const cleaned = input.replace(/[^\d.,]/g, '');
    // Normalize: remove thousand dots, keep comma as decimal
    const noThousands = cleaned.replace(/\./g, '');
    // Only allow one comma
    const commaIdx = noThousands.indexOf(',');
    let intPart, decPart;
    if (commaIdx >= 0) {
      intPart = noThousands.slice(0, commaIdx).replace(/[^\d]/g, '');
      decPart = noThousands.slice(commaIdx + 1).replace(/[^\d]/g, '');
    } else {
      intPart = noThousands.replace(/[^\d]/g, '');
      decPart = null;
    }
    const formatted = intPart ? parseInt(intPart).toLocaleString('es-CO') : (commaIdx >= 0 ? '0' : '');
    const displayVal = decPart !== null ? formatted + ',' + decPart : formatted;
    setDisplay(displayVal);
    // Send raw numeric value (with dot as decimal)
    const raw = decPart !== null ? (intPart || '0') + '.' + decPart : intPart;
    onChange(raw || '');
  }
  return e('input', { ref, type: 'text', inputMode: 'decimal', className: className || 'form-input', value: display, onChange: handleChange, required, placeholder, disabled, style });
}

// Tabla compacta para desglose por persona en cards bimonetarias (Me Deben / Me Deben Corte).
// Header: Persona | COP | USD. Cada fila muestra un punto de color, nombre y los dos valores.
// Si una persona solo debe en una moneda, la otra columna muestra "—" discreto.
// Aplica el "estilo Opción A" elegido para v3.1.1.
//
// Tipografía: los NOMBRES heredan la sans-serif del sistema (Segoe UI en Windows) —
// se ven como nombres propios. Los VALORES numéricos sí usan monospace para alinear
// los montos verticalmente.
function personasTableBimon(detalle) {
  const e = React.createElement;
  const hayUsd = detalle.some(d => (d.totalUsd || 0) > 0);
  const cellBase = { padding: '6px 4px', fontSize: 12 };
  const cellMono = Object.assign({}, cellBase, { fontFamily: 'monospace' });
  const headStyle = {
    padding: '4px 4px 8px',
    fontSize: 9, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 600,
    borderBottom: '1px solid var(--border)'
  };
  return e('div', { style: { width: '100%' } },
    e('table', { style: { width: '100%', borderCollapse: 'collapse' } },
      e('thead', null,
        e('tr', null,
          e('th', { style: Object.assign({}, headStyle, { textAlign: 'left' }) }, 'Persona'),
          e('th', { style: Object.assign({}, headStyle, { textAlign: 'right' }) }, 'COP'),
          hayUsd && e('th', { style: Object.assign({}, headStyle, { textAlign: 'right', color: '#4FC3F7' }) }, 'USD')
        )
      ),
      e('tbody', null,
        detalle.map(d => e('tr', { key: d.nombre, style: { borderBottom: '1px solid rgba(255,255,255,0.04)' } },
          // Columna Persona: sans-serif heredada (sin monospace) para nombres propios.
          e('td', { style: Object.assign({}, cellBase, { textAlign: 'left', color: 'var(--text-primary)' }) },
            e('span', { style: {
              display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
              background: d.color || 'var(--success)', marginRight: 6, verticalAlign: 'middle'
            } }),
            d.nombre
          ),
          // Columnas COP y USD: monospace para alinear los dígitos.
          e('td', { style: Object.assign({}, cellMono, { textAlign: 'right', color: 'var(--text-primary)', fontWeight: 600 }) },
            (d.total || 0) > 0 ? fmtCOP(d.total) : e('span', { style: { color: 'var(--text-muted)' } }, '—')
          ),
          hayUsd && e('td', { style: Object.assign({}, cellMono, { textAlign: 'right', color: '#4FC3F7', fontWeight: 700 }) },
            (d.totalUsd || 0) > 0 ? fmtUsd(d.totalUsd) : e('span', { style: { color: 'var(--text-muted)' } }, '—')
          )
        ))
      )
    )
  );
}
function bimonCard(opts) {
  // opts: { variant, title, copValue, usdValue, hasUsd, copExtra, usdExtra, footer, footerSub }
  // variant -> 'success' | 'danger' | 'warning' | 'accent' | 'purple'
  // Diseño "dos pisos": title arriba, valor COP con prefix inline, divisor horizontal,
  // valor USD con prefix inline en cyan. Footer y footerSub opcionales separados.
  const e = React.createElement;
  const className = 'card' + (opts.variant ? ' card-' + opts.variant : '');
  const tierStyle = { padding: '12px 16px' };
  const dividerTier = Object.assign({}, tierStyle, { borderTop: '1px solid var(--border)' });
  // Valor principal: misma tipografía/jerarquía que la clase .card-value (sans-serif del
  // sistema, 28px, weight 700) usada por la card "Pago Mínimo", para que todas las cards del
  // dashboard se vean consistentes. Los mini-bloques de detalle (copExtra/usdExtra) conservan
  // su fuente monospace pequeña.
  const valueStyleCop = { fontSize: 25, fontWeight: 700, lineHeight: 1.1, color: 'var(--text-primary)' };
  const valueStyleUsd = Object.assign({}, valueStyleCop, { color: '#4FC3F7' });
  // Prefijo "COP" SOLO cuando la card maneja doble moneda (hasUsd): ahí hay un valor USD abajo
  // del que hay que distinguir el de pesos. En tarjetas de una sola moneda el prefijo es
  // redundante, así que mostramos el valor a secas ("$XXX").
  const copDisplay = (opts.hasUsd && typeof opts.copValue === 'string' && !opts.copValue.startsWith('COP '))
    ? 'COP ' + opts.copValue : opts.copValue;
  // USD ya viene como "USD $X.XX" desde fmtUsd, lo dejamos tal cual.
  return e('div', { className, style: { padding: 0, overflow: 'hidden' } },
    e('div', { style: { padding: '12px 16px 10px' } },
      e('div', { className: 'card-label', style: { margin: 0 } }, opts.title)
    ),
    e('div', { style: Object.assign({}, tierStyle, { borderTop: '1px solid var(--border)' }) },
      e('div', { style: valueStyleCop }, copDisplay),
      opts.copExtra || null
    ),
    opts.hasUsd ? e('div', { style: dividerTier },
      e('div', { style: valueStyleUsd }, opts.usdValue),
      opts.usdExtra || null
    ) : null,
    opts.footer ? e('div', { style: { borderTop: '1px solid var(--border)', padding: '10px 16px' } }, opts.footer) : null,
    opts.footerSub ? e('div', { style: { borderTop: '1px solid var(--border)', padding: '8px 16px 12px', fontSize: 11, color: 'var(--text-muted)' } }, opts.footerSub) : null
  );
}

function CicloPicker({ value, onChange }) {
  function shift(delta) {
    const [y, m] = value.split('-').map(Number);
    const d = new Date(y, m - 1 + delta);
    onChange(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  }
  const label = value ? new Date(value + '-15').toLocaleDateString('es-CO', { month: 'long', year: 'numeric' }) : '';
  return e('div', { style: { display: 'flex', alignItems: 'center', gap: 2, background: 'var(--bg-tertiary)', borderRadius: 20, padding: '3px 6px', border: '1px solid var(--border)' } },
    e('button', { type: 'button', onClick: () => shift(-1), style: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 6px', fontSize: 16, lineHeight: 1, borderRadius: 12 } }, '\u2039'),
    e('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--accent)', minWidth: 130, textAlign: 'center', textTransform: 'capitalize', userSelect: 'none' } }, label),
    e('button', { type: 'button', onClick: () => shift(1), style: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 6px', fontSize: 16, lineHeight: 1, borderRadius: 12 } }, '\u203a')
  );
}

// ═══════════════════════════════════════════════════════════════════
// MODAL COMPONENT
// ═══════════════════════════════════════════════════════════════════
function Modal({ show, onClose, title, large, children }) {
  if (!show) return null;
  return e('div', { className: 'modal-overlay' },
    e('div', { className: 'modal' + (large ? ' modal-lg' : '') },
      e('div', { className: 'modal-handle' }),
      e('button', { type: 'button', className: 'modal-close-btn', onClick: onClose, title: 'Cerrar' }, '\u2715'),
      e('div', { className: 'modal-title' }, title),
      children
    )
  );
}
