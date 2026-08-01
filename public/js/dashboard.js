// public/js/dashboard.js — Vista inicial: mega-card de cupo global y grilla de tarjetas.


// ═══════════════════════════════════════════════════════════════════
// GLOBAL DASHBOARD
// ═══════════════════════════════════════════════════════════════════
function GlobalDashboard({ tarjetas, onSelectCard, onNewCard }) {
  const [dashData, setDashData] = useState(null);
  const [cardDash, setCardDash] = useState({});

  useEffect(() => { api('/dashboard').then(setDashData); }, []);
  // Solo fetcheamos dashboards de tarjetas activas — las inactivas no aportan al centro del Dashboard.
  const tarjetasActivas = tarjetas.filter(t => t.estado === 'activa');
  useEffect(() => {
    if (!tarjetasActivas.length) return;
    Promise.all(tarjetasActivas.map(t => api('/dashboard?tarjeta_id=' + t.id).then(d => ({ id: t.id, data: d }))))
      .then(results => {
        const map = {};
        results.forEach(r => { map[r.id] = r.data; });
        setCardDash(map);
      });
  }, [tarjetas]);

  return e('div', null,
    e('div', { className: 'section-title' }, e(Ico, { name: 'bar-chart', size: 20, color: 'var(--accent)' }), ' Dashboard General'),

    // Mega card: Cupo Total con barra de progreso
    dashData && (() => {
      var cupo = dashData.cupoTotal || 0;
      // Para vista global: si alguna tarjeta es dual, deudaTotalEnCop incluye conversión USD.
      // Por ahora la vista global no diferencia (la TRM se aplica por tarjeta en su vista).
      var deuda = dashData.deudaTotalEnCop != null ? dashData.deudaTotalEnCop : (dashData.deudaTotal || 0);
      // Sobrecupo: disponible puede ser negativo (la deuda superó el cupo). El % "usado" se muestra
      // real (ej. 104.5%) pero el ANCHO de la barra se capa al 100% para no romper el layout.
      var disponible = cupo - deuda;
      var sobrecupo = disponible < 0;
      var pctReal = cupo > 0 ? (deuda / cupo * 100) : 0;
      var pctBar = Math.min(Math.round(pctReal), 100);
      var barColor = (sobrecupo || pctReal >= 80) ? 'var(--danger)' : pctReal >= 50 ? 'var(--warning)' : 'var(--success)';
      var comprasTotal = deuda - (dashData.deudaAvances || 0) - (dashData.deudaDiferidas || 0);
      return e('div', null,
        cupo > 0 && e('div', { className: 'card', style: { marginBottom: 16, padding: '20px 24px', borderLeft: '4px solid ' + barColor } },
          e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
            e('div', { className: 'card-label', style: { margin: 0 } }, 'Cupo Total'),
            e('div', { style: { fontSize: 14, fontWeight: 700, color: barColor } }, 'Usado: ' + pctReal.toFixed(1) + '%')
          ),
          e('div', { className: 'card-value', style: { marginBottom: 12, color: 'var(--text-primary)' } }, fmtCOP(cupo)),
          e('div', { style: { width: '100%', height: 10, background: 'rgba(255,255,255,0.08)', borderRadius: 6, overflow: 'hidden', marginBottom: 14 } },
            e('div', { style: { width: pctBar + '%', height: '100%', background: barColor, borderRadius: 6, transition: 'width 0.6s ease' } })
          ),
          e('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 8 } },
            e('div', null,
              e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 } }, 'Deuda Total'),
              e('div', { style: { fontSize: 18, fontWeight: 700, color: 'var(--danger)' } }, fmtCOP(deuda))
            ),
            e('div', { style: { textAlign: 'right' } },
              e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 } }, sobrecupo ? 'Sobrecupo' : 'Disponible'),
              e('div', { style: { fontSize: 18, fontWeight: 700, color: sobrecupo ? 'var(--danger)' : 'var(--success)' } }, fmtCOP(disponible))
            )
          ),
          e('div', { style: { fontSize: 10, color: 'var(--text-muted)', marginTop: 4, marginBottom: 8, fontStyle: 'italic', lineHeight: 1.3 } }, 'El disponible puede diferir del banco por intereses devengados sin facturar y cuota de manejo del mes.'),
          e('div', { style: { display: 'flex', gap: 14, marginTop: 4 } },
            e('div', null,
              e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Avances'),
              e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(dashData.deudaAvances))
            ),
            e('div', null,
              e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Diferidas'),
              e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(dashData.deudaDiferidas))
            ),
            e('div', null,
              e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Compras'),
              e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(Math.max(0, comprasTotal)))
            )
          )
        ),
        e('div', { className: 'cards-row' },
          e('div', { className: 'card card-warning' },
            e('div', { className: 'card-label' }, 'Compras del Ciclo'),
            e('div', { className: 'card-value' }, fmtCOP(dashData.comprasCiclo)),
            e('div', { className: 'card-sub' }, 'Ciclo actual')
          ),
          e('div', { className: 'card card-purple' },
            e('div', { className: 'card-label' }, 'Intereses del Mes'),
            e('div', { className: 'card-value' }, fmtCOPDec(dashData.interesesMes)),
            e('div', { style: { display: 'flex', gap: 14, marginTop: 6 } },
              e('div', null,
                e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Diferidas'),
                e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOPDec(dashData.interesesMesDiferidas || 0))
              ),
              e('div', null,
                e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Avances'),
                e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOPDec(dashData.interesesMesAvances || 0))
              ),
              dashData.interesesComprasIntl > 0 && e('div', null,
                e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Int Intl'),
                e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(dashData.interesesComprasIntl))
              )
            )
          ),
          bimonCard({
            variant: 'success',
            title: 'Me Deben',
            copValue: fmtCOP(dashData.meDeben.total),
            usdValue: fmtUsd(dashData.meDeben.totalUsd || 0),
            hasUsd: (dashData.meDeben.totalUsd || 0) > 0,
            footer: dashData.meDeben.detalle.length > 0
              ? personasTableBimon(dashData.meDeben.detalle)
              : e('div', { className: 'card-sub', style: { margin: 0 } }, 'Sin deudas pendientes')
          })
        )
      );
    })(),

    // Tarjetas grid
    e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, marginTop: 8 } },
      e('div', { className: 'section-title', style: { margin: 0 } }, e(Ico, { name: 'credit-card', size: 20, color: 'var(--accent)' }), ' Mis Tarjetas'),
      e('button', { className: 'btn btn-primary', onClick: onNewCard }, '+ Nueva Tarjeta')
    ),

    tarjetasActivas.length === 0
      ? e('div', { className: 'empty-state' },
          e('div', { className: 'icon' }, e(Ico, { name: 'credit-card', size: 48, color: 'var(--text-muted)' })),
          e('div', null, tarjetas.length === 0 ? 'No tienes tarjetas registradas' : 'No hay tarjetas activas — todas están archivadas'),
          e('div', { style: { marginTop: 16 } },
            e('button', { className: 'btn btn-primary', onClick: onNewCard }, '+ Crear tu primera tarjeta')
          )
        )
      : e('div', { className: 'tarjeta-grid' },
          tarjetasActivas.map(t =>
            e('div', { key: t.id, className: 'tarjeta-card', onClick: () => onSelectCard(t.id) },
              t.imagen && e('img', { src: t.imagen, className: 'tarjeta-card-img', alt: t.nombre }),
              e('div', { className: 'tarjeta-card-header' },
                !t.imagen && e('div', { className: 'tarjeta-card-dot', style: { background: t.color } }),
                e('div', { className: 'tarjeta-card-info' },
                  e('div', { className: 'tarjeta-card-name' }, t.nombre),
                  e('div', { className: 'tarjeta-card-bank' }, t.banco || '')
                ),
                e('span', { className: 'badge badge-' + t.estado }, t.estado)
              ),
              e('div', { className: 'tarjeta-card-body' },
                e('div', { className: 'tarjeta-stat' },
                  e('div', { className: 'tarjeta-stat-label' }, 'Deuda Total'),
                  e('div', { className: 'tarjeta-stat-value danger' }, fmtCOP(t.deudaTotal))
                ),
                e('div', { className: 'tarjeta-stat' },
                  e('div', { className: 'tarjeta-stat-label' }, 'Compras Ciclo'),
                  e('div', { className: 'tarjeta-stat-value accent' }, fmtCOP(t.comprasCiclo))
                ),
                e('div', { className: 'tarjeta-stat' },
                  e('div', { className: 'tarjeta-stat-label' }, 'Avances Activos'),
                  e('div', { className: 'tarjeta-stat-value' }, t.numAvancesActivos)
                ),
                e('div', { className: 'tarjeta-stat' },
                  e('div', { className: 'tarjeta-stat-label' }, 'Diferidas Activas'),
                  e('div', { className: 'tarjeta-stat-value' }, t.numDiferidasActivas)
                )
              )
            )
          )
        ),

    // Proximos pagos: solo extractos cuyo corte YA CERRÓ y siguen sin pagar (con su fecha
    // límite de pago). Aparecen el día siguiente al corte y desaparecen al pagar. Se muestran
    // todos los pendientes por tarjeta (vencido + recién cerrado). Ya NO se muestra la cuenta
    // regresiva al próximo corte (antes de cerrar no aparece nada para esa tarjeta).
    dashData && tarjetas.length > 0 && (function() {
      const pagosItems = tarjetas.filter(t => t.estado === 'activa').flatMap(t => {
        const cd = cardDash[t.id];
        if (!cd || !cd.extractosVencidos || !cd.extractosVencidos.length) return [];
        return cd.extractosVencidos.map(ext => {
          const mesLabel = (() => { const [a, m] = ext.ciclo.split('-'); return new Date(a, m - 1).toLocaleDateString('es-CO', { month: 'long' }); })();
          const isVencido = ext.tipo === 'vencido';
          const diasRestantes = ext.fechaPago ? Math.ceil((new Date(ext.fechaPago + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000) : 999;
          const casiVencido = !isVencido && diasRestantes <= 5;
          const color = isVencido ? 'var(--danger)' : casiVencido ? '#FF8C00' : 'var(--warning)';
          const bgColor = isVencido ? 'rgba(239,68,68,0.08)' : casiVencido ? 'rgba(255,140,0,0.08)' : 'var(--warning-bg)';
          const labelFecha = ext.fechaPago ? new Date(ext.fechaPago + 'T00:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) : '';
          return e('div', { key: t.id + '-' + ext.ciclo, className: 'card', style: { cursor: 'pointer', borderLeft: '3px solid ' + color, background: bgColor }, onClick: () => onSelectCard(t.id, 'pagos') },
            e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              e('div', null,
                e('div', { style: { fontWeight: 700, fontSize: 14 } }, t.nombre),
                e('div', { style: { fontSize: 12, color: color, marginTop: 2, fontWeight: 600 } }, 'Extracto de ' + mesLabel + ' sin pagar'),
                e('div', { style: { fontSize: 13, marginTop: 6 } },
                  e('span', { style: { color: 'var(--text-muted)' } }, 'Falta: '),
                  e('span', { style: { fontWeight: 700, color: color } }, fmtCOP(ext.falta)),
                  ext.pagado > 0 && e('span', { style: { fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 } }, '(pagado: ' + fmtCOP(ext.pagado) + ')')
                )
              ),
              e('div', { style: { textAlign: 'right' } },
                e('div', { style: { fontWeight: 700, fontSize: isVencido ? 16 : 13, color: color } }, isVencido ? 'VENCIDO' : 'PRÓXIMO A VENCER'),
                e('div', { style: { fontSize: 11, color: 'var(--text-muted)' } }, isVencido ? 'Pagar antes de abonar' : 'Límite: ' + labelFecha, !isVencido && ext.esFechaManual && e('span', { style: { fontSize: 9, marginLeft: 4, color: 'var(--accent)', fontWeight: 700 } }, '(MANUAL)'))
              )
            )
          );
        });
      });
      return e('div', null,
        e('div', { className: 'section-title', style: { marginTop: 8 } }, e(Ico, { name: 'calendar', size: 20, color: 'var(--accent)' }), ' Proximos Pagos'),
        pagosItems.length > 0
          ? e('div', { className: 'cards-row' }, pagosItems)
          : e('div', { className: 'card', style: { color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '20px' } },
              'No tienes pagos proximos. El pago de cada tarjeta aparecera aqui cuando cierre su corte, con la fecha limite.')
      );
    })()
  );
}
