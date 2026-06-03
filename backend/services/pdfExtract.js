// backend/services/pdfExtract.js
// Extracción de texto de PDFs de extractos bancarios con pdfjs-dist (build legacy CJS,
// corre en Node sin worker). Soporta PDFs protegidos con contraseña y detecta PDFs
// escaneados sin capa de texto (no hay OCR).
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// Colapsa una linea que es N copias consecutivas exactas de un mismo patron de palabras
// (artefacto de PDFs con texto en capas, ej. "Moneda: PESOS Moneda: PESOS Moneda: PESOS").
// Solo actua si TODA la linea es la repeticion: las filas de datos con valores distintos no se tocan.
function colapsarRepeticion(linea) {
  const palabras = String(linea).split(' ');
  const n = palabras.length;
  if (n < 2) return linea;
  for (let period = 1; period <= Math.floor(n / 2); period++) {
    if (n % period !== 0) continue;
    const veces = n / period;
    if (veces < 2) continue;
    const patron = palabras.slice(0, period).join(' ');
    let ok = true;
    for (let k = 1; k < veces && ok; k++) {
      if (palabras.slice(k * period, (k + 1) * period).join(' ') !== patron) ok = false;
    }
    if (ok) return patron;
  }
  return linea;
}

// Reordena los items de texto por coordenadas (Y descendente, luego X ascendente) para
// reconstruir el layout por columnas tipico de un extracto. Sin esto, pdfjs entrega el
// texto en orden de stream (a menudo desordenado entre columnas).
function ordenarPorCoordenadas(items) {
  const conPos = (items || [])
    .filter(it => it && typeof it.str === 'string' && it.str.length > 0)
    .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
  if (!conPos.length) return '';
  // Orden global: primero las lineas mas altas (mayor Y); dentro de cada una, izquierda→derecha.
  conPos.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const TOL = 3; // tolerancia en px para agrupar items en la misma linea visual
  const lineas = [];
  let actual = null;
  conPos.forEach(it => {
    if (!actual || Math.abs(it.y - actual.y) > TOL) {
      actual = { y: it.y, items: [it] };
      lineas.push(actual);
    } else {
      actual.items.push(it);
    }
  });
  return lineas
    .map(l => colapsarRepeticion(l.items.sort((a, b) => a.x - b.x).map(i => i.str).join(' ').replace(/\s{2,}/g, ' ').trim()))
    .filter(Boolean)
    .join('\n');
}

/**
 * Extrae el texto de un PDF.
 * @param {Buffer} buffer  Contenido del PDF.
 * @param {string} [password]  Contraseña de apertura (si el PDF está cifrado).
 * @returns {Promise<object>} Uno de:
 *   { texto, paginas }                          → éxito
 *   { necesita_password, password_incorrecta }  → PDF cifrado / clave errónea
 *   { sin_texto: true }                          → PDF sin capa de texto (escaneado, sin OCR)
 */
async function extraerTextoPdf(buffer, password) {
  const data = new Uint8Array(buffer);
  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data,
      password: password || undefined,
      isEvalSupported: false,
      useSystemFonts: true,
      verbosity: 0
    }).promise;
  } catch (err) {
    const name = err && err.name;
    const code = err && err.code;
    // PasswordException: code 1 = NEED_PASSWORD (falta clave), code 2 = INCORRECT_PASSWORD.
    if (name === 'PasswordException' || code === 1 || code === 2) {
      return { necesita_password: true, password_incorrecta: code === 2 };
    }
    throw err;
  }

  const numPages = doc.numPages;
  let texto = '';
  try {
    for (let p = 1; p <= numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const txtPagina = ordenarPorCoordenadas(content.items);
      if (txtPagina) texto += txtPagina + '\n\n';
    }
  } finally {
    try { await doc.destroy(); } catch (_) { /* noop */ }
  }

  const limpio = texto.trim();
  if (!limpio) return { sin_texto: true };
  return { texto: limpio, paginas: numPages };
}

module.exports = { extraerTextoPdf, ordenarPorCoordenadas, colapsarRepeticion };
