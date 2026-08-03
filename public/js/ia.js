// public/js/ia.js — Asistente de conciliacion de extractos: proveedores, analisis y las
// acciones de 1 clic sobre el resultado.
//
// La IA NUNCA escribe en la base: propone, y cada accion la aplica el usuario con un clic.


// Proveedores de IA soportados por el Asistente de Conciliación.
// 'mock' = Demo sin conexión (no requiere key; valida la UI sin gastar créditos).
// Cada modelo es { id, label }: el `id` es el string EXACTO que acepta la API y el `label` es el
// nombre corto que ve el usuario en el desplegable.
//
// Lista auditada el 3-ago-2026 contra la documentacion OFICIAL de cada proveedor. Se quitaron SEIS
// modelos retirados que seguian ofreciendose y habrian devuelto 404 al conciliar:
//   - claude-opus-4-1-20250805  se retira el 5-ago-2026 (dos dias despues de esta auditoria)
//   - gemini-2.0-flash          apagado el 1-jun-2026
//   - gemini-1.5-pro / -flash   ya ni figuran en la documentacion de Google
//   - deepseek-chat / -reasoner apagados el 24-jul-2026; nunca fueron modelos, sino etiquetas de
//                               enrutamiento al modo thinking / no-thinking del mismo modelo
//
// OJO con la convencion de Anthropic: desde la generacion 4.6 los IDs van SIN fecha
// (claude-opus-5, claude-sonnet-5, claude-sonnet-4-6) y cada uno es un snapshot fijo, no un alias.
// Anadirles un sufijo de fecha produce un ID que no existe. Los anteriores a 4.6 si la llevan.
const IA_PROVIDERS = [
  { id: 'mock', label: 'Demo (sin conexion)', defaultModel: '', models: [] },

  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o', models: [
    { id: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.4',       label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini',  label: 'GPT-5.4 Mini' },
    { id: 'gpt-4o',        label: 'GPT-4o' },
    { id: 'gpt-4o-mini',   label: 'GPT-4o Mini' },
    { id: 'gpt-4.1',       label: 'GPT-4.1' },
  ] },

  // Los tres primeros estan confirmados por partida doble: la documentacion oficial Y el log de
  // esta app (sonnet-4-6 devolvio un analisis completo; sonnet-5 respondio tras 82s; opus-5 fue
  // aceptado sin "model not found"). El default se queda en Sonnet 4.6, el unico con una
  // conciliacion completa observada de principio a fin.
  { id: 'anthropic', label: 'Anthropic (Claude)', defaultModel: 'claude-sonnet-4-6', models: [
    { id: 'claude-opus-5',              label: 'Opus 5' },
    { id: 'claude-sonnet-5',            label: 'Sonnet 5' },
    { id: 'claude-sonnet-4-6',          label: 'Sonnet 4.6' },
    { id: 'claude-opus-4-5-20251101',   label: 'Opus 4.5' },
    { id: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5' },
  ] },

  { id: 'gemini', label: 'Google Gemini', defaultModel: 'gemini-2.5-pro', models: [
    { id: 'gemini-3.6-flash',      label: 'Gemini 3.6 Flash' },
    { id: 'gemini-3.5-flash',      label: 'Gemini 3.5 Flash' },
    { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  ] },

  { id: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-v4-flash', models: [
    { id: 'deepseek-v4-pro',   label: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  ] },
];
const IA_LINKS = {
  openai:    'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  gemini:    'https://aistudio.google.com/app/apikey',
  deepseek:  'https://platform.deepseek.com/api_keys',
};
function iaProviderDefaultModel(pid) {
  const p = IA_PROVIDERS.find(x => x.id === pid);
  return p ? p.defaultModel : '';
}
function iaProviderLabel(pid) {
  const p = IA_PROVIDERS.find(x => x.id === pid);
  return p ? p.label : pid;
}
function iaProviderModels(pid) {
  const p = IA_PROVIDERS.find(x => x.id === pid);
  return (p && p.models) ? p.models : [];
}

// ── Render del resultado de conciliación + aplicar acciones con 1 clic (Fase 4) ──
function IaResultado({ resultado, isMock, tarjetaId, ciclo, onAplicada, onReanalizar, reanalizando }) {
  const c = (resultado && resultado.conciliacion_pago_minimo) || {};
  const disc = Array.isArray(resultado && resultado.discrepancias) ? resultado.discrepancias : [];
  const pagos = Array.isArray(resultado && resultado.pagos_detectados) ? resultado.pagos_detectados : [];
  const sevColor = (s) => s === 'alta' ? '#f87171' : (s === 'media' ? 'var(--warning)' : 'var(--text-muted)');
  const [accionSel, setAccionSel] = useState(null);   // { d, idx }
  const [aplicando, setAplicando] = useState(false);
  const [aplicadas, setAplicadas] = useState({});
  // Discrepancias que el usuario marca como revisadas SIN aplicarlas (falso positivo de la IA, o algo
  // que ya resolvio a mano). Es la salida del bloqueo de "fijar la cifra oficial": sin ella, un
  // hallazgo estructural erroneo dejaria el sellado del mes bloqueado para siempre. Estado LOCAL: no
  // se persiste, se pierde al re-analizar (que es lo correcto: el analisis nuevo trae otra lista).
  const [descartadas, setDescartadas] = useState({});
  const [errAplicar, setErrAplicar] = useState('');
  const [contextoUser, setContextoUser] = useState('');
  // Las marcas de estado (aplicada / descartada) se guardan por INDICE de la lista de discrepancias, y
  // el re-analisis devuelve una lista distinta sin remontar este componente (no lleva key). Sin este
  // reset, el indice 0 del analisis nuevo heredaba la marca del indice 0 del anterior: cosmetico en
  // "Aplicada", pero en "Descartada" DESBLOQUEA en silencio el candado de la cifra oficial, que es
  // justo lo que ese candado debe impedir. Se limpian ambas cuando llega un resultado nuevo.
  useEffect(() => { setAplicadas({}); setDescartadas({}); }, [resultado]);
  // Contexto VIVO de la tarjeta, leido de la BD: las compras (para detectar si una discrepancia apunta
  // a una compra DIVIDIDA; una accion por compra_id no puede operar sobre un grupo — causaba
  // PUT /api/compras/null) y el pago minimo que CALCULA la app para el ciclo.
  // Se recarga TRAS CADA ACCION APLICADA: el analisis de la IA es una FOTO, y sus cifras dejan de
  // describir la BD en cuanto se aplica la primera correccion. Sin esto, el modal de "fijar la cifra
  // oficial" mostraba como "Estimado de la app" el valor de ANTES de mover las compras — y como la
  // jerarquia obliga a mover primero y fijar despues, esa cifra estaba obsoleta practicamente siempre.
  const [comprasTj, setComprasTj] = useState([]);
  const [minimoAppVivo, setMinimoAppVivo] = useState(null);
  function recargarContexto() {
    if (!tarjetaId) { setComprasTj([]); setMinimoAppVivo(null); return; }
    api('/compras?tarjeta_id=' + Number(tarjetaId)).then(l => setComprasTj(Array.isArray(l) ? l : [])).catch(() => setComprasTj([]));
    api('/extractos?tarjeta_id=' + Number(tarjetaId)).then(rows => {
      const ex = Array.isArray(rows) ? rows.find(x => x.ciclo === ciclo) : null;
      // Con una cifra oficial ya fijada, `pago_minimo` ES la del banco y el calculo propio queda en
      // `pago_minimo_calculado`; sin ella, `pago_minimo` ya es el calculo propio.
      setMinimoAppVivo(ex ? (ex.pago_minimo_calculado != null ? ex.pago_minimo_calculado : ex.pago_minimo) : null);
    }).catch(() => setMinimoAppVivo(null));
  }
  useEffect(() => { recargarContexto(); }, [tarjetaId, ciclo]);
  // Operaciones que la app puede aplicar automaticamente (mapean a endpoints existentes).
  const AUTO = { crear_compra: 1, eliminar_compra: 1, fijar_pago_minimo_oficial: 1, editar_valor: 1, mover_ciclo: 1, reprogramar_cuotas: 1, convertir_a_diferida: 1, crear_diferida_omitida: 1, actualizar_tasa_intl: 1, actualizar_fecha_pago: 1, reversar_compra: 1, registrar_pago: 1 };
  // Operaciones ESTRUCTURALES: cambian QUE compras forman el ciclo y por cuanto. Fijar la cifra oficial
  // del extracto tiene que ir DESPUES de estas, porque es lo que convierte un pago parcial inofensivo en
  // un SELLADO del mes: sin cifra oficial, pagar menos que el estimado del motor queda como abono y no
  // cierra el ciclo; con ella, ese mismo pago sella, y sellar marca `estado='pagado'` +
  // `monto_abonado=valor_cop` en TODAS las compras del ciclo (syncData paso 6) — incluidas las que
  // todavia habria que mover a otro mes, que quedan tras el 403 de ciclos pagados y sin reversa.
  // NO estructurales a proposito: actualizar_fecha_pago (solo cambia lo que se ve) y registrar_pago
  // (opera sobre el ciclo ANTERIOR, no sobre la composicion de este).
  const ESTRUCTURAL = { crear_compra: 1, eliminar_compra: 1, editar_valor: 1, mover_ciclo: 1, reprogramar_cuotas: 1, convertir_a_diferida: 1, crear_diferida_omitida: 1, actualizar_tasa_intl: 1, reversar_compra: 1, fecha_corte_movida: 1 };

  // Formatea una tasa mensual decimal a porcentaje colombiano (0.020849 -> "2,0849%").
  const fmtPct = (x) => (x == null || x === '') ? '—' : (Number(x) * 100).toFixed(4).replace('.', ',') + '%';
  // Título legible del tipo de discrepancia (no mostrar el slug crudo del JSON). Mapa para los
  // tipos conocidos (con tildes/palabras de enlace) + fallback genérico: "_" → espacio y mayúscula inicial.
  const fmtTipoDiscrepancia = (tipo) => {
    if (!tipo) return 'Discrepancia';
    const map = {
      compra_omitida: 'Compra omitida', monto_erroneo: 'Monto erróneo',
      clasificacion_incorrecta: 'Clasificación incorrecta', cuota_reprogramada: 'Cuota reprogramada',
      tasa_intl_incorrecta: 'Tasa internacional incorrecta', fecha_pago_movida: 'Fecha de pago movida',
      reverso_detectado: 'Reverso detectado', mover_ciclo: 'Mover de ciclo', diferida_omitida: 'Diferida omitida',
      pago_omitido: 'Pago no registrado', compra_no_facturada: 'Compra que el banco no facturó',
      pago_minimo_oficial: 'Pago mínimo del extracto', otro: 'Otra discrepancia'
    };
    if (map[tipo]) return map[tipo];
    const s = String(tipo).replace(/_/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  // Título legible de la operación de la acción sugerida (mismo criterio que los tipos).
  const fmtOperacion = (op) => {
    if (!op) return '';
    const map = {
      crear_compra: 'Crear compra', eliminar_compra: 'Eliminar compra', editar_valor: 'Editar valor', mover_ciclo: 'Mover de ciclo',
      reprogramar_cuotas: 'Reprogramar cuotas', actualizar_tasa_intl: 'Actualizar tasa internacional',
      actualizar_fecha_pago: 'Actualizar fecha de pago', fecha_corte_movida: 'Aplicar corte adelantado',
      convertir_a_diferida: 'Convertir a diferida', crear_diferida_omitida: 'Crear diferida omitida', reversar_compra: 'Reversar compra',
      registrar_pago: 'Registrar pago', fijar_pago_minimo_oficial: 'Usar el pago minimo del extracto', ninguna: 'Sin acción'
    };
    if (map[op]) return map[op];
    const s = String(op).replace(/_/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  function paramsDe(d) { return (d.accion_sugerida && d.accion_sugerida.parametros) || {}; }
  // Compra objetivo de una discrepancia, resuelta contra la tabla real por compra_id (de los
  // parametros o del nivel raiz). null si la IA no dio id o el id no existe en esta tarjeta.
  function compraDe(d) {
    const p = paramsDe(d);
    const cid = p.compra_id != null ? p.compra_id : d.compra_id;
    if (cid == null || String(cid) === 'null') return null;
    return comprasTj.find(x => String(x.id) === String(cid)) || null;
  }
  // Partes de la compra dividida a la que pertenece `compra` (ella incluida), buscadas en `lista`.
  // Devuelve [compra] si no es un grupo, para que quien la use no tenga que bifurcar.
  function partesDeGrupo(lista, compra) {
    if (!compra) return [];
    if (!compra.grupo_id) return [compra];
    return lista.filter(x => x.grupo_id && String(x.grupo_id) === String(compra.grupo_id));
  }
  // ¿La discrepancia apunta a una compra DIVIDIDA (grupo) de forma que NO se pueda aplicar? Las
  // acciones por compra_id (editar_valor, reprogramar, convertir, eliminar, reversar) no pueden operar
  // sobre un grupo: cada parte es una compra distinta, con su propio valor y responsable, y el backend
  // ademas responde 403 por grupo_id en varias de ellas.
  // EXCEPCION mover_ciclo (v5.9.1): es la unica operacion semanticamente GRUPAL — "una compra dividida
  // vive entera en un solo ciclo" (mismo criterio que handleEditGrupo, el camino manual). Si el objetivo
  // esta identificado por id, ejecutarAccion mueve TODAS las partes y no hay razon para bloquearlo.
  // Sin id resoluble se sigue bloqueando: ahi no se puede saber de que grupo se habla, que es
  // precisamente el caso que origino este guard (la IA devolvia compra_id null → PUT /api/compras/null).
  // Deteccion: (a) la compra objetivo tiene grupo_id, o (b) su descripcion cruza con compras agrupadas.
  function afectaGrupo(d) {
    // Las acciones que CREAN un recurso nuevo (no operan sobre una compra existente por id) nunca
    // afectan un grupo: crear_diferida_omitida (diferida standalone) y crear_compra (compra nueva). Sin
    // este corte, la rama por descripción bloquearía de más si el nombre coincide con un grupo de otro ciclo.
    const opAG = d.accion_sugerida ? d.accion_sugerida.operacion : '';
    if (opAG === 'crear_diferida_omitida' || opAG === 'crear_compra' || opAG === 'registrar_pago' || opAG === 'fijar_pago_minimo_oficial') return false;
    const t = compraDe(d);
    if (opAG === 'mover_ciclo' && t) return false;
    if (t && t.grupo_id) return true;
    const p = paramsDe(d);
    const desc = String((p.descripcion != null ? p.descripcion : d.descripcion) || '').toLowerCase().trim();
    if (desc.length >= 3 && comprasTj.some(x => x.grupo_id && String(x.descripcion || '').toLowerCase().trim() === desc)) return true;
    return false;
  }
  function resumenAccion(d) {
    const op = d.accion_sugerida ? d.accion_sugerida.operacion : 'ninguna';
    const p = paramsDe(d);
    const cid = p.compra_id != null ? p.compra_id : d.compra_id;
    if (op === 'crear_compra') return { titulo: 'Crear compra nueva', endpoint: 'POST /api/compras', filas: [['Descripcion', p.descripcion || d.descripcion || ''], ['Valor', fmtCOP(p.valor_cop != null ? p.valor_cop : d.valor_extracto)], ['Ciclo', ciclo], ['Fecha', p.fecha || (ciclo + '-15')]] };
    if (op === 'eliminar_compra') {
      // Accion DESTRUCTIVA e irreversible: el resumen se arma con los datos REALES de la compra tomados
      // de la tabla (no los que reporta la IA), para que la confirmacion no sea a ciegas.
      const t = comprasTj.find(x => String(x.id) === String(cid));
      if (!t) return { titulo: 'Eliminar la compra de la app', endpoint: 'DELETE /api/compras/' + cid, filas: [
        ['Compra', '#' + cid],
        ['ATENCION', 'no se encontro esa compra en esta tarjeta: no se eliminara nada']
      ] };
      const filas = [
        ['Compra', '#' + t.id + ' - ' + (t.descripcion || '')],
        ['Valor', fmtCOP(t.valor_cop)],
        ['Fecha', t.fecha || ''],
        ['Motivo', 'el banco no la facturo en este extracto']
      ];
      if (t.persona_nombre || t.persona_id) filas.push(['Responsable', t.persona_nombre || ('persona #' + t.persona_id)]);
      if (t.monto_bolsillo > 0) filas.push(['Dinero apartado', fmtCOP(t.monto_bolsillo)]);
      // Borrar la ultima compra que referencia una diferida borra TAMBIEN la diferida: el usuario debe
      // saber que se lleva por delante la tabla de amortizacion completa, no una sola cuota.
      if (t.diferida_id) filas.push(['OJO', 'es una compra a cuotas: se elimina tambien su plan de amortizacion']);
      filas.push(['ATENCION', 'se borra de forma definitiva y no se puede deshacer']);
      return { titulo: 'Eliminar la compra de la app', endpoint: 'DELETE /api/compras/' + cid, filas };
    }
    if (op === 'editar_valor') return { titulo: 'Editar valor de la compra', endpoint: 'PUT /api/compras/' + cid, filas: [['Compra', '#' + cid], ['Valor actual (app)', fmtCOP(d.valor_app)], ['Nuevo valor (extracto)', fmtCOP(p.valor_cop != null ? p.valor_cop : d.valor_extracto)]] };
    if (op === 'mover_ciclo') {
      // El resumen se arma con los datos REALES de la tabla, no con los que reporta la IA. En una compra
      // DIVIDIDA se listan todas las partes: el usuario tiene que ver que se mueven juntas y por cuanto.
      const t = compraDe(d);
      const destino = p.ciclo || ciclo;
      const partes = partesDeGrupo(comprasTj, t);
      if (partes.length > 1) {
        return { titulo: 'Reasignar al ciclo (compra dividida)', endpoint: 'PUT /api/compras/:id  (x' + partes.length + ')', filas: [
          ['Compra', (t.descripcion || '') + '  ·  ' + partes.length + ' partes'],
          ['Partes', partes.map(x => '#' + x.id + ' ' + fmtCOP(x.valor_cop)).join('   |   ')],
          ['Total', fmtCOP(partes.reduce((s, x) => s + (Number(x.valor_cop) || 0), 0))],
          ['Ciclo actual', t.ciclo],
          ['Nuevo ciclo', destino],
          ['Alcance', 'se mueven TODAS las partes juntas (una compra dividida vive entera en un solo ciclo)'],
          ['Dinero apartado', 'se conserva en cada parte'],
          ['Conserva su fecha real', 'si']
        ] };
      }
      return { titulo: 'Reasignar al ciclo (manual)', endpoint: 'PUT /api/compras/' + cid, filas: [
        ['Compra', '#' + cid + (t ? '  ' + (t.descripcion || '') : '')],
        ['Ciclo actual', t ? t.ciclo : '(no se pudo leer)'],
        ['Nuevo ciclo', destino],
        ['Conserva su fecha real', 'si']
      ] };
    }
    if (op === 'reprogramar_cuotas') {
      const esDividir = Array.isArray(p.cuotas) && p.cuotas.length > 0;
      if (esDividir) return { titulo: 'Reprogramar dividiendo en cuotas', endpoint: 'POST /api/compras/' + cid + '/dividir-cuotas', filas: [['Compra', '#' + cid], ['Cuotas (irregulares)', String(p.cuotas.length)], ['Detalle', p.cuotas.map(q => q.ciclo + ': ' + fmtCOP(q.monto)).join('   |   ')]] };
      return { titulo: 'Reprogramar número de cuotas', endpoint: 'POST /api/diferidas/(de #' + cid + ')/reprogramar', filas: [['Compra', '#' + cid], ['Nuevo total de cuotas', String(p.num_cuotas || '')], ['Regenera la proyección', 'si']] };
    }
    if (op === 'convertir_a_diferida') return { titulo: 'Convertir compra de contado a cuotas (diferida)', endpoint: 'POST /api/compras/' + cid + '/convertir-a-diferida', filas: [['Compra', '#' + cid], ['Pasa de', '1 cuota (contado)'], ['Nuevo total de cuotas', String(p.num_cuotas || '')], ['Cobra intereses', (p.cobrar_intereses === false ? 'no' : 'si')], ['Conserva su fecha real', 'si']] };
    if (op === 'actualizar_tasa_intl') {
      const grupos = Array.isArray(p.grupos) ? p.grupos : (p.tasa_intl != null ? [{ tasa_intl: p.tasa_intl, compra_ids: p.compra_ids || [] }] : []);
      const nTotal = grupos.reduce((s, g) => s + ((g.compra_ids || []).length), 0);
      const filas = [['Tasas a aplicar (una por mes)', String(grupos.length)], ['Compras a actualizar', String(nTotal)], ['Ciclo', ciclo]];
      grupos.forEach((g, i) => filas.push(['Tasa ' + (i + 1), fmtPct(g.tasa_intl) + ' · ' + ((g.compra_ids || []).length) + ' compra(s)']));
      return { titulo: 'Sincronizar tasa internacional con el extracto', endpoint: 'POST /api/compras/aplicar-tasa-intl', filas };
    }
    if (op === 'actualizar_fecha_pago') {
      const fp = p.fecha_pago != null ? p.fecha_pago : d.fecha_extracto;
      return { titulo: 'Ajustar la fecha de pago de este ciclo', endpoint: 'PUT /api/extractos/fecha-pago-custom',
        filas: [['Fecha en la app', fmtDate(d.fecha_app)], ['Fecha del extracto', fmtDate(fp)], ['Ciclo', ciclo], ['Alcance', 'solo cambia lo que ves; no afecta intereses ni pago minimo']] };
    }
    if (op === 'fecha_corte_movida') {
      const fc = p.fecha_corte != null ? p.fecha_corte : d.fecha_extracto;
      return { titulo: 'Fijar el corte adelantado de este ciclo', endpoint: 'POST /api/compras/aplicar-corte-ciclo',
        filas: [['Corte que calculo la app', fmtDate(d.fecha_app)], ['Corte real del extracto', fmtDate(fc)], ['Ciclo', p.ciclo || ciclo], ['Efecto', 'las compras posteriores al corte pasan al ciclo siguiente (ahora y a futuro)']] };
    }
    if (op === 'reversar_compra') {
      const rv = d.reverso || {};
      const filas = [['Compra', '#' + cid + '  ' + (rv.compra_descripcion || '')],
        ['Movimiento del extracto', (rv.concepto_extracto || '') + '  ' + fmtCOP(rv.monto != null ? rv.monto : Math.abs(Number(d.valor_extracto) || 0))],
        ['Efecto', 'la compra deja de contar como deuda (su valor histórico se conserva)']];
      if (rv.es_tercero) filas.push(['Saldo a favor', 'se crea ' + fmtCOP(rv.reembolso) + ' a favor del tercero (ya te había reembolsado)']);
      return { titulo: 'Reversar compra (devolución del banco)', endpoint: 'POST /api/compras/' + cid + '/reversar', filas };
    }
    if (op === 'crear_diferida_omitida') {
      const M = Number(p.num_cuotas) || 0, N = Number(p.cuota_actual) || 1, cap = Number(p.capital) || 0;
      const total = Math.round(cap * M);
      // Ciclo de origen = ciclo conciliado - (N-1) meses (solo para el preview; el backend re-deriva).
      let co = ciclo;
      try { const pr = String(ciclo).split('-'); let y = Number(pr[0]), mm = Number(pr[1]) - (N - 1); while (mm < 1) { mm += 12; y -= 1; } co = y + '-' + String(mm).padStart(2, '0'); } catch (e) {}
      return { titulo: 'Crear diferida omitida (compra a cuotas que la app no tiene)', endpoint: 'POST /api/diferidas/crear-omitida', filas: [
        ['Descripcion', p.descripcion || d.descripcion || ''],
        ['Capital por cuota (extracto)', fmtCOP(cap)],
        ['Numero de cuotas', String(M)],
        ['Valor total (capital x cuotas)', fmtCOP(total)],
        ['Ciclo de origen (calculado)', co],
        ['Cobra intereses', (p.cobrar_intereses === false ? 'no' : 'si')]
      ] };
    }
    if (op === 'fijar_pago_minimo_oficial') {
      // El estimado se lee VIVO de la BD (minimoAppVivo), no del analisis: si el usuario acaba de mover
      // compras de ciclo —que es lo que la jerarquia le obliga a hacer ANTES de llegar aqui—, la cifra
      // del analisis ya no describe nada. Se cae a la del analisis solo si la lectura viva fallo, y en
      // ese caso se rotula como tal en vez de presentarla como el estado actual.
      const pmExtracto = (p.pago_minimo != null ? p.pago_minimo : d.valor_extracto);
      const estimadoVivo = (minimoAppVivo != null ? minimoAppVivo : d.valor_app);
      const filasPmo = [
        ['Ciclo', p.ciclo || ciclo],
        ['Pago minimo del extracto', fmtCOP(pmExtracto)],
        ['Estimado de la app', fmtCOP(estimadoVivo) + (minimoAppVivo != null ? '' : '  (del analisis, no se pudo leer el actual)')]
      ];
      if (Number.isFinite(Number(pmExtracto)) && Number.isFinite(Number(estimadoVivo))) {
        filasPmo.push(['Diferencia', fmtCOP(Number(pmExtracto) - Number(estimadoVivo))]);
      }
      filasPmo.push(
        ['Efecto', 'al pagar, la app propondra el valor exacto del banco (no hay que copiarlo a mano)'],
        ['No cambia', 'la deuda, el cupo ni las proyecciones siguen saliendo del calculo de la app']
      );
      return { titulo: 'Usar el pago minimo que exige el extracto', endpoint: 'POST /api/extractos/pago-oficial', filas: filasPmo };
    }
    if (op === 'registrar_pago') {
      const pg = d.pago || {};
      const mo = p.monto != null ? p.monto : pg.monto;
      return { titulo: 'Registrar el pago del extracto anterior', endpoint: 'POST /api/extractos/registrar-pago', filas: [
        ['Ciclo que se salda', p.ciclo || pg.ciclo || ''],
        ['Monto del pago', fmtCOP(mo)],
        ['Tipo', pg.tipo_pago === 'total' ? 'Pago total' : 'Pago minimo'],
        ['Fecha', p.fecha || pg.fecha || 'hoy'],
        ['Efecto', 'marca ese extracto como pagado y lo asienta en el historial de Pagos']
      ] };
    }
    return { titulo: op, endpoint: '', filas: [] };
  }

  async function ejecutarAccion() {
    if (!accionSel) return;
    const d = accionSel.d, idx = accionSel.idx;
    const op = d.accion_sugerida ? d.accion_sugerida.operacion : '';
    const p = paramsDe(d);
    // Modo Demo: el análisis es un EJEMPLO fabricado (mock, sin API key). NUNCA escribir en la BD real
    // aunque el usuario confirme (evita sembrar datos de ejemplo como "SUSCRIPCION DEMO" en su tarjeta).
    if (isMock) { toast('Modo Demo: este es un resultado de ejemplo; las acciones no se aplican.'); setAccionSel(null); return; }
    setAplicando(true); setErrAplicar('');
    try {
      if (!tarjetaId) throw new Error('No hay tarjeta seleccionada.');
      if (op === 'crear_compra') {
        // desde_conciliacion: exime del candado de "ciclo cerrado" del POST (la IA registra compras
        // que el extracto YA facturado trae y la app no tiene); el de ciclos PAGADOS sigue aplicando.
        const body = { tarjeta_id: Number(tarjetaId), ciclo: ciclo, ciclo_manual: 1, fecha: p.fecha || (ciclo + '-15'), descripcion: p.descripcion || d.descripcion || 'Compra (conciliacion)', valor_cop: Number(p.valor_cop != null ? p.valor_cop : d.valor_extracto) || 0, es_internacional: p.es_internacional ? 1 : 0, desde_conciliacion: true };
        const r = await api('/compras', { method: 'POST', body });
        if (r && r.error) throw new Error(r.error);
      } else if (op === 'eliminar_compra') {
        // Caso INVERSO de crear_compra: la app tiene una compra que el banco NUNCA facturo (tipicamente
        // un doble registro del usuario). desde_conciliacion exime del candado de "ciclo cerrado" — sin
        // el flag el DELETE responde 403 en cuanto el ciclo cierra, que es justo cuando llega el extracto
        // y se concilia; el candado de ciclos PAGADOS sigue aplicando y no se puede saltar.
        const cid = p.compra_id != null ? p.compra_id : d.compra_id;
        if (!cid) throw new Error('No se identifico la compra a eliminar.');
        // Verificar contra la BD que la compra EXISTE y es de ESTA tarjeta antes de borrar (mismo patron
        // que editar_valor/mover_ciclo). Sin esto, un compra_id equivocado del modelo podia borrar una
        // compra de otra tarjeta; el backend tambien lo blinda (404 + guards de contenido).
        const lista = await api('/compras?tarjeta_id=' + Number(tarjetaId));
        const a = Array.isArray(lista) ? lista.find(x => String(x.id) === String(cid)) : null;
        if (!a) throw new Error('No se encontro la compra #' + cid + ' en la tarjeta. No se elimino nada.');
        const r = await api('/compras/' + cid, { method: 'DELETE', body: { desde_conciliacion: true } });
        if (r && r.error) throw new Error(r.error);
      } else if (op === 'editar_valor' || op === 'mover_ciclo') {
        const cid = p.compra_id != null ? p.compra_id : d.compra_id;
        if (!cid) throw new Error('No se identifico la compra a modificar.');
        // Traer la compra actual completa: el PUT reemplaza TODOS los campos, asi que mergeamos.
        const lista = await api('/compras?tarjeta_id=' + Number(tarjetaId));
        const a = Array.isArray(lista) ? lista.find(x => String(x.id) === String(cid)) : null;
        if (!a) throw new Error('No se encontro la compra #' + cid + ' en la tarjeta.');
        // Cuerpo POR FILA: el PUT reemplaza TODOS los campos, asi que cada compra viaja con los suyos.
        // Incluye monto_bolsillo explicito (el endpoint tambien lo conserva si va ausente, pero mandarlo
        // hace evidente que mover de ciclo no toca el dinero apartado).
        // desde_conciliacion: exime del candado de "ciclo cerrado" del PUT (la IA corrige valores y
        // ciclos de extractos YA facturados); el candado de ciclos PAGADOS sigue aplicando.
        const cuerpoDe = (x) => ({ tarjeta_id: x.tarjeta_id, fecha: x.fecha, descripcion: x.descripcion, valor_cop: x.valor_cop, valor_usd: x.valor_usd, tasa_usd: x.tasa_usd, persona_id: x.persona_id, estado: x.estado, notas: x.notas, monto_bolsillo: x.monto_bolsillo, es_internacional: x.es_internacional, ciclo: x.ciclo, ciclo_manual: x.ciclo_manual, desde_conciliacion: true });
        if (op === 'editar_valor') {
          const body = cuerpoDe(a);
          body.valor_cop = Number(p.valor_cop != null ? p.valor_cop : d.valor_extracto) || a.valor_cop;
          const r = await api('/compras/' + cid, { method: 'PUT', body });
          if (r && r.error) throw new Error(r.error);
        } else {
          // GUARD DEL NO-OP (v5.9.1): el fallback `|| ciclo` (el ciclo que se esta conciliando) es
          // LEGITIMO para la cascada INVERSA (v4.3.2: el banco facturo en ESTE ciclo una compra que la
          // app puso en el siguiente), asi que no se puede exigir que el destino sea distinto del ciclo
          // conciliado. Lo que si es siempre un error es que el destino coincida con el ciclo ACTUAL de
          // la compra: el PUT la reescribia con su mismo ciclo, no movia nada, y la UI reportaba
          // "Accion aplicada correctamente". Un no-op vendido como exito es peor que un fallo.
          const destino = p.ciclo || ciclo;
          if (!/^\d{4}-\d{2}$/.test(String(destino))) throw new Error('El ciclo destino no es valido: "' + destino + '".');
          if (String(destino) === String(a.ciclo)) throw new Error('La compra #' + cid + ' ya esta en el ciclo ' + destino + ': no hay nada que mover. Si el extracto la factura en otro mes, re-analiza indicando el ciclo destino.');
          // Compra DIVIDIDA: una compra partida entre personas vive ENTERA en un solo ciclo (mismo
          // criterio que handleEditGrupo). Se mueven TODAS sus partes, no solo la que reporto la IA:
          // dejar el grupo repartido entre dos meses es peor que no moverlo. Secuencial y no en paralelo
          // para poder decir exactamente cuales quedaron movidas si una falla.
          const partes = a.grupo_id ? lista.filter(x => x.grupo_id && String(x.grupo_id) === String(a.grupo_id)) : [a];
          const movidas = [];
          for (const parte of partes) {
            const body = cuerpoDe(parte);
            body.ciclo = destino; body.ciclo_manual = 1;
            const r = await api('/compras/' + parte.id, { method: 'PUT', body });
            if (r && r.error) {
              throw new Error(partes.length > 1
                ? ('Se movieron ' + movidas.length + ' de ' + partes.length + ' partes' + (movidas.length ? ' (#' + movidas.join(', #') + ')' : '') + '. La parte #' + parte.id + ' fallo: ' + r.error + '. Revisa la tabla: el grupo puede haber quedado repartido entre dos ciclos.')
                : r.error);
            }
            movidas.push(parte.id);
          }
          // Discrepancias HERMANAS: las otras partes del mismo grupo ya quedaron resueltas por este
          // movimiento. Se marcan aplicadas para no pedir un clic que no hace nada (y que ademas
          // chocaria con el guard del no-op de arriba, porque ya estarian en el ciclo destino).
          if (partes.length > 1) {
            const ids = new Set(partes.map(x => String(x.id)));
            const hermanas = {};
            disc.forEach((dd, j) => {
              if (j === idx) return;
              const opj = dd.accion_sugerida ? dd.accion_sugerida.operacion : '';
              const pj = paramsDe(dd);
              const cj = pj.compra_id != null ? pj.compra_id : dd.compra_id;
              if (opj === 'mover_ciclo' && cj != null && ids.has(String(cj))) hermanas[j] = true;
            });
            if (Object.keys(hermanas).length) setAplicadas(prev => Object.assign({}, prev, hermanas));
          }
        }
      } else if (op === 'reprogramar_cuotas') {
        const cid = p.compra_id != null ? p.compra_id : d.compra_id;
        if (!cid) throw new Error('No se identifico la compra a reprogramar.');
        if (Array.isArray(p.cuotas) && p.cuotas.length > 0) {
          // Ruta C: cuotas irregulares → dividir en compras de 1 cuota. desde_conciliacion exime
          // del candado de "ciclo cerrado" (reprogramaciones que el banco hizo en extractos pasados).
          const r = await api('/compras/' + cid + '/dividir-cuotas', { method: 'POST', body: { cuotas: p.cuotas, desde_conciliacion: true } });
          if (r && r.error) throw new Error(r.error);
        } else {
          // Ruta A: reprogramacion uniforme → cambiar num_cuotas de la diferida vinculada.
          if (!(Number(p.num_cuotas) > 0)) throw new Error('Falta el nuevo numero de cuotas.');
          const lista = await api('/compras?tarjeta_id=' + Number(tarjetaId));
          const a = Array.isArray(lista) ? lista.find(x => String(x.id) === String(cid)) : null;
          if (!a) throw new Error('No se encontro la compra #' + cid + ' en la tarjeta.');
          if (!a.diferida_id) throw new Error('La compra #' + cid + ' no es una compra a cuotas (diferida).');
          // desde_conciliacion: exime del candado de "ciclo cerrado" (la IA corrige planes que el
          // banco YA reprogramó en extractos pasados); el candado de ciclos PAGADOS sigue aplicando.
          const r = await api('/diferidas/' + a.diferida_id + '/reprogramar', { method: 'POST', body: { num_cuotas: Number(p.num_cuotas), desde_conciliacion: true } });
          if (r && r.error) throw new Error(r.error);
        }
      } else if (op === 'convertir_a_diferida') {
        const cid = p.compra_id != null ? p.compra_id : d.compra_id;
        if (!cid) throw new Error('No se identifico la compra a convertir.');
        if (!(Number(p.num_cuotas) >= 2)) throw new Error('Falta el numero de cuotas (2 o mas).');
        // desde_conciliacion: exime del candado de "ciclo cerrado" (la IA convierte a cuotas una compra
        // que el banco diferio en un extracto YA facturado); el candado de ciclos PAGADOS sigue aplicando.
        const r = await api('/compras/' + cid + '/convertir-a-diferida', { method: 'POST', body: { num_cuotas: Number(p.num_cuotas), cobrar_intereses: p.cobrar_intereses !== false, desde_conciliacion: true } });
        if (r && r.error) throw new Error(r.error);
      } else if (op === 'actualizar_tasa_intl') {
        const grupos = Array.isArray(p.grupos) ? p.grupos : (p.tasa_intl != null ? [{ tasa_intl: p.tasa_intl, compra_ids: p.compra_ids || [] }] : []);
        const limpios = grupos.filter(g => Number(g.tasa_intl) > 0 && Array.isArray(g.compra_ids) && g.compra_ids.length);
        if (!limpios.length) throw new Error('No hay tasas internacionales validas para aplicar.');
        const r = await api('/compras/aplicar-tasa-intl', { method: 'POST', body: { tarjeta_id: Number(tarjetaId), ciclo: ciclo, grupos: limpios } });
        if (r && r.error) throw new Error(r.error);
      } else if (op === 'actualizar_fecha_pago') {
        const fp = p.fecha_pago != null ? p.fecha_pago : d.fecha_extracto;
        if (!fp) throw new Error('No hay una fecha de pago para aplicar.');
        const r = await api('/extractos/fecha-pago-custom', { method: 'PUT', body: { tarjeta_id: Number(tarjetaId), ciclo: ciclo, fecha_pago: fp } });
        if (r && r.error) throw new Error(r.error);
      } else if (op === 'fecha_corte_movida') {
        // Persiste el corte adelantado (cortes_custom) y reubica las compras de la ventana.
        const fc = p.fecha_corte != null ? p.fecha_corte : d.fecha_extracto;
        if (!fc) throw new Error('No hay una fecha de corte para aplicar.');
        const r = await api('/compras/aplicar-corte-ciclo', { method: 'POST', body: { tarjeta_id: Number(tarjetaId), ciclo: (p.ciclo || ciclo), fecha_corte: fc } });
        if (r && r.error) throw new Error(r.error);
      } else if (op === 'reversar_compra') {
        // Reverso (devolución del banco): neutraliza la compra y, si es de un tercero que ya reembolsó,
        // crea el saldo a favor. El endpoint es idempotente (409 si ya está reversada).
        const cid = p.compra_id != null ? p.compra_id : d.compra_id;
        if (!cid) throw new Error('No se identifico la compra a reversar.');
        const r = await api('/compras/' + cid + '/reversar', { method: 'POST' });
        if (r && r.error) throw new Error(r.error);
      } else if (op === 'crear_diferida_omitida') {
        // Diferida OMITIDA: crea una diferida standalone. El backend deriva total (capital x cuotas),
        // ciclo y fechas de origen; desde_conciliacion por consistencia (no hay candado que eximir).
        const cap = Number(p.capital);
        if (!(Number(p.num_cuotas) >= 2)) throw new Error('Falta el numero de cuotas (2 o mas).');
        if (!(Number(p.cuota_actual) >= 1)) throw new Error('Falta la cuota actual (N de M).');
        if (!(cap > 0)) throw new Error('Falta el capital de la cuota.');
        const r = await api('/diferidas/crear-omitida', { method: 'POST', body: { tarjeta_id: Number(tarjetaId), descripcion: p.descripcion || d.descripcion || 'Diferida (conciliacion)', capital: cap, num_cuotas: Number(p.num_cuotas), cuota_actual: Number(p.cuota_actual), ciclo: ciclo, cobrar_intereses: p.cobrar_intereses !== false, desde_conciliacion: true } });
        if (r && r.error) throw new Error(r.error);
      } else if (op === 'fijar_pago_minimo_oficial') {
        // Guarda la cifra impresa en el PDF para ese ciclo. No edita compras ni el extracto: solo
        // alimenta el valor que la app propone al pagar (el calculo del motor queda intacto).
        const pmo = Number(p.pago_minimo != null ? p.pago_minimo : d.valor_extracto);
        if (!(pmo > 0)) throw new Error('No se identifico el pago minimo del extracto.');
        const r = await api('/extractos/pago-oficial', { method: 'POST', body: {
          tarjeta_id: Number(tarjetaId), ciclo: p.ciclo || ciclo, pago_minimo: pmo,
          pago_total: (p.pago_total != null ? Number(p.pago_total) : null), fuente: 'conciliacion' } });
        if (r && r.error) throw new Error(r.error);
      } else if (op === 'registrar_pago') {
        // Registra el pago que saldó el extracto ANTERIOR (detectado en el PDF). El endpoint resuelve/crea
        // ese extracto y es idempotente (409 si ya está registrado). No usa desde_conciliacion: crea un
        // registro de pago nuevo, no edita una compra con candado de ciclo cerrado.
        const pg = d.pago || {};
        const mo = p.monto != null ? p.monto : pg.monto;
        const cicloPago = p.ciclo || pg.ciclo;
        if (!(Number(mo) > 0)) throw new Error('No hay un monto de pago valido.');
        if (!cicloPago) throw new Error('No se identifico el ciclo del pago.');
        const r = await api('/extractos/registrar-pago', { method: 'POST', body: { tarjeta_id: Number(tarjetaId), ciclo: cicloPago, monto: Number(mo), fecha: (p.fecha || pg.fecha || null), moneda: (p.moneda || 'COP') } });
        if (r && r.error) throw new Error(r.error);
      } else {
        throw new Error('Operacion no aplicable automaticamente.');
      }
      setAplicadas(prev => Object.assign({}, prev, { [idx]: true }));
      setAccionSel(null);
      toast('Accion aplicada correctamente.');
      // Releer compras y pago minimo: lo que este panel muestre a partir de ahora debe describir la BD
      // DESPUES de esta accion, no la foto del analisis.
      recargarContexto();
      if (onAplicada) onAplicada();
    } catch (err) {
      setErrAplicar((err && err.message) || 'No se pudo aplicar la accion.');
    }
    setAplicando(false);
  }

  // Cambios de ESTRUCTURA todavia sin resolver (ni aplicados ni descartados). Mientras haya alguno,
  // "fijar la cifra oficial del extracto" queda bloqueado: ver el comentario de ESTRUCTURAL. Se excluyen
  // los que ya vienen marcados como ruido (posible_falso_positivo) o ya hechos (ya_aplicado), porque
  // esos no muestran boton y bloquearian sin que el usuario pueda hacer nada al respecto.
  const pendientesEstructurales = disc.reduce((n, dd, j) => {
    const opj = dd.accion_sugerida ? dd.accion_sugerida.operacion : '';
    if (!ESTRUCTURAL[opj] || dd.posible_falso_positivo || dd.ya_aplicado) return n;
    return (aplicadas[j] || descartadas[j]) ? n : n + 1;
  }, 0);
  const btnDescartar = (i) => e('button', {
    className: 'btn btn-sm', style: { fontSize: 11 },
    title: 'Marcar como revisada sin aplicarla (deja de bloquear la cifra del extracto)',
    onClick: () => setDescartadas(prev => Object.assign({}, prev, { [i]: true }))
  }, 'Descartar');
  const btnDeshacerDescarte = (i) => e('button', {
    className: 'btn btn-sm', style: { fontSize: 10, padding: '1px 6px' },
    onClick: () => setDescartadas(prev => { const n = Object.assign({}, prev); delete n[i]; return n; })
  }, 'Deshacer');

  return e('div', { style: { marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 } },
    isMock && e('div', { style: { fontSize: 11, color: 'var(--warning)', marginBottom: 8 } }, 'Resultado de ejemplo (modo Demo).'),
    e('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 } }, 'Conciliacion del pago minimo'),
    e('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 10 } },
      e('div', null, e('div', { style: { fontSize: 11, color: 'var(--text-muted)' } }, 'Extracto'), e('div', { style: { fontSize: 15, fontWeight: 700 } }, fmtCOP(c.pago_minimo_extracto))),
      e('div', null, e('div', { style: { fontSize: 11, color: 'var(--text-muted)' } }, 'App'), e('div', { style: { fontSize: 15, fontWeight: 700 } }, fmtCOP(c.pago_minimo_app))),
      e('div', null, e('div', { style: { fontSize: 11, color: 'var(--text-muted)' } }, 'Diferencia'), e('div', { style: { fontSize: 15, fontWeight: 700, color: Math.abs(Number(c.diferencia) || 0) > 0 ? 'var(--warning)' : 'var(--success)' } }, fmtCOP(c.diferencia)))
    ),
    Array.isArray(c.explicacion) && c.explicacion.length > 0 && e('ul', { style: { margin: '0 0 10px 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 } }, c.explicacion.map((x, i) => e('li', { key: i }, String(x)))),
    // Con impactos CON SIGNO (v5.6.3) un residual NEGATIVO es posible (el analisis sobre-explica la
    // diferencia) y tambien hay que mostrarlo: con el guard viejo (> 0) quedaba invisible justo el caso
    // que delata un razonamiento mal cerrado.
    Number.isFinite(Number(c.residual_no_explicado)) && Math.round(Number(c.residual_no_explicado)) !== 0 && e('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 } }, 'Residual no explicado: ', e('strong', null, fmtCOP(c.residual_no_explicado))),
    pagos.length > 0 && e('div', { style: { marginBottom: 10 } },
      e('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 4 } }, 'Pagos detectados (no son compras faltantes)'),
      pagos.map((p, i) => e('div', { key: i, style: { fontSize: 12, color: 'var(--text-secondary)' } }, (p.fecha || '') + '  ' + fmtCOP(p.monto) + '  ' + (p.etiqueta_extracto || '') + (p.coincide_con_pago_app ? '  (coincide con un pago en la app)' : '')))
    ),
    (resultado && resultado.cruce_determinista && resultado.cruce_determinista.conciliadas > 0) && e('div', { style: { fontSize: 12, color: 'var(--success)', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.22)', borderRadius: 8, padding: '8px 10px', marginBottom: 10, lineHeight: 1.45 } },
      e('strong', null, 'Cruce exacto: ' + resultado.cruce_determinista.conciliadas + ' compra(s) conciliada(s) automaticamente'),
      ' con el extracto por monto + fecha + descripcion (antes de consultar a la IA). Estas no se reportan como discrepancia.'
    ),
    e('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: '12px 0 8px' } },
      'Discrepancias (' + disc.length + ')',
      (resultado && resultado.discrepancias_omitidas) ? e('span', { style: { fontSize: 11.5, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 } }, resultado.discrepancias_omitidas + ' de redondeo/division omitidas') : null
    ),
    disc.length === 0
      ? e('div', { style: { fontSize: 12.5, color: 'var(--success)' } }, 'No se encontraron discrepancias accionables.')
      : disc.map((d, i) => {
          const op = d.accion_sugerida ? d.accion_sugerida.operacion : 'ninguna';
          const aplicada = !!aplicadas[i];
          const descartada = !aplicada && !!descartadas[i];
          // Aviso INFORMATIVO (no accionable, operacion 'ninguna'): el banco corto en una fecha
          // distinta a la calculada. Estilo de "aviso" (borde punteado + fondo azul tenue) que
          // contrasta con las tarjetas accionables. Las compras que cayeron fuera se listan abajo
          // como acciones mover_ciclo separadas (con su badge "por desfase de corte").
          if (d.tipo === 'corte_desfasado') {
            const afc = Array.isArray(d.compras_afectadas) ? d.compras_afectadas : [];
            const inverso = d.sentido === 'inverso';
            return e('div', { key: i, style: { border: '1px dashed rgba(79,140,255,0.5)', background: 'rgba(79,140,255,0.06)', borderRadius: 8, padding: '10px 12px', marginBottom: 8 } },
              e('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 } },
                e(Ico, { name: 'bulb', size: 14, color: 'var(--accent)' }),
                e('span', { style: { fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Aviso · desfase de fecha de corte')
              ),
              e('div', { style: { fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.45 } },
                inverso
                  ? ['El banco cerró el ', e('strong', { key: 'e', style: { color: 'var(--text-primary)' } }, fmtDate(d.fecha_extracto)), ', después del corte que calculó la app (', e('strong', { key: 'a', style: { color: 'var(--text-primary)' } }, fmtDate(d.fecha_app)), ').']
                  : ['El banco cortó el ', e('strong', { key: 'e', style: { color: 'var(--text-primary)' } }, fmtDate(d.fecha_extracto)), ', pero la app calculó el ', e('strong', { key: 'a', style: { color: 'var(--text-primary)' } }, fmtDate(d.fecha_app)), '.']),
              afc.length > 0
                ? e('div', { style: { marginTop: 6, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.4 } },
                    inverso
                      ? ('Estas ' + afc.length + ' compra(s) que la app puso en ' + (d.ciclo_origen || 'el próximo ciclo') + ' el banco las facturó en ESTE ciclo. Abajo aparecen como acciones para traerlas:')
                      : ('Estas ' + afc.length + ' compra(s) quedaron después del corte real; el banco las factura en ' + (afc[0].ciclo_destino || 'el próximo ciclo') + '. Al aplicar el corte adelantado se reubicarán automáticamente:'),
                    afc.map((cc, ci) => e('div', { key: ci, style: { color: 'var(--text-secondary)', marginTop: 2 } }, '· ' + (cc.descripcion || ('#' + cc.compra_id)) + '  (' + fmtDate(cc.fecha) + ')')))
                : e('div', { style: { marginTop: 6, fontSize: 11.5, color: 'var(--text-muted)' } }, inverso
                    ? 'No hay compras del mes siguiente dentro de la ventana del desfase; es solo informativo.'
                    : (d.hay_compras_ventana
                        ? 'Hay compras en esta ventana de desfase que se reubicarán automáticamente al siguiente ciclo al aplicar el corte.'
                        : 'No hay compras en la ventana por ahora; aplica el corte para que las próximas (después del corte real) entren al ciclo correcto.')),
              // Adelanto: botón para PERSISTIR el corte real (cortes_custom). Al aplicarlo se reubican
              // las compras de la ventana y las futuras se auto-asignan. El inverso no es accionable.
              op === 'fecha_corte_movida' && (aplicada
                ? e('div', { key: 'ap', style: { marginTop: 8, fontSize: 11.5, color: 'var(--success)', fontWeight: 600 } }, 'Corte aplicado: las compras de la ventana se reubicaron en su ciclo correcto.')
                : descartada
                  // Tambien lleva "Descartar": es una operacion ESTRUCTURAL y sin salida propia dejaria
                  // bloqueada la cifra oficial cuando el usuario decide no aplicar el corte.
                  ? e('div', { key: 'ds', style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-muted)' } },
                      'Descartada: ya no bloquea la cifra del extracto.', btnDeshacerDescarte(i))
                  : e('div', { key: 'btn', style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                      e('button', { className: 'btn btn-sm btn-primary', onClick: () => { setErrAplicar(''); setAccionSel({ d: d, idx: i }); } }, 'Aplicar corte adelantado'),
                      btnDescartar(i)))
            );
          }
          return e('div', { key: i, style: { border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', marginBottom: 8, background: 'var(--bg-input)' } },
            e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
              e('span', { style: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: sevColor(d.severidad) } }, d.severidad || ''),
              e('span', { style: { fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' } }, fmtTipoDiscrepancia(d.tipo)),
              d.motivo === 'corte_desfasado' && e('span', { style: { fontSize: 10, fontWeight: 600, color: 'var(--accent)', background: 'rgba(79,140,255,0.12)', borderRadius: 4, padding: '1px 6px' } }, 'por desfase de corte'),
              aplicada
                ? e('span', { style: { marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--success)' } }, 'Aplicada')
                : descartada
                  ? e('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 } },
                      e('span', { style: { fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' } }, 'Descartada'), btnDeshacerDescarte(i))
                  : null
            ),
            e('div', { style: { fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 4, lineHeight: 1.45 } }, d.descripcion || ''),
            d.tipo === 'tasa_intl_incorrecta'
              ? e('div', { style: { fontSize: 12, color: 'var(--text-muted)' } },
                  (Array.isArray(d.grupos) ? d.grupos : (Array.isArray(d.compras_afectadas) ? [{ tasa_intl: d.tasa_extracto, meses: [], compras_afectadas: d.compras_afectadas }] : [])).map((g, gi) =>
                    e('div', { key: gi, style: { marginTop: gi ? 8 : 0 } },
                      e('div', { style: { fontSize: 11.5, marginBottom: 2, fontWeight: 600, color: 'var(--text-secondary)' } },
                        (Array.isArray(g.meses) && g.meses.length ? (g.meses.join(', ') + ' · ') : '') + 'tasa del extracto: ', e('strong', { style: { color: 'var(--accent)' } }, fmtPct(g.tasa_intl))),
                      (g.compras_afectadas || []).map((cc, ci) => e('div', { key: ci, style: { fontSize: 11.5, color: 'var(--text-secondary)' } },
                        '· ' + (cc.descripcion || ('#' + cc.id)) + ': ' + fmtCOP(cc.interes_actual) + ' -> ' + fmtCOP(cc.interes_nuevo) + (cc.tasa_actual == null ? '  (sin tasa fijada)' : '')))
                    ))
                )
              : (d.valor_extracto != null || d.valor_app != null) && e('div', { style: { fontSize: 12, color: 'var(--text-muted)' } }, 'Extracto: ' + fmtCOP(d.valor_extracto) + '   App: ' + fmtCOP(d.valor_app)),
            // Cuanto de la diferencia del pago minimo explica ESTA causa (con signo): es la cifra que
            // permite ver si las discrepancias suman la diferencia total o si todavia falta una causa.
            // Number.isFinite descarta un valor no numerico (el modelo podria devolverlo formateado):
            // sin ese guard, NaN pasaba el "!== 0" y pintaba un enganoso "Explica $0".
            Number.isFinite(Number(d.impacto_pago_minimo)) && Math.round(Number(d.impacto_pago_minimo)) !== 0 && e('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 } },
              'Explica ' + (Number(d.impacto_pago_minimo) > 0 ? '+' : '') + fmtCOP(d.impacto_pago_minimo) + ' del pago minimo'),
            d.posible_falso_positivo && e('div', { style: { marginTop: 6, fontSize: 11.5, color: 'var(--warning)', background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 6, padding: '6px 8px', lineHeight: 1.4 } },
              e('div', { style: { fontWeight: 700, marginBottom: 2 } }, 'Posible falso positivo'),
              e('div', { style: { color: 'var(--text-secondary)' } }, 'Tu app ya tiene una compra de este monto bien clasificada; la IA pudo confundir estas:'),
              (d.candidatas || []).map((cc, ci) => e('div', { key: ci, style: { color: 'var(--text-secondary)', marginTop: 2 } }, '· ' + (cc.descripcion || ('#' + cc.id)) + ' → ' + ((cc.es_internacional || cc.interes_intl > 0) ? 'internacional' : 'no internacional')))
            ),
            // Reverso ya aplicado (idempotencia): la compra ya está reversada en la BD -> sin botón.
            d.ya_aplicado && e('div', { style: { marginTop: 6, fontSize: 11.5, color: 'var(--text-muted)', fontStyle: 'italic' } }, 'Ya aplicado: esta compra ya está reversada en la app.'),
            // Bloque de acciones. Se arma en UN solo sitio, con los dos motivos de bloqueo como
            // banderas, en vez de tres ramas paralelas. Razon: con ramas separadas, la de "compra
            // dividida" no renderizaba "Descartar", asi que una discrepancia estructural bloqueada por
            // grupo contaba para el candado del pago minimo y NO se podia resolver desde el Asistente:
            // el candado se volvia una trampa sin salida. Aqui el boton "Descartar" depende solo de que
            // la operacion sea ESTRUCTURAL, que es exactamente el mismo predicado que la cuenta —
            // asi el invariante "todo lo que bloquea se puede resolver" no se puede romper por descuido.
            (!aplicada && !descartada && !d.posible_falso_positivo && (AUTO[op] || ESTRUCTURAL[op])) && (function () {
              const bloqGrupo = !!(AUTO[op] && afectaGrupo(d));
              // JERARQUIA: la cifra del extracto se fija DE ULTIMO. Es lo que habilita el sellado del
              // mes, y sellar da por pagadas todas las compras del ciclo; si todavia falta mover o
              // corregir alguna, ese sellado la congela en el mes equivocado y no tiene reversa.
              const bloqJerarquia = (op === 'fijar_pago_minimo_oficial' && pendientesEstructurales > 0);
              const bloqueado = bloqGrupo || bloqJerarquia;
              const nota = bloqGrupo
                ? 'Compra dividida: edítala manualmente en la tabla.'
                : bloqJerarquia
                  ? ('Resuelve primero ' + pendientesEstructurales + (pendientesEstructurales === 1 ? ' cambio' : ' cambios') +
                     ' de estructura de esta lista. Fijar la cifra del extracto es lo que permite cerrar el mes, y al cerrarlo ' +
                     'se dan por pagadas TODAS las compras del ciclo: hazlo cuando la lista de compras ya sea la correcta. ' +
                     'Si alguno es un error de la IA, usa "Descartar".')
                  : null;
              return e('div', { style: { marginTop: 6 } },
                e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  (!bloqueado && AUTO[op]) ? e('span', { style: { fontSize: 11.5, color: 'var(--text-muted)' } },
                    'Accion sugerida: ', e('strong', { style: { color: 'var(--accent)' } }, fmtOperacion(op))) : null,
                  AUTO[op] ? e('button', {
                    className: 'btn btn-sm btn-primary', disabled: bloqueado,
                    style: bloqueado ? { opacity: 0.5, cursor: 'not-allowed' } : null,
                    onClick: bloqueado ? undefined : () => { setErrAplicar(''); setAccionSel({ d: d, idx: i }); }
                  }, 'Aplicar') : null,
                  (ESTRUCTURAL[op] && !d.ya_aplicado) ? btnDescartar(i) : null
                ),
                nota ? e('div', { style: { fontSize: 11.5, color: bloqJerarquia ? 'var(--warning)' : 'var(--text-muted)', marginTop: 4, lineHeight: 1.45, maxWidth: 620 } }, nota) : null
              );
            })()
          );
        }),
    // Re-análisis iterativo: el usuario aclara/corrige y la IA vuelve a analizar (mismo PDF y
    // movimientos, + contexto_usuario). El resultado anterior se mantiene visible mientras corre.
    onReanalizar && e('div', { style: { marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 } },
      e('div', { style: { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 } },
        e(Ico, { name: 'sparkles', size: 14, color: 'var(--accent)' }), 'Re-analizar con tu contexto'),
      e('div', { style: { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.45 } },
        'Si algo no cuadra, dale una aclaración a la IA y vuelve a analizar (mismo PDF y datos, sin re-subir nada).'),
      e('textarea', { className: 'form-input', value: contextoUser, onChange: ev => setContextoUser(ev.target.value), rows: 3, disabled: reanalizando,
        placeholder: "Aclaraciones sobre este análisis (ej. 'La compra de Apple la pasé a 2 cuotas en el banco')...", style: { resize: 'vertical', minHeight: 64, fontFamily: 'inherit' } }),
      e('div', { style: { marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
        e('button', { className: 'btn btn-primary', disabled: reanalizando || !contextoUser.trim(), onClick: () => onReanalizar(contextoUser.trim()) },
          e(Ico, { name: 'refresh', size: 14 }), reanalizando ? ' Re-analizando...' : ' Re-analizar'),
        contextoUser.trim() && !reanalizando && e('button', { className: 'btn', onClick: () => setContextoUser('') }, 'Limpiar')
      )
    ),
    // Modal de confirmación: muestra exactamente qué se enviará antes de ejecutar.
    accionSel && (function () {
      const rs = resumenAccion(accionSel.d);
      return e(Modal, { show: true, onClose: () => { if (!aplicando) setAccionSel(null); }, title: 'Confirmar accion' },
        e('div', null,
          e('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 } }, rs.titulo),
          e('div', { style: { background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 10 } },
            rs.filas.map((f, k) => e('div', { key: k, style: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5, padding: '3px 0' } },
              e('span', { style: { color: 'var(--text-muted)' } }, f[0]),
              e('span', { style: { color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right' } }, String(f[1]))
            ))
          ),
          e('div', { style: { fontSize: 11, color: 'var(--text-muted)', fontFamily: "'SF Mono','Consolas',monospace", marginBottom: 10 } }, rs.endpoint),
          e('div', { style: { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.45 } }, 'Se modificaran tus datos reales usando los endpoints de la app (con sus validaciones). Si el extracto del ciclo ya esta pagado, no se aplicara.'),
          errAplicar && e('div', { style: { fontSize: 12.5, color: '#f87171', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '8px 10px', marginBottom: 12 } }, errAplicar),
          e('div', { style: { display: 'flex', gap: 10, justifyContent: 'flex-end' } },
            e('button', { className: 'btn', onClick: () => setAccionSel(null), disabled: aplicando }, 'Cancelar'),
            e('button', { className: 'btn btn-primary', onClick: ejecutarAccion, disabled: aplicando }, aplicando ? 'Aplicando...' : 'Confirmar y aplicar')
          )
        )
      );
    })()
  );
}

// ── IA Asistente — Conciliación de extractos (config, extracción y análisis) ──
function IaAsistente({ iaConfig, onIaConfigChange, tarjetas, onGoConfig, demoMode, onActivarDemo, onSalirDemo, onRefrescarTarjetas }) {
  const cfg = iaConfig || { provider: null, model: '', hasKey: false };
  const hasKey = !!cfg.hasKey;
  const isMock = !!demoMode && !hasKey;            // Demo solo aplica si no hay key real
  const operativo = hasKey || isMock;
  const MESES_IA = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const cicloLabel = (c) => { const a = String(c).split('-'); return (MESES_IA[Number(a[1]) - 1] || a[1]) + ' ' + a[0]; };
  const cicloAnterior = (c) => { const a = String(c).split('-'); let y = Number(a[0]); let m = Number(a[1]) - 1; if (m < 1) { m = 12; y -= 1; } return y + '-' + String(m).padStart(2, '0'); };
  const activas = (tarjetas || []).filter(t => t.estado === 'activa');

  const [tarjetaId, setTarjetaId] = useState('');
  const [ciclo, setCiclo] = useState('');
  const [ciclosTarjeta, setCiclosTarjeta] = useState([]);
  const [loadingCiclos, setLoadingCiclos] = useState(false);
  const [pdfName, setPdfName] = useState('');
  const [pdfFile, setPdfFile] = useState(null);
  const fileRef = useRef(null);
  const fetchSeq = useRef(0);
  const [analizando, setAnalizando] = useState(false);
  const [preview, setPreview] = useState(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [pdfPassword, setPdfPassword] = useState('');
  const [passwordError, setPasswordError] = useState(false);
  const [extraerError, setExtraerError] = useState('');
  const [analizandoIA, setAnalizandoIA] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [errorIA, setErrorIA] = useState('');
  // Modelo seleccionable para este análisis (default = el configurado o el por defecto del proveedor).
  const [modeloSel, setModeloSel] = useState('');
  useEffect(() => { setModeloSel(cfg.model || iaProviderDefaultModel(cfg.provider)); }, [cfg.provider, cfg.model]);

  // Dep estable: solo cambia si cambia el conjunto de tarjetas activas (no en cada
  // render de App, que recrearia el array y dispararia el efecto de mas).
  const activasIds = activas.map(t => t.id).join(',');

  // Auto-selecciona la primera tarjeta activa; respeta una seleccion manual valida.
  useEffect(() => {
    if (activas.length && !activas.some(t => String(t.id) === String(tarjetaId))) {
      setTarjetaId(String(activas[0].id));
    }
  }, [activasIds]);

  // Periodos = historial REAL de la tarjeta seleccionada (sus extractos hasta el ciclo
  // vigente) + el ciclo vigente. Al cambiar de tarjeta se LIMPIA de inmediato y se
  // refetchea solo para ese tarjeta_id. fetchSeq descarta respuestas obsoletas (sin mezclas).
  useEffect(() => {
    const card = (tarjetas || []).find(t => String(t.id) === String(tarjetaId));
    if (!card) { setCiclosTarjeta([]); setCiclo(''); setLoadingCiclos(false); return; }
    // Vigente consciente del corte (del backend): si el banco ya cortó, avanza al mes siguiente y
    // el mes que cerró pasa a ser un "cerrado" más en la lista (sin rótulo de "en curso").
    const vig = card.ciclo_vigente || cicloVigente(card.dia_corte);
    const seq = ++fetchSeq.current;
    setLoadingCiclos(true);
    setCiclosTarjeta([]);   // limpia ya: nunca quedan visibles los de otra tarjeta
    setCiclo('');
    // Ciclos cerrados (r.ciclo < vig) + SIEMPRE el ciclo vigente (en curso) como primera opción:
    // el banco puede ADELANTAR el corte (fin de semana/festivo) y emitir el extracto antes de la
    // fecha teórica, así que el usuario debe poder conciliar el mes en curso aunque "matemáticamente"
    // no haya cerrado. El default sigue siendo el último cerrado (caso normal); el vigente queda
    // disponible y rotulado aparte. La conciliación confía en las fechas REALES del PDF.
    api('/extractos?tarjeta_id=' + card.id).then(rows => {
      if (seq !== fetchSeq.current) return;   // respuesta de una tarjeta anterior → descartar
      const set = {};
      (Array.isArray(rows) ? rows : []).forEach(r => { if (r && r.ciclo && r.ciclo < vig) set[r.ciclo] = 1; });
      const cerrados = Object.keys(set).sort().reverse();
      const ciclos = [vig, ...cerrados];
      setCiclosTarjeta(ciclos);
      setCiclo(cerrados[0] || vig);   // default: último cerrado; si no hay ninguno, el vigente
      setLoadingCiclos(false);
    }).catch(() => {
      if (seq !== fetchSeq.current) return;
      const prev = cicloAnterior(vig);   // fallback offline: ultimo cerrado por calendario
      setCiclosTarjeta([vig, prev]); setCiclo(prev); setLoadingCiclos(false);
    });
  }, [tarjetaId]);

  // Al cambiar tarjeta / periodo / archivo, descarta cualquier vista previa o estado de contraseña previos.
  useEffect(() => { setPreview(null); setNeedPassword(false); setPasswordError(false); setExtraerError(''); setPdfPassword(''); setResultado(null); setErrorIA(''); }, [tarjetaId, ciclo, pdfName]);

  function openLink(url) { if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(url); }
  function onPickFile(ev) { const f = ev.target.files && ev.target.files[0]; setPdfFile(f || null); setPdfName(f ? f.name : ''); }
  function quitarPdf() { setPdfFile(null); setPdfName(''); if (fileRef.current) fileRef.current.value = ''; }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { const s = String(reader.result || ''); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
      reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
      reader.readAsDataURL(file);
    });
  }
  async function analizar() {
    if (!pdfFile || !tarjetaId || !ciclo) return;
    setAnalizando(true); setExtraerError('');
    try {
      const b64 = await fileToBase64(pdfFile);
      const r = await api('/ia/extraer', { method: 'POST', body: { tarjeta_id: Number(tarjetaId), ciclo: ciclo, pdf_base64: b64, password: pdfPassword || undefined } });
      if (r && r.necesita_password) { setNeedPassword(true); setPasswordError(!!r.password_incorrecta); setPreview(null); setAnalizando(false); return; }
      if (r && r.sin_texto) { setExtraerError('El PDF no contiene texto seleccionable (parece escaneado). No hay OCR disponible.'); setAnalizando(false); return; }
      if (r && r.error) { setExtraerError(r.error); setAnalizando(false); return; }
      setNeedPassword(false); setPasswordError(false); setPreview(r); setAnalizando(false);
    } catch (err) { setExtraerError('Error al procesar el PDF.'); setAnalizando(false); }
  }
  function resumenRedaccion(c) {
    if (!c) return 'ninguno';
    const p = [];
    if (c.tarjetas) p.push(c.tarjetas + ' tarjeta(s)');
    if (c.nombres) p.push(c.nombres + ' nombre(s)');
    if (c.documentos) p.push(c.documentos + ' documento(s)');
    if (c.emails) p.push(c.emails + ' email(s)');
    if (c.telefonos) p.push(c.telefonos + ' telefono(s)');
    if (c.direcciones) p.push(c.direcciones + ' direccion(es)');
    return p.length ? p.join(', ') : 'ninguno';
  }
  function construirPromptManual(pv) {
    if (!pv) return '';
    const mv = pv.movimientos || {};
    const NL = String.fromCharCode(10);
    const datos = JSON.stringify({ compras: mv.compras, diferidas: mv.diferidas, avances: mv.avances, intereses_intl: mv.intereses_intl, pago_minimo_app: mv.pago_minimo_app }, null, 2);
    return [
      'Actua como un conciliador experto de extractos de tarjeta de credito. Responde en espanol, claro y conciso.',
      'Tengo el extracto oficial del banco y los movimientos de mi app. Concilia el PAGO MINIMO y explica cualquier diferencia.',
      '',
      'REGLAS:',
      '- Los "ABONO SUCURSAL VIRTUAL" o similares NO son compras faltantes: por defecto son el pago del extracto anterior. No los marques como discrepancia.',
      '- Si una diferencia no se explica con los movimientos, reportala como "residual no explicado"; no inventes.',
      '',
      'MIS MOVIMIENTOS (' + (mv.tarjeta ? (mv.tarjeta.banco + ' ' + (mv.tarjeta.franquicia || '')) : '') + ', ciclo ' + (mv.ciclo || '') + '):',
      datos,
      '',
      'TEXTO DEL EXTRACTO (datos personales ya ocultados):',
      (pv.texto_redactado || ''),
      '',
      'Entrega: 1) pago minimo del extracto, 2) diferencia con mi app, 3) a que se debe cada parte, 4) compras faltantes o mal registradas.'
    ].join(NL);
  }
  function copiarPrompt() {
    const txt = construirPromptManual(preview);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('Prompt copiado. Pegalo en tu IA preferida.'); }, function () { toastErr('No se pudo copiar al portapapeles'); });
    } else { toastErr('Portapapeles no disponible'); }
  }
  async function analizarConIA(contextoUsuario) {
    if (!preview) return;
    const prov = isMock ? 'mock' : cfg.provider;
    const esReanalisis = typeof contextoUsuario === 'string' && contextoUsuario.trim().length > 0;
    setAnalizandoIA(true); setErrorIA('');
    // En re-análisis mantenemos el resultado anterior visible hasta tener el nuevo.
    if (!esReanalisis) setResultado(null);
    try {
      const body = { provider: prov, model: modeloSel || cfg.model || undefined, texto_redactado: preview.texto_redactado, movimientos: preview.movimientos };
      if (esReanalisis) body.contexto_usuario = contextoUsuario.trim();
      const r = await api('/ia/analizar', { method: 'POST', body });
      if (r && r.ok && r.resultado) setResultado(r.resultado);
      else setErrorIA((r && r.error) || 'No se pudo completar el analisis.');
      setAnalizandoIA(false);
    } catch (err) { setErrorIA('Error de conexion con el analisis.'); setAnalizandoIA(false); }
  }
  // Refresh tras aplicar una accion: recarga los movimientos del ciclo (nuevo pago minimo de
  // la app) y los agregados globales, para ver el impacto sin re-subir el PDF.
  async function recargarMovimientos() {
    if (tarjetaId && ciclo) {
      try {
        const mv = await api('/ia/movimientos?tarjeta_id=' + Number(tarjetaId) + '&ciclo=' + encodeURIComponent(ciclo));
        if (mv && !mv.error) setPreview(prev => prev ? Object.assign({}, prev, { movimientos: mv }) : prev);
      } catch (_) { /* noop */ }
    }
    if (onRefrescarTarjetas) onRefrescarTarjetas();
  }

  const titulo = e('div', { className: 'section-title' }, e(Ico, { name: 'sparkles', size: 18, color: 'var(--accent)', className: 'ai-glow' }), ' IA Asistente');

  // Sin proveedor operativo (sin key real y sin Demo de sesion) → tutorial
  if (!operativo) {
    const provInfo = [
      { id: 'openai', como: 'Crea una cuenta en OpenAI y genera una clave en la seccion API keys.' },
      { id: 'anthropic', como: 'Entra a la consola de Anthropic y crea una API key.' },
      { id: 'gemini', como: 'Abre Google AI Studio y genera tu clave de Gemini.' },
      { id: 'deepseek', como: 'Crea una cuenta en DeepSeek y genera tu API key en su plataforma.' },
    ];
    return e('div', null, titulo,
      e('div', { style: { maxWidth: 760 } },
        e('div', { style: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', marginBottom: 18 } },
          e('div', { style: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 } }, 'Conecta una IA para conciliar tus extractos'),
          e('div', { style: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 } },
            'Subis el PDF del extracto y la app lo contrasta con tus movimientos para explicarte por que no cuadra el pago minimo. ',
            'Para usarlo necesitas una API key de alguno de estos proveedores. Tambien podes empezar con el modo ',
            e('strong', null, 'Demo (sin conexion)'), ', que muestra un analisis de ejemplo sin gastar creditos ni enviar datos.'
          )
        ),
        provInfo.map(pi => e('div', { key: pi.id, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 10 } },
          e('div', null,
            e('div', { style: { fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 } }, iaProviderLabel(pi.id)),
            e('div', { style: { fontSize: 12, color: 'var(--text-secondary)' } }, pi.como),
            e('div', { style: { fontSize: 11, color: 'var(--text-muted)', fontFamily: "'SF Mono','Consolas',monospace", marginTop: 3 } }, IA_LINKS[pi.id])
          ),
          e('button', { className: 'btn btn-sm', onClick: () => openLink(IA_LINKS[pi.id]) }, e(Ico, { name: 'globe', size: 14 }), ' Abrir')
        )),
        e('div', { style: { marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          e('button', { className: 'btn btn-primary', onClick: onGoConfig }, e(Ico, { name: 'settings', size: 14 }), ' Ir a Configuracion'),
          e('button', { className: 'btn', onClick: onActivarDemo }, e(Ico, { name: 'sparkles', size: 14 }), ' Probar modo Demo'),
          e('span', { style: { fontSize: 12, color: 'var(--text-muted)' } }, 'El modo Demo dura solo esta sesion; no se guarda.')
        )
      )
    );
  }

  // Operativo (key real o Demo de sesion) → interfaz de conciliación (análisis: Fase 2-3)
  return e('div', null, titulo,
    e('div', { style: { maxWidth: 760 } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' } },
        e('span', { style: { fontSize: 11.5, fontWeight: 600, color: isMock ? 'var(--warning)' : 'var(--accent)', background: isMock ? 'rgba(251,191,36,0.12)' : 'var(--accent-bg)', borderRadius: 99, padding: '4px 12px' } }, isMock ? 'Modo Demo (sin conexion)' : iaProviderLabel(cfg.provider)),
        !isMock && e('span', { style: { fontSize: 12, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 } },
          'Modelo:',
          e('select', {
            value: modeloSel, onChange: ev => setModeloSel(ev.target.value),
            title: 'Modelos más avanzados ofrecen mejor razonamiento, pero consumen más tokens',
            style: { background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 6px', fontSize: 12 }
          },
            (function () {
              // Cada modelo es { id, label }: se muestra el nombre corto y se envia el id exacto.
              // Un modelo guardado en Configuracion que no este en la lista se anade igualmente
              // como opcion (rotulado con su id), para no bloquear a quien use uno nuevo o de
              // acceso restringido antes de que aparezca aqui.
              const ms = iaProviderModels(cfg.provider);
              const opts = ms.slice();
              if (modeloSel && !opts.some(m => m.id === modeloSel)) opts.unshift({ id: modeloSel, label: modeloSel });
              if (opts.length === 0) {
                const d = iaProviderDefaultModel(cfg.provider) || '';
                opts.push({ id: d, label: d });
              }
              return opts.map(m => e('option', { key: m.id, value: m.id }, m.label));
            })()
          )
        ),
        isMock && e('button', { className: 'btn btn-sm', onClick: onSalirDemo, style: { marginLeft: 'auto' } }, 'Salir del Demo')
      ),
      !isMock && e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: -10, marginBottom: 14 } }, 'Modelos más avanzados ofrecen mejor razonamiento, pero consumen más tokens.'),
      activas.length === 0
        ? e('div', { style: { fontSize: 13, color: 'var(--text-muted)' } }, 'No hay tarjetas activas para conciliar.')
        : e(Fragment, null,
            e('div', { className: 'form-row' },
              e('div', { className: 'form-group' },
                e('label', { className: 'form-label' }, 'Tarjeta'),
                e('select', { className: 'form-input', value: tarjetaId, onChange: ev => setTarjetaId(ev.target.value) },
                  activas.map(t => e('option', { key: t.id, value: String(t.id) }, t.nombre + (t.franquicia ? ' - ' + t.franquicia : '')))
                )
              ),
              e('div', { className: 'form-group' },
                e('label', { className: 'form-label' }, 'Periodo a conciliar'),
                loadingCiclos
                  ? e('div', { className: 'form-input', style: { color: 'var(--text-muted)', display: 'flex', alignItems: 'center' } }, 'Cargando periodos...')
                  : ciclosTarjeta.length
                    ? (function() {
                        // Vigente consciente del corte (backend). vigAvanzo = el banco YA cortó y el
                        // ciclo en curso avanzó al siguiente → el mes que cerró es un "cerrado" normal
                        // ("Ultimo extracto cerrado"), no "en curso". Si NO avanzó (sin corte registrado),
                        // se conserva el rótulo de v4.5.6 para poder conciliar el mes en curso por adelanto.
                        const cardSel = activas.find(t => String(t.id) === String(tarjetaId));
                        const vigLocal = cardSel ? cicloVigente(cardSel.dia_corte) : null;
                        const vigSel = cardSel ? (cardSel.ciclo_vigente || vigLocal) : null;
                        const vigAvanzo = !!(vigSel && vigLocal && vigSel !== vigLocal);
                        const primerCerrado = ciclosTarjeta.find(c => c !== vigSel);
                        return e('select', { className: 'form-input', value: ciclo, onChange: ev => setCiclo(ev.target.value) },
                          ciclosTarjeta.map(c => e('option', { key: c, value: c },
                            cicloLabel(c) + (c === vigSel
                              ? (vigAvanzo ? ' (Ciclo en curso)' : ' (Ciclo en curso / Corte adelantado)')
                              : (c === primerCerrado ? ' (Ultimo extracto cerrado)' : '')))));
                      })()
                    : e('div', { className: 'form-input', style: { color: 'var(--text-muted)', display: 'flex', alignItems: 'center' } }, 'Sin periodos disponibles')
              )
            ),
            // Zona de carga del PDF (con boton para quitar/reemplazar)
            e('input', { ref: fileRef, type: 'file', accept: 'application/pdf,.pdf', style: { display: 'none' }, onChange: onPickFile }),
            !pdfName
              ? e('div', { onClick: () => fileRef.current && fileRef.current.click(), style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, border: '1.5px dashed var(--border)', borderRadius: 12, padding: '26px 16px', cursor: 'pointer', background: 'var(--bg-card)', marginTop: 6 } },
                  e(Ico, { name: 'download', size: 22, color: 'var(--text-muted)' }),
                  e('div', { style: { fontSize: 13, color: 'var(--text-secondary)' } }, 'Selecciona el PDF del extracto')
                )
              : e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', background: 'var(--bg-card)', marginTop: 6 } },
                  e(Ico, { name: 'clipboard', size: 18, color: 'var(--accent)' }),
                  e('span', { style: { flex: 1, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, pdfName),
                  e('button', { className: 'btn btn-sm', onClick: () => fileRef.current && fileRef.current.click(), title: 'Reemplazar documento' }, e(Ico, { name: 'refresh', size: 14 })),
                  e('button', { className: 'btn btn-sm btn-danger', onClick: quitarPdf, title: 'Quitar documento' }, e(Ico, { name: 'trash', size: 14 }))
                ),
            !isMock && e('div', { style: { fontSize: 11.5, color: 'var(--warning)', background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 8, padding: '8px 10px', marginTop: 14, lineHeight: 1.45 } },
              'Al analizar, el texto del extracto (sin tus datos personales) y tus movimientos se envian a ', iaProviderLabel(cfg.provider), '. Cada analisis consume creditos.'),
            // Campo de contraseña si el PDF está protegido
            needPassword && e('div', { style: { marginTop: 12 } },
              e('label', { className: 'form-label', style: passwordError ? { color: '#f87171' } : null }, passwordError ? 'Contraseña incorrecta. Intenta de nuevo' : 'El PDF está protegido. Ingresa la contraseña de apertura'),
              e('input', { type: 'password', className: 'form-input', value: pdfPassword, onChange: ev => setPdfPassword(ev.target.value), placeholder: 'Contraseña del PDF', autoComplete: 'off', spellCheck: false, onKeyDown: ev => { if (ev.key === 'Enter') analizar(); } }),
              e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 4 } }, 'La contraseña solo se usa para abrir el PDF; no se guarda ni se envia a la IA.')
            ),
            extraerError && e('div', { style: { marginTop: 12, fontSize: 12.5, color: '#f87171', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '8px 10px' } }, extraerError),
            e('div', { style: { marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
              e('button', { className: 'btn btn-primary', onClick: analizar, disabled: !pdfFile || analizando || !ciclo }, e(Ico, { name: 'sparkles', size: 14 }), analizando ? ' Procesando...' : (needPassword ? ' Reintentar' : ' Analizar extracto')),
              !pdfFile && e('span', { style: { fontSize: 12, color: 'var(--text-muted)' } }, 'Adjunta el PDF del extracto para analizar.')
            ),
            // Vista previa de la extracción (el usuario confirma antes de enviar a la IA)
            preview && e('div', { style: { marginTop: 18, border: '1px solid var(--border)', borderRadius: 12, padding: 16, background: 'var(--bg-card)' } },
              e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
                e(Ico, { name: 'check', size: 16, color: 'var(--success)' }),
                e('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' } }, 'Vista previa de la extraccion'),
                e('span', { style: { marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' } }, (preview.paginas || 0) + ' pag.')
              ),
              (preview.perfil_configurado === false) && e('div', { style: { fontSize: 12, color: '#f87171', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.35)', borderRadius: 8, padding: '10px 12px', marginBottom: 12, lineHeight: 1.45 } },
                e('div', { style: { fontWeight: 700, marginBottom: 4 } }, 'No configuraste tus datos personales a ocultar'),
                e('div', { style: { marginBottom: 8 } }, 'Tu nombre, ciudad o direccion pueden viajar a la IA tal cual aparecen en el extracto. Configuralos una vez y se ocultaran en cada analisis (revisa el texto de abajo).'),
                e('button', { className: 'btn btn-sm btn-primary', onClick: onGoConfig }, e(Ico, { name: 'settings', size: 14 }), ' Configurar mis datos a ocultar')
              ),
              e('div', { style: { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 } },
                'Revisa que el texto y los movimientos sean correctos antes de enviar a la IA. Datos personales ocultados: ',
                e('strong', null, resumenRedaccion(preview.redaccion)), '.',
                (preview.movimientos && preview.movimientos.banco_doc)
                  ? e(Fragment, null, ' Reglas del banco: ', e('strong', null, preview.movimientos.banco_doc))
                  : ' (no hay doc de reglas para este banco)'
              ),
              e('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, marginBottom: 12 } },
                e('div', null, e('span', { style: { color: 'var(--text-muted)' } }, 'Pago minimo (app): '), e('strong', null, fmtCOP(preview.movimientos ? preview.movimientos.pago_minimo_app : 0))),
                e('div', null, e('span', { style: { color: 'var(--text-muted)' } }, 'Compras: '), String(preview.movimientos && preview.movimientos.compras ? preview.movimientos.compras.length : 0)),
                e('div', null, e('span', { style: { color: 'var(--text-muted)' } }, 'Cuotas diferidas: '), String(preview.movimientos && preview.movimientos.diferidas ? preview.movimientos.diferidas.length : 0)),
                e('div', null, e('span', { style: { color: 'var(--text-muted)' } }, 'Avances: '), String(preview.movimientos && preview.movimientos.avances ? preview.movimientos.avances.length : 0))
              ),
              e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 } }, 'Texto del extracto (datos personales ocultados):'),
              e('pre', { style: { maxHeight: 220, overflow: 'auto', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, fontSize: 11.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: "'SF Mono','Consolas',monospace" } }, preview.texto_redactado || ''),
              e('div', { style: { marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
                e('button', { className: 'btn', onClick: copiarPrompt }, e(Ico, { name: 'clipboard', size: 14 }), ' Copiar prompt para IA'),
                e('button', { className: 'btn btn-primary', onClick: () => analizarConIA(), disabled: analizandoIA }, e(Ico, { name: 'sparkles', size: 14 }), analizandoIA ? ' Analizando...' : (isMock ? ' Analizar (Demo)' : ' Confirmar y analizar con IA')),
                e('button', { className: 'btn', onClick: () => { setPreview(null); setResultado(null); setErrorIA(''); } }, 'Descartar')
              ),
              // Mientras analiza se avisa de que la espera larga es normal: los modelos que razonan
              // tardan uno o dos minutos con un ciclo completo, y sin este aviso la pantalla quieta
              // parece un cuelgue (fue justo lo que ocurrio en el QA).
              analizandoIA && !isMock && e('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--accent)' } },
                'Analizando el extracto. Con los modelos mas avanzados esto puede tardar uno o dos minutos: no cierres esta vista.'),
              e('div', { style: { marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)' } }, 'Tip: "Copiar prompt para IA" arma un mensaje listo para pegar en ChatGPT, Claude o Gemini, sin gastar tokens de mas.'),
              errorIA && e('div', { style: { marginTop: 12, fontSize: 12.5, color: '#f87171', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '8px 10px' } }, errorIA),
              resultado && e(IaResultado, { resultado: resultado, isMock: isMock, tarjetaId: tarjetaId, ciclo: ciclo, onAplicada: recargarMovimientos, onReanalizar: analizarConIA, reanalizando: analizandoIA })
            )
          )
    )
  );
}
