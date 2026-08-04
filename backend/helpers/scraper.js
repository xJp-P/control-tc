// backend/helpers/scraper.js — Web scraping and PDF text extraction for interest rates

// ─── PDF text extraction ───────────────────────────────────────────
// La lectura del PDF la hace pdfjs, el MISMO motor con que la app lee los extractos bancarios.
// Antes vivia aqui un extractor propio (~120 lineas: inflate de los streams, mapa de glifos y
// operadores BT/ET interpretados a mano) que convivia con pdfjs sin saberlo, y NO era equivalente:
// sobre el tarifario de Bancolombia devolvia caracteres de control y CERO porcentajes, y sobre el
// PDF mensual de RappiCard se dejaba 4 de las 12 cifras y entregaba el documento en orden de
// stream, empezando por la tabla de cashback del final en vez del encabezado de tasas. Ese orden
// importa: el parser de abajo decide que porcentaje va con que etiqueta por la POSICION del texto,
// asi que un documento desordenado no solo pierde cifras, puede emparejarlas mal. pdfjs reconstruye
// el orden de lectura por coordenadas.
const { extraerTextoPdf } = require('../services/pdfExtract');

// Devuelve el texto del PDF, o cadena VACIA si no se puede leer. Devolver '' y no basura es lo que
// permite que el flujo caiga al texto del HTML (mas abajo): un texto ilegible pero no vacio pasaba
// ese fallback de largo y se parseaba igual. El motivo se dice en consola — un PDF cifrado o
// escaneado que falla en silencio reaparece aguas abajo como "no se encontraron tasas en la
// pagina", que manda a depurar el parser cuando lo que fallo fue la lectura.
async function textoDePdf(buffer, origen) {
  try {
    const r = await extraerTextoPdf(buffer);
    if (r && r.texto) return r.texto;
    const motivo = r && r.necesita_password ? 'esta protegido con contrasena'
      : r && r.sin_texto ? 'no tiene capa de texto (escaneado, sin OCR)'
      : 'no devolvio texto';
    console.log('[Tasas] El PDF ' + motivo + ': ' + origen);
    return '';
  } catch (err) {
    console.log('[Tasas] No se pudo leer el PDF (' + (err && err.message) + '): ' + origen);
    return '';
  }
}

// ─── Web scraping for interest rates ──────────────────────────────
// Muro de bot (Imperva Incapsula, antes Distil). Devuelve HTTP **200** con una pagina de 6 kB, no un
// 4xx, asi que sin esta deteccion el flujo lo tomaba por exito: no encontraba porcentajes y decia
// "no se encontraron tasas en la pagina", mandando al usuario a buscar un problema de lectura cuando
// lo que paso es que no le dejaron entrar. Se mira el CUERPO, nunca la cabecera `x-iinfo`: Imperva la
// pone en TODAS las respuestas que proxea, tambien en las buenas, y usarla da falsos positivos
// (medido: grupobancolombia.com responde 122 kB de pagina real con esa cabecera puesta).
function detectarMuroBot(texto) {
  if (!texto || texto.length > 60000) return null;
  if (/Pardon Our Interruption/i.test(texto)) return 'imperva';
  if (/reeseSkipExpirationCheck|_Incapsula_Resource|\/_Incapsula_/i.test(texto)) return 'imperva';
  if (/Checking your browser before accessing|cf-browser-verification|__cf_chl_/i.test(texto)) return 'cloudflare';
  return null;
}

async function scrapeTasas(url) {
  try {
    // `Accept: */*` y no la cabecera de navegador que habia antes. Dos razones, y la primera basta:
    // al pedir un PDF, anunciar "quiero HTML" es sencillamente incorrecto — asi se descargaba el
    // tarifario mensual de tasas de Bancolombia. Ademas, medido en ago-2026, la regla de Imperva del
    // banco se dispara justo con esa cabecera de HTML: con ella devuelve el interstitial de 6 kB y
    // con `*/*` entrega la pagina completa de 270 kB. Es una cabecera estandar y honesta (la que
    // manda curl por defecto), no un disfraz: no se tocan cookies, huellas ni retos de JavaScript.
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8'
    };

    const response = await fetch(url, { headers });
    const contentType = response.headers.get('content-type') || '';

    let text = '';

    if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      text = await textoDePdf(buffer, url);
    } else {
      const html = await response.text();

      // Si lo que llego es el muro, se corta AQUI y se dice. Seguir parseando solo produce el
      // "no se encontraron tasas" que enmascara la verdadera causa.
      const muro = detectarMuroBot(html);
      if (muro) {
        return { ok: true, found: false, bloqueado: true, proteccion: muro, rates: null,
          error: 'La pagina respondio con una verificacion antibot en vez del contenido. Abrela en el navegador y copia la tasa a mano.' };
      }

      const pdfRegex = /(?:href|src)=["']([^"']*\.pdf[^"']*)["']/gi;
      const pdfLinks = [];
      let pdfM;
      while ((pdfM = pdfRegex.exec(html)) !== null) pdfLinks.push(pdfM[1]);
      const pdfUrlRegex = /(https?:\/\/[^\s"'<>]*\.pdf)/gi;
      while ((pdfM = pdfUrlRegex.exec(html)) !== null) {
        if (!pdfLinks.includes(pdfM[1])) pdfLinks.push(pdfM[1]);
      }
      const tasaPdf = pdfLinks.find(l => /tasa|tarifa/i.test(l));
      if (tasaPdf) {
        let pdfUrl = tasaPdf;
        if (pdfUrl.startsWith('/')) {
          const urlObj = new URL(url);
          pdfUrl = urlObj.origin + pdfUrl;
        } else if (!pdfUrl.startsWith('http')) {
          pdfUrl = url.replace(/\/[^\/]*$/, '/') + pdfUrl;
        }
        try {
          const pdfResp = await fetch(pdfUrl, { headers });
          if (pdfResp.ok) {
            const buffer = Buffer.from(await pdfResp.arrayBuffer());
            text = await textoDePdf(buffer, pdfUrl);
          }
        } catch (e) { /* fallback to HTML */ }
      }

      if (!text) {
        text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
      }
    }

    const rates = { compras_mv: null, compras_ea: null, avances_mv: null, avances_ea: null };
    const percentPattern = /(\d{1,2}[,\.]\d{2,4})\s*%/g;
    const allPercents = [];
    let match;
    while ((match = percentPattern.exec(text)) !== null) {
      const val = parseFloat(match[1].replace(',', '.'));
      const pos = match.index;
      allPercents.push({ val, pos, raw: match[0] });
    }

    function eaToMv(ea) { return (Math.pow(1 + ea / 100, 1 / 12) - 1) * 100; }

    const textLow = text.toLowerCase();
    const comprasIdx = textLow.search(/compras\s+(con\s+)?tarjeta|para compras|compras y pago/);
    const avancesIdx = textLow.search(/avances\s+(con\s+)?tarjeta|para avances|avances nacionales/);

    if (comprasIdx >= 0 && allPercents.length > 0) {
      const comprasPercents = allPercents.filter(p => p.pos > comprasIdx && (avancesIdx < 0 || p.pos < avancesIdx));
      const mv = comprasPercents.find(p => p.val < 5);
      const ea = comprasPercents.find(p => p.val >= 5);
      if (mv) rates.compras_mv = mv.val;
      if (ea) { rates.compras_ea = ea.val; if (!rates.compras_mv) rates.compras_mv = parseFloat(eaToMv(ea.val).toFixed(4)); }
    }

    if (avancesIdx >= 0 && allPercents.length > 0) {
      const avancesPercents = allPercents.filter(p => p.pos > avancesIdx);
      const mv = avancesPercents.find(p => p.val < 5);
      const ea = avancesPercents.find(p => p.val >= 5);
      if (mv) rates.avances_mv = mv.val;
      if (ea) { rates.avances_ea = ea.val; if (!rates.avances_mv) rates.avances_mv = parseFloat(eaToMv(ea.val).toFixed(4)); }
    }

    if (!rates.compras_mv && !rates.avances_mv && allPercents.length > 0) {
      const mvIdx = textLow.search(/mensual\s*vencido|m\.?\s*v\.?/);
      if (mvIdx >= 0) {
        const nearby = allPercents.filter(p => Math.abs(p.pos - mvIdx) < 300 && p.val < 5);
        if (nearby.length > 0) {
          rates.compras_mv = nearby[0].val;
          rates.avances_mv = nearby[0].val;
        }
      }
      if (!rates.compras_mv) {
        const mensualIdx = textLow.search(/mensual/);
        if (mensualIdx >= 0) {
          const nearby = allPercents.filter(p => Math.abs(p.pos - mensualIdx) < 200 && p.val < 5);
          if (nearby.length > 0) {
            rates.compras_mv = nearby[0].val;
            rates.avances_mv = nearby[0].val;
          }
        }
      }
    }

    if (!rates.compras_mv && !rates.avances_mv && allPercents.length > 0) {
      const eaIdx = textLow.search(/efectivo\s*anual|e\.?\s*a\.?\s/);
      if (eaIdx >= 0) {
        const nearby = allPercents.filter(p => Math.abs(p.pos - eaIdx) < 200 && p.val >= 10);
        if (nearby.length > 0) {
          const ea = nearby[0].val;
          const mv = parseFloat(eaToMv(ea).toFixed(4));
          rates.compras_ea = ea;
          rates.avances_ea = ea;
          rates.compras_mv = mv;
          rates.avances_mv = mv;
        }
      }
    }

    const found = rates.compras_mv || rates.avances_mv;

    if (!found && url.includes('superfinanciera.gov.co')) {
      try {
        const now = new Date();
        const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
        const mes = meses[now.getMonth()];
        const anio = now.getFullYear();
        const altUrls = [
          `https://www.elespectador.com/economia/finanzas-personales/estos-son-los-topes-para-la-tasa-de-usura-y-el-interes-bancario-en-${mes}-de-${anio}/`,
          `https://www.eltiempo.com/economia/finanzas-personales/tasa-de-usura-para-${mes}-de-${anio}`
        ];
        for (const altUrl of altUrls) {
          try {
            const altResp = await fetch(altUrl, { headers });
            if (!altResp.ok) continue;
            const altHtml = await altResp.text();
            const altText = altHtml.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
            const usuraMatch = altText.match(/usura.*?consumo.*?(\d{1,2}[,\.]\d{1,2})\s*%/i)
              || altText.match(/consumo.*?ordinario.*?usura.*?(\d{1,2}[,\.]\d{1,2})\s*%/i)
              || altText.match(/tasa de usura.*?(\d{1,2}[,\.]\d{1,2})\s*%/i);
            if (usuraMatch) {
              const ea = parseFloat(usuraMatch[1].replace(',', '.'));
              if (ea >= 10 && ea <= 50) {
                const mv = parseFloat(eaToMv(ea).toFixed(4));
                rates.compras_ea = ea;
                rates.avances_ea = ea;
                rates.compras_mv = mv;
                rates.avances_mv = mv;
                return { ok: true, found: true, rates, source: 'Tasa de usura ' + mes + ' ' + anio + ': ' + ea + '% EA', raw_percents: [usuraMatch[0]] };
              }
            }
          } catch (e) { continue; }
        }
      } catch (e) { /* fallback to not found */ }
    }

    return { ok: true, found: !!found, rates, raw_percents: allPercents.map(p => p.raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { scrapeTasas, detectarMuroBot };
