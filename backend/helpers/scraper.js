// backend/helpers/scraper.js — Web scraping and PDF text extraction for interest rates

// ─── PDF text extraction ───────────────────────────────────────────

function codeUnitsToCodePoints(units) {
  const pts = [];
  for (let i = 0; i < units.length; i++) {
    if (units[i] >= 0xD800 && units[i] <= 0xDBFF && i + 1 < units.length && units[i+1] >= 0xDC00 && units[i+1] <= 0xDFFF) {
      pts.push(0x10000 + (units[i] - 0xD800) * 0x400 + (units[i+1] - 0xDC00)); i++;
    } else { pts.push(units[i]); }
  }
  return pts;
}

function decodeHexGlyphs(hex, glyphMap) {
  if (!glyphMap || glyphMap.size === 0) {
    let result = '';
    for (let i = 0; i + 3 < hex.length; i += 4) result += String.fromCharCode(parseInt(hex.substring(i, i + 4), 16));
    return result;
  }
  const sampleKey = glyphMap.keys().next().value;
  const step = sampleKey ? sampleKey.length : 4;
  let result = '';
  for (let i = 0; i + step - 1 < hex.length; i += step) {
    const gid = hex.substring(i, i + step).toUpperCase();
    result += glyphMap.get(gid) || '';
  }
  return result;
}

function extractTextOps(block, texts, glyphMap) {
  const btPattern = /BT([\s\S]*?)ET/g;
  let bm;
  while ((bm = btPattern.exec(block)) !== null) {
    const btBlock = bm[1];
    const allOps = [];
    const opPattern = /\(([^)]*)\)\s*Tj|<([0-9A-Fa-f]+)>\s*Tj|\[([^\]]*)\]\s*TJ/g;
    let tm;
    while ((tm = opPattern.exec(btBlock)) !== null) {
      if (tm[1] !== undefined) {
        allOps.push({ type: 'literal', text: tm[1] });
      } else if (tm[2] !== undefined) {
        allOps.push({ type: 'hex', text: decodeHexGlyphs(tm[2], glyphMap) });
      } else if (tm[3] !== undefined) {
        const arr = tm[3];
        const parts = arr.match(/\(([^)]*)\)/g);
        const hexParts = arr.match(/<([0-9A-Fa-f]+)>/g);
        if (parts) allOps.push({ type: 'literal', text: parts.map(p => p.slice(1, -1)).join('') });
        else if (hexParts) allOps.push({ type: 'hex', text: hexParts.map(h => decodeHexGlyphs(h.slice(1, -1), glyphMap)).join('') });
      }
    }
    let btText = '';
    for (const op of allOps) {
      if (op.type === 'hex') {
        btText += op.text;
      } else {
        if (btText) btText += ' ';
        btText += op.text;
      }
    }
    if (btText) texts.push(btText);
  }
}

function extractTextFromPDF(buffer) {
  const zlib = require('zlib');
  const str = buffer.toString('binary');
  const texts = [];

  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  const decodedStreams = [];
  let m;
  while ((m = streamRegex.exec(str)) !== null) {
    let block = m[1];
    if (block.endsWith('\r\n')) block = block.slice(0, -2);
    else if (block.endsWith('\n')) block = block.slice(0, -1);
    try {
      const buf = Buffer.from(block, 'binary');
      decodedStreams.push(zlib.inflateSync(buf).toString('latin1'));
    } catch (e) {
      decodedStreams.push(block);
    }
  }

  const glyphMap = new Map();
  for (const dec of decodedStreams) {
    if (dec.includes('beginbfchar') || dec.includes('beginbfrange')) {
      const charBlocks = dec.match(/beginbfchar[\s\S]*?endbfchar/g) || [];
      for (const cb of charBlocks) {
        const pairs = cb.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || [];
        for (const p of pairs) {
          const pm = p.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
          if (pm) {
            const src = pm[1].toUpperCase();
            const dstHex = pm[2];
            const codes = [];
            for (let i = 0; i < dstHex.length; i += 4) codes.push(parseInt(dstHex.substring(i, i + 4), 16));
            glyphMap.set(src, String.fromCodePoint(...codeUnitsToCodePoints(codes)));
          }
        }
      }
      const rangeBlocks = dec.match(/beginbfrange[\s\S]*?endbfrange/g) || [];
      for (const rb of rangeBlocks) {
        const ranges = rb.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || [];
        for (const r of ranges) {
          const rm = r.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
          if (rm) {
            const start = parseInt(rm[1], 16), end = parseInt(rm[2], 16);
            let dstCode = parseInt(rm[3], 16);
            const padLen = rm[1].length;
            for (let code = start; code <= end; code++) {
              glyphMap.set(code.toString(16).toUpperCase().padStart(padLen, '0'), String.fromCharCode(dstCode++));
            }
          }
        }
      }
    }
  }

  for (const dec of decodedStreams) {
    if (dec.includes('Tj') || dec.includes('TJ') || dec.includes('BT')) {
      extractTextOps(dec, texts, glyphMap);
    }
  }
  return texts.join(' ').replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))).replace(/\s+/g, ' ');
}

// ─── Web scraping for interest rates ──────────────────────────────
async function scrapeTasas(url) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8'
    };

    const response = await fetch(url, { headers });
    const contentType = response.headers.get('content-type') || '';

    let text = '';

    if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      text = extractTextFromPDF(buffer);
    } else {
      const html = await response.text();

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
            text = extractTextFromPDF(buffer);
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

module.exports = { scrapeTasas, extractTextFromPDF };
