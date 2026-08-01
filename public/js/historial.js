// public/js/historial.js — Log paginado de acciones.


// ═══════════════════════════════════════════════════════════════════
// HISTORIAL (Log de acciones)
// ═══════════════════════════════════════════════════════════════════
function Historial() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const pageSize = 30;

  function loadLogs(p) {
    api('/log?limit=' + pageSize + '&offset=' + (p * pageSize)).then(data => {
      setLogs(data.rows);
      setTotal(data.total);
    });
  }

  useEffect(() => { loadLogs(page); }, [page]);

  async function clearLog() {
    const ok = await confirmDialog('Eliminar todo el historial?');
    if (!ok) return;
    api('/log', { method: 'DELETE' }).then(() => { setLogs([]); setTotal(0); setPage(0); toast('Historial limpiado'); });
  }

  const accionIcons = { crear: 'plus', editar: 'edit', eliminar: 'trash', pago: 'dollar', revertir: 'refresh' };
  const totalPages = Math.ceil(total / pageSize);

  return e('div', null,
    e('div', { className: 'section-title', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      e('span', null, e(Ico, { name: 'activity', size: 18, color: 'var(--accent)' }), ' Historial de Acciones'),
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        e('span', { style: { fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 } }, total + ' registro' + (total !== 1 ? 's' : '')),
        total > 0 && e('button', { onClick: clearLog, className: 'btn btn-sm btn-danger', style: { fontSize: 11, padding: '4px 10px' } }, 'Limpiar')
      )
    ),
    logs.length === 0
      ? e('div', { style: { textAlign: 'center', padding: 40, color: 'var(--text-muted)' } }, 'No hay registros aun')
      : e('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          logs.map(l =>
            e('div', { key: l.id, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg-card)', borderRadius: 8, fontSize: 13 } },
              e('span', { style: { width: 22, textAlign: 'center', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(Ico, { name: accionIcons[l.accion] || 'clipboard', size: 14, color: l.accion === 'crear' ? 'var(--success)' : l.accion === 'eliminar' ? 'var(--danger)' : 'var(--text-secondary)' })),
              e('div', { style: { flex: 1, minWidth: 0 } },
                e('div', { style: { color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, l.descripcion),
                l.detalles && e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 2 } }, l.detalles)
              ),
              e('div', { style: { fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, textAlign: 'right', minWidth: 110 } },
                e('div', null, l.fecha.slice(0, 10)),
                e('div', null, l.fecha.slice(11, 16))
              )
            )
          ),
          totalPages > 1 && e('div', { style: { display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 } },
            e('button', { disabled: page <= 0, onClick: () => setPage(p => p - 1), style: { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: page <= 0 ? 'default' : 'pointer', opacity: page <= 0 ? 0.4 : 1, fontFamily: 'inherit' } }, '\u2190'),
            e('span', { style: { fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' } }, (page + 1) + ' / ' + totalPages),
            e('button', { disabled: page >= totalPages - 1, onClick: () => setPage(p => p + 1), style: { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: page >= totalPages - 1 ? 'default' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1, fontFamily: 'inherit' } }, '\u2192')
          )
        )
  );
}
