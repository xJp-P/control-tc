// public/js/proyecciones.js — Grafico de proyeccion de extractos a N meses.


// ═══════════════════════════════════════════════════════════════════
// PROYECCIONES (per card)
// ═══════════════════════════════════════════════════════════════════
function Proyecciones({ tarjeta }) {
  const [data, setData] = useState(null);
  const [meses, setMeses] = useState(24);
  useEffect(() => { api('/proyecciones?tarjeta_id=' + tarjeta.id + '&meses=' + meses).then(setData); }, [meses, tarjeta.id]);
  if (!data) return e('div', { className: 'loading' }, 'Calculando...');
  const maxTotal = Math.max(...data.proyeccion.map(p => p.totalExtracto), 1);

  return e('div', null,
    e('div', { className: 'toolbar' },
      e('div', { className: 'toolbar-spacer' }),
      e('label', { className: 'form-label', style: { margin: 0 } }, 'Meses: '),
      e('select', { className: 'form-select', style: { width: 80 }, value: meses, onChange: ev => setMeses(parseInt(ev.target.value)) },
        e('option', { value: 12 }, '12'), e('option', { value: 24 }, '24'), e('option', { value: 36 }, '36')
      )
    ),
    data.fechaDeudaCero && e('div', { className: 'cards-row' },
      e('div', { className: 'card card-success' },
        e('div', { className: 'card-label' }, 'Fecha Estimada Deuda Cero'), e('div', { className: 'card-value' }, data.fechaDeudaCero)
      )
    ),
    e('div', { className: 'card', style: { marginBottom: 24 } },
      e('div', { style: { fontWeight: 700, marginBottom: 12 } }, 'Evolucion del Extracto Mensual'),
      e('div', { className: 'bar-chart' },
        data.proyeccion.map((p, i) =>
          e('div', { key: i, className: 'bar-col' },
            e('div', { className: 'bar-value' }, p.totalExtracto > 0 ? fmtCOP(p.totalExtracto) : ''),
            e('div', { className: 'bar', style: { height: (p.totalExtracto / maxTotal * 160) + 'px', background: p.totalExtracto > 0 ? 'var(--accent)' : 'var(--border)' } }),
            e('div', { className: 'bar-label' }, p.mes.slice(5))
          )
        )
      )
    ),
    e('div', { className: 'table-wrap' },
      e('table', null,
        e('thead', null, e('tr', null,
          e('th', null, 'Mes'), e('th', { className: 'text-right' }, 'Avances'), e('th', { className: 'text-right' }, 'Diferidas'),
          e('th', { className: 'text-right' }, 'Int. Avances'), e('th', { className: 'text-right' }, 'Int. Diferidas'), e('th', { className: 'text-right' }, 'Total')
        )),
        e('tbody', null,
          data.proyeccion.map((p, i) =>
            e('tr', { key: i },
              e('td', { style: { fontWeight: 600 } }, p.mes),
              e('td', { className: 'text-right text-mono' }, fmtCOP(p.totalAvances)),
              e('td', { className: 'text-right text-mono' }, fmtCOP(p.totalDiferidas)),
              e('td', { className: 'text-right text-mono' }, fmtCOP(p.interesesAvances)),
              e('td', { className: 'text-right text-mono' }, fmtCOP(p.interesesDiferidas)),
              e('td', { className: 'text-right text-mono', style: { fontWeight: 700 } }, fmtCOP(p.totalExtracto))
            )
          )
        )
      )
    )
  );
}
