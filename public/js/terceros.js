// public/js/terceros.js — Pestana Terceros: deudas por persona, reembolsos y saldos a favor.


// ═══════════════════════════════════════════════════════════════════
// TERCEROS — Control de deudas personales con amigos
// ═══════════════════════════════════════════════════════════════════
function Terceros({ tarjeta }) {
  const [compras, setCompras] = useState([]);
  const [bolsilloModal, setBolsilloModal] = useState(null); // { compra, target, monto }
  // Saldo a favor de terceros (reversos, Fase 2): { creditos, porPersona, gestionables }. Es por-PERSONA
  // (cross-tarjeta). `gestionables` decide SI el chip se pinta (la regla de negocio vive en el backend y
  // este mapa es su único vehículo); `porPersona` solo decide si va verde con monto o gris.
  const [saldosFavor, setSaldosFavor] = useState({ creditos: [], porPersona: {}, gestionables: {} });
  const [favorModal, setFavorModal] = useState(null);   // { persona_id, nombre, color }
  const [aplicarSel, setAplicarSel] = useState(null);   // { creditoId, compra_destino_id, monto }

  const loadData = useCallback(() => {
    api('/terceros?tarjeta_id=' + tarjeta.id).then(setCompras);
    api('/saldos-favor').then(setSaldosFavor).catch(() => {});
  }, [tarjeta.id]);

  useEffect(() => { loadData(); }, [loadData]);

  async function togglePagado(id) {
    // api() NO lanza en un 4xx con cuerpo JSON: lo devuelve como {error} (contrato de v6.1.1). Sin
    // esta comprobacion, un rechazo del backend se traga en silencio o -peor- se anuncia como exito.
    const rT = await api('/terceros/' + id + '/toggle', { method: 'PUT' });
    if (rT && rT.error) { toastErr(rT.error); return; }
    loadData();
  }

  function openBolsilloTercero(compra, target, cuotaNum) {
    const mb = cuotaNum != null ? (compra._bolsilloCuota || 0) : (compra.monto_bolsillo || 0);
    const isPartial = mb > 0 && mb < target;
    const compraConCuota = cuotaNum != null ? Object.assign({}, compra, { monto_bolsillo: mb, _cuota_num: cuotaNum }) : compra;
    setBolsilloModal({ compra: compraConCuota, target, monto: isPartial ? '' : String(mb || '') });
  }
  async function saveBolsilloTercero() {
    if (!bolsilloModal) return;
    const { compra, target } = bolsilloModal;
    const _mb = compra.monto_bolsillo || 0;
    const _isAgregar = _mb > 0 && _mb < target;
    let monto;
    if (_isAgregar) {
      const adicional = parseFloat(bolsilloModal.monto) || 0;
      monto = Math.min(_mb + adicional, target);
    } else {
      monto = parseFloat(bolsilloModal.monto) || 0;
    }
    if (monto < 0) return;
    const bodyT = { monto_bolsillo: monto, desde_terceros: true };
    if (compra._cuota_num != null) bodyT.cuota_num = compra._cuota_num;
    const resp = await api('/compras/' + compra.id + '/bolsillo', { method: 'PUT', body: bodyT });
    // Se corta ANTES de cerrar el modal: el usuario ve el motivo y conserva lo que habia escrito.
    if (resp && resp.error) { toastErr(resp.error); return; }
    setBolsilloModal(null);
    loadData();
    if (resp && resp.capped) toast('Se apartó el máximo de la compra: ' + fmtCOP(resp.tope));
    else toast(monto > 0 ? 'Bolsillo actualizado' : 'Bolsillo quitado');
  }

  // ── Saldo a favor: cruce de cuentas (aplicar a una deuda del mismo tercero) y liquidación (cashout) ──
  async function aplicarSaldo() {
    if (!aplicarSel || !aplicarSel.compra_destino_id) { toastErr('Elige una deuda destino.'); return; }
    const monto = parseFloat(aplicarSel.monto) || 0;
    if (monto <= 0) { toastErr('Ingresa un monto válido.'); return; }
    // cuota_num viaja SIEMPRE que el destino sea una cuota: sin el, el backend rechaza el cruce a una
    // diferida (no adivina a que cuota va) y el deshacer no sabria de donde restar.
    const resp = await api('/saldos-favor/' + aplicarSel.creditoId + '/aplicar', { method: 'POST', body: { compra_destino_id: Number(aplicarSel.compra_destino_id), monto, cuota_num: aplicarSel.cuota_num || null } });
    if (resp && resp.error) { toastErr(resp.error); return; }
    setAplicarSel(null);
    toast('Saldo a favor aplicado a la deuda.');
    loadData();
  }
  async function liquidarSaldo(creditoId) {
    const resp = await api('/saldos-favor/' + creditoId + '/liquidar', { method: 'POST', body: { notas: 'Devolución en efectivo/transferencia' } });
    if (resp && resp.error) { toastErr(resp.error); return; }
    toast('Saldo a favor liquidado (devuelto en efectivo).');
    loadData();
  }
  // Deshace un movimiento (cruce o liquidación): restaura la compra destino y devuelve el disponible al crédito.
  async function deshacerAplicacion(aplId) {
    const resp = await api('/saldos-favor/aplicaciones/' + aplId, { method: 'DELETE' });
    if (resp && resp.error) { toastErr(resp.error); return; }
    toast('Movimiento deshecho; el saldo a favor se restauró.');
    loadData();
  }

  // Solo Bancolombia Visa cobra intereses sobre compras intl en COP (validado con extracto real).
  const _frT = tarjeta.franquicia ? tarjeta.franquicia.toLowerCase() : '';
  const _dualT = _frT.includes('mastercard') || _frT.includes('amex') || _frT.includes('american express');
  const aplicaIntl = !!(tarjeta.banco && tarjeta.banco.toLowerCase().includes('bancolombia') && !_dualT);

  // Interés intl para compras de terceros (misma fórmula que backend)
  const calcInteresIntlTercero = (compra) => {
    if (!aplicaIntl) return 0;
    if (compra.es_diferida) return 0;
    if (!compra.es_internacional) return 0;
    const saldo = compra.valor_cop;
    if (saldo <= 0) return 0;
    // Snapshot histórico: tasa congelada de la compra si existe; si no, la global actual de la tarjeta.
    const tasaIntl = (compra.tasa_intl != null ? compra.tasa_intl : tarjeta.tasa_mv_avances);
    if (!tasaIntl || !compra.ciclo) return 0;
    const [yr, mo] = compra.ciclo.split('-').map(Number);
    const lastDay = new Date(yr, mo, 0).getDate();
    const fechaCorteIntl = new Date(yr, mo - 1, Math.min(tarjeta.dia_corte, lastDay)).toISOString().slice(0, 10);
    const dias = Math.round((new Date(fechaCorteIntl + 'T12:00:00') - new Date(compra.fecha + 'T12:00:00')) / 86400000);
    if (dias <= 0) return 0;
    return Math.round(saldo * tasaIntl * (dias / 30));
  };

  // OBJETIVO COP de una compra de tercero = lo que me debe por ella: capital + interés. El interés llega
  // por DOS vías EXCLUYENTES entre sí:
  //  · interes_sellado → cuota SELLADA por reprogramación de saldo: el interés REAL que el banco facturó
  //    por esa cuota. La sellada nace con es_internacional=0, así que las dos vías nunca se suman.
  //  · recargo intl en vivo → compra internacional normal (Bancolombia Visa).
  // PUNTO ÚNICO a propósito: esta fórmula estaba copiada en 6 sitios y YA estaba desincronizada (dos de
  // ellos ni sumaban el intl). Todo consumidor debe llamar aquí — es el espejo de objetivoBolsilloCop.
  const objetivoTerceroCop = (c) => (c.valor_cop || 0) + Math.round(c.interes_sellado || 0) + calcInteresIntlTercero(c);

  // Reparto de UNA cuota de diferida entre lo ya reembolsado y lo que sigue debiendo. PROPORCIONAL
  // desde el 24-ago-2026: antes era TODO-O-NADA y una cuota a medias contaba ENTERA como pendiente
  // mientras su propia fila mostraba el abono -la vista se contradecia consigo misma-.
  // Los DOS se calculan aqui y no en cada sitio a proposito: se reparten el MISMO coste, asi que
  // migrar uno solo produce doble conteo o plata perdida. El tope a `q.total` mantiene la particion
  // aunque el tercero haya puesto de mas: reembolso + pendiente == q.total SIEMPRE.
  const reembolsoCuota = (q) => Math.min(Math.max(0, q.monto_bolsillo_cuota || 0), q.total);
  const pendienteCuota = (q) => q.total - reembolsoCuota(q);

  // Columna DINERO unificada (compras 1-cuota y cuotas de diferida): "Pagado" (verde) si el tercero
  // saldó — sea por el toggle "Recibido" o porque el bolsillo/reembolso cubre el total —; "Pendiente"
  // (rojo) si aún debe. En parcial conserva el detalle "$apartado / $total · Falta" (sigue pendiente).
  const dineroCell = (settled, bol, total) => {
    if (settled) return e('span', { className: 'badge badge-pagado' }, 'Pagado');
    if (bol > 0 && total > 0 && bol < total) {
      const falta = Math.max(0, total - bol);
      const pct = Math.min(100, Math.round(bol / total * 100));
      return e('div', null,
        e('span', { className: 'badge badge-vencido' }, 'Pendiente'),
        e('div', { style: { fontSize: 11, color: 'var(--purple)', fontWeight: 600, marginTop: 3 } }, fmtCOP(bol) + ' / ' + fmtCOP(total)),
        e('div', { style: { background: 'var(--bg-tertiary)', borderRadius: 4, height: 4, marginTop: 3, width: 80 } },
          e('div', { style: { background: 'var(--purple)', borderRadius: 4, height: 4, width: pct + '%' } })),
        e('div', { style: { fontSize: 10, color: 'var(--text-muted)', marginTop: 2 } }, 'Falta: ' + fmtCOP(falta))
      );
    }
    return e('span', { className: 'badge badge-vencido' }, 'Pendiente');
  };

  // Group by persona
  const grouped = {};
  compras.forEach(c => {
    const key = c.persona_id;
    if (!grouped[key]) grouped[key] = { persona_id: c.persona_id, nombre: c.persona_nombre, color: c.persona_color, compras: [], totalPendiente: 0, totalPendienteUsd: 0, totalRecibido: 0, totalRecibidoUsd: 0 };
    grouped[key].compras.push(c);
    if (c.tercero_pagado) {
      grouped[key].totalRecibido += c.valor_cop;
      if (c.valor_usd && c.valor_usd > 0) grouped[key].totalRecibidoUsd += c.valor_usd;
    } else if (c.es_diferida) {
      const reembolsado = (c.cuotas || []).reduce((s, q) => s + reembolsoCuota(q), 0);
      grouped[key].totalPendiente += c.valor_pendiente || 0;
      grouped[key].totalPendienteUsd += c.valor_usd_pendiente || 0;
      grouped[key].totalRecibido += reembolsado;
    } else {
      const bol = c.monto_bolsillo || 0;
      grouped[key].totalPendiente += objetivoTerceroCop(c) - bol;
      grouped[key].totalRecibido += bol;
      if (c.valor_usd && c.valor_usd > 0) grouped[key].totalPendienteUsd += c.valor_usd;
    }
  });
  const personas = Object.values(grouped);
  const totalPendiente = compras.filter(c => !c.tercero_pagado).reduce((s, c) => s + (c.es_diferida ? (c.valor_pendiente || 0) : objetivoTerceroCop(c) - (c.monto_bolsillo || 0)), 0);
  const totalPendienteUsd = compras.filter(c => !c.tercero_pagado).reduce((s, c) => s + (c.es_diferida ? (c.valor_usd_pendiente || 0) : (c.valor_usd || 0)), 0);
  const totalRecibido = compras.reduce((s, c) => {
    if (c.tercero_pagado) return s + c.valor_cop;
    if (c.es_diferida) return s + (c.cuotas || []).reduce((a, q) => a + reembolsoCuota(q), 0);
    return s + (c.monto_bolsillo || 0);
  }, 0);
  const fmtUsd = (n) => 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

  // Compras que recibieron un cruce de saldo a favor: su estado/bolsillo NO se tocan por la vía directa
  // (Desmarcar / quitar bolsillo) porque descuadraría el crédito. Se gestionan con "Deshacer" en el
  // modal de Dinero a favor. Se derivan de las aplicaciones que ya trae saldosFavor.creditos.
  const compraIdsConCruce = new Set();
  (saldosFavor.creditos || []).forEach(cr => (cr.aplicaciones || []).forEach(ap => {
    if (ap.tipo === 'cruce' && ap.compra_destino_id != null) compraIdsConCruce.add(String(ap.compra_destino_id));
  }));

  return e('div', null,
    // Summary cards
    e('div', { className: 'cards-row' },
      bimonCard({
        variant: 'warning',
        title: 'Me Deben',
        copValue: fmtCOP(totalPendiente),
        usdValue: fmtUsd(totalPendienteUsd),
        hasUsd: totalPendienteUsd > 0,
        footerSub: compras.filter(c => !c.tercero_pagado).length + ' compras pendientes'
      })
    ),

    personas.length === 0
      ? e('div', { className: 'empty-state' }, e('div', { className: 'icon' }, e(Ico, { name: 'users', size: 48, color: 'var(--text-muted)' })), e('div', null, 'No hay compras asignadas a terceros'))
      : personas.map(p => {
          // Agrupar compras por ciclo (más reciente primero)
          const ciclosMap = {};
          p.compras.forEach(c => {
            if (c.es_diferida && c.cuotas && c.cuotas.length > 0) {
              c.cuotas.forEach(q => {
                const cic = q.fecha_corte ? q.fecha_corte.slice(0, 7) : (c.ciclo || 'Sin ciclo');
                if (!ciclosMap[cic]) ciclosMap[cic] = [];
                ciclosMap[cic].push({ _compra: c, _cuota: q });
              });
            } else {
              const cic = c.ciclo || 'Sin ciclo';
              if (!ciclosMap[cic]) ciclosMap[cic] = [];
              ciclosMap[cic].push({ _compra: c, _cuota: null });
            }
          });
          const ciclos = Object.keys(ciclosMap).sort((a, b) => b.localeCompare(a));
          return e('div', { key: p.nombre, className: 'persona-card', style: { marginBottom: 20 } },
            e('div', { className: 'persona-card-header' },
              e('div', { className: 'persona-name' }, e('span', { className: 'persona-dot', style: { background: p.color } }), p.nombre),
              e('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                e('span', { style: { fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginRight: 4 } }, 'Total deudor'),
                (p.totalPendiente > 0 || (p.totalPendienteUsd || 0) > 0) && e('div', { style: {
                  background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.25)',
                  borderRadius: 8, padding: '4px 12px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end'
                } },
                  e('span', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 } }, 'Pendiente'),
                  e('span', { style: { fontSize: 14, fontWeight: 700, color: 'var(--warning)', fontFamily: 'monospace' } }, fmtCOP(p.totalPendiente)),
                  (p.totalPendienteUsd || 0) > 0 && e('span', { style: { fontSize: 12, fontWeight: 700, color: '#4FC3F7', fontFamily: 'monospace' } }, fmtUsd(p.totalPendienteUsd))
                ),
                (p.totalRecibido > 0 || (p.totalRecibidoUsd || 0) > 0) && e('div', { style: {
                  background: 'rgba(52,211,153,0.10)', border: '1px solid rgba(52,211,153,0.25)',
                  borderRadius: 8, padding: '4px 12px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end'
                } },
                  e('span', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 } }, 'Recibido'),
                  e('span', { style: { fontSize: 14, fontWeight: 700, color: 'var(--success)', fontFamily: 'monospace' } }, fmtCOP(p.totalRecibido)),
                  (p.totalRecibidoUsd || 0) > 0 && e('span', { style: { fontSize: 12, fontWeight: 700, color: '#4FC3F7', fontFamily: 'monospace' } }, fmtUsd(p.totalRecibidoUsd))
                ),
                // Saldo a favor del tercero (reversos): chip clickable → abre el modal de gestión.
                // Solo aparece si hay algo que hacer: dinero sin repartir (VERDE con el monto) o algún
                // cruce sobre una compra de un ciclo ABIERTO (gris, "Ver historial"). Si el saldo es $0 y
                // todo se usó en meses ya pagados, ese libro está cerrado → el chip DESAPARECE: no hay
                // razón de negocio para deshacer pagos de meses anteriores y esas compras ni salen ya en
                // la tabla (v5.6.1). La regla vive en el backend (`gestionables`); aquí solo se consume.
                ((saldosFavor.gestionables || {})[p.persona_id]) && (() => {
                  const disp = saldosFavor.porPersona[p.persona_id] || 0;
                  const activo = disp > 0;
                  return e('div', {
                    className: 'badge-clickable',
                    style: { display: 'inline-flex', alignItems: 'center', gap: 8, background: activo ? 'rgba(52,211,153,0.16)' : 'var(--bg-input)', border: '1px solid ' + (activo ? 'rgba(52,211,153,0.55)' : 'var(--border)'), borderRadius: 8, padding: '6px 10px', cursor: 'pointer' },
                    onClick: () => { setAplicarSel(null); setFavorModal({ persona_id: p.persona_id, nombre: p.nombre, color: p.color }); },
                    title: 'Gestionar saldo a favor de ' + p.nombre
                  },
                    e(Ico, { name: 'dollar', size: 15, color: activo ? 'var(--success)' : 'var(--text-muted)' }),
                    e('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.15, gap: 3 } },
                      e('span', { style: { fontSize: 9.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 } }, 'Dinero a favor'),
                      e('span', { style: { fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: activo ? 'var(--success)' : 'var(--text-secondary)' } }, activo ? fmtCOP(disp) : 'Ver historial')
                    ),
                    e(Ico, { name: 'chevron-right', size: 14, color: activo ? 'var(--success)' : 'var(--text-muted)' })
                  );
                })()
              )
            ),
            e('div', { className: 'persona-card-body' },
              ciclos.map(cic => {
                const rows = ciclosMap[cic];
                const subPendiente = rows.reduce((s, { _compra: c, _cuota: q }) => {
                  if (q) return s + (c.tercero_pagado ? 0 : pendienteCuota(q));
                  return s + (c.tercero_pagado ? 0 : objetivoTerceroCop(c) - (c.monto_bolsillo || 0));
                }, 0);
                const subRecibido = rows.reduce((s, { _compra: c, _cuota: q }) => {
                  if (q) return s + (c.tercero_pagado ? q.total : reembolsoCuota(q));
                  return s + (c.tercero_pagado ? c.valor_cop : (c.monto_bolsillo || 0));
                }, 0);
                return e('div', { key: cic, style: { marginBottom: 12 } },
                  e('div', { style: { display: 'flex', alignItems: 'center', background: 'var(--bg-tertiary)', borderRadius: 6, padding: '7px 12px', marginBottom: 8, gap: 10 } },
                    e('span', { style: { fontWeight: 700, fontSize: 13, color: 'var(--accent)' } }, fmtCicloLabel(cic)),
                    subPendiente > 0 && e('span', { style: { fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 } }, '—'),
                    subPendiente > 0 && e('span', { style: { fontSize: 12, color: 'var(--warning)', fontWeight: 600 } }, 'Pendiente: ' + fmtCOP(subPendiente)),
                    subRecibido  > 0 && e('span', { style: { fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 } }, subPendiente > 0 ? '·' : '—'),
                    subRecibido  > 0 && e('span', { style: { fontSize: 12, color: 'var(--success)', fontWeight: 600 } }, 'Recibido: ' + fmtCOP(subRecibido))
                  ),
                  e('table', null,
                    e('thead', null, e('tr', null,
                      e('th', null, 'Fecha'), e('th', null, 'Descripcion'),
                      e('th', { className: 'text-right' }, 'Valor COP'),
                      e('th', { className: 'text-right', style: { whiteSpace: 'nowrap', color: '#4FC3F7' } }, 'Valor USD'),
                      aplicaIntl && e('th', { className: 'text-right', style: { whiteSpace: 'nowrap' } }, 'Tasa'),
                      aplicaIntl && e('th', { className: 'text-right', style: { whiteSpace: 'nowrap' } }, 'Int Intl'),
                      aplicaIntl && e('th', { className: 'text-right', style: { whiteSpace: 'nowrap' } }, 'Total'),
                      e('th', null, 'Estado TC'), e('th', null, 'Dinero'), e('th', null, '')
                    )),
                    e('tbody', null,
                      rows.map(({ _compra: c, _cuota: q }) => {
                        if (q) {
                          // Per-cuota bolsillo: cada cuota tiene su propio monto independiente
                          const bolCuota = q.monto_bolsillo_cuota || 0;
                          const cubierta = !!q.cubierta_bolsillo;
                          const bolsilloParcial = !cubierta && bolCuota > 0;
                          const hecha = c.tercero_pagado || cubierta;
                          return e('tr', { key: c.id + '-q' + q.num, style: hecha ? { background: 'rgba(52,211,153,0.06)' } : bolsilloParcial ? { background: 'rgba(167,139,250,0.06)' } : null },
                            e('td', null, fmtDate(q.fecha_corte)),
                            e('td', { style: { fontWeight: 600 } },
                              c.descripcion,
                              // Contador de cuota como mini "pastilla" sutil (tema oscuro), no texto plano.
                              e('span', { className: 'badge', style: { marginLeft: 8, fontSize: 10, fontWeight: 600, background: 'var(--bg-tertiary)', color: 'var(--text-muted)', padding: '2px 6px', borderRadius: 4 } }, 'Cuota ' + badgeCuotaLabel(q.num, c.cuotas.length, c.reprog_total))
                            ),
                            e('td', { className: 'text-right text-mono', style: { fontWeight: 600, color: hecha ? 'var(--success)' : undefined } },
                              (c.valor_usd && c.valor_usd > 0 && !q.total)
                                ? e('span', { style: { color: 'var(--text-muted)' } }, '—')
                                : fmtCOP(q.total)
                            ),
                            e('td', { className: 'text-right text-mono', style: { color: '#4FC3F7', fontWeight: 600 } },
                              c.valor_usd && c.valor_usd > 0
                                ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c.valor_usd / c.cuotas.length)
                                : e('span', { style: { color: 'var(--text-muted)' } }, '—')
                            ),
                            aplicaIntl && e('td', { className: 'text-right text-mono', style: { fontSize: 12 } }, e('span', { style: { color: 'var(--text-muted)' } }, '—')),
                            aplicaIntl && e('td', { className: 'text-right text-mono', style: { fontSize: 12 } }, e('span', { style: { color: 'var(--text-muted)' } }, '—')),
                            aplicaIntl && e('td', { className: 'text-right text-mono', style: { fontSize: 12 } }, e('span', { style: { color: 'var(--text-muted)' } }, '—')),
                            // ESTADO TC = estado REAL con el banco de ESTA cuota (no el redundante "diferida").
                            // Pagado si el extracto de su ciclo ya se pagó; si no, Pendiente. Mismo criterio
                            // (y mismas clases de color) que la fila simple de abajo.
                            e('td', null, e('span', { className: 'badge badge-' + (q.ciclo_pagado ? 'pagado' : 'pendiente') }, q.ciclo_pagado ? 'Pagado' : 'Pendiente')),
                            e('td', null, dineroCell(hecha, bolCuota, q.total)),
                            e('td', { style: { whiteSpace: 'nowrap', textAlign: 'right' } },
                              (q.ciclo_pagado && hecha)
                                // Cuota con corte pagado Y saldada por el tercero: el dinero reservado ya se
                                // usó al pagar el extracto -> no hay bolsillo que apartar ni retirar.
                                ? e('span', { className: 'badge', style: { background: 'rgba(148,163,184,0.15)', color: 'var(--text-muted)' } }, 'Saldada')
                                : c.tercero_pagado
                                  ? e('button', { className: 'btn btn-sm btn-danger', onClick: () => togglePagado(c.id) }, 'Desmarcar')
                                  : e('button', {
                                      className: 'btn btn-sm btn-success',
                                      onClick: () => openBolsilloTercero(Object.assign({}, c, { _bolsilloCuota: bolCuota }), q.total, q.num)
                                    }, 'Bolsillo')
                            )
                          );
                        }
                        const bol = c.monto_bolsillo || 0;
                        const intlTercero = calcInteresIntlTercero(c);
                        // El tercero debe su valor + su porción proporcional del interés intl de su
                        // división (v4.8.2): el bolsillo cubre cuando alcanza valor+intl, igual que la
                        // tabla principal (renderSingleRow) y la card "Me Deben" del dashboard.
                        const objetivoTercero = objetivoTerceroCop(c);
                        const bolCubre = bol >= objetivoTercero;
                        const faltaBol = Math.max(0, objetivoTercero - bol);
                        const pctBol = objetivoTercero > 0 ? Math.min(100, Math.round(bol / objetivoTercero * 100)) : 0;
                        return e('tr', { key: c.id, style: (c.tercero_pagado || bolCubre) ? { background: 'rgba(52,211,153,0.08)' } : bol > 0 ? { background: 'rgba(167,139,250,0.06)' } : null },
                          e('td', null, fmtDate(c.fecha)),
                          e('td', { style: { fontWeight: 600 } }, c.descripcion,
                            c.nota_personal && e('div', { style: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginTop: 1 } }, c.nota_personal)
                          ),
                          e('td', { className: 'text-right text-mono', style: { fontWeight: 600, color: (c.tercero_pagado || bolCubre) ? 'var(--success)' : undefined } },
                            (c.valor_usd && c.valor_usd > 0 && !c.valor_cop)
                              ? e('span', { style: { color: 'var(--text-muted)' } }, '—')
                              : fmtCOP(c.valor_cop)
                          ),
                          e('td', { className: 'text-right text-mono', style: { color: '#4FC3F7', fontWeight: 600 } },
                            c.valor_usd && c.valor_usd > 0
                              ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c.valor_usd)
                              : e('span', { style: { color: 'var(--text-muted)' } }, '—')
                          ),
                          aplicaIntl && tasaIntlTd(c, tarjeta),
                          aplicaIntl && e('td', { className: 'text-right text-mono', style: { fontSize: 12 } }, intlTercero > 0 ? fmtCOP(intlTercero) : e('span', { style: { color: 'var(--text-muted)' } }, '—')),
                          aplicaIntl && e('td', { className: 'text-right text-mono', style: { fontWeight: intlTercero > 0 ? 600 : undefined } }, fmtCOP(objetivoTercero)),
                          // ESTADO TC = estado con el BANCO: ignora el bolsillo (que es plata del usuario, no
                          // del banco). Una compra de tercero visible aquí aún no está pagada al banco → 'Pendiente'.
                          // (La columna "Dinero" ya muestra si el tercero reembolsó; si el ciclo se paga, la compra
                          // desaparece de Terceros.)
                          e('td', null, e('span', { className: 'badge badge-' + (c.estado === 'pagado' ? 'pagado' : 'pendiente') }, c.estado === 'pagado' ? 'Pagado' : 'Pendiente')),
                          e('td', null, dineroCell(c.tercero_pagado || bolCubre, bol, objetivoTercero)),
                          e('td', { style: { whiteSpace: 'nowrap', textAlign: 'right' } },
                            // Con cruce: atenuado y protegido SOLO si el cruce ya cubre el 100%. Si el
                            // cruce es PARCIAL, cae al botón Bolsillo activo para completar el resto en
                            // efectivo (el backend impide bajar del monto ya cruzado). v4.8.1.
                            (compraIdsConCruce.has(String(c.id)) && (bolCubre || c.tercero_pagado))
                              ? e('button', {
                                  className: 'btn btn-sm btn-success',
                                  style: { opacity: 0.5, cursor: 'not-allowed' },
                                  // Este botón abre el modal por sí mismo (onClick), así que no depende del
                                  // chip: por eso el texto no dice dónde está.
                                  title: 'Esta compra recibió un saldo a favor cruzado. Gestiónalo desde "Dinero a favor".',
                                  onClick: () => { setAplicarSel(null); setFavorModal({ persona_id: p.persona_id, nombre: p.nombre, color: p.color }); }
                                }, 'Bolsillo')
                              : c.tercero_pagado
                                ? e('button', { className: 'btn btn-sm btn-danger', onClick: () => togglePagado(c.id) }, 'Desmarcar')
                                : e('button', {
                                    className: 'btn btn-sm btn-success',
                                    onClick: () => openBolsilloTercero(c, objetivoTerceroCop(c))
                                  }, 'Bolsillo')
                          )
                        );
                      })
                    )
                  )
                );
              })
            )
          );
        }),

    // Modal bolsillo (diferidas y compras normales de terceros)
    bolsilloModal && (() => {
      const { compra, target } = bolsilloModal;
      const actualMb = compra.monto_bolsillo || 0;  // monto ya guardado en BD
      const bState = actualMb >= target ? 'bolsillo' : actualMb > 0 ? 'bolsillo_parcial' : 'pendiente';
      const modalTitle = bState === 'pendiente' ? 'Apartar en Bolsillo' : bState === 'bolsillo' ? 'Retirar de Bolsillo' : 'Gestionar Bolsillo';
      return e('div', { className: 'modal-overlay', onClick: () => setBolsilloModal(null) },
        e('div', { className: 'modal', onClick: ev => ev.stopPropagation() },
          e('div', { className: 'modal-header' },
            e('div', { className: 'modal-title' }, modalTitle),
            e('button', { type: 'button', className: 'modal-close-btn', onClick: () => setBolsilloModal(null), title: 'Cerrar' }, '\u2715')
          ),
          e('div', { style: { padding: '16px 20px' } },
            e('div', { style: { marginBottom: 16, padding: '12px 16px', background: 'var(--bg-tertiary)', borderRadius: 8 } },
              e('div', { style: { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 } }, compra.descripcion),
              compra.persona_nombre && e('div', { style: { fontSize: 12, color: 'var(--accent)', marginBottom: 4 } }, compra.persona_nombre),
              e('div', { style: { fontSize: 18, fontWeight: 700 } }, compra.es_diferida ? 'Cuota' + (compra._cuota_num ? ' ' + compra._cuota_num : '') + ': ' : 'Total: ', fmtCOP(target)),
              compra.monto_bolsillo > 0 && e('div', { style: { fontSize: 13, color: 'var(--success)', marginTop: 4 } }, 'Apartado actualmente: ', fmtCOP(compra.monto_bolsillo))
            ),
            bState === 'pendiente' && e('div', null,
              e('button', { type: 'button', className: 'btn btn-success', style: { width: '100%', marginBottom: 12, marginTop: 12 }, onClick: () => {
                var bodyApartar = { monto_bolsillo: target, desde_terceros: true };
                if (compra._cuota_num != null) bodyApartar.cuota_num = compra._cuota_num;
                api('/compras/' + compra.id + '/bolsillo', { method: 'PUT', body: bodyApartar })
                  .then(r => { if (r && r.error) { toastErr(r.error); return; } setBolsilloModal(null); loadData(); toast('Apartado en bolsillo'); });
              } }, 'Apartar todo (' + fmtCOP(target) + ')'),
              e('div', { style: { textAlign: 'center', fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 } }, 'o apartar un monto parcial:')
            ),
            bState === 'bolsillo' && e('div', { style: { marginTop: 12, marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' } },
              'Ingresa el nuevo monto apartado (menor al total para parcial, 0 para quitar):'
            ),
            bState === 'bolsillo_parcial' && e('button', { type: 'button', className: 'btn btn-success', style: { width: '100%', marginBottom: 12, marginTop: 12 }, onClick: () => {
                var bodyRest = { monto_bolsillo: target, desde_terceros: true };
                if (compra._cuota_num != null) bodyRest.cuota_num = compra._cuota_num;
                api('/compras/' + compra.id + '/bolsillo', { method: 'PUT', body: bodyRest })
                  .then(r => { if (r && r.error) { toastErr(r.error); return; } setBolsilloModal(null); loadData(); toast('Apartado en bolsillo'); });
              } }, 'Apartar restante (' + fmtCOP(target - actualMb) + ')'),
            e('div', { className: 'form-group' },
              e('label', { className: 'form-label' }, bState === 'bolsillo_parcial' ? 'Monto a agregar' : 'Monto apartado'),
              e(MoneyInput, { value: bolsilloModal.monto, onChange: val => setBolsilloModal(prev => ({ ...prev, monto: val })), placeholder: 'Ej: 50.000' }),
              (() => {
                var val = parseFloat(bolsilloModal.monto) || 0;
                if (!val) return null;
                if (bState === 'bolsillo_parcial') {
                  var totalR = actualMb + val;
                  return totalR >= target
                    ? e('div', { className: 'form-hint', style: { color: 'var(--success)' } }, 'Total resultante: ' + fmtCOP(totalR) + ' — Cubre el total')
                    : e('div', { className: 'form-hint', style: { color: 'var(--warning)' } }, 'Total resultante: ' + fmtCOP(totalR) + ' · Faltaria: ' + fmtCOP(target - totalR));
                }
                return val < target
                  ? e('div', { className: 'form-hint', style: { color: 'var(--warning)' } }, 'Faltaria: ' + fmtCOP(target - val))
                  : e('div', { className: 'form-hint', style: { color: 'var(--success)' } }, 'Cubre el total — se marcara como Pagado');
              })()
            ),
            e('div', { className: 'modal-actions', style: { marginTop: 16 } },
              bState !== 'pendiente' && e('button', { type: 'button', className: 'btn btn-danger', onClick: () => {
                var bodyQuitar = { monto_bolsillo: 0, desde_terceros: true };
                if (compra._cuota_num != null) bodyQuitar.cuota_num = compra._cuota_num;
                api('/compras/' + compra.id + '/bolsillo', { method: 'PUT', body: bodyQuitar })
                  .then(r => { if (r && r.error) { toastErr(r.error); return; } setBolsilloModal(null); loadData(); toast('Bolsillo quitado'); });
              } }, 'Quitar de bolsillo'),
              e('button', { type: 'button', className: 'btn', onClick: () => setBolsilloModal(null) }, 'Cancelar'),
              e('button', { type: 'button', className: 'btn btn-primary', onClick: saveBolsilloTercero }, 'Guardar')
            )
          )
        )
      );
    })(),

    // Modal: gestión del Saldo a Favor de un tercero (cruce contra sus deudas o liquidación en efectivo).
    favorModal && (() => {
      const pid = favorModal.persona_id;
      const creditos = (saldosFavor.creditos || [])
        .filter(cr => String(cr.persona_id) === String(pid))
        .sort((a, b) => (a.estado === 'activo' ? 0 : 1) - (b.estado === 'activo' ? 0 : 1));
      // DESTINOS del cruce: una compra de 1 cuota, o una CUOTA concreta de una diferida. En una
      // diferida el reembolso vive por cuota, asi que el usuario elige a cual va — el sistema no lo
      // reparte solo (regla de v5.6.0: esa plata es del deudor).
      //
      // OJO con los topes: son ESPEJO EXACTO del backend y cada rama tiene el suyo.
      //  · 1 cuota  -> capital pelado (valor_cop - monto_bolsillo). El cruce sigue topeado al CAPITAL
      //    desde v4.8.2; el interes se cubre con el bolsillo. NO usar objetivoTerceroCop aqui.
      //  · cuota    -> total de la cuota - lo ya reembolsado en ELLA, que es lo que devuelve
      //    targetBolsillo(c,'COP',n) en el backend menos bolsilloDeCuota.
      // Si el modal ofrece un maximo distinto al del servidor, este responde 400 y el usuario ve un
      // rechazo sin motivo aparente: es la leccion de v5.6.0.
      const misCompras = compras.filter(c => String(c.persona_id) === String(pid));
      const deudas = [];
      misCompras.forEach(c => {
        if (c.es_diferida) {
          (c.cuotas || []).forEach(q => {
            const falta = Math.round(q.total - (q.monto_bolsillo_cuota || 0));
            if (falta > 0) deudas.push({
              key: c.id + ':' + q.num, id: c.id, cuota_num: q.num, max: falta,
              etiqueta: c.descripcion + ' — cuota ' + badgeCuotaLabel(q.num, c.cuotas.length, c.reprog_total),
            });
          });
        } else {
          const falta = Math.round((c.valor_cop || 0) - (c.monto_bolsillo || 0));
          if (falta > 0) deudas.push({ key: String(c.id), id: c.id, cuota_num: null, max: falta, etiqueta: c.descripcion });
        }
      });
      const claveDestino = (sel) => sel ? (sel.compra_destino_id + (sel.cuota_num ? ':' + sel.cuota_num : '')) : '';
      const leerDestino = (k) => { const p = String(k).split(':'); return { compra_destino_id: p[0], cuota_num: p[1] ? parseInt(p[1], 10) : null }; };
      return e('div', { className: 'modal-overlay', onClick: () => { setFavorModal(null); setAplicarSel(null); } },
        e('div', { className: 'modal', onClick: ev => ev.stopPropagation() },
          e('div', { className: 'modal-header' },
            e('div', { className: 'modal-title', style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
              e('span', { className: 'persona-dot', style: { background: favorModal.color } }), 'Saldo a favor de ' + favorModal.nombre),
            e('button', { type: 'button', className: 'modal-close-btn', onClick: () => { setFavorModal(null); setAplicarSel(null); }, title: 'Cerrar' }, '✕')
          ),
          e('div', { style: { padding: '16px 20px' } },
            e('div', { style: { fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.45, marginBottom: 14 } },
              'Créditos a favor de esta persona (ej. reversos de compras que ya te había reembolsado). Aplícalos a otras deudas suyas o liquídalos si le devolviste el dinero.'),
            creditos.length === 0
              ? e('div', { style: { fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' } }, 'Sin créditos a favor.')
              : creditos.map(cr => {
                  const disp = Math.round(cr.disponible);
                  const abierto = !!(aplicarSel && aplicarSel.creditoId === cr.id);
                  const dSel = deudas.find(x => x.key === claveDestino(aplicarSel));
                  // El tope de cada destino ya viene calculado como espejo del backend (ver `deudas`).
                  const maxCruce = dSel ? Math.min(disp, dSel.max) : disp;
                  const aps = cr.aplicaciones || [];
                  const estadoLabel = cr.estado === 'liquidado' ? 'Liquidado' : (disp > 0 ? 'Disponible' : 'Consumido');
                  return e('div', { key: cr.id, style: { border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', marginBottom: 10, background: 'var(--bg-input)' } },
                    e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                      e('div', null,
                        e('div', { style: { fontSize: 13, fontWeight: 600 } }, cr.descripcion || 'Reverso'),
                        e('div', { style: { fontSize: 11, color: 'var(--text-muted)' } }, (cr.origen_tipo || 'reverso') + ' · ' + fmtDate(cr.fecha) + ' · crédito de ' + fmtCOP(Math.round(cr.monto)))
                      ),
                      e('div', { style: { textAlign: 'right' } },
                        e('div', { style: { fontSize: 15, fontWeight: 700, color: disp > 0 ? 'var(--success)' : 'var(--text-muted)', fontFamily: 'monospace' } }, fmtCOP(disp)),
                        e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 } }, estadoLabel)
                      )
                    ),
                    disp > 0 && e('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                      e('button', { type: 'button', className: 'btn btn-sm btn-primary', onClick: () => setAplicarSel(abierto ? null : Object.assign({ creditoId: cr.id, monto: '' }, leerDestino(deudas[0] ? deudas[0].key : ''))) }, abierto ? 'Cerrar' : 'Aplicar a una deuda'),
                      e('button', { type: 'button', className: 'btn btn-sm', onClick: () => liquidarSaldo(cr.id) }, 'Liquidar (efectivo)')
                    ),
                    abierto && e('div', { style: { marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' } },
                      deudas.length === 0
                        ? e('div', { style: { fontSize: 12.5, color: 'var(--warning)' } }, 'Este tercero no tiene otras deudas de 1 cuota pendientes; puedes liquidar el crédito en efectivo.')
                        : e('div', null,
                            e('div', { className: 'form-group', style: { marginBottom: 8 } },
                              e('label', { className: 'form-label' }, 'Aplicar a la deuda'),
                              e('select', { className: 'form-select', value: claveDestino(aplicarSel), onChange: ev => setAplicarSel(prev => Object.assign({}, prev, leerDestino(ev.target.value))) },
                                deudas.map(d => e('option', { key: d.key, value: d.key }, d.etiqueta + ' — debe ' + fmtCOP(d.max))))
                            ),
                            e('div', { className: 'form-group', style: { marginBottom: 6 } },
                              e('label', { className: 'form-label' }, 'Monto a cruzar'),
                              e(MoneyInput, { value: aplicarSel.monto, onChange: val => setAplicarSel(prev => ({ ...prev, monto: val })), placeholder: 'Ej: ' + maxCruce })
                            ),
                            e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 } }, 'Máximo aquí: ' + fmtCOP(maxCruce) + '  ',
                              e('span', { style: { color: 'var(--accent)', cursor: 'pointer', fontWeight: 600 }, onClick: () => setAplicarSel(prev => ({ ...prev, monto: String(maxCruce) })) }, 'usar máximo')),
                            e('button', { type: 'button', className: 'btn btn-sm btn-success', onClick: aplicarSaldo }, 'Aplicar cruce')
                          )
                    ),
                    aps.length > 0 && e('div', { style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)' } },
                      e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 } }, 'Movimientos aplicados'),
                      aps.map(ap => e('div', { key: ap.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 0' } },
                        e('div', { style: { fontSize: 12 } },
                          e('span', { style: { fontFamily: 'monospace', fontWeight: 600 } }, fmtCOP(Math.round(ap.monto))),
                          e('span', { style: { color: 'var(--text-muted)' } }, ' · ' + (ap.tipo === 'liquidacion' ? 'Liquidación (efectivo)' : ('cruce a ' + (ap.compra_desc || ('compra #' + ap.compra_destino_id)) + (ap.cuota_num ? ' (cuota ' + ap.cuota_num + ')' : '')))),
                          // De qué mes es la compra: distingue un cruce del ciclo en curso de uno viejo
                          // (útil ahora que ambos se pueden deshacer).
                          ap.tipo !== 'liquidacion' && ap.compra_ciclo && e('span', { style: { color: 'var(--text-muted)', opacity: 0.7 } }, ' · ' + fmtCicloLabel(ap.compra_ciclo))
                        ),
                        // Un cruce sobre una compra de un mes YA PAGADO no ofrece "Deshacer": ese libro
                        // esta cerrado y no hay razon de negocio para deshacer pagos de meses anteriores
                        // (misma regla del chip, por movimiento). Se sigue viendo, con su mes, para poder
                        // auditarlo. Es SOLO display: el backend no lo bloquea (responde 200 y lo hace sin
                        // reabrir el mes) — si algun dia hace falta, la via existe. v5.6.1.
                        ap.ciclo_pagado
                          ? e('span', {
                              style: { fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', whiteSpace: 'nowrap' },
                              title: 'Este mes ya esta pagado: su libro esta cerrado y no hay nada que corregir aqui.'
                            }, 'Mes pagado')
                          : e('button', { type: 'button', className: 'btn btn-sm', style: { color: 'var(--danger)' }, onClick: () => deshacerAplicacion(ap.id), title: 'Deshacer este movimiento' }, 'Deshacer')
                      ))
                    )
                  );
                })
          )
        )
      );
    })()
  );
}
