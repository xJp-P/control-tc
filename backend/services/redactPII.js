// backend/services/redactPII.js
// Ofusca la PII del titular ANTES de que el texto del extracto salga hacia una IA externa.
// Política: la privacidad es innegociable; ante la duda, se oculta.
//
// Estrategia en dos capas:
//   A) PERFIL DEL USUARIO (lo más confiable): replace EXACTO de datos que el usuario declara
//      suyos (nombre, ciudad, departamento, dirección, documento, palabras extra). No depende
//      de etiquetas ni del layout del banco — resuelve casos como Bancolombia, que imprime el
//      nombre y la dirección en bruto, sin "Titular:" ni "Dirección:".
//   B) REGLAS GENÉRICAS por patrón (tarjeta, email, NIT, teléfono, dirección).
//
// Los importes NO se ofuscan: la IA los necesita para conciliar el pago mínimo.
// Doble seguro: el usuario revisa el texto redactado en la vista previa antes de enviarlo.

const OCULTO = '[DATO_OCULTO]';

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Patrón con espacios flexibles entre palabras (tolera espacios múltiples del PDF).
function patronFlexible(valor) {
  const limpio = String(valor || '').trim().replace(/\s+/g, ' ');
  if (!limpio) return null;
  return limpio.split(' ').map(escapeRegex).join('[ \\t]+');
}

// N-gramas consecutivos (>=2 palabras) de un nombre, de más largo a más corto. Cubre que el
// banco imprima el nombre en cualquier orden (nombres+apellidos o apellidos+nombres) sin
// borrar palabras sueltas comunes (p. ej. "JUAN" solo).
function ngramasNombre(nombre) {
  const palabras = String(nombre || '').trim().replace(/\s+/g, ' ').split(' ').filter(w => w.length >= 2);
  const out = [];
  for (let len = palabras.length; len >= 2; len--) {
    for (let i = 0; i + len <= palabras.length; i++) out.push(palabras.slice(i, i + len).join(' '));
  }
  return out;
}

function redactarPII(textoOriginal, perfil) {
  let texto = String(textoOriginal || '');
  const conteo = { perfil: 0, tarjetas: 0, nombres: 0, emails: 0, documentos: 0, telefonos: 0, direcciones: 0 };
  perfil = perfil || {};

  // ── Capa A: PERFIL del usuario (replace exacto) ──────────────────────────────
  const valoresExactos = [];
  if (perfil.nombre) ngramasNombre(perfil.nombre).forEach(ng => valoresExactos.push(ng));
  ['direccion', 'documento'].forEach(k => { if (perfil[k]) valoresExactos.push(perfil[k]); });
  if (Array.isArray(perfil.palabras)) perfil.palabras.forEach(w => { if (w && String(w).trim().length >= 3) valoresExactos.push(String(w).trim()); });

  valoresExactos.forEach(v => {
    const pat = patronFlexible(v);
    if (!pat) return;
    // Numérico (documento) → con \b para no partir montos; alfabético → sin \b (pro-privacidad).
    const esNumerico = /^[\d.\- ]+$/.test(v);
    const re = new RegExp((esNumerico ? '\\b' : '') + pat + (esNumerico ? '\\b' : ''), 'gi');
    texto = texto.replace(re, () => { conteo.perfil++; return OCULTO; });
  });

  // Ciudad y departamento: se redactan SOLO cuando ocupan su propia línea (encabezado del
  // extracto), no cuando aparecen dentro del nombre de un comercio (ej. "BELLA PIEL MONTERIA").
  [perfil.ciudad, perfil.departamento].forEach(v => {
    if (!v || !String(v).trim()) return;
    const pat = patronFlexible(v);
    if (!pat) return;
    const re = new RegExp('(^|\\n)([ \\t]*)' + pat + '([ \\t]*)(?=\\n|$)', 'gi');
    texto = texto.replace(re, (m, pre, s1, s2) => { conteo.perfil++; return pre + s1 + OCULTO + s2; });
  });

  // ── Capa B: reglas genéricas por patrón ──────────────────────────────────────

  // 1) TARJETAS (PAN): 13-16 dígitos con separadores espacio/guion (no punto). → ****1234
  texto = texto.replace(/\b(?:\d[ -]?){12,15}\d\b/g, (m) => {
    const dig = m.replace(/\D/g, '');
    if (dig.length < 13 || dig.length > 16) return m;
    conteo.tarjetas++;
    return '****' + dig.slice(-4);
  });

  // 2) NOMBRE del titular etiquetado (Titular / Señor(a) / Cliente / Nombre), misma línea.
  texto = texto.replace(
    /\b(Titular|Se[ñn]or(?:\(a\)|a)?|Cliente|Nombre)[ \t]*:?[ \t]*[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ.'-]+(?:[ \t]+[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ.'-]+){1,4}/g,
    (m, etiqueta) => { conteo.nombres++; return etiqueta + ': ' + OCULTO; }
  );

  // 3) EMAILS
  texto = texto.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => { conteo.emails++; return OCULTO; });

  // 4) NIT con dígito de verificación: 900.123.456-7 (formato inequívoco, no es un monto).
  texto = texto.replace(/\b\d{1,3}(?:\.\d{3}){2,3}-\d\b/g, () => { conteo.documentos++; return OCULTO; });

  // 5) CÉDULA / NIT / DOCUMENTO etiquetados → conserva la etiqueta, oculta el número.
  texto = texto.replace(
    /\b(C\.?[ \t]?C\.?|N\.?[ \t]?I\.?[ \t]?T\.?|C[eé]dula|Documento|Identificaci[oó]n)[ \t]*(?:No\.?|Nro\.?|#|:)?[ \t]*\d[\d.\-]{4,}\d/gi,
    (m, etiqueta) => { conteo.documentos++; return etiqueta + ' ' + OCULTO; }
  );

  // 6) CELULAR colombiano: 10 dígitos que empiezan en 3.
  texto = texto.replace(/(?:\+?57[ -]?)?\b3\d{2}[ -]?\d{3}[ -]?\d{4}\b/g, () => { conteo.telefonos++; return OCULTO; });

  // 7) TELÉFONO etiquetado (Tel / Celular / Móvil / Fax).
  texto = texto.replace(/\b(?:Tel[eé]fono|Tel|Cel(?:ular)?|M[oó]vil|Fax)\.?[ \t]*[:#]?[ \t]*\d[\d.\-() ]{5,}\d/gi,
    () => { conteo.telefonos++; return OCULTO; });

  // 8) DIRECCIONES con etiqueta # / No (Calle 123 # 45-67).
  texto = texto.replace(
    /\b(?:Calle|Cll|Cl|Carrera|Cra|Cr|Kr|Avenida|Av|Autopista|Diagonal|Diag|Dg|Transversal|Transv|Tv|Manzana|Mz)\.?[ \t]*\d+[A-Za-z]?[ \t]*(?:#|No\.?|Nro\.?|N°|-)[ \t]*\d+[A-Za-z]?(?:[ \t]*-[ \t]*\d+[A-Za-z]?)?/gi,
    () => { conteo.direcciones++; return OCULTO; }
  );

  // 8b) DIRECCIÓN abreviada colombiana SIN etiqueta # (ej. "CL 15 3 89W TR 1 AP 101").
  //     Marcador de vía (CL/KR/CR/TR/DG/AV/AC/AK...) + números cortos/sufijos. Se limitan los
  //     números a 1-4 dígitos para no engullir montos (5+ dígitos) que estén en la misma línea.
  texto = texto.replace(
    /\b(?:CL|CLL|CALLE|KR|CR|CRA|CARRERA|TV|TR|TRANSV(?:ERSAL)?|DG|DIAG(?:ONAL)?|AV|AVDA|AVENIDA|AC|AK|DIAG)\b[ \t]*\d{1,4}[A-Z]?(?:[ \t]+(?:[A-Z]{1,4}|\d{1,4}[A-Z]?|#|-)){0,8}/gi,
    () => { conteo.direcciones++; return OCULTO; }
  );

  return { texto, conteo };
}

module.exports = { redactarPII };
