// public/js/calculadora.js — Simulador de avances y diferidas.


// ═══════════════════════════════════════════════════════════════════
// CALCULADORA
// ═══════════════════════════════════════════════════════════════════
function Calculadora({ tarjetas }) {
  const [tipo, setTipo] = useState('avance');
  const [tarjetaId, setTarjetaId] = useState('');
  const [monto, setMonto] = useState('');
  const [plazo, setPlazo] = useState('24');
  const [tasaMv, setTasaMv] = useState('');
  const [fecha, setFecha] = useState(todayISO());
  const [diaCorte, setDiaCorte] = useState('30');
  const [comision, setComision] = useState('');
  const [resultado, setResultado] = useState(null);
  const [loading, setLoading] = useState(false);
  const [bancoSel, setBancoSel] = useState('');

  function onTarjetaChange(id) {
    setTarjetaId(id); setResultado(null);
    if (!id) { setBancoSel(''); return; }
    const tj = tarjetas.find(t => String(t.id) === id);
    if (!tj) return;
    setTasaMv(((tipo === 'avance' ? tj.tasa_mv_avances : tj.tasa_mv_diferidas) * 100).toFixed(4));
    setDiaCorte(String(tj.dia_corte));
    setBancoSel(tj.banco || '');
  }

  function onTipoChange(t) {
    setTipo(t); setResultado(null);
    if (t === 'avance') setPlazo('24');
    if (tarjetaId) {
      const tj = tarjetas.find(tj => String(tj.id) === tarjetaId);
      if (tj) setTasaMv(((t === 'avance' ? tj.tasa_mv_avances : tj.tasa_mv_diferidas) * 100).toFixed(4));
    }
  }

  async function calcular(ev) {
    ev.preventDefault();
    const m = parseFloat(String(monto).replace(/\./g, '').replace(',', '.'));
    if (!m || m <= 0) { toastErr('Ingresa un monto válido'); return; }
    const p = parseInt(plazo);
    if (!p || p < 1 || p > 120) { toastErr('Cuotas debe ser entre 1 y 120'); return; }
    const t = parseFloat(tasaMv);
    if (!t || t <= 0) { toastErr('Tasa MV inválida'); return; }
    setLoading(true);
    try {
      const res = await api('/calculadora', {
        method: 'POST',
        body: { tipo, monto: m, tasa_mv: t, plazo: p, fecha, dia_corte: parseInt(diaCorte) || 30, comision: parseFloat(comision) || 0, tarjeta_id: tarjetaId || null }
      });
      if (res.error) toastErr(res.error); else setResultado(res);
    } catch(e) { toastErr('Error al calcular'); }
    setLoading(false);
  }

  const isNu = bancoSel && bancoSel.toLowerCase().includes('nu');
  const tarjetasActivas = (tarjetas || []).filter(t => t.estado === 'activa');

  var totalPagar = 0, totalIntereses = 0, primeraCuota = 0, ultimaCuota = 0;
  if (resultado && resultado.tabla && resultado.tabla.length > 0) {
    const col = tipo === 'avance' ? 'totalExtracto' : 'totalPagar';
    totalPagar = resultado.tabla.reduce((s, r) => s + r[col], 0);
    totalIntereses = resultado.resumen.totalIntereses;
    primeraCuota = resultado.tabla[0][col];
    ultimaCuota = resultado.tabla[resultado.tabla.length - 1][col];
  }

  return e('div', null,
    e('div', { className: 'section-title' }, e(Ico, { name: 'calculator', size: 20, color: 'var(--accent)' }), ' Calculadora'),
    e('div', { style: { fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 } },
      'Simula la amortización de un avance o compra diferida. No afecta ningún registro.'
    ),

    // Selector de tipo
    e('div', { style: { display: 'flex', gap: 12, marginBottom: 28 } },
      e('div', {
        onClick: () => onTipoChange('avance'),
        style: { flex: 1, cursor: 'pointer', borderRadius: 14, padding: '18px 20px', border: '2px solid ' + (tipo === 'avance' ? 'var(--accent)' : 'var(--border)'), background: tipo === 'avance' ? 'var(--accent-bg)' : 'var(--bg-card)', transition: 'all 0.15s' }
      },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } },
          e(Ico, { name: 'dollar', size: 28, color: tipo === 'avance' ? 'var(--accent)' : 'var(--text-muted)' }),
          e('div', null,
            e('div', { style: { fontWeight: 700, fontSize: 15, color: tipo === 'avance' ? 'var(--accent)' : 'var(--text-primary)' } }, 'Avance de Dinero'),
            e('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginTop: 3 } }, 'Efectivo a cuotas · interés desde cuota 1')
          )
        )
      ),
      e('div', {
        onClick: () => onTipoChange('diferida'),
        style: { flex: 1, cursor: 'pointer', borderRadius: 14, padding: '18px 20px', border: '2px solid ' + (tipo === 'diferida' ? 'var(--accent)' : 'var(--border)'), background: tipo === 'diferida' ? 'var(--accent-bg)' : 'var(--bg-card)', transition: 'all 0.15s' }
      },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } },
          e(Ico, { name: 'credit-card', size: 28, color: tipo === 'diferida' ? 'var(--accent)' : 'var(--text-muted)' }),
          e('div', null,
            e('div', { style: { fontWeight: 700, fontSize: 15, color: tipo === 'diferida' ? 'var(--accent)' : 'var(--text-primary)' } }, 'Compra Diferida'),
            e('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginTop: 3 } }, 'Pago en cuotas desde la fecha de compra')
          )
        )
      )
    ),

    // Formulario
    e('form', { onSubmit: calcular },
      // Tarjeta selector
      e('div', { style: { marginBottom: 16, maxWidth: 440 } },
        e('label', { className: 'form-label' }, 'Tarjeta'),
        e('select', { className: 'form-input', value: tarjetaId, onChange: ev => onTarjetaChange(ev.target.value) },
          e('option', { value: '' }, '— Seleccionar tarjeta —'),
          tarjetasActivas.map(t => e('option', { key: t.id, value: String(t.id) }, t.nombre + (t.banco ? ' · ' + t.banco : '')))
        )
      ),

      // Info auto-filled (visible solo cuando hay tarjeta seleccionada)
      tarjetaId && e('div', { style: { display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' } },
        e('div', { style: { background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 16px', minWidth: 90 } },
          e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 } }, 'Tasa MV'),
          e('div', { style: { fontSize: 15, fontWeight: 700, color: 'var(--accent)', fontFamily: 'monospace', marginTop: 2 } }, tasaMv + '%')
        ),
        e('div', { style: { background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 16px', minWidth: 90 } },
          e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 } }, 'Día de corte'),
          e('div', { style: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace', marginTop: 2 } }, diaCorte)
        ),
        tipo === 'avance' && e('div', { style: { background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 16px', minWidth: 90 } },
          e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 } }, 'Cuotas'),
          e('div', { style: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace', marginTop: 2 } }, '24')
        ),
        isNu && tipo === 'diferida' && e('div', { style: { background: 'var(--accent-bg)', border: '1px solid var(--accent)', borderRadius: 10, padding: '8px 16px' } },
          e('div', { style: { fontSize: 10, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.5 } }, 'Nu Colombia'),
          e('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--accent)', marginTop: 2 } }, 'Cuota 1 sin intereses')
        )
      ),

      // Inputs del usuario
      e('div', { className: 'cards-row', style: { marginBottom: 20 } },
        // Monto
        e('div', { className: 'card', style: { flex: '1 1 160px' } },
          e('label', { className: 'form-label' }, 'Monto'),
          e('input', { className: 'form-input', type: 'text', inputMode: 'numeric',
            value: monto ? parseInt(monto, 10).toLocaleString('es-CO') : '',
            onChange: ev => { const raw = ev.target.value.replace(/\D/g, ''); setMonto(raw); setResultado(null); },
            placeholder: '5.000.000', required: true })
        ),
        // Fecha
        e('div', { className: 'card', style: { flex: '1 1 160px' } },
          e('label', { className: 'form-label' }, tipo === 'avance' ? 'Fecha desembolso' : 'Fecha de compra'),
          e('input', { className: 'form-input', type: 'date', value: fecha, onChange: ev => { setFecha(ev.target.value); setResultado(null); }, required: true })
        ),
        // Cuotas solo para diferidas
        tipo === 'diferida' && e('div', { className: 'card', style: { flex: '0 1 130px' } },
          e('label', { className: 'form-label' }, 'Nº cuotas'),
          e('input', { className: 'form-input', type: 'number', value: plazo, onChange: ev => { setPlazo(ev.target.value); setResultado(null); }, min: 1, max: 120, required: true })
        ),
        // Comisión (solo avances)
        tipo === 'avance' && e('div', { className: 'card', style: { flex: '0 1 160px' } },
          e('label', { className: 'form-label' }, 'Comisión (opcional)'),
          e('input', { className: 'form-input', type: 'number', value: comision, onChange: ev => { setComision(ev.target.value); setResultado(null); }, placeholder: '0', min: 0 }),
          e('div', { className: 'form-hint' }, 'Se suma a la 1ª cuota')
        )
      ),
      e('button', { className: 'btn btn-primary', type: 'submit', disabled: loading || !tarjetaId },
        loading ? 'Calculando...' : !tarjetaId ? 'Selecciona una tarjeta primero' : 'Calcular amortización'
      )
    ),

    // Resultado
    resultado && resultado.tabla && e('div', { style: { marginTop: 32 } },
      // Encabezado resultado
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, borderTop: '1px solid var(--border)', paddingTop: 24 } },
        e('div', { className: 'section-title', style: { margin: 0 } }, 'Resultado'),
        e('div', { style: { fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-tertiary)', borderRadius: 8, padding: '3px 10px' } },
          (tipo === 'avance' ? 'Avance' : 'Diferida') + ' · ' + resultado.tabla.length + ' cuotas · ' + tasaMv + '% MV · corte día ' + diaCorte
        )
      ),

      // Cards resumen
      e('div', { className: 'cards-row', style: { marginBottom: 24 } },
        e('div', { className: 'card card-danger' },
          e('div', { className: 'card-label' }, 'Total a Pagar'),
          e('div', { className: 'card-value' }, fmtCOP(Math.round(totalPagar))),
          e('div', { style: { display: 'flex', gap: 14, marginTop: 6 } },
            e('div', null,
              e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Capital'),
              e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(parseFloat(monto) || 0))
            ),
            e('div', null,
              e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Intereses'),
              e('div', { style: { fontSize: 12, color: 'var(--danger)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOPDec(totalIntereses))
            )
          )
        ),
        e('div', { className: 'card card-purple' },
          e('div', { className: 'card-label' }, 'Total Intereses'),
          e('div', { className: 'card-value' }, fmtCOPDec(totalIntereses)),
          e('div', { className: 'card-sub' }, Math.round(totalIntereses / (parseFloat(monto) || 1) * 100) + '% del capital')
        ),
        e('div', { className: 'card card-warning' },
          e('div', { className: 'card-label' }, 'Primera cuota'),
          e('div', { className: 'card-value' }, fmtCOP(Math.round(primeraCuota))),
          resultado.tabla.length > 1 && e('div', { style: { display: 'flex', gap: 14, marginTop: 6 } },
            e('div', null,
              e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Última'),
              e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(Math.round(ultimaCuota)))
            )
          )
        ),
        e('div', { className: 'card card-accent' },
          e('div', { className: 'card-label' }, 'Capital por cuota'),
          e('div', { className: 'card-value' }, fmtCOP(Math.round(resultado.resumen.cuotaCapitalFija)))
        )
      ),

      // Tabla amortización
      e('div', { className: 'section-title', style: { marginBottom: 10 } }, 'Tabla de Amortización'),
      e('table', null,
        e('thead', null, e('tr', null,
          e('th', null, 'Cuota'), e('th', null, 'Fecha corte'), e('th', null, 'Días'),
          e('th', { className: 'text-right' }, 'Saldo inicial'),
          e('th', { className: 'text-right' }, 'Capital'),
          e('th', { className: 'text-right' }, 'Interés'),
          e('th', { className: 'text-right' }, 'Total cuota')
        )),
        e('tbody', null,
          resultado.tabla.map((r, i) => {
            var total   = tipo === 'avance' ? r.totalExtracto : r.totalPagar;
            var interes = tipo === 'avance' ? r.interes       : r.interesTotal;
            var saldo   = tipo === 'avance' ? r.saldoInicio   : r.saldoInicial;
            return e('tr', { key: i },
              e('td', null, e('span', { style: { fontWeight: 600, color: 'var(--text-muted)', fontSize: 12 } }, r.numCuota + '/' + resultado.tabla.length)),
              e('td', null, fmtDate(r.fechaCorte)),
              e('td', { style: { color: 'var(--text-muted)', fontSize: 12 } }, r.dias),
              e('td', { className: 'text-right text-mono' }, fmtCOP(Math.round(saldo))),
              e('td', { className: 'text-right text-mono', style: { color: 'var(--accent)' } }, fmtCOP(Math.round(r.cuotaCapital))),
              e('td', { className: 'text-right text-mono', style: { color: interes > 0 ? 'var(--danger)' : 'var(--success)' } }, fmtCOPDec(interes)),
              e('td', { className: 'text-right text-mono', style: { fontWeight: 700 } }, fmtCOP(Math.round(total)))
            );
          })
        )
      )
    )
  );
}
