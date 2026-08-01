// public/js/tarjetas.js — Presets de banco y formulario de alta/edicion de tarjeta.
//
// ORDEN OBLIGATORIO DENTRO DE ESTE ARCHIVO: BANCOS_PRESETS LEE DEFAULT_BANCO_URLS y
// DEFAULT_BANCO_COLORS al construirse, o sea EN TIEMPO DE CARGA. Es la unica dependencia de
// carga entre simbolos de todo el frontend. Por eso los tres viajan juntos en el mismo archivo:
// separarlos convertiria el orden de las etiquetas <script> en un contrato fragil, y cargarlos
// al reves lanzaria ReferenceError por TDZ con la app entera sin montar.


// ═══════════════════════════════════════════════════════════════════
// TARJETA FORM
// ═══════════════════════════════════════════════════════════════════
// Defaults irrompibles: si el usuario borra la URL en la configuración o limpia
// el campo de la tarjeta, el sistema vuelve a estos valores. NO mutar en runtime.
const DEFAULT_BANCO_URLS = Object.freeze({
  'Bancolombia': 'https://www.bancolombia.com/personas/tarjetas-de-credito/visa/infinite',
  'Nu':          'https://cdn.nubank.com.br/colombia/tarjeta_credito_tarifas_y_costos.pdf',
  'RappiCard':   'https://rappicard.co/tasas-y-tarifas/',
});
const DEFAULT_BANCO_COLORS = Object.freeze({
  'Bancolombia': '#FFCD00',
  'Nu':          '#820AD1',
  'RappiCard':   '#FF441F',
});

// BANCOS_PRESETS es la lista de trabajo: el usuario puede sobrescribir su URL desde
// la configuración. La defaults canónicas viven en DEFAULT_BANCO_URLS arriba y
// se usan como fallback cuando una URL queda vacía.
const BANCOS_PRESETS = [
  { nombre: 'Bancolombia', url: DEFAULT_BANCO_URLS['Bancolombia'], color: DEFAULT_BANCO_COLORS['Bancolombia'] },
  { nombre: 'Nu',          url: DEFAULT_BANCO_URLS['Nu'],          color: DEFAULT_BANCO_COLORS['Nu'] },
  { nombre: 'RappiCard',   url: DEFAULT_BANCO_URLS['RappiCard'],   color: DEFAULT_BANCO_COLORS['RappiCard'] },
];

// Helper: devuelve la URL efectiva de un banco preset (su URL actual o la default canónica).
function getBancoUrl(nombre) {
  const preset = BANCOS_PRESETS.find(b => b.nombre === nombre);
  if (preset && preset.url) return preset.url;
  return DEFAULT_BANCO_URLS[nombre] || '';
}

function TarjetaForm({ item, onSave, onCancel }) {
  const [nombre, setNombre] = useState(item ? item.nombre : '');
  const [banco, setBanco] = useState(item ? (item.banco || '') : '');
  const [bancoCustom, setBancoCustom] = useState(() => {
    if (!item || !item.banco) return '';
    return BANCOS_PRESETS.find(b => b.nombre === item.banco) ? '' : item.banco;
  });
  const [diaCorte, setDiaCorte] = useState(item ? item.dia_corte : 30);
  const [diaPago, setDiaPago] = useState(item ? (item.dia_pago || 16) : 16);
  const [color, setColor] = useState(item ? item.color : '#4f8cff');
  const [tasaMvAvances, setTasaMvAvances] = useState(item ? (item.tasa_mv_avances * 100).toFixed(4) : '1.9110');
  const [tasaMvDiferidas, setTasaMvDiferidas] = useState(item ? (item.tasa_mv_diferidas * 100).toFixed(4) : '1.8800');
  const [urlTasas, setUrlTasas] = useState(item ? (item.url_tasas || '') : '');
  const [cupoTotal, setCupoTotal] = useState(item ? item.cupo_total : '');
  const [estado, setEstado] = useState(item ? item.estado : 'activa');
  const [notas, setNotas] = useState(item ? (item.notas || '') : '');
  const [franquicia, setFranquicia] = useState(item ? (item.franquicia || '') : '');
  // null = no configurado, 0 = no difiere, 1 = sí difiere (solo Bancolombia)
  const [difiereInteresesCuota1, setDifiereInteresesCuota1] = useState(
    item && (item.difiere_intereses_cuota1 === 0 || item.difiere_intereses_cuota1 === 1)
      ? item.difiere_intereses_cuota1 : null
  );
  const [imagen, setImagen] = useState(item ? (item.imagen || '') : '');
  // Orden manual de la tarjeta en listados — null = sin orden, cae al final por created_at.
  const [orden, setOrden] = useState(item && item.orden != null ? String(item.orden) : '');
  const [fetchingRates, setFetchingRates] = useState(false);
  const [tasaTipoAvances, setTasaTipoAvances] = useState('mv');
  const [tasaTipoDiferidas, setTasaTipoDiferidas] = useState('mv');
  const [tasaDisplayAvances, setTasaDisplayAvances] = useState(item ? (item.tasa_mv_avances * 100).toFixed(4) : '1.9110');
  const [tasaDisplayDiferidas, setTasaDisplayDiferidas] = useState(item ? (item.tasa_mv_diferidas * 100).toFixed(4) : '1.8800');
  const imgInputRef = useRef(null);

  function eaToMv(ea) { return (Math.pow(1 + ea / 100, 1 / 12) - 1) * 100; }
  function mvToEa(mv) { return (Math.pow(1 + mv / 100, 12) - 1) * 100; }

  function handleTasaAvancesChange(val) {
    setTasaDisplayAvances(val);
    if (tasaTipoAvances === 'ea') {
      const mv = eaToMv(parseFloat(val) || 0);
      setTasaMvAvances(mv.toFixed(4));
    } else {
      setTasaMvAvances(val);
    }
  }
  function handleTasaDiferidasChange(val) {
    setTasaDisplayDiferidas(val);
    if (tasaTipoDiferidas === 'ea') {
      const mv = eaToMv(parseFloat(val) || 0);
      setTasaMvDiferidas(mv.toFixed(4));
    } else {
      setTasaMvDiferidas(val);
    }
  }
  function switchTasaTipoAvances(tipo) {
    const currentMv = parseFloat(tasaMvAvances) || 0;
    setTasaTipoAvances(tipo);
    if (tipo === 'ea') setTasaDisplayAvances(mvToEa(currentMv).toFixed(2));
    else setTasaDisplayAvances(currentMv.toFixed(4));
  }
  function switchTasaTipoDiferidas(tipo) {
    const currentMv = parseFloat(tasaMvDiferidas) || 0;
    setTasaTipoDiferidas(tipo);
    if (tipo === 'ea') setTasaDisplayDiferidas(mvToEa(currentMv).toFixed(2));
    else setTasaDisplayDiferidas(currentMv.toFixed(4));
  }

  function handleBancoChange(val) {
    setBanco(val);
    setBancoCustom('');
    const preset = BANCOS_PRESETS.find(b => b.nombre === val);
    if (preset) {
      // Si el preset perdió la URL (usuario la borró en config), caemos al default
      // canónico. Garantiza que la tarjeta nunca quede sin URL para auto-actualizar tasas.
      const url = preset.url || DEFAULT_BANCO_URLS[val] || '';
      setUrlTasas(url);
      if (!item) setColor(preset.color || DEFAULT_BANCO_COLORS[val] || '#666');
      if (preset.nota) toast(preset.nota, 5000);
    }
  }

  function handleImageUpload(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toastErr('La imagen debe ser menor a 2MB'); return; }
    const reader = new FileReader();
    reader.onload = (e) => setImagen(e.target.result);
    reader.readAsDataURL(file);
  }

  async function fetchRates() {
    if (!urlTasas) { toastErr('Ingresa una URL de tasas primero'); return; }
    setFetchingRates(true);
    try {
      const result = await api('/scrape-tasas?url=' + encodeURIComponent(urlTasas));
      if (result.ok && result.found && result.rates) {
        if (result.rates.avances_mv) setTasaMvAvances(result.rates.avances_mv.toFixed(4));
        if (result.rates.compras_mv) setTasaMvDiferidas(result.rates.compras_mv.toFixed(4));
        toast('Tasas actualizadas desde la web');
      } else if (result.ok && !result.found) {
        toastErr('No se encontraron tasas en la pagina. Ingresalas manualmente.');
      } else {
        toastErr('Error al consultar: ' + (result.error || 'formato no reconocido'));
      }
    } catch (err) {
      toastErr('Error al consultar: ' + err.message);
    }
    setFetchingRates(false);
  }

  function submit(ev) {
    ev.preventDefault();
    const bancoFinal = banco === '__otro__' ? (bancoCustom || null) : (banco || null);
    const esBanco = bancoFinal && bancoFinal.toLowerCase().includes('bancolombia');
    if (esBanco && difiereInteresesCuota1 !== 0 && difiereInteresesCuota1 !== 1) {
      toastErr('Debes indicar si esta tarjeta difiere los intereses de la cuota 1');
      return;
    }
    onSave({
      nombre, banco: bancoFinal,
      dia_corte: parseInt(diaCorte), dia_pago: parseInt(diaPago), color, imagen: imagen || null,
      tasa_mv_avances: parseFloat(tasaMvAvances) / 100,
      tasa_mv_diferidas: parseFloat(tasaMvDiferidas) / 100,
      url_tasas: urlTasas || null, cupo_total: parseFloat(cupoTotal) || 0,
      estado, notas, franquicia: franquicia || null,
      difiere_intereses_cuota1: esBanco ? difiereInteresesCuota1 : null,
      orden: orden.trim() === '' ? null : parseInt(orden)
    });
  }

  return e('form', { onSubmit: submit },
    // Imagen de la tarjeta
    e('div', { className: 'form-group' },
      e('label', { className: 'form-label' }, 'Imagen de la tarjeta (opcional)'),
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 16 } },
        imagen
          ? e('div', { style: { position: 'relative' } },
              e('img', { src: imagen, style: { width: 180, height: 113, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border)' } }),
              e('button', { type: 'button', onClick: () => setImagen(''), style: { position: 'absolute', top: -6, right: -6, background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: '50%', width: 22, height: 22, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, '\u{2715}')
            )
          : e('div', { onClick: () => imgInputRef.current && imgInputRef.current.click(), style: { width: 180, height: 113, borderRadius: 10, border: '2px dashed var(--border)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12, gap: 4, transition: 'all 0.2s' } },
              e('span', { style: { fontSize: 28 } }, '+'),
              'Click para subir imagen'
            ),
        e('input', { ref: imgInputRef, type: 'file', accept: 'image/*', onChange: handleImageUpload, style: { display: 'none' } })
      ),
      e('div', { className: 'form-hint' }, 'Sube una foto o imagen de tu tarjeta (max 2MB)')
    ),

    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Nombre de la tarjeta *'),
        e('input', { type: 'text', className: 'form-input', value: nombre, onChange: ev => setNombre(ev.target.value), required: true, placeholder: 'Ej: Visa Infinite' })
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Banco'),
        (() => {
          const isPreset = BANCOS_PRESETS.find(b => b.nombre === banco);
          const showCustom = !isPreset && banco !== '';
          const selectVal = isPreset ? banco : (showCustom ? '__otro__' : '');
          return e(Fragment, null,
            e('select', { className: 'form-select', value: selectVal, onChange: ev => {
              if (ev.target.value === '__otro__') { setBanco('__otro__'); setBancoCustom(''); }
              else if (ev.target.value === '') { setBanco(''); setBancoCustom(''); setUrlTasas(''); }
              else handleBancoChange(ev.target.value);
            }},
              e('option', { value: '' }, 'Seleccionar...'),
              BANCOS_PRESETS.map(b => e('option', { key: b.nombre, value: b.nombre }, b.nombre)),
              e('option', { value: '__otro__' }, 'Otro')
            ),
            (selectVal === '__otro__' || showCustom) && e('input', { type: 'text', className: 'form-input', value: bancoCustom, onChange: ev => { setBancoCustom(ev.target.value); setBanco(ev.target.value || '__otro__'); }, placeholder: 'Nombre del banco', style: { marginTop: 8 } })
          );
        })()
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Cupo Total'),
        e(MoneyInput, { value: cupoTotal, onChange: val => setCupoTotal(val), placeholder: '0' })
      )
    ),
    banco === 'Bancolombia' && e(Fragment, null,
      e('div', { className: 'form-row' },
        e('div', { className: 'form-group' },
          e('label', { className: 'form-label' }, 'Franquicia'),
          e('select', { className: 'form-select', value: franquicia, onChange: ev => setFranquicia(ev.target.value) },
            e('option', { value: '' }, 'Seleccionar franquicia...'),
            e('option', { value: 'Visa' }, 'Visa'),
            e('option', { value: 'Mastercard' }, 'Mastercard'),
            e('option', { value: 'American Express' }, 'American Express')
          ),
          e('div', { className: 'form-hint' }, 'Cada franquicia maneja las compras internacionales de forma diferente')
        )
      ),
      // Difiere intereses cuota 1 → cuota 2 (varía por modelo de tarjeta Bancolombia)
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, '¿Esta tarjeta difiere los intereses de la primera cuota? *'),
        e('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 } },
          e('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', background: difiereInteresesCuota1 === 1 ? 'var(--bg-tertiary)' : 'transparent' } },
            e('input', { type: 'radio', name: 'difiereInteresesCuota1', checked: difiereInteresesCuota1 === 1, onChange: () => setDifiereInteresesCuota1(1), style: { marginTop: 2 } }),
            e('div', null,
              e('div', { style: { fontWeight: 600 } }, 'Sí, difiere'),
              e('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 } }, 'La cuota 1 acumula intereses; la cuota 2 cobra (interés_1 + interés_2). Cuotas 3+ normales.')
            )
          ),
          e('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', background: difiereInteresesCuota1 === 0 ? 'var(--bg-tertiary)' : 'transparent' } },
            e('input', { type: 'radio', name: 'difiereInteresesCuota1', checked: difiereInteresesCuota1 === 0, onChange: () => setDifiereInteresesCuota1(0), style: { marginTop: 2 } }),
            e('div', null,
              e('div', { style: { fontWeight: 600 } }, 'No, cobra desde cuota 1'),
              e('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 } }, 'Cada cuota cobra su propio interés desde la primera (comportamiento estándar).')
            )
          )
        ),
        e('div', { className: 'form-hint', style: { marginTop: 6 } }, 'Verificá esta info en la página oficial de tu tarjeta Bancolombia.')
      )
    ),
    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Dia de Corte'),
        e('input', { type: 'number', className: 'form-input', value: diaCorte, onChange: ev => setDiaCorte(ev.target.value), min: 1, max: 31 })
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Dia de Pago'),
        e('input', { type: 'number', className: 'form-input', value: diaPago, onChange: ev => setDiaPago(ev.target.value), min: 1, max: 31 })
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Color'),
        e('input', { type: 'color', className: 'form-input', value: color, onChange: ev => setColor(ev.target.value), style: { height: 40, padding: 4 } })
      )
    ),

    // URL de tasas
    e('div', { className: 'form-group' },
      e('label', { className: 'form-label' }, 'URL para consultar tasas (opcional)'),
      e('div', { style: { display: 'flex', gap: 8 } },
        e('input', { type: 'url', className: 'form-input', value: urlTasas, onChange: ev => setUrlTasas(ev.target.value), placeholder: 'https://www.bancolombia.com/personas/tarjetas-de-credito/...' }),
        e('button', { type: 'button', className: 'rate-fetch-btn' + (fetchingRates ? ' loading' : ''), onClick: fetchRates, disabled: fetchingRates },
          fetchingRates ? '\u{23F3} Consultando...' : 'Consultar Tasas'
        )
      ),
      e('div', { className: 'form-hint' }, 'Si configuras la URL, podras actualizar las tasas automaticamente desde la web del banco')
    ),

    e('div', { style: { background: 'var(--bg-main)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 } },
      '\u{26A0}\u{FE0F} Siempre verifica las tasas de manera manual en la pagina web o app movil de tu banco. Este programa consulta fuentes publicas pero no garantiza exactitud al 100%.'
    ),

    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Tasa Avances (%)'),
        e('div', { style: { display: 'flex', gap: 6 } },
          e('input', { type: 'number', step: tasaTipoAvances === 'ea' ? '0.01' : '0.0001', className: 'form-input', value: tasaDisplayAvances, onChange: ev => handleTasaAvancesChange(ev.target.value), style: { flex: 1 } }),
          e('div', { className: 'tasa-toggle' },
            e('button', { type: 'button', className: 'tasa-toggle-btn' + (tasaTipoAvances === 'mv' ? ' active' : ''), onClick: () => switchTasaTipoAvances('mv') }, 'MV'),
            e('button', { type: 'button', className: 'tasa-toggle-btn' + (tasaTipoAvances === 'ea' ? ' active' : ''), onClick: () => switchTasaTipoAvances('ea') }, 'EA')
          )
        ),
        tasaTipoAvances === 'ea' && e('div', { className: 'form-hint' }, 'MV: ' + (parseFloat(tasaMvAvances) || 0).toFixed(4) + '%')
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Tasa Diferidas (%)'),
        e('div', { style: { display: 'flex', gap: 6 } },
          e('input', { type: 'number', step: tasaTipoDiferidas === 'ea' ? '0.01' : '0.0001', className: 'form-input', value: tasaDisplayDiferidas, onChange: ev => handleTasaDiferidasChange(ev.target.value), style: { flex: 1 } }),
          e('div', { className: 'tasa-toggle' },
            e('button', { type: 'button', className: 'tasa-toggle-btn' + (tasaTipoDiferidas === 'mv' ? ' active' : ''), onClick: () => switchTasaTipoDiferidas('mv') }, 'MV'),
            e('button', { type: 'button', className: 'tasa-toggle-btn' + (tasaTipoDiferidas === 'ea' ? ' active' : ''), onClick: () => switchTasaTipoDiferidas('ea') }, 'EA')
          )
        ),
        tasaTipoDiferidas === 'ea' && e('div', { className: 'form-hint' }, 'MV: ' + (parseFloat(tasaMvDiferidas) || 0).toFixed(4) + '%')
      ),
      item && e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Estado'),
        e('select', { className: 'form-select', value: estado, onChange: ev => setEstado(ev.target.value) },
          e('option', { value: 'activa' }, 'Activa'),
          e('option', { value: 'inactiva' }, 'Inactiva')
        )
      ),
      // Orden manual: número entero. Menor = aparece primero. Vacío = al final por fecha de creación.
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Orden (opcional)'),
        e('input', {
          type: 'number',
          className: 'form-input',
          value: orden,
          onChange: ev => setOrden(ev.target.value),
          placeholder: 'Ej: 1, 2, 3...',
          min: 0
        }),
        e('div', { className: 'form-hint' }, 'Posición en listados (Mis Tarjetas y Dashboard). Menor número = aparece primero. Vacío = al final.')
      )
    ),
    e('div', { className: 'form-group' },
      e('label', { className: 'form-label' }, 'Notas'),
      e('input', { type: 'text', className: 'form-input', value: notas, onChange: ev => setNotas(ev.target.value) })
    ),
    e('div', { className: 'modal-actions' },
      e('button', { type: 'button', className: 'btn', onClick: onCancel }, 'Cancelar'),
      e('button', { type: 'submit', className: 'btn btn-primary' }, 'Guardar')
    )
  );
}
