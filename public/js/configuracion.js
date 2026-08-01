// public/js/configuracion.js — Pantalla de configuracion: personas, URLs de tasas y ajustes
// del proveedor de IA (la API key se maneja por IPC con safeStorage, nunca llega aqui).


// ═══════════════════════════════════════════════════════════════════
// CONFIGURACION
// ═══════════════════════════════════════════════════════════════════
function BancosUrlsConfig() {
  const [urls, setUrls] = useState([]);
  const [saved, setSaved] = useState(true);
  const [newBanco, setNewBanco] = useState('');

  useEffect(() => {
    api('/config').then(cfg => {
      // Empezamos siempre desde los presets canónicos (DEFAULT_BANCO_URLS) para que
      // si el usuario en algún momento borró un built-in, se reaparezca solo.
      let list = BANCOS_PRESETS.map(b => ({ nombre: b.nombre, url: b.url, nota: b.nota || '', color: b.color, builtin: true }));
      if (cfg.bancos_urls) {
        try {
          const savedData = JSON.parse(cfg.bancos_urls);
          // Sobrescribir URLs de los built-in con las personalizadas del usuario.
          // Si el usuario guardó string vacío, conservamos la URL default (no quedaría
          // sin fallback nunca). Esto hace que la URL del built-in sea "irrompible".
          list = list.map(b => {
            const s = savedData.find(x => x.nombre === b.nombre);
            const overrideUrl = s && s.url && s.url.trim() ? s.url.trim() : null;
            return overrideUrl ? { ...b, url: overrideUrl } : b;
          });
          // Agregar bancos personalizados (no built-in) creados por el usuario.
          savedData.filter(s => !BANCOS_PRESETS.find(p => p.nombre === s.nombre)).forEach(s => {
            list.push({ nombre: s.nombre, url: s.url || '', nota: '', color: s.color || '#666', builtin: false });
          });
          // Sincronizar BANCOS_PRESETS in-memory con los overrides (sin tocar built-ins
          // si el override está vacío — la URL por defecto se mantiene).
          savedData.forEach(s => {
            const preset = BANCOS_PRESETS.find(p => p.nombre === s.nombre);
            if (preset && s.url && s.url.trim()) preset.url = s.url.trim();
          });
        } catch (e) {}
      }
      setUrls(list);
    });
  }, []);

  function updateUrl(i, val) {
    const next = [...urls];
    next[i] = { ...next[i], url: val };
    setUrls(next);
    setSaved(false);
    // Solo mutamos BANCOS_PRESETS para bancos custom (no built-in). Los built-in
    // mantienen su URL canónica viva en memoria — si el usuario guarda string
    // vacío, al recargar la app la URL default se restaura automáticamente.
    const preset = BANCOS_PRESETS.find(p => p.nombre === next[i].nombre);
    if (preset && !next[i].builtin && val && val.trim()) preset.url = val.trim();
    if (preset && next[i].builtin && val && val.trim()) preset.url = val.trim();
  }

  async function resetToDefault(i) {
    const b = urls[i];
    const defaultUrl = DEFAULT_BANCO_URLS[b.nombre];
    if (!defaultUrl) return;
    const next = [...urls];
    next[i] = { ...next[i], url: defaultUrl };
    setUrls(next);
    setSaved(false);
    const preset = BANCOS_PRESETS.find(p => p.nombre === b.nombre);
    if (preset) preset.url = defaultUrl;
    // Propagar la URL canónica también a las tarjetas individuales con ese banco
    // para evitar el caso "el preset está bien pero la tarjeta sigue con URL vieja".
    try {
      const r = await api('/config/sync-bank-url', { method: 'POST', body: { banco: b.nombre, url: defaultUrl } });
      if (r && r.tarjetasActualizadas > 0) {
        toast('URL restaurada y propagada a ' + r.tarjetasActualizadas + ' tarjeta(s)');
      } else {
        toast('URL del preset restaurada');
      }
    } catch (e) {
      toastErr('URL restaurada en preset, pero no se pudo propagar a tarjetas: ' + e.message);
    }
  }

  function addBanco() {
    const name = newBanco.trim();
    if (!name) return;
    if (urls.find(b => b.nombre.toLowerCase() === name.toLowerCase())) { toastErr('Ese banco ya existe'); return; }
    setUrls([...urls, { nombre: name, url: '', nota: '', color: '#666', builtin: false }]);
    BANCOS_PRESETS.push({ nombre: name, url: '', color: '#666' });
    setNewBanco('');
    setSaved(false);
  }

  async function removeBanco(i) {
    const b = urls[i];
    // Los built-in (Bancolombia, Nu, RappiCard) NO se pueden eliminar — solo
    // pueden ser reseteados a su URL canónica. Esto garantiza que el sistema
    // automático de scraping nunca pierda el fallback.
    if (b.builtin) {
      const ok = await confirmDialog(
        '"' + b.nombre + '" es un banco predefinido y no puede eliminarse.\n\n¿Quieres restaurar su URL al valor por defecto?',
        { confirmText: 'Restaurar URL' }
      );
      if (ok) resetToDefault(i);
      return;
    }
    if (!await confirmDialog('Eliminar "' + b.nombre + '" de la lista de bancos?', { confirmText: 'Eliminar' })) return;
    const next = urls.filter((_, j) => j !== i);
    setUrls(next);
    const pi = BANCOS_PRESETS.findIndex(p => p.nombre === b.nombre);
    if (pi >= 0) BANCOS_PRESETS.splice(pi, 1);
    setSaved(false);
  }

  function save() {
    // Include custom (non-builtin) banks too
    const allData = urls.map(b => ({ nombre: b.nombre, url: b.url, color: b.color, builtin: b.builtin }));
    api('/config/bancos_urls', { method: 'PUT', body: { value: JSON.stringify(allData) } }).then(() => { setSaved(true); toast('URLs guardadas'); });
  }

  return e('div', { className: 'config-section' },
    e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
      e('div', { className: 'config-section-title', style: { margin: 0 } }, 'URLs de Tasas por Banco'),
      !saved && e('button', { className: 'btn btn-sm btn-primary', onClick: save }, 'Guardar')
    ),
    e('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 } }, 'Configura los enlaces donde cada banco publica sus tasas.'),
    urls.map((b, i) => {
      const defaultUrl = DEFAULT_BANCO_URLS[b.nombre];
      const isModified = b.builtin && defaultUrl && b.url !== defaultUrl;
      return e('div', { key: b.nombre + i, style: { marginBottom: 10 } },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
          e('label', { style: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', flex: 1 } },
            b.nombre,
            b.builtin && e('span', { style: { fontSize: 10, color: 'var(--text-muted)', marginLeft: 6, fontWeight: 400 } }, '(predefinido)')
          ),
          isModified && e('button', { className: 'btn btn-sm', onClick: () => resetToDefault(i), style: { padding: '2px 10px', fontSize: 11 }, title: 'Restaurar a la URL oficial por defecto' }, 'Restaurar'),
          e('button', { className: 'btn btn-sm btn-danger', onClick: () => removeBanco(i), style: { padding: '2px 8px', fontSize: 11 } }, '\u2715')
        ),
        b.nota
          ? e('div', { style: { fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: '6px 10px', background: 'var(--bg-main)', borderRadius: 8 } }, b.nota)
          : e('input', { type: 'url', className: 'form-input', value: b.url, onChange: ev => updateUrl(i, ev.target.value), placeholder: defaultUrl || 'https://...', style: { fontSize: 12 } })
      );
    }),
    e('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
      e('input', { type: 'text', className: 'form-input', value: newBanco, onChange: ev => setNewBanco(ev.target.value), placeholder: 'Nombre del nuevo banco', style: { fontSize: 12, flex: 1 }, onKeyDown: ev => ev.key === 'Enter' && (ev.preventDefault(), addBanco()) }),
      e('button', { type: 'button', className: 'btn btn-sm btn-primary', onClick: addBanco }, '+ Agregar')
    )
  );
}

function Configuracion({ iaConfig, onIaConfigChange }) {
  const [personas, setPersonas] = useState([]);
  const [showPersonaModal, setShowPersonaModal] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.getVersion) {
      window.electronAPI.getVersion().then(v => setAppVersion(v));
    }
  }, []);
  const [editPersona, setEditPersona] = useState(null);

  // IA Asistente — configuración de proveedor/modelo/key. La key se cifra y guarda
  // vía IPC (safeStorage en main); aquí solo se captura para enviarla una vez.
  const [iaProvider, setIaProvider] = useState((iaConfig && iaConfig.provider && iaConfig.provider !== 'mock') ? iaConfig.provider : 'openai');
  const [iaModel, setIaModel] = useState((iaConfig && iaConfig.model) || '');
  const [iaKeyInput, setIaKeyInput] = useState('');
  const [iaSaving, setIaSaving] = useState(false);
  useEffect(() => {
    if (iaConfig) { setIaProvider((iaConfig.provider && iaConfig.provider !== 'mock') ? iaConfig.provider : 'openai'); setIaModel(iaConfig.model || ''); }
  }, [iaConfig]);
  async function saveIaConfig() {
    if (!window.electronAPI || !window.electronAPI.iaSaveKey) { toastErr('Disponible solo en la app de escritorio'); return; }
    setIaSaving(true);
    const model = iaModel || iaProviderDefaultModel(iaProvider);
    const r = await window.electronAPI.iaSaveKey({ provider: iaProvider, model, key: iaKeyInput });
    setIaSaving(false);
    if (r && r.ok) { setIaKeyInput(''); if (onIaConfigChange) onIaConfigChange(); toast('Configuracion de IA guardada'); }
    else { toastErr('Error: ' + ((r && r.error) || 'desconocido')); }
  }
  async function clearIaKey() {
    if (!window.electronAPI || !window.electronAPI.iaClearKey) return;
    if (!await confirmDialog('Borrar la API key guardada?', { confirmText: 'Borrar' })) return;
    const r = await window.electronAPI.iaClearKey();
    if (r && r.ok) { if (onIaConfigChange) onIaConfigChange(); toast('API key borrada'); }
    else { toastErr('Error: ' + ((r && r.error) || 'desconocido')); }
  }

  // Perfil de datos personales a ocultar (se redactan del extracto antes de enviarlo a la IA).
  const [pii, setPii] = useState({ nombre: '', ciudad: '', departamento: '', direccion: '', documento: '', palabras: '' });
  const [piiSaving, setPiiSaving] = useState(false);
  useEffect(() => {
    api('/config').then(cfg => {
      if (cfg && cfg.pii_perfil) {
        try {
          const p = JSON.parse(cfg.pii_perfil);
          setPii({ nombre: p.nombre || '', ciudad: p.ciudad || '', departamento: p.departamento || '', direccion: p.direccion || '', documento: p.documento || '', palabras: Array.isArray(p.palabras) ? p.palabras.join(', ') : '' });
        } catch (_) { /* perfil inválido */ }
      }
    });
  }, []);
  async function savePii() {
    setPiiSaving(true);
    const obj = {
      nombre: pii.nombre.trim(), ciudad: pii.ciudad.trim(), departamento: pii.departamento.trim(),
      direccion: pii.direccion.trim(), documento: pii.documento.trim(),
      palabras: pii.palabras.split(',').map(s => s.trim()).filter(Boolean)
    };
    await api('/config/pii_perfil', { method: 'PUT', body: { value: JSON.stringify(obj) } });
    setPiiSaving(false);
    toast('Datos personales guardados. Se ocultaran en los analisis.');
  }

  const load = useCallback(() => { api('/personas').then(setPersonas); }, []);
  useEffect(() => { load(); }, [load]);

  function savePersona(data) {
    const method = editPersona ? 'PUT' : 'POST';
    const url = editPersona ? '/personas/' + editPersona.id : '/personas';
    api(url, { method, body: data }).then(() => { setShowPersonaModal(false); load(); toast('Persona guardada'); });
  }
  async function removePersona(id) {
    if (!await confirmDialog('Eliminar esta persona?', { confirmText: 'Eliminar' })) return;
    api('/personas/' + id, { method: 'DELETE' }).then(() => { load(); toast('Persona eliminada'); });
  }

  async function doBackup() {
    if (window.electronAPI) {
      const r = await window.electronAPI.backupDb();
      if (r.ok) toast('Backup guardado en: ' + r.path);
      else if (!r.cancelled) toastErr('Error: ' + r.error);
    } else { window.open(API + '/backup'); }
  }
  async function doRestore() {
    if (!window.electronAPI) return;
    const ok = await confirmDialog(
      'Restaurar un backup reemplazará tu base de datos actual. La app se reiniciará al finalizar para aplicar los cambios.\n\n¿Quieres continuar?',
      { confirmText: 'Restaurar' }
    );
    if (!ok) return;
    const r = await window.electronAPI.restoreDb();
    if (r.ok) {
      // Forzar la pantalla de reinicio (igual que moveDb) en lugar de depender de
      // que el usuario reinicie manualmente. El backend sigue con la DB anterior
      // en memoria hasta que el proceso se reinicia con createApp() de nuevo.
      if (r.needsRestart && window.__setNeedsRestart) window.__setNeedsRestart(true);
      else toast(r.msg);
    } else if (!r.cancelled) {
      toastErr('Error: ' + r.error);
    }
  }

  const [dbLocation, setDbLocation] = useState(null);
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.getDbLocation) {
      window.electronAPI.getDbLocation().then(setDbLocation);
    }
  }, []);

  async function moveDb() {
    if (!window.electronAPI) return;
    const r = await window.electronAPI.moveDb();
    if (r.ok) {
      if (window.__setNeedsRestart) window.__setNeedsRestart(true);
    } else if (!r.cancelled) {
      toastErr(r.error);
    }
  }

  async function restoreDbLocation() {
    if (!window.electronAPI) return;
    if (!await confirmDialog('Restaurar la base de datos a su ubicacion original?', { confirmText: 'Restaurar' })) return;
    const r = await window.electronAPI.restoreDbLocation();
    if (r.ok) {
      if (window.__setNeedsRestart) window.__setNeedsRestart(true);
    } else if (!r.cancelled) {
      toastErr(r.error);
    }
  }

  return e('div', null,
    e('div', { className: 'section-title' }, e(Ico, { name: 'settings', size: 18, color: 'var(--accent)' }), ' Configuracion'),
    e('div', { className: 'config-grid' },
      // Personas
      e('div', { className: 'config-section' },
        e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 } },
          e('div', { className: 'config-section-title', style: { margin: 0 } }, 'Personas'),
          e('button', { className: 'btn btn-sm btn-primary', onClick: () => { setEditPersona(null); setShowPersonaModal(true); } }, '+ Agregar')
        ),
        personas.length === 0
          ? e('div', { style: { color: 'var(--text-muted)', fontSize: 13 } }, 'No hay personas configuradas')
          : personas.map(p =>
              e('div', { key: p.id, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' } },
                e('span', { className: 'persona-dot', style: { background: p.color } }),
                e('span', { style: { flex: 1, fontWeight: 500 } }, p.nombre),
                p.telefono && e('span', { style: { color: 'var(--text-muted)', fontSize: 12 } }, p.telefono),
                e('button', { className: 'btn btn-sm', onClick: () => { setEditPersona(p); setShowPersonaModal(true); } }, e(Ico, { name: 'edit', size: 14, color: 'currentColor' })),
                e('button', { className: 'btn btn-sm btn-danger', onClick: () => removePersona(p.id) }, e(Ico, { name: 'trash', size: 14, color: 'currentColor' }))
              )
            )
      ),
      // Backup
      e('div', { className: 'config-section' },
        e('div', { className: 'config-section-title' }, 'Backup y Restauracion'),
        e('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          e('button', { className: 'btn btn-primary', onClick: doBackup }, e(Ico, { name: 'save', size: 14 }), ' Exportar Backup'),
          e('button', { className: 'btn', onClick: doRestore }, e(Ico, { name: 'download', size: 14 }), ' Restaurar Backup')
        ),
        e('div', { style: { marginTop: 16, fontSize: 12, color: 'var(--text-muted)' } }, 'La base de datos se guarda automaticamente.')
      ),
      // Ubicacion BD
      window.electronAPI && e('div', { className: 'config-section' },
        e('div', { className: 'config-section-title' }, 'Ubicacion de la Base de Datos'),
        dbLocation && e('div', { style: { marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)', wordBreak: 'break-all' } },
          e('strong', null, 'Ruta actual: '), dbLocation.currentPath
        ),
        e('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          e('button', { className: 'btn btn-primary', onClick: moveDb }, e(Ico, { name: 'folder', size: 14 }), ' Mover Base de Datos'),
          !dbLocation?.isDefault && e('button', { className: 'btn', onClick: restoreDbLocation }, e(Ico, { name: 'refresh', size: 14 }), ' Restaurar Ubicacion Original')
        ),
        e('div', { style: { marginTop: 12, fontSize: 12, color: 'var(--text-muted)' } }, 'Mover la BD requiere reiniciar la aplicacion.')
      ),
      // URLs de Bancos
      e(BancosUrlsConfig, null),
      // Asistente de IA
      e('div', { className: 'config-section' },
        e('div', { className: 'config-section-title' }, 'Asistente de IA'),
        e('div', { style: { fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.5 } },
          'Conecta un proveedor de IA para conciliar tus extractos. La API key se guarda cifrada en tu equipo (no se incluye en los backups ni se mueve con la base de datos).'
        ),
        e('div', { className: 'form-group', style: { marginBottom: 12 } },
          e('label', { className: 'form-label' }, 'Proveedor'),
          e('select', { className: 'form-input', value: iaProvider, onChange: ev => { const p = ev.target.value; setIaProvider(p); setIaModel(iaProviderDefaultModel(p)); } },
            IA_PROVIDERS.filter(p => p.id !== 'mock').map(p => e('option', { key: p.id, value: p.id }, p.label))
          )
        ),
        iaProvider !== 'mock' && e(Fragment, null,
          e('div', { className: 'form-group', style: { marginBottom: 12 } },
            e('label', { className: 'form-label' }, 'API Key' + (iaConfig && iaConfig.hasKey ? '  (ya hay una guardada)' : '')),
            e('input', { type: 'password', className: 'form-input', value: iaKeyInput, onChange: ev => setIaKeyInput(ev.target.value), autoComplete: 'off', spellCheck: false, placeholder: (iaConfig && iaConfig.hasKey) ? 'Guardada. Escribe para reemplazarla' : 'Pega tu API key' })
          ),
          e('div', { className: 'form-group', style: { marginBottom: 12 } },
            e('label', { className: 'form-label' }, 'Modelo Predeterminado'),
            e('input', { type: 'text', className: 'form-input', value: iaModel, onChange: ev => setIaModel(ev.target.value), placeholder: iaProviderDefaultModel(iaProvider), spellCheck: false }),
            e('div', { className: 'form-hint', style: { color: 'var(--text-muted)' } }, 'Es el modelo que el Asistente toma por defecto; allí puedes cambiarlo para cada análisis.')
          ),
          e('div', { style: { fontSize: 11.5, color: 'var(--warning)', background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 8, padding: '8px 10px', marginBottom: 12, lineHeight: 1.45 } },
            'Al analizar un extracto, los movimientos y el texto del PDF se envian a ', iaProviderLabel(iaProvider), ' para el analisis. Cada analisis consume creditos de tu cuenta.'
          )
        ),
        e('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          e('button', { className: 'btn btn-primary', onClick: saveIaConfig, disabled: iaSaving }, e(Ico, { name: 'save', size: 14 }), iaSaving ? ' Guardando...' : ' Guardar'),
          (iaConfig && iaConfig.hasKey) && e('button', { className: 'btn btn-danger', onClick: clearIaKey }, e(Ico, { name: 'trash', size: 14 }), ' Borrar API key')
        ),
        (window.electronAPI && iaConfig && iaConfig.encryptionAvailable === false) && e('div', { style: { marginTop: 10, fontSize: 11.5, color: '#f87171' } }, 'El cifrado seguro del sistema no esta disponible; no se puede guardar la API key en este equipo.')
      ),
      // Datos personales a ocultar (privacidad del Asistente de IA)
      e('div', { className: 'config-section' },
        e('div', { className: 'config-section-title' }, 'Datos personales a ocultar (IA)'),
        e('div', { style: { fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.5 } },
          'Estos datos se reemplazan por [DATO_OCULTO] en el texto del extracto antes de enviarlo a la IA. Necesario para bancos (como Bancolombia) que imprimen tu nombre y direccion sin etiquetas.'
        ),
        e('div', { className: 'form-row' },
          e('div', { className: 'form-group' },
            e('label', { className: 'form-label' }, 'Nombre completo'),
            e('input', { type: 'text', className: 'form-input', value: pii.nombre, onChange: ev => setPii(p => ({ ...p, nombre: ev.target.value })), placeholder: 'Tal como aparece en el extracto', spellCheck: false })
          ),
          e('div', { className: 'form-group' },
            e('label', { className: 'form-label' }, 'Documento (opcional)'),
            e('input', { type: 'text', className: 'form-input', value: pii.documento, onChange: ev => setPii(p => ({ ...p, documento: ev.target.value })), spellCheck: false })
          )
        ),
        e('div', { className: 'form-row' },
          e('div', { className: 'form-group' },
            e('label', { className: 'form-label' }, 'Ciudad'),
            e('input', { type: 'text', className: 'form-input', value: pii.ciudad, onChange: ev => setPii(p => ({ ...p, ciudad: ev.target.value })), spellCheck: false })
          ),
          e('div', { className: 'form-group' },
            e('label', { className: 'form-label' }, 'Departamento'),
            e('input', { type: 'text', className: 'form-input', value: pii.departamento, onChange: ev => setPii(p => ({ ...p, departamento: ev.target.value })), spellCheck: false })
          )
        ),
        e('div', { className: 'form-group', style: { marginBottom: 12 } },
          e('label', { className: 'form-label' }, 'Direccion'),
          e('input', { type: 'text', className: 'form-input', value: pii.direccion, onChange: ev => setPii(p => ({ ...p, direccion: ev.target.value })), placeholder: 'Copia la direccion que te sale en el extracto', spellCheck: false })
        ),
        e('div', { className: 'form-group', style: { marginBottom: 12 } },
          e('label', { className: 'form-label' }, 'Otras palabras a ocultar (separadas por coma)'),
          e('input', { type: 'text', className: 'form-input', value: pii.palabras, onChange: ev => setPii(p => ({ ...p, palabras: ev.target.value })), placeholder: 'apodo, barrio, etc.', spellCheck: false })
        ),
        e('button', { className: 'btn btn-primary', onClick: savePii, disabled: piiSaving }, e(Ico, { name: 'save', size: 14 }), piiSaving ? ' Guardando...' : ' Guardar datos a ocultar')
      ),
      // Info del sistema
      e('div', { className: 'config-section' },
        e('div', { className: 'config-section-title' }, 'Info del sistema'),
        e('div', { style: { fontSize: 13, display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 6 } },
          e('span', { style: { color: 'var(--text-muted)' } }, 'Version'),
          e('span', { style: { color: 'var(--text-primary)', fontFamily: "'SF Mono','Consolas',monospace", fontSize: 12.5 } }, appVersion || '1.1.1'),
          e('span', { style: { color: 'var(--text-muted)' } }, 'Motor'),
          e('span', { style: { color: 'var(--text-primary)', fontFamily: "'SF Mono','Consolas',monospace", fontSize: 12.5 } }, 'Electron + Express'),
          e('span', { style: { color: 'var(--text-muted)' } }, 'Base de datos'),
          e('span', { style: { color: 'var(--text-primary)', fontFamily: "'SF Mono','Consolas',monospace", fontSize: 12.5 } }, 'SQLite (better-sqlite3)'),
          e('span', { style: { color: 'var(--text-muted)' } }, 'Frontend'),
          e('span', { style: { color: 'var(--text-primary)', fontFamily: "'SF Mono','Consolas',monospace", fontSize: 12.5 } }, 'React 18 UMD')
        )
      )
    ),
    e(Modal, { show: showPersonaModal, onClose: () => setShowPersonaModal(false), title: editPersona ? 'Editar Persona' : 'Nueva Persona' },
      e(PersonaForm, { item: editPersona, onSave: savePersona, onCancel: () => setShowPersonaModal(false) })
    )
  );
}
