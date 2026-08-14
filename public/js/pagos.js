// public/js/pagos.js — Pestana Pagos: extractos por ciclo, desglose y registro del pago.


// ═══════════════════════════════════════════════════════════════════
// PAGOS (per card)
// ═══════════════════════════════════════════════════════════════════
function Pagos({ tarjeta, onDataChange }) {
  const [extractos, setExtractos] = useState([]);
  const [pagos, setPagos] = useState([]);
  const [showPagoModal, setShowPagoModal] = useState(false);
  const [pagoExtracto, setPagoExtracto] = useState(null);
  const [pagoMonto, setPagoMonto] = useState('');
  const [pagoFecha, setPagoFecha] = useState(todayISO());
  const [pagoTipo, setPagoTipo] = useState('pago_minimo');
  const [pagoMoneda, setPagoMoneda] = useState('COP'); // 'COP' | 'USD'

  const loadExtractos = useCallback(() => { api('/extractos?tarjeta_id=' + tarjeta.id).then(setExtractos); }, [tarjeta.id]);
  const loadPagos = useCallback(() => { api('/pagos?tarjeta_id=' + tarjeta.id).then(setPagos); }, [tarjeta.id]);
  useEffect(() => { loadExtractos(); loadPagos(); }, [loadExtractos, loadPagos]);

  function openPagar(ext) {
    setPagoExtracto(ext);
    // Si el ciclo es dual y la porción COP ya está pagada, arrancar con USD por default.
    const monedaInicial = (ext.estado === 'pagado' && ext.dual_extracto && ext.estado_usd === 'pendiente' && ext.pago_minimo_usd > 0)
      ? 'USD'
      : 'COP';
    setPagoMoneda(monedaInicial);
    if (monedaInicial === 'USD') {
      const restanteUsd = Math.max(0, (ext.pago_minimo_usd || 0) - (ext.monto_pagado_usd || 0));
      setPagoMonto(restanteUsd);
    } else {
      // `ext.pago_minimo` ya viene siendo el valor OFICIAL del extracto cuando se concilio el PDF
      // (v5.7.0, backend routes/extractos.js). Si no hay oficial, cae al estimado de la app.
      const restante = Math.max(0, ext.pago_minimo - (ext.monto_pagado || 0));
      setPagoMonto(restante);
    }
    setPagoTipo('pago_restante');
    setPagoFecha(todayISO());
    setShowPagoModal(true);
  }

  async function submitPago(ev) {
    ev.preventDefault();
    var monto = parseFloat(pagoMonto);
    if (!monto || monto <= 0) { toast('Ingresa un monto valido'); return; }
    const resp = await api('/extractos/' + pagoExtracto.id + '/pagar', {
      method: 'PUT',
      body: { monto_pagado: monto, fecha_pagado: pagoFecha, tipo: 'abono_extracto', moneda: pagoMoneda }
    });
    // api() no lanza ante 4xx/5xx: devuelve {error}. Sin este corte, un pago fallido mostraba
    // igualmente un toast de exito y el usuario creia haber pagado.
    if (!resp || resp.error) { toastErr('No se registro el pago: ' + ((resp && resp.error) || 'sin respuesta del servidor')); return; }
    setShowPagoModal(false);
    loadExtractos(); loadPagos();
    if (onDataChange) onDataChange();
    if (pagoMoneda === 'USD') {
      var nuevoTotalUsd = (pagoExtracto.monto_pagado_usd || 0) + monto;
      toast(nuevoTotalUsd >= (pagoExtracto.pago_minimo_usd || 0) ? 'Pago USD completado' : 'Abono USD registrado');
    } else {
      // El veredicto lo da el BACKEND (aplica la tolerancia y conoce la cifra oficial): compararlo aca
      // contra el estimado del front daria un mensaje distinto al efecto real. Fallback local solo si
      // la respuesta no trae el dato.
      var completo = (resp && typeof resp.pagadoCompleto === 'boolean')
        ? resp.pagadoCompleto
        : ((pagoExtracto.monto_pagado || 0) + monto) >= pagoExtracto.pago_minimo;
      var aj = (resp && resp.ajuste) || 0;
      if (completo && aj) {
        toast('Pago minimo COP completado. Se ajusto una diferencia de ' + (aj > 0 ? 'mas ' : 'menos ') + fmtCOP(Math.abs(aj)) + ' por dias de interes.');
      } else if (completo && resp.absorbido_por_tolerancia) {
        // Sella por tolerancia pero SIN adoptar cifra (ya habia una del PDF): hay que decirlo igual,
        // porque el usuario pago menos que la cifra del banco que la app tiene guardada.
        toast('Pago minimo COP completado. Se acepto una diferencia de ' + fmtCOP(Math.abs(resp.faltante_absorbido || 0)) + ' frente a la cifra del extracto.');
      } else {
        toast(completo ? 'Pago minimo COP completado' : 'Abono COP registrado');
      }
    }
  }


  function fmtCiclo(c) { const [y, m] = c.split('-'); const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']; return meses[parseInt(m)-1] + ' ' + y; }

  const hoy = todayISO();
  const totalPagado = pagos.reduce((s, p) => s + p.monto, 0);
  // Ciclo "actual" para agrupar la tabla = ciclo vigente consciente del corte adelantado (viene del
  // backend); si el banco ya cortó junio, el actual es julio y junio baja a "Por pagar". Fallback al
  // cálculo local (sin corte) solo si el backend no lo envió. cicloAct alimenta el DISPLAY de la
  // vista Pagos (Ciclo Actual / Por pagar); los candados de edición viven en CompraForm (isCicloCerrado).
  const cicloAct = tarjeta.ciclo_vigente || cicloVigente(tarjeta.dia_corte);
  const extCicloActual = extractos.find(x => x.ciclo === cicloAct);
  const extFaltaPagar = extractos.filter(x => x.ciclo !== cicloAct && x.estado === 'pendiente' && x.fecha_corte <= hoy).sort((a, b) => a.ciclo.localeCompare(b.ciclo));
  const extProximosCiclos = extractos.filter(x => x.ciclo !== cicloAct && x.estado === 'pendiente' && x.fecha_corte > hoy).sort((a, b) => a.ciclo.localeCompare(b.ciclo));
  const extHistoricosPagados = extractos.filter(x => x.estado === 'pagado').sort((a, b) => b.ciclo.localeCompare(a.ciclo));

  const [expandedExt, setExpandedExt] = useState(null);

  function renderExtractoRows(ext) {
    const vencido = ext.estado === 'pendiente' && ext.fecha_pago < hoy;
    const isExpanded = expandedExt === ext.id;
    const hasDetail = (ext.compras > 0 || (ext.detalle_avances && ext.detalle_avances.length > 0) || (ext.detalle_diferidas && ext.detalle_diferidas.length > 0));
    const rows = [];
    // Soporte dual COP/USD: solo cuando la tarjeta es dual y el extracto tiene saldo USD.
    const tieneUsd = !!(ext.dual_extracto && (ext.pago_minimo_usd || 0) > 0);
    const usdPagado = ext.estado_usd === 'pagado';
    const copPagado = ext.estado === 'pagado';
    const cerradoCompleto = copPagado && (usdPagado || ext.estado_usd === 'no_aplica' || !tieneUsd);
    const hayPendiente = !copPagado || (tieneUsd && !usdPagado);
    const fmtUsd = (n) => 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

    rows.push(e('tr', {
      key: ext.id,
      style: Object.assign({}, cerradoCompleto ? { background: 'rgba(52,211,153,0.08)' } : vencido ? { background: 'rgba(239,68,68,0.08)' } : {}, hasDetail ? { cursor: 'pointer' } : {}),
      onClick: hasDetail ? () => setExpandedExt(isExpanded ? null : ext.id) : undefined
    },
      e('td', { style: { fontWeight: 600 } }, hasDetail ? (isExpanded ? '\u25BC ' : '\u25B6 ') : '  ', fmtCiclo(ext.ciclo)),
      e('td', null, fmtDate(ext.fecha_corte),
        ext.es_corte_adelantado && e('span', { style: { fontSize: 9, marginLeft: 6, color: 'var(--accent)', fontWeight: 700, letterSpacing: 0.3 }, title: ext.fecha_corte_auto ? 'Corte te\u00F3rico: ' + fmtDate(ext.fecha_corte_auto) : undefined }, '(ADELANTADO)')),
      e('td', { style: { color: vencido ? 'var(--danger)' : '' } },
        fmtDate(ext.fecha_pago),
        ext.es_fecha_pago_manual && e('span', { style: { fontSize: 9, marginLeft: 6, color: 'var(--accent)', fontWeight: 700, letterSpacing: 0.3 } }, '(MANUAL)'),
        vencido && e('span', { style: { color: 'var(--danger)', fontSize: 11, marginLeft: 6 } }, 'VENCIDO')
      ),
      e('td', { className: 'text-right text-mono' },
        fmtCOP(ext.pago_minimo),
        // Marca que esta cifra es la OFICIAL leida del extracto del banco, no el estimado de la app
        // (v5.7.0). Es la que hay que pagar; el estimado queda en pago_minimo_calculado.
        ext.tiene_oficial && e('div', {
          style: { fontSize: 9, color: ext.oficial_es_ajuste ? 'var(--warning)' : 'var(--success)', fontWeight: 700, letterSpacing: 0.3, cursor: 'help' },
          title: (ext.oficial_es_ajuste
            ? 'Cifra adoptada de lo que pagaste, no leida de un extracto. Estimado de la app: '
            : 'Cifra tomada del extracto del banco. Estimado de la app: ') + fmtCOP(ext.pago_minimo_calculado)
        }, ext.oficial_es_ajuste ? 'AJUSTADO AL PAGO' : 'DEL EXTRACTO'),
        tieneUsd && e('div', { style: { fontSize: 11, color: '#4FC3F7', fontWeight: 700 } }, fmtUsd(ext.pago_minimo_usd))
      ),
      e('td', { className: 'text-right text-mono' },
        fmtCOP(ext.pago_total),
        tieneUsd && e('div', { style: { fontSize: 11, color: '#4FC3F7', fontWeight: 700 } }, fmtUsd(ext.pago_total_usd || ext.pago_minimo_usd))
      ),
      e('td', { className: 'text-right text-mono', style: { fontSize: 12, color: ext.intereses_intl > 0 ? '#14b8a6' : 'var(--text-muted)', fontWeight: ext.intereses_intl > 0 ? 600 : 400 } },
        ext.intereses_intl > 0 ? fmtCOP(ext.intereses_intl) : '\u2014'
      ),
      e('td', { className: 'text-right text-mono', style: { fontWeight: 700, color: ext.monto_pagado > 0 ? 'var(--success)' : '' } },
        ext.monto_pagado > 0 ? e('span', null, fmtCOP(ext.monto_pagado),
          ext.estado === 'pendiente' && ext.monto_pagado < ext.pago_minimo
            ? e('div', { style: { fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 } }, 'Falta: ' + fmtCOP(ext.pago_minimo - ext.monto_pagado))
            : null
        ) : '-',
        tieneUsd && (ext.monto_pagado_usd || 0) > 0 && e('div', { style: { fontSize: 11, color: '#4FC3F7', fontWeight: 700 } }, fmtUsd(ext.monto_pagado_usd))
      ),
      e('td', null,
        // Para tarjetas duales con USD: dos badges apilados (COP + USD).
        tieneUsd
          ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' } },
              copPagado
                ? e('span', { className: 'badge badge-pagado', style: { fontSize: 10 } }, 'COP PAGADO')
                : ext.monto_pagado > 0 && ext.monto_pagado < ext.pago_minimo
                  ? e('span', { className: 'badge', style: { background: 'rgba(251,191,36,0.15)', color: 'var(--warning)', fontSize: 10 } }, 'COP ABONADO')
                  : vencido
                    ? e('span', { className: 'badge badge-vencido', style: { fontSize: 10 } }, 'COP VENCIDO')
                    : e('span', { className: 'badge badge-pendiente', style: { fontSize: 10 } }, 'COP PENDIENTE'),
              usdPagado
                ? e('span', { className: 'badge badge-pagado', style: { fontSize: 10, background: 'rgba(79,195,247,0.15)', color: '#4FC3F7' } }, 'USD PAGADO')
                : (ext.monto_pagado_usd || 0) > 0 && (ext.monto_pagado_usd || 0) < (ext.pago_minimo_usd || 0)
                  ? e('span', { className: 'badge', style: { background: 'rgba(251,191,36,0.15)', color: 'var(--warning)', fontSize: 10 } }, 'USD ABONADO')
                  : e('span', { className: 'badge badge-pendiente', style: { fontSize: 10 } }, 'USD PENDIENTE')
            )
          // Tarjetas no-duales o ciclos sin USD: badge \u00FAnico como antes.
          : copPagado
            ? e('span', { className: 'badge badge-pagado' }, 'PAGADO')
            : ext.monto_pagado > 0 && ext.monto_pagado < ext.pago_minimo
              ? e('span', { className: 'badge', style: { background: 'rgba(251,191,36,0.15)', color: 'var(--warning)' } }, 'ABONADO')
              : vencido
                ? e('span', { className: 'badge badge-vencido' }, 'VENCIDO')
                : e('span', { className: 'badge badge-pendiente' }, 'PENDIENTE')
      ),
      e('td', { onClick: ev => ev.stopPropagation() },
        hayPendiente
          ? e('button', { className: 'btn btn-sm btn-success', onClick: () => openPagar(ext) }, e(Ico, { name: 'dollar', size: 14 }),
              ext.monto_pagado > 0 || (ext.monto_pagado_usd || 0) > 0 ? ' Abonar' : ' Pagar')
          : null
      )
    ));

    if (isExpanded) {
      var cellStyle = { padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)' };
      var cellR = Object.assign({}, cellStyle, { textAlign: 'right' });
      var headerStyle = { padding: '8px', fontWeight: 700, fontSize: 12, borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' };
      var subRowStyle = { padding: '4px 8px 4px 24px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 12, color: 'var(--text-secondary)' };
      var subRowR = Object.assign({}, subRowStyle, { textAlign: 'right' });

      var desgloseRows = [];

      // Merge all items into one chronological list. Compras divididas (con grupo_id) se agrupan en un item padre.
      var allItems = [];
      if (ext.detalle_compras) {
        var gruposCompras = {};
        var singlesCompras = [];
        ext.detalle_compras.forEach(function(c) {
          if (c.grupo_id) {
            if (!gruposCompras[c.grupo_id]) gruposCompras[c.grupo_id] = [];
            gruposCompras[c.grupo_id].push(c);
          } else {
            singlesCompras.push(c);
          }
        });
        singlesCompras.forEach(function(c) {
          var intl = c.interes_intl || 0;
          allItems.push({ tipo: 'compra', fecha: c.fecha || '', _ordenId: c.id, nombre: c.descripcion, capital: c.total, interes: intl, total: c.total + intl, valor_usd: c.valor_usd, tasa_usd: c.tasa_usd, es_internacional: c.es_internacional });
        });
        Object.keys(gruposCompras).forEach(function(gid) {
          var partes = gruposCompras[gid];
          if (partes.length > 1) {
            var first = partes[0];
            var capitalGrupo = partes.reduce(function(s, p) { return s + p.total; }, 0);
            var interesGrupo = partes.reduce(function(s, p) { return s + (p.interes_intl || 0); }, 0);
            allItems.push({
              tipo: 'compra_grupo', fecha: first.fecha || '', nombre: first.descripcion,
              // _ordenId = menor id de las partes (nacimiento de la compra dividida), igual que
              // purchaseRows en la tabla principal — desempate cronológico por fecha igual.
              _ordenId: Math.min.apply(null, partes.map(function(p) { return p.id; })),
              capital: capitalGrupo, interes: interesGrupo, total: capitalGrupo + interesGrupo,
              valor_usd: first.valor_usd, tasa_usd: first.tasa_usd, partes: partes
            });
          } else {
            var c = partes[0];
            var intlSingle = c.interes_intl || 0;
            allItems.push({ tipo: 'compra', fecha: c.fecha || '', _ordenId: c.id, nombre: c.descripcion, capital: c.total, interes: intlSingle, total: c.total + intlSingle, valor_usd: c.valor_usd, tasa_usd: c.tasa_usd, es_internacional: c.es_internacional });
          }
        });
      }
      if (ext.detalle_avances) ext.detalle_avances.forEach(function(a) {
        allItems.push({ tipo: 'avance', fecha: a.fecha || '', nombre: a.etiqueta, capital: a.capital, interes: a.interes, total: a.total, valor_usd: null });
      });
      if (ext.detalle_diferidas) {
        // Agrupar diferidas divididas por grupo_id (proveniente de la compra vinculada).
        var gruposDif = {};
        var singlesDif = [];
        ext.detalle_diferidas.forEach(function(d) {
          if (d.grupo_id) {
            if (!gruposDif[d.grupo_id]) gruposDif[d.grupo_id] = [];
            gruposDif[d.grupo_id].push(d);
          } else {
            singlesDif.push(d);
          }
        });
        singlesDif.forEach(function(d) {
          allItems.push({ tipo: 'diferida', fecha: d.fecha || '', nombre: d.etiqueta, capital: d.capital, interes: d.interes, total: d.total, valor_usd: null });
        });
        Object.keys(gruposDif).forEach(function(gid) {
          var partes = gruposDif[gid];
          if (partes.length > 1) {
            var first = partes[0];
            var capitalGrupo = partes.reduce(function(s, p) { return s + p.capital; }, 0);
            var interesGrupo = partes.reduce(function(s, p) { return s + p.interes; }, 0);
            var totalGrupo = partes.reduce(function(s, p) { return s + p.total; }, 0);
            allItems.push({
              tipo: 'diferida_grupo', fecha: first.fecha || '', nombre: first.etiqueta,
              capital: capitalGrupo, interes: interesGrupo, total: totalGrupo, partes: partes
            });
          } else {
            var d = partes[0];
            allItems.push({ tipo: 'diferida', fecha: d.fecha || '', nombre: d.etiqueta, capital: d.capital, interes: d.interes, total: d.total, valor_usd: null });
          }
        });
      }
      // Orden ASCENDENTE (cronológico, viejo→nuevo) con desempate por id: ante misma fecha, la
      // compra registrada antes va primero — mismo criterio que la tabla principal pero en sentido
      // inverso. Solo las compras exponen _ordenId; avances/diferidas (sin id comparable entre
      // tablas) caen a 0 y conservan su orden estable.
      allItems.sort(function(a, b) {
        var byFecha = a.fecha.localeCompare(b.fecha);
        if (byFecha !== 0) return byFecha;
        return (a._ordenId || 0) - (b._ordenId || 0);
      });

      var tipoLabel = { compra: 'Compra', avance: 'Avance', diferida: 'Diferida' };
      var tipoColor = { compra: 'var(--text-secondary)', avance: 'var(--danger)', diferida: 'var(--purple)' };

      allItems.forEach(function(item, i) {
        if (item.tipo === 'compra_grupo') {
          // Fila padre del grupo
          desgloseRows.push(e('tr', { key: 'item-grp-' + i, style: { background: 'rgba(99,102,241,0.06)' } },
            e('td', { style: subRowStyle }, item.fecha ? fmtDate(item.fecha) : '-'),
            e('td', { style: Object.assign({}, subRowStyle, { fontWeight: 700 }) },
              e('span', { style: { color: tipoColor.compra, fontSize: 10, fontWeight: 700, marginRight: 6, textTransform: 'uppercase' } }, tipoLabel.compra),
              item.nombre,
              e('span', { style: { fontSize: 10, color: 'var(--accent)', marginLeft: 8, fontWeight: 600 } }, 'Dividida ' + item.partes.length + ' partes')
            ),
            e('td', { style: subRowR, className: 'text-mono' }, item.capital ? fmtCOP(item.capital) : '-'),
            e('td', { style: Object.assign({}, subRowR, item.interes ? { color: '#14b8a6', fontWeight: 600 } : null), className: 'text-mono' }, item.interes ? fmtCOP(item.interes) : '-'),
            e('td', { style: subRowR, className: 'text-mono' }, item.valor_usd ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(item.valor_usd) : 'COP'),
            e('td', { style: Object.assign({}, subRowR, { fontWeight: 700 }), className: 'text-mono' }, fmtCOP(item.total))
          ));
          // Filas hijas (cada parte / persona)
          item.partes.forEach(function(p, j) {
            var pIntl = p.interes_intl || 0;
            desgloseRows.push(e('tr', { key: 'item-grp-' + i + '-' + j, style: { background: 'rgba(99,102,241,0.03)' } },
              e('td', { style: subRowStyle }),
              e('td', { style: Object.assign({}, subRowStyle, { paddingLeft: 40, fontSize: 12, color: 'var(--text-secondary)' }) },
                e('span', { style: { background: p.persona_id ? (p.persona_color || '#666') : '#666', width: 8, height: 8, display: 'inline-block', borderRadius: '50%', marginRight: 6, verticalAlign: 'middle' } }),
                p.persona_id ? p.persona_nombre : 'Personal'
              ),
              e('td', { style: subRowR, className: 'text-mono' }, fmtCOP(p.total)),
              e('td', { style: Object.assign({}, subRowR, pIntl > 0 ? { color: '#14b8a6', fontWeight: 600 } : null), className: 'text-mono' }, pIntl > 0 ? fmtCOP(pIntl) : '-'),
              e('td', { style: subRowR, className: 'text-mono' }, '-'),
              e('td', { style: subRowR, className: 'text-mono' }, fmtCOP(p.total + pIntl))
            ));
          });
        } else if (item.tipo === 'diferida_grupo') {
          // Fila padre del grupo de diferidas
          desgloseRows.push(e('tr', { key: 'item-difgrp-' + i, style: { background: 'rgba(168,85,247,0.06)' } },
            e('td', { style: subRowStyle }, item.fecha ? fmtDate(item.fecha) : '-'),
            e('td', { style: Object.assign({}, subRowStyle, { fontWeight: 700 }) },
              e('span', { style: { color: tipoColor.diferida, fontSize: 10, fontWeight: 700, marginRight: 6, textTransform: 'uppercase' } }, tipoLabel.diferida),
              item.nombre,
              e('span', { style: { fontSize: 10, color: 'var(--accent)', marginLeft: 8, fontWeight: 600 } }, 'Dividida ' + item.partes.length + ' partes')
            ),
            e('td', { style: subRowR, className: 'text-mono' }, item.capital ? fmtCOP(item.capital) : '-'),
            e('td', { style: subRowR, className: 'text-mono' }, item.interes ? fmtCOP(item.interes) : '-'),
            e('td', { style: subRowR, className: 'text-mono' }, 'COP'),
            e('td', { style: Object.assign({}, subRowR, { fontWeight: 700 }), className: 'text-mono' }, fmtCOP(item.total))
          ));
          // Filas hijas (cada parte / persona)
          item.partes.forEach(function(p, j) {
            desgloseRows.push(e('tr', { key: 'item-difgrp-' + i + '-' + j, style: { background: 'rgba(168,85,247,0.03)' } },
              e('td', { style: subRowStyle }),
              e('td', { style: Object.assign({}, subRowStyle, { paddingLeft: 40, fontSize: 12, color: 'var(--text-secondary)' }) },
                e('span', { style: { background: p.persona_id ? (p.persona_color || '#666') : '#666', width: 8, height: 8, display: 'inline-block', borderRadius: '50%', marginRight: 6, verticalAlign: 'middle' } }),
                p.persona_id ? p.persona_nombre : 'Personal'
              ),
              e('td', { style: subRowR, className: 'text-mono' }, p.capital ? fmtCOP(p.capital) : '-'),
              e('td', { style: subRowR, className: 'text-mono' }, p.interes ? fmtCOP(p.interes) : '-'),
              e('td', { style: subRowR, className: 'text-mono' }, '-'),
              e('td', { style: subRowR, className: 'text-mono' }, fmtCOP(p.total))
            ));
          });
        } else {
          // Para compras individuales con interés intl, resaltar el rubro en teal.
          var esIntlRow = item.tipo === 'compra' && item.interes > 0;
          desgloseRows.push(e('tr', { key: 'item' + i },
            e('td', { style: subRowStyle }, item.fecha ? fmtDate(item.fecha) : '-'),
            e('td', { style: subRowStyle },
              e('span', { style: { color: tipoColor[item.tipo], fontSize: 10, fontWeight: 700, marginRight: 6, textTransform: 'uppercase' } }, tipoLabel[item.tipo]),
              item.nombre
            ),
            e('td', { style: subRowR, className: 'text-mono' }, item.capital ? fmtCOP(item.capital) : '-'),
            e('td', { style: Object.assign({}, subRowR, esIntlRow ? { color: '#14b8a6', fontWeight: 600 } : null), className: 'text-mono' }, item.interes ? fmtCOP(item.interes) : '-'),
            e('td', { style: subRowR, className: 'text-mono' }, item.valor_usd ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(item.valor_usd) : 'COP'),
            e('td', { style: subRowR, className: 'text-mono' }, fmtCOP(item.total))
          ));
        }
      });

      // Summary row with totals by type
      var totalCompras = ext.compras || 0;
      var totalAvances = ext.detalle_avances ? ext.detalle_avances.reduce(function(s,a){return s+a.total},0) : 0;
      var totalDiferidas = ext.detalle_diferidas ? ext.detalle_diferidas.reduce(function(s,d){return s+d.total},0) : 0;
      if (totalCompras > 0) desgloseRows.push(e('tr', { key: 'sum-c', style: { borderTop: '1px solid var(--border)' } },
        e('td', null), e('td', { style: { padding: '4px 8px', fontSize: 12, fontWeight: 600 } }, ext.dual_extracto ? 'Subtotal Compras COP' : 'Subtotal Compras'), e('td', null), e('td', null), e('td', null),
        e('td', { style: { padding: '4px 8px', textAlign: 'right', fontWeight: 600 }, className: 'text-mono' }, fmtCOP(totalCompras))
      ));
      if (totalAvances > 0) desgloseRows.push(e('tr', { key: 'sum-a' },
        e('td', null), e('td', { style: { padding: '4px 8px', fontSize: 12, fontWeight: 600, color: 'var(--danger)' } }, 'Subtotal Avances'), e('td', null), e('td', null), e('td', null),
        e('td', { style: { padding: '4px 8px', textAlign: 'right', fontWeight: 600 }, className: 'text-mono' }, fmtCOP(totalAvances))
      ));
      if (totalDiferidas > 0) desgloseRows.push(e('tr', { key: 'sum-d' },
        e('td', null), e('td', { style: { padding: '4px 8px', fontSize: 12, fontWeight: 600, color: 'var(--purple)' } }, 'Subtotal Diferidas'), e('td', null), e('td', null), e('td', null),
        e('td', { style: { padding: '4px 8px', textAlign: 'right', fontWeight: 600 }, className: 'text-mono' }, fmtCOP(totalDiferidas))
      ));
      // Intereses agrupados:
      //  - Mastercard/Amex (dual): el banco muestra "INTERESES CORRIENTES" único — agrupamos avances + diferidas + intl en una sola línea
      //  - Visa (no dual): mantenemos la línea específica "Intereses Internacionales"
      // ext.cuotas_interes ya viene del backend con avances + diferidas + intereses_intl sumados.
      if (ext.dual_extracto) {
        if ((ext.cuotas_interes || 0) > 0) desgloseRows.push(e('tr', { key: 'sum-intc' },
          e('td', null),
          e('td', { style: { padding: '4px 8px', fontSize: 12, fontWeight: 600, color: '#14b8a6' } }, 'Intereses Corrientes'),
          e('td', null), e('td', null), e('td', null),
          e('td', { style: { padding: '4px 8px', textAlign: 'right', fontWeight: 600, color: '#14b8a6' }, className: 'text-mono' }, fmtCOP(ext.cuotas_interes))
        ));
      } else if (ext.intereses_intl > 0) {
        desgloseRows.push(e('tr', { key: 'sum-intl' },
          e('td', null),
          e('td', { style: { padding: '4px 8px', fontSize: 12, fontWeight: 600, color: '#14b8a6' } }, 'Intereses Internacionales'),
          e('td', null), e('td', null), e('td', null),
          e('td', { style: { padding: '4px 8px', textAlign: 'right', fontWeight: 600, color: '#14b8a6' }, className: 'text-mono' }, fmtCOP(ext.intereses_intl))
        ));
      }
      // Sección USD (extracto dual): se ubica al final del desglose para reflejar la
      // estructura del PDF de Bancolombia (cierra el bloque COP primero, abre USD después).
      if (ext.dual_extracto && ext.detalle_compras_usd && ext.detalle_compras_usd.length > 0) {
        desgloseRows.push(e('tr', { key: 'usd-header', style: { borderTop: '2px solid var(--info)' } },
          e('td', { colSpan: 6, style: { padding: '8px', fontWeight: 700, fontSize: 12, color: '#4FC3F7', textTransform: 'uppercase' } }, 'Secci\u00F3n D\u00F3lares (USD)')
        ));
        ext.detalle_compras_usd.forEach(function(c, i) {
          desgloseRows.push(e('tr', { key: 'usd' + i },
            e('td', { style: subRowStyle }, c.fecha ? fmtDate(c.fecha) : '-'),
            e('td', { style: subRowStyle },
              e('span', { style: { color: '#4FC3F7', fontSize: 10, fontWeight: 700, marginRight: 6, textTransform: 'uppercase' } }, 'COMPRA USD'),
              c.descripcion
            ),
            e('td', { style: subRowR, className: 'text-mono' }, '-'),
            e('td', { style: subRowR, className: 'text-mono' }, '-'),
            e('td', { style: subRowR, className: 'text-mono' }, 'USD'),
            e('td', { style: subRowR, className: 'text-mono', color: '#4FC3F7' }, 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c.total_usd))
          ));
        });
        desgloseRows.push(e('tr', { key: 'sum-usd', style: { borderTop: '1px solid var(--border)' } },
          e('td', null), e('td', { style: { padding: '4px 8px', fontSize: 12, fontWeight: 600, color: '#4FC3F7' } }, 'Subtotal Compras USD'), e('td', null), e('td', null), e('td', null),
          e('td', { style: { padding: '4px 8px', textAlign: 'right', fontWeight: 600, color: '#4FC3F7' }, className: 'text-mono' }, 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ext.compras_usd || 0))
        ));
        if (ext.intereses_compras_usd > 0) {
          desgloseRows.push(e('tr', { key: 'int-usd' },
            e('td', null), e('td', { style: { padding: '4px 8px', fontSize: 12, fontWeight: 600, color: '#4FC3F7' } }, 'Intereses Compras USD'), e('td', null), e('td', null), e('td', null),
            e('td', { style: { padding: '4px 8px', textAlign: 'right', fontWeight: 600, color: '#4FC3F7' }, className: 'text-mono' }, 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ext.intereses_compras_usd))
          ));
        }
      }
      // Nota: el "Pago M\u00EDnimo USD" se renderiza fuera de desgloseRows (ver tbody m\u00E1s abajo)
      // para que cierre el bloque visual junto al "Pago M\u00EDnimo COP".

      var thStyle = { textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' };
      var thStyleR = Object.assign({}, thStyle, { textAlign: 'right' });

      rows.push(e('tr', { key: ext.id + '-detail' },
        e('td', { colSpan: 9, style: { padding: '12px 20px', background: 'var(--bg-tertiary)', borderTop: 'none' } },
          e('div', { style: { fontSize: 13 } },
            e('div', { style: { fontWeight: 700, marginBottom: 10, color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase' } }, 'Desglose del extracto'),
            e('table', { style: { width: '100%', borderCollapse: 'collapse' } },
              e('thead', null, e('tr', null,
                e('th', { style: thStyle }, 'Fecha'),
                e('th', { style: thStyle }, 'Concepto'),
                e('th', { style: thStyleR }, 'Capital'),
                e('th', { style: thStyleR }, 'Intereses'),
                e('th', { style: thStyleR }, 'Moneda'),
                e('th', { style: thStyleR }, 'Total')
              )),
              e('tbody', null,
                ...desgloseRows,
                e('tr', { style: { borderTop: '2px solid var(--border)' } },
                  e('td', null),
                  e('td', { style: { padding: '8px', fontWeight: 700 } }, ext.dual_extracto ? 'Pago M\u00EDnimo COP' : 'Pago Minimo'),
                  e('td', null),
                  e('td', null),
                  e('td', null),
                  e('td', { className: 'text-mono', style: { padding: '8px', textAlign: 'right', fontWeight: 700, color: 'var(--warning)' } }, fmtCOP(ext.pago_minimo))
                ),
                ext.dual_extracto && ext.pago_minimo_usd > 0 ? e('tr', null,
                  e('td', null),
                  e('td', { style: { padding: '8px', fontWeight: 700, color: '#4FC3F7' } }, 'Pago M\u00EDnimo USD'),
                  e('td', null),
                  e('td', null),
                  e('td', null),
                  e('td', { className: 'text-mono', style: { padding: '8px', textAlign: 'right', fontWeight: 700, color: '#4FC3F7' } }, 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ext.pago_minimo_usd))
                ) : null
              )
            )
          )
        )
      ));
    }

    return rows;
  }

  function renderExtractoTable(rows) {
    return e('div', { className: 'table-wrap' },
      e('table', null,
        e('thead', null, e('tr', null,
          e('th', null, 'Ciclo'),
          e('th', null, 'Fecha Corte'),
          e('th', null, 'Fecha Pago'),
          e('th', { className: 'text-right' }, 'Pago Minimo'),
          e('th', { className: 'text-right' }, 'Pago Total'),
          e('th', { className: 'text-right', style: { color: '#14b8a6', whiteSpace: 'nowrap' } }, 'Intereses Int.'),
          e('th', { className: 'text-right' }, 'Pagado'),
          e('th', null, 'Estado'),
          e('th', null, '')
        )),
        e('tbody', null, rows.flatMap(renderExtractoRows))
      )
    );
  }

  return e('div', null,
    // Resumen
    e('div', { className: 'cards-row', style: { marginBottom: 20 } },
      e('div', { className: 'card card-accent' },
        e('div', { className: 'card-label' }, 'Total Pagado Historico'),
        e('div', { className: 'card-value' }, fmtCOP(totalPagado))
      ),
      e('div', { className: 'card' },
        e('div', { className: 'card-label' }, 'Extractos Pendientes'),
        e('div', { className: 'card-value', style: { color: extractos.filter(x => x.estado === 'pendiente' && x.fecha_pago <= hoy).length > 0 ? 'var(--danger)' : 'var(--text-primary)' } },
          extractos.filter(x => x.estado === 'pendiente').length)
      )
    ),

    // Falta por Pagar (extractos cuyo corte ya pasó y no están pagados)
    extFaltaPagar.length > 0 && e('div', null,
      e('div', { className: 'section-title', style: { color: 'var(--danger)' } }, e(Ico, { name: 'alert', size: 18, color: 'var(--danger)' }), ' Falta por Pagar'),
      renderExtractoTable(extFaltaPagar)
    ),

    // Ciclo Actual
    e('div', { className: 'section-title', style: { marginTop: 24 } }, e(Ico, { name: 'calendar', size: 18, color: 'var(--accent)' }), ' Ciclo Actual - ' + fmtCiclo(cicloAct)),
    extCicloActual
      ? renderExtractoTable([extCicloActual])
      : e('div', { className: 'empty-state', style: { padding: '16px 20px' } }, e('div', null, 'No hay movimientos en el ciclo actual.')),

    // Próximos Ciclos
    extProximosCiclos.length > 0 && e('div', null,
      e('div', { className: 'section-title', style: { marginTop: 24 } }, e(Ico, { name: 'trending', size: 18, color: 'var(--accent)' }), ' Proximos Ciclos'),
      renderExtractoTable(extProximosCiclos)
    ),

    // Historial (pagados)
    extHistoricosPagados.length > 0 && e('div', null,
      e('div', { className: 'section-title', style: { marginTop: 24 } }, e(Ico, { name: 'check', size: 18, color: 'var(--success)' }), ' Historial de Extractos'),
      renderExtractoTable(extHistoricosPagados)
    ),

    // Historial de pagos
    pagos.length > 0 && e('div', null,
      e('div', { className: 'section-title', style: { marginTop: 24 } }, e(Ico, { name: 'credit-card', size: 18, color: 'var(--accent)' }), ' Historial de Pagos'),
      e('div', { className: 'table-wrap' },
        e('table', null,
          e('thead', null, e('tr', null, e('th', null, 'Fecha'), e('th', { className: 'text-right' }, 'Monto'), e('th', null, 'Tipo'), e('th', null, 'Notas'), e('th', { style: { width: 60, textAlign: 'center' } }, ''))),
          e('tbody', null,
            pagos.map(p =>
              e('tr', { key: p.id },
                e('td', null, fmtDate(p.fecha)),
                e('td', { className: 'text-right text-mono', style: { fontWeight: 700 } }, fmtCOP(p.monto)),
                e('td', null, e('span', { className: 'badge badge-active' }, ({pago_minimo:'Pago Minimo', pago_total:'Pago Total', abono_capital:'Abono Capital', abono_extracto:'Abono Extracto'})[p.tipo] || p.tipo)),
                e('td', null, p.notas || '-'),
                e('td', { style: { textAlign: 'center' } },
                  e('button', {
                    className: 'btn btn-sm',
                    style: { background: 'transparent', padding: '4px 8px', border: 'none', cursor: 'pointer', opacity: 0.5, transition: 'opacity 0.2s' },
                    title: 'Revertir este pago',
                    onMouseEnter: (ev) => { ev.currentTarget.style.opacity = '1'; },
                    onMouseLeave: (ev) => { ev.currentTarget.style.opacity = '0.5'; },
                    onClick: async () => {
                      var tipoLabel = ({pago_minimo:'Pago Minimo', pago_total:'Pago Total', abono_capital:'Abono Capital', abono_extracto:'Abono Extracto'})[p.tipo] || p.tipo;
                      var ok = await confirmDialog(tipoLabel + ': ' + fmtCOP(p.monto) + '\nFecha: ' + fmtDate(p.fecha) + (p.notas ? '\nNotas: ' + p.notas : ''), { title: '¿Revertir este pago?', confirmText: 'Revertir' });
                      if (!ok) return;
                      api('/pagos/' + p.id, { method: 'DELETE' }).then(() => {
                        toast('Pago revertido exitosamente');
                        loadExtractos(); loadPagos();
                      // Mismo criterio: api() ya avisa de la escritura fallida y marca el error.
                      }).catch(err => { if (!err || !err.__avisado) toast('Error al revertir: ' + err.message); });
                    }
                  }, e(Ico, { name: 'undo', size: 15, color: 'var(--danger)' }))
                )
              )
            )
          )
        )
      )
    ),

    // Modal de pago
    e(Modal, { show: showPagoModal, onClose: () => setShowPagoModal(false), title: 'Registrar Pago - ' + (pagoExtracto ? fmtCiclo(pagoExtracto.ciclo) : '') },
      pagoExtracto && (function() {
        // Helper de formato según la moneda seleccionada.
        var esUsd = pagoMoneda === 'USD';
        var fmtMon = (n) => esUsd
          ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)
          : fmtCOP(n || 0);
        var pagoMinimoActual = esUsd ? (pagoExtracto.pago_minimo_usd || 0) : pagoExtracto.pago_minimo;
        var pagoTotalActual  = esUsd ? (pagoExtracto.pago_total_usd  || pagoExtracto.pago_minimo_usd || 0) : pagoExtracto.pago_total;
        var yaPagado = esUsd ? (pagoExtracto.monto_pagado_usd || 0) : (pagoExtracto.monto_pagado || 0);
        var restante = Math.max(0, pagoMinimoActual - yaPagado);
        // Banda sobre el minimo COMPLETO (como el backend), no sobre el restante: con un abono previo
        // el 2% se calcularia sobre una base menor y el aviso prometeria menos de lo que se acepta.
        var bandaCop = bandaToleranciaCop(pagoExtracto, pagoMinimoActual);
        var porcentaje = pagoMinimoActual > 0 ? Math.min(100, Math.round(yaPagado / pagoMinimoActual * 100)) : 0;
        var muestraSelector = pagoExtracto.dual_extracto && (pagoExtracto.pago_minimo_usd || 0) > 0;
        var copYaPagado = pagoExtracto.estado === 'pagado';
        var usdYaPagado = pagoExtracto.estado_usd === 'pagado';
        // Helper para renderizar un tab. activo=true marca color y borde inferior.
        // saldado=true muestra etiqueta y deshabilita.
        function tabBtn(label, moneda, activo, saldado) {
          const color = moneda === 'USD' ? '#4FC3F7' : 'var(--accent)';
          return e('button', {
            type: 'button',
            disabled: saldado,
            onClick: () => {
              if (saldado) return;
              setPagoMoneda(moneda);
              if (moneda === 'USD') {
                setPagoMonto(Math.max(0, (pagoExtracto.pago_minimo_usd || 0) - (pagoExtracto.monto_pagado_usd || 0)));
              } else {
                setPagoMonto(Math.max(0, pagoExtracto.pago_minimo - (pagoExtracto.monto_pagado || 0)));
              }
              setPagoTipo('pago_restante');
            },
            style: {
              flex: 1, padding: '12px 16px', background: activo ? 'rgba(255,255,255,0.04)' : 'transparent',
              border: 'none', borderBottom: activo ? '2px solid ' + color : '2px solid transparent',
              color: activo ? color : (saldado ? 'var(--text-muted)' : 'var(--text-secondary)'),
              fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
              cursor: saldado ? 'not-allowed' : 'pointer', opacity: saldado ? 0.55 : 1,
              transition: 'all 0.15s', position: 'relative'
            }
          },
            label,
            saldado && e('span', { style: { display: 'block', fontSize: 9, marginTop: 2, color: 'var(--success)', fontWeight: 700, letterSpacing: 0.6 } }, 'SALDADO')
          );
        }
        return e('form', { onSubmit: submitPago },
          // Tabs (solo para tarjetas duales con saldo USD)
          muestraSelector && e('div', { style: { display: 'flex', marginBottom: 16, borderBottom: '1px solid var(--border)' } },
            tabBtn('Pago COP', 'COP', pagoMoneda === 'COP', copYaPagado),
            tabBtn('Pago USD', 'USD', pagoMoneda === 'USD', usdYaPagado)
          ),
          e('div', { className: 'summary-box', style: { marginBottom: 16 } },
            e('div', { className: 'summary-row' }, e('span', { className: 'summary-label' }, 'Pago Minimo' + (esUsd ? ' USD' : '')), e('span', { className: 'summary-value' + (esUsd ? '' : ''), style: esUsd ? { color: '#4FC3F7' } : {} }, fmtMon(pagoMinimoActual))),
            e('div', { className: 'summary-row' }, e('span', { className: 'summary-label' }, 'Pago Total' + (esUsd ? ' USD' : '')), e('span', { className: 'summary-value', style: esUsd ? { color: '#4FC3F7' } : {} }, fmtMon(pagoTotalActual))),
            !esUsd && pagoExtracto.intereses_intl > 0 && e('div', { className: 'summary-row' },
              e('span', { className: 'summary-label', style: { color: '#14b8a6' } }, 'Intereses Internacionales (incluidos)'),
              e('span', { className: 'summary-value', style: { color: '#14b8a6', fontWeight: 600 } }, fmtCOP(pagoExtracto.intereses_intl))
            ),
            e('div', { className: 'summary-row' }, e('span', { className: 'summary-label' }, 'Fecha Limite'), e('span', { className: 'summary-value' }, fmtDate(pagoExtracto.fecha_pago), pagoExtracto.es_fecha_pago_manual && e('span', { style: { fontSize: 9, marginLeft: 6, color: 'var(--accent)', fontWeight: 700, letterSpacing: 0.3 } }, '(MANUAL)'))),
            yaPagado > 0 && e('div', { style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' } },
              e('div', { className: 'summary-row' }, e('span', { className: 'summary-label', style: { color: 'var(--success)' } }, 'Ya Abonado'), e('span', { className: 'summary-value', style: { color: 'var(--success)' } }, fmtMon(yaPagado))),
              e('div', { className: 'summary-row' }, e('span', { className: 'summary-label', style: { color: 'var(--warning)' } }, 'Restante'), e('span', { className: 'summary-value', style: { color: 'var(--warning)', fontWeight: 700 } }, fmtMon(restante))),
              e('div', { style: { marginTop: 8, background: 'var(--bg-secondary)', borderRadius: 6, height: 8, overflow: 'hidden' } },
                e('div', { style: { width: porcentaje + '%', height: '100%', background: 'var(--success)', borderRadius: 6, transition: 'width 0.3s' } })
              ),
              e('div', { style: { textAlign: 'right', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 } }, porcentaje + '% completado')
            )
          ),
          e('div', { className: 'form-group' },
            e('label', { className: 'form-label' }, 'Tipo de Pago'),
            e('select', { className: 'form-select', value: pagoTipo, onChange: ev => {
              setPagoTipo(ev.target.value);
              if (ev.target.value === 'pago_restante') setPagoMonto(restante);
              else if (ev.target.value === 'pago_total') setPagoMonto(Math.max(0, pagoTotalActual - yaPagado));
              else setPagoMonto('');
            }},
              e('option', { value: 'pago_restante' }, restante < pagoMinimoActual ? 'Pagar Restante (' + fmtMon(restante) + ')' : 'Pago Minimo'),
              e('option', { value: 'pago_total' }, 'Pago Total'),
              e('option', { value: 'otro' }, 'Otro Valor (Abono Parcial)')
            )
          ),
          e('div', { className: 'form-row' },
            e('div', { className: 'form-group' },
              e('label', { className: 'form-label' }, 'Monto a Pagar' + (esUsd ? ' (USD)' : '')),
              e(MoneyInput, { value: pagoMonto, onChange: val => setPagoMonto(val), required: true }),
              // Desacople de la conciliacion: conciliar el PDF es opcional, pagar no. Si el banco pide
              // unos pesos mas (o menos) que el estimado, se acepta igual y el extracto queda saldado.
              // El aviso anuncia la banda REAL de este ciclo, no el tope absoluto: con la cifra del
              // extracto ya cargada no hay margen que ofrecer, y prometerlo llevaria al usuario a pagar
              // de menos creyendo que sella (v5.7.2).
              !esUsd && pagoExtracto.tiene_oficial && e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 } },
                'Este valor viene del extracto del banco: escribelo tal cual. Aqui no hay margen, un faltante deja el mes sin saldar.'),
              !esUsd && !pagoExtracto.tiene_oficial && bandaCop > 0 && e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 } },
                'Puedes escribir el valor exacto que te pide el banco: las diferencias menores a ' + fmtCOP(bandaCop) + ' se aceptan como pago completo y la app ajusta sola el ciclo.')
            ),
            e('div', { className: 'form-group' },
              e('label', { className: 'form-label' }, 'Fecha del Pago'),
              e('input', { type: 'date', className: 'form-input', value: pagoFecha, onChange: ev => setPagoFecha(ev.target.value), required: true })
            )
          ),
          e('div', { className: 'modal-actions' },
            e('button', { type: 'button', className: 'btn', onClick: () => setShowPagoModal(false) }, 'Cancelar'),
            e('button', { type: 'submit', className: 'btn btn-primary' },
              (parseFloat(pagoMonto) >= (restante - (esUsd ? 0 : bandaCop)) ? 'Completar Pago ' : 'Registrar Abono ') + (esUsd ? 'USD' : 'COP'))
          )
        );
      })()
    )
  );
}
