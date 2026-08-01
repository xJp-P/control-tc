// public/js/app.js — Raiz de la interfaz: navegacion, tema, auto-updater y el contenedor con
// pestanas de cada tarjeta. OJO: es public/js/app.js, no tiene nada que ver con backend/app.js.
//
// El BOOTSTRAP (ReactDOM.createRoot(...).render(e(App))) NO esta aqui: se queda en el <script>
// en linea de index.html, que es la ultima pieza que ejecuta el navegador. Es la unica
// sentencia ejecutable de nivel superior de todo el frontend y tiene que ir de ultima.


// ═══════════════════════════════════════════════════════════════════
// CARD VIEW — Container with tabs
// ═══════════════════════════════════════════════════════════════════
const CARD_TABS = [
  { id: 'resumen', label: 'Resumen', icoName: 'bar-chart' },
  { id: 'pagos', label: 'Pagos', icoName: 'credit-card' },
  { id: 'terceros', label: 'Terceros', icoName: 'users' },
  { id: 'proyecciones', label: 'Proyecciones', icoName: 'trending' }
];

function CardView({ tarjetaId, initialTab, onBack, onRefreshTarjetas }) {
  const [tarjeta, setTarjeta] = useState(null);
  const [tab, setTab] = useState(initialTab || 'resumen');
  const [showEditModal, setShowEditModal] = useState(false);

  useEffect(() => { api('/tarjetas/' + tarjetaId).then(setTarjeta); }, [tarjetaId]);

  function saveTarjeta(data) {
    api('/tarjetas/' + tarjetaId, { method: 'PUT', body: data }).then(() => {
      setShowEditModal(false);
      api('/tarjetas/' + tarjetaId).then(setTarjeta);
      if (onRefreshTarjetas) onRefreshTarjetas();
      toast('Tarjeta actualizada');
    });
  }

  async function deleteTarjeta() {
    if (!await confirmDialog('ATENCION: Esto eliminara la tarjeta y TODOS sus registros (compras, avances, diferidas, pagos). Continuar?', { confirmText: 'Eliminar', title: 'Eliminar Tarjeta' })) return;
    api('/tarjetas/' + tarjetaId, { method: 'DELETE' }).then(() => {
      toast('Tarjeta eliminada');
      if (onRefreshTarjetas) onRefreshTarjetas();
      onBack();
    });
  }

  async function updateRatesFromWeb() {
    if (!tarjeta.url_tasas) { toastErr('Configura una URL de tasas primero'); return; }
    try {
      const r = await api('/tarjetas/' + tarjetaId + '/actualizar-tasas', { method: 'POST' });
      if (r.ok && r.found) {
        toast('Tasas actualizadas desde la web');
        api('/tarjetas/' + tarjetaId).then(setTarjeta);
      } else if (r.ok && !r.found) {
        toastErr('No se encontraron tasas en la pagina. Ingresalas manualmente en la configuracion de la tarjeta.');
      } else { toastErr(r.error || 'Error al actualizar tasas'); }
    } catch (err) { toastErr(err.message); }
  }

  if (!tarjeta) return e('div', { className: 'loading' }, 'Cargando tarjeta...');

  const tabViews = {
    resumen: () => e(CardResumen, { tarjeta, onDataChange: () => { if (onRefreshTarjetas) onRefreshTarjetas(); } }),
    pagos: () => e(Pagos, { tarjeta, onDataChange: () => { if (onRefreshTarjetas) onRefreshTarjetas(); } }),
    terceros: () => e(Terceros, { tarjeta }),
    proyecciones: () => e(Proyecciones, { tarjeta })
  };

  return e('div', null,
    // Card header
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 } },
      e('button', { className: 'btn btn-sm', onClick: onBack }, 'Volver'),
      tarjeta.imagen
        ? e('img', { src: tarjeta.imagen, style: { width: 64, height: 40, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' } })
        : e('div', { className: 'tarjeta-card-dot', style: { background: tarjeta.color, width: 16, height: 16 } }),
      e('div', { style: { flex: 1 } },
        e('div', { style: { fontSize: 20, fontWeight: 700 } }, tarjeta.nombre),
        e('div', { style: { fontSize: 13, color: 'var(--text-muted)' } }, tarjeta.banco || '')
      ),
      tarjeta.url_tasas && e('button', { className: 'rate-fetch-btn', onClick: updateRatesFromWeb, title: 'Actualizar tasas desde la web' }, 'Actualizar Tasas'),
      e('button', { className: 'btn btn-sm', onClick: () => setShowEditModal(true) }, e(Ico, { name: 'edit', size: 14 }), ' Editar'),
      e('button', { className: 'btn btn-sm btn-danger', onClick: deleteTarjeta }, e(Ico, { name: 'trash', size: 14, color: 'currentColor' }))
    ),

    // Tabs
    e('div', { className: 'tab-bar' },
      CARD_TABS.map(t =>
        e('div', { key: t.id, className: 'tab-item' + (tab === t.id ? ' active' : ''), onClick: () => setTab(t.id) },
          e(Ico, { name: t.icoName, size: 14, color: tab === t.id ? 'var(--accent)' : 'var(--text-secondary)' }), ' ' + t.label
        )
      )
    ),

    // Tab content
    (tabViews[tab] || tabViews.resumen)(),

    // Edit modal
    e(Modal, { show: showEditModal, onClose: () => setShowEditModal(false), title: 'Editar Tarjeta', large: true },
      e(TarjetaForm, { item: tarjeta, onSave: saveTarjeta, onCancel: () => setShowEditModal(false) })
    )
  );
}

// ═══════════════════════════════════════════════════════════════════
// APP ROOT
// ═══════════════════════════════════════════════════════════════════
function App() {
  const [view, setView] = useState('dashboard');
  const [showInactivasNav, setShowInactivasNav] = useState(false); // sección "Historial / Inactivas" colapsada por defecto
  const [tarjetas, setTarjetas] = useState([]);
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  const [showNewCardModal, setShowNewCardModal] = useState(false);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [changelogDlg, setChangelogDlg] = useState(null);
  const [appVersion, setAppVersion] = useState('');
  // Estado de la config de IA (provider/model/hasKey). Reactivo: Configuracion lo
  // recarga al guardar/borrar y se refleja al instante en la seccion IA Asistente.
  const [iaConfig, setIaConfig] = useState({ provider: null, model: '', hasKey: false, encryptionAvailable: false });
  // Modo Demo: estado de sesion (NO se persiste). Al reiniciar, sin key real → tutorial.
  const [iaDemo, setIaDemo] = useState(false);
  // IaAsistente se monta perezosamente al entrar la primera vez y NO se desmonta al cambiar de
  // vista (se oculta con CSS): preserva la vista previa y el analisis, sin re-gastar tokens.
  const [iaMontado, setIaMontado] = useState(false);
  useEffect(() => { if (view === 'ia') setIaMontado(true); }, [view]);
  const reloadIaConfig = useCallback(() => {
    if (window.electronAPI && window.electronAPI.iaGetConfig) window.electronAPI.iaGetConfig().then(setIaConfig);
  }, []);
  useEffect(() => { reloadIaConfig(); }, [reloadIaConfig]);

  // Expose restart setter globally so Configuracion can trigger it
  window.__setNeedsRestart = setNeedsRestart;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Get app version + show changelog if updated
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.getVersion) {
      window.electronAPI.getVersion().then(v => {
        setAppVersion(v);
        const lastSeen = localStorage.getItem('lastSeenVersion');
        if (lastSeen && lastSeen !== v) {
          setChangelogDlg({ version: v, items: CHANGELOG[v] || ['Mejoras y correcciones generales'] });
        }
        localStorage.setItem('lastSeenVersion', v);
      });
    }
  }, []);

  // Auto-update listeners
  useEffect(() => {
    if (!window.electronAPI) return;
    if (window.electronAPI.onUpdateAvailable) {
      window.electronAPI.onUpdateAvailable((info) => {
        setUpdateStatus({ status: 'available', version: info.version });
      });
    }
    if (window.electronAPI.onDownloadProgress) {
      window.electronAPI.onDownloadProgress((progress) => {
        setUpdateStatus(s => s ? { ...s, status: 'downloading', percent: Math.round(progress.percent || 0) } : s);
      });
    }
    if (window.electronAPI.onUpdateDownloaded) {
      window.electronAPI.onUpdateDownloaded(() => {
        setUpdateStatus(s => s ? { ...s, status: 'downloaded' } : { status: 'downloaded', version: '' });
      });
    }
  }, []);

  const loadTarjetas = useCallback(() => { api('/tarjetas').then(setTarjetas); }, []);
  useEffect(() => { loadTarjetas(); }, [loadTarjetas]);

  // Load saved bank URLs into global presets
  useEffect(() => {
    api('/config').then(cfg => {
      if (cfg.bancos_urls) {
        try {
          const saved = JSON.parse(cfg.bancos_urls);
          saved.forEach(s => {
            const preset = BANCOS_PRESETS.find(p => p.nombre === s.nombre);
            if (preset) preset.url = s.url;
            else if (!s.builtin) BANCOS_PRESETS.push({ nombre: s.nombre, url: s.url, color: s.color || '#666' });
          });
        } catch (e) {}
      }
    });
  }, []);

  // One-time notice: ask Bancolombia users to set franquicia
  const franquiciaCheckRef = useRef(false);
  useEffect(() => {
    if (franquiciaCheckRef.current || !tarjetas.length) return;
    franquiciaCheckRef.current = true;
    const sinFranquicia = tarjetas.filter(t => t.banco === 'Bancolombia' && !t.franquicia);
    if (sinFranquicia.length === 0) return;
    const already = localStorage.getItem('franquicia_notice_shown');
    if (already) return;
    localStorage.setItem('franquicia_notice_shown', '1');
    const nombres = sinFranquicia.map(t => '• ' + t.nombre).join('\n');
    infoDialog('Las siguientes tarjetas Bancolombia no tienen franquicia asignada:\n\n' + nombres + '\n\nPor favor ve a editar cada tarjeta y selecciona su franquicia (Visa, Mastercard o American Express).\n\nCada franquicia maneja las compras internacionales de forma diferente.', 'Franquicia requerida');
  }, [tarjetas]);

  // Data sync on startup
  const syncDoneRef = useRef(false);
  useEffect(() => {
    if (syncDoneRef.current) return;
    syncDoneRef.current = true;
    api('/sync', { method: 'POST' }).then(r => {
      if (r && r.fixes > 0) {
        console.log('[Sync] ' + r.fixes + ' correcciones aplicadas');
        loadTarjetas();
      }
    });
  }, []);

  // Modal bloqueante: tarjetas Bancolombia que no tienen difiere_intereses_cuota1 configurado
  const [bancolombiaPendientes, setBancolombiaPendientes] = useState([]);
  const [bancolombiaSelections, setBancolombiaSelections] = useState({}); // id → 0 | 1
  const [savingBancolombia, setSavingBancolombia] = useState(false);
  useEffect(() => {
    api('/tarjetas/pendientes-config').then(list => {
      if (Array.isArray(list)) setBancolombiaPendientes(list);
    });
  }, [tarjetas]);
  function selectBancolombia(id, value) {
    setBancolombiaSelections(s => ({ ...s, [id]: value }));
  }
  async function saveBancolombiaConfig() {
    if (savingBancolombia) return;
    const todas = bancolombiaPendientes.every(t => bancolombiaSelections[t.id] === 0 || bancolombiaSelections[t.id] === 1);
    if (!todas) {
      toastErr('Debés elegir una opción para cada tarjeta');
      return;
    }
    setSavingBancolombia(true);
    try {
      await Promise.all(bancolombiaPendientes.map(t =>
        api('/tarjetas/' + t.id + '/difiere-intereses', { method: 'PUT', body: { difiere: bancolombiaSelections[t.id] } })
      ));
      setBancolombiaPendientes([]);
      setBancolombiaSelections({});
      loadTarjetas();
      toast('Configuración guardada');
    } catch (err) {
      toastErr('Error al guardar: ' + (err.message || 'desconocido'));
    }
    setSavingBancolombia(false);
  }

  // Auto-update rates on app startup for cards that have a URL configured
  const ratesUpdatedRef = useRef(false);
  useEffect(() => {
    if (ratesUpdatedRef.current || tarjetas.length === 0) return;
    ratesUpdatedRef.current = true;
    const cardsWithUrl = tarjetas.filter(t => t.url_tasas && t.estado === 'activa');
    if (cardsWithUrl.length === 0) return;
    console.log('[Tasas] Actualizando tasas para ' + cardsWithUrl.length + ' tarjeta(s)...');
    Promise.allSettled(
      cardsWithUrl.map(t =>
        api('/tarjetas/' + t.id + '/actualizar-tasas', { method: 'POST' })
          .then(r => {
            if (r.ok && r.found) console.log('[Tasas] ' + t.nombre + ' actualizada:', r.rates);
            else if (r.ok && !r.found) console.log('[Tasas] ' + t.nombre + ': no se encontraron tasas en la pagina');
            else console.warn('[Tasas] ' + t.nombre + ' error:', r.error);
            return r;
          })
      )
    ).then(results => {
      const updated = results.filter(r => r.status === 'fulfilled' && r.value && r.value.ok && r.value.found).length;
      if (updated > 0) {
        loadTarjetas();
        toast('Tasas actualizadas para ' + updated + ' tarjeta(s)');
      }
    });
  }, [tarjetas]);

  const [initialTab, setInitialTab] = useState(null);
  function selectCard(id, tab) { setSelectedCardId(id); setInitialTab(tab || null); setView('card'); }
  function goToDashboard() { setView('dashboard'); setSelectedCardId(null); loadTarjetas(); }

  function saveNewCard(data) {
    api('/tarjetas', { method: 'POST', body: data }).then(r => {
      setShowNewCardModal(false);
      loadTarjetas();
      selectCard(r.id);
      toast('Tarjeta creada');
    });
  }

  const headerTitle = view === 'dashboard' ? e(Fragment, null, e(Ico, { name: 'bar-chart', size: 18, color: 'var(--accent)' }), ' Dashboard') :
                      view === 'ia' ? e(Fragment, null, e(Ico, { name: 'sparkles', size: 18, color: 'var(--accent)', className: 'ai-glow' }), ' IA Asistente') :
                      view === 'config' ? e(Fragment, null, e(Ico, { name: 'settings', size: 18, color: 'var(--accent)' }), ' Configuracion') :
                      view === 'historial' ? e(Fragment, null, e(Ico, { name: 'activity', size: 18, color: 'var(--accent)' }), ' Historial') :
                      view === 'calculadora' ? e(Fragment, null, e(Ico, { name: 'calculator', size: 18, color: 'var(--accent)' }), ' Calculadora') :
                      view === 'card' ? '' : '';

  return e('div', { className: 'app-layout' },
    // Sidebar
    e('div', { className: 'sidebar' + (sidebarOpen ? '' : ' collapsed') },
      e('div', { className: 'sidebar-header' },
        e(Ico, { name: 'credit-card', size: 20, color: 'var(--accent)' }),
        e('div', { className: 'sidebar-logo' }, 'Gestor TC')
      ),
      e('div', { className: 'sidebar-nav' },
        // Dashboard
        e('div', { className: 'nav-item' + (view === 'dashboard' ? ' active' : ''), onClick: goToDashboard },
          e(Ico, { name: 'home', size: 18, color: view === 'dashboard' ? 'var(--accent)' : 'var(--text-secondary)' }), 'Dashboard'
        ),

        // Tarjetas section — solo activas
        (() => {
          const tjActivas = tarjetas.filter(t => t.estado === 'activa');
          const tjInactivas = tarjetas.filter(t => t.estado === 'inactiva');
          return e(Fragment, null,
            e('div', { className: 'nav-section-title' }, 'Mis Tarjetas'),
            tjActivas.map(t =>
              e('div', { key: t.id, className: 'nav-item nav-card-item' + (view === 'card' && selectedCardId === t.id ? ' active' : ''), onClick: () => selectCard(t.id) },
                t.imagen
                  ? e('img', { src: t.imagen, style: { width: 28, height: 18, objectFit: 'cover', borderRadius: 3, flexShrink: 0 } })
                  : e('span', { className: 'nav-card-dot', style: { background: t.color } }),
                e('span', { className: 'nav-card-name' }, t.nombre),
                t.deudaTotal > 0 && e('span', { className: 'nav-card-badge' }, fmtCOP(t.deudaTotal))
              )
            ),
            e('div', { className: 'nav-item nav-add-btn', onClick: () => setShowNewCardModal(true) },
              e(Ico, { name: 'plus', size: 16, color: 'var(--accent)' }), 'Nueva Tarjeta'
            ),
            // Sección colapsable de tarjetas inactivas — solo se renderiza si hay alguna.
            tjInactivas.length > 0 && e(Fragment, null,
              e('div', {
                className: 'nav-section-title',
                style: { cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none' },
                onClick: () => setShowInactivasNav(v => !v),
                title: showInactivasNav ? 'Ocultar' : 'Mostrar'
              },
                e(Ico, { name: showInactivasNav ? 'chevron-down' : 'chevron-right', size: 10, color: 'currentColor' }),
                'Historial / Inactivas',
                e('span', { style: { marginLeft: 'auto', opacity: 0.6 } }, '(' + tjInactivas.length + ')')
              ),
              showInactivasNav && tjInactivas.map(t =>
                e('div', { key: t.id, className: 'nav-item nav-card-item' + (view === 'card' && selectedCardId === t.id ? ' active' : ''), style: { opacity: 0.7 }, onClick: () => selectCard(t.id) },
                  t.imagen
                    ? e('img', { src: t.imagen, style: { width: 28, height: 18, objectFit: 'cover', borderRadius: 3, flexShrink: 0, filter: 'grayscale(0.4)' } })
                    : e('span', { className: 'nav-card-dot', style: { background: t.color, opacity: 0.6 } }),
                  e('span', { className: 'nav-card-name' }, t.nombre)
                )
              )
            )
          );
        })(),

        // Calculadora, Historial & Config
        e('div', { className: 'nav-section-title', style: { marginTop: 12 } }, ''),
        e('div', { className: 'nav-item' + (view === 'calculadora' ? ' active' : ''), onClick: () => { setView('calculadora'); setSelectedCardId(null); } },
          e(Ico, { name: 'calculator', size: 18, color: view === 'calculadora' ? 'var(--accent)' : 'var(--text-secondary)' }), 'Calculadora'
        ),
        e('div', { className: 'nav-item' + (view === 'historial' ? ' active' : ''), onClick: () => { setView('historial'); setSelectedCardId(null); } },
          e(Ico, { name: 'activity', size: 18, color: view === 'historial' ? 'var(--accent)' : 'var(--text-secondary)' }), 'Historial'
        ),
        e('div', { className: 'nav-item' + (view === 'ia' ? ' active' : ''), onClick: () => { setView('ia'); setSelectedCardId(null); } },
          e(Ico, { name: 'sparkles', size: 18, color: 'var(--accent)', className: 'ai-glow' }), 'IA Asistente'
        ),
        e('div', { className: 'nav-item' + (view === 'config' ? ' active' : ''), onClick: () => { setView('config'); setSelectedCardId(null); } },
          e(Ico, { name: 'settings', size: 18, color: view === 'config' ? 'var(--accent)' : 'var(--text-secondary)' }), 'Configuracion'
        )
      ),
      e('div', { className: 'sidebar-footer' }, appVersion ? 'v' + appVersion : 'v1.0.1')
    ),

    // Main
    e('div', { className: 'main-area' },
      e('div', { className: 'header' },
        e('button', { className: 'hamburger', onClick: () => setSidebarOpen(s => !s) }, e(Ico, { name: 'menu', size: 20, color: 'var(--text-primary)' })),
        e('div', { className: 'header-title' }, headerTitle),
        e('div', { className: 'header-actions' },
          e('button', { className: 'theme-toggle', onClick: () => setTheme(t => t === 'dark' ? 'light' : 'dark'), title: 'Cambiar tema', style: { display: 'flex', alignItems: 'center', justifyContent: 'center' } },
            e(Ico, { name: theme === 'dark' ? 'sun' : 'moon', size: 16, color: 'var(--text-primary)' })
          )
        )
      ),
      // Update banner
      updateStatus && updateStatus.status === 'available' && e('div', { style: { background: 'var(--success-bg)', border: '1px solid var(--success)', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexShrink: 0 } },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          e(Ico, { name: 'download', size: 16, color: 'var(--success)' }),
          e('span', { style: { fontSize: 12, color: 'var(--success)', fontWeight: 600 } }, 'Nueva version v' + updateStatus.version + ' disponible')
        ),
        e('div', { style: { display: 'flex', gap: 8 } },
          e('button', { onClick: () => { if (window.electronAPI) window.electronAPI.downloadUpdate(); }, style: { background: 'var(--success)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' } }, 'Descargar'),
          e('button', { onClick: () => setUpdateStatus(null), style: { background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--success)', fontSize: 16 } }, '\u2715')
        )
      ),
      updateStatus && updateStatus.status === 'downloading' && e('div', { style: { background: 'var(--accent-bg)', border: '1px solid var(--accent)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 } },
        e(Ico, { name: 'download', size: 16, color: 'var(--accent)' }),
        e('div', { style: { flex: 1 } },
          e('div', { style: { fontSize: 12, color: 'var(--accent)', fontWeight: 600, marginBottom: 4 } }, 'Descargando actualizacion... ' + (updateStatus.percent || 0) + '%'),
          e('div', { style: { background: 'var(--border)', borderRadius: 6, height: 5, overflow: 'hidden' } },
            e('div', { style: { width: (updateStatus.percent || 0) + '%', height: '100%', background: 'linear-gradient(90deg,#2ea043,#3fb950)', borderRadius: 6, transition: 'width 0.3s' } })
          )
        )
      ),
      updateStatus && updateStatus.status === 'downloaded' && e('div', { style: { background: 'var(--success-bg)', border: '1px solid var(--success)', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexShrink: 0 } },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          e(Ico, { name: 'check', size: 16, color: 'var(--success)' }),
          e('span', { style: { fontSize: 12, color: 'var(--success)', fontWeight: 600 } }, 'v' + (updateStatus.version || '') + ' lista para instalar')
        ),
        e('button', { onClick: () => { if (window.electronAPI) window.electronAPI.installUpdate(); }, style: { background: 'var(--success)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' } }, 'Reiniciar e instalar')
      ),

      e('div', { className: 'content' },
        view === 'dashboard' && e(GlobalDashboard, { tarjetas, onSelectCard: selectCard, onNewCard: () => setShowNewCardModal(true) }),
        view === 'card' && selectedCardId && e(CardView, { tarjetaId: selectedCardId, initialTab, onBack: goToDashboard, onRefreshTarjetas: loadTarjetas }),
        view === 'calculadora' && e(Calculadora, { tarjetas }),
        view === 'historial' && e(Historial),
        iaMontado && e('div', { key: 'ia-wrap', style: { display: view === 'ia' ? 'block' : 'none' } }, e(IaAsistente, { iaConfig, onIaConfigChange: reloadIaConfig, tarjetas, onGoConfig: () => setView('config'), demoMode: iaDemo, onActivarDemo: () => { setIaDemo(true); toast('Modo Demo activado (solo esta sesion)'); }, onSalirDemo: () => setIaDemo(false), onRefrescarTarjetas: loadTarjetas })),
        view === 'config' && e(Configuracion, { iaConfig, onIaConfigChange: reloadIaConfig })
      )
    ),

    // Modal bloqueante: configurar comportamiento de intereses para tarjetas Bancolombia
    bancolombiaPendientes.length > 0 && e('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 998, backdropFilter: 'blur(8px)', padding: 20, overflow: 'auto' } },
      e('div', { style: { background: 'var(--bg-secondary)', borderRadius: 14, padding: 28, maxWidth: 560, width: '100%', maxHeight: '90vh', overflow: 'auto', border: '1px solid var(--border)' } },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } },
          e(Ico, { name: 'alert-circle', size: 22, color: 'var(--warning)' }),
          e('div', { style: { fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' } }, 'Configuración requerida')
        ),
        e('div', { style: { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.5 } },
          'No todas las tarjetas Bancolombia cobran los intereses de las diferidas igual. ',
          'Algunas cobran desde la cuota 1, otras difieren los intereses de la cuota 1 a la cuota 2. ',
          e('br'), e('br'),
          e('strong', null, 'Verificá esta info en la página oficial de tu tarjeta Bancolombia '),
          'y elegí el comportamiento correcto para cada una. Sin esto, tus diferidas pueden calcularse mal.'
        ),
        bancolombiaPendientes.map(t =>
          e('div', { key: t.id, style: { background: 'var(--bg-tertiary)', borderRadius: 10, padding: 14, marginBottom: 12, border: '1px solid var(--border)' } },
            e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } },
              t.imagen
                ? e('img', { src: t.imagen, style: { width: 44, height: 28, objectFit: 'cover', borderRadius: 4 } })
                : e('span', { style: { width: 14, height: 14, borderRadius: '50%', background: t.color || '#666' } }),
              e('div', { style: { fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' } }, t.nombre),
              e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' } }, t.banco)
            ),
            e('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              e('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer', background: bancolombiaSelections[t.id] === 1 ? 'var(--bg-secondary)' : 'transparent' } },
                e('input', { type: 'radio', name: 'bcol-' + t.id, checked: bancolombiaSelections[t.id] === 1, onChange: () => selectBancolombia(t.id, 1), style: { marginTop: 2 } }),
                e('div', null,
                  e('div', { style: { fontWeight: 600, fontSize: 13 } }, 'Sí, difiere intereses'),
                  e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 2 } }, 'Cuota 1 acumula · cuota 2 cobra interés_1 + interés_2')
                )
              ),
              e('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer', background: bancolombiaSelections[t.id] === 0 ? 'var(--bg-secondary)' : 'transparent' } },
                e('input', { type: 'radio', name: 'bcol-' + t.id, checked: bancolombiaSelections[t.id] === 0, onChange: () => selectBancolombia(t.id, 0), style: { marginTop: 2 } }),
                e('div', null,
                  e('div', { style: { fontWeight: 600, fontSize: 13 } }, 'No, cobra desde cuota 1'),
                  e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 2 } }, 'Cada cuota cobra su propio interés desde la primera')
                )
              )
            )
          )
        ),
        e('button', {
          onClick: saveBancolombiaConfig,
          disabled: savingBancolombia || !bancolombiaPendientes.every(t => bancolombiaSelections[t.id] === 0 || bancolombiaSelections[t.id] === 1),
          style: { width: '100%', padding: '12px 0', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', marginTop: 8, opacity: (savingBancolombia || !bancolombiaPendientes.every(t => bancolombiaSelections[t.id] === 0 || bancolombiaSelections[t.id] === 1)) ? 0.5 : 1 }
        }, savingBancolombia ? 'Guardando...' : 'Guardar configuración')
      )
    ),

    // Restart overlay (after DB move)
    needsRestart && e('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 999, backdropFilter: 'blur(8px)' } },
      e('div', null, e(Ico, { name: 'refresh', size: 40, color: 'var(--accent)' })),
      e('div', { style: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginTop: 16, marginBottom: 8 } }, 'Ruta actualizada'),
      e('div', { style: { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24, textAlign: 'center', padding: '0 40px' } }, 'Debes reiniciar la app para usar la nueva ubicacion de la base de datos.'),
      e('button', { onClick: () => { if (window.electronAPI) window.electronAPI.relaunchApp(); }, style: { background: 'var(--success)', color: '#fff', border: 'none', borderRadius: 12, padding: '14px 48px', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' } }, 'Reiniciar')
    ),

    // Changelog dialog
    // Layout flex-column con maxHeight 70vh: header y botón quedan fijos,
    // solo la lista de items hace scroll cuando hay muchos cambios. Override
    // de .modal { overflow-y: auto } via overflow:hidden en el contenedor.
    changelogDlg && e('div', { className: 'modal-overlay', onClick: () => setChangelogDlg(null) },
      e('div', { className: 'modal', onClick: (ev) => ev.stopPropagation(), style: { maxWidth: 380, maxHeight: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        e('div', { className: 'modal-handle', style: { flexShrink: 0 } }),
        e('div', { style: { textAlign: 'center', marginBottom: 14, flexShrink: 0 } },
          e('div', { style: { marginBottom: 6 } }, e(Ico, { name: 'check', size: 28, color: 'var(--success)' })),
          e('div', { style: { fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' } }, 'Actualizado a v' + changelogDlg.version)
        ),
        e('div', { style: { marginBottom: 16, overflowY: 'auto', flex: '1 1 auto', minHeight: 0, paddingRight: 6 } },
          changelogDlg.items.map((item, i) =>
            e('div', { key: i, style: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 } },
              // Icono más grande y con un poco de margen superior para alinear con la primera línea del texto.
              e('span', { style: { flexShrink: 0, marginTop: 2 } }, e(Ico, { name: 'check', size: 18, color: 'var(--success)' })),
              e('span', null, item)
            )
          )
        ),
        e('button', { onClick: () => setChangelogDlg(null), style: { width: '100%', padding: '10px 0', background: 'var(--success)', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 } }, 'Entendido')
      )
    ),

    e(ToastContainer),
    e(ConfirmDialog),

    // New card modal
    e(Modal, { show: showNewCardModal, onClose: () => setShowNewCardModal(false), title: 'Nueva Tarjeta de Credito', large: true },
      e(TarjetaForm, { item: null, onSave: saveNewCard, onCancel: () => setShowNewCardModal(false) })
    )
  );
}
