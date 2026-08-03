// backend/routes/ia/extraer.js
//
// Ruta movida VERBATIM desde ia.js. Se registra sobre el MISMO router que crea el archivo padre,
// no sobre un sub-router montado: asi el stack de Express conserva su forma y su ORDEN exactos.
const { extraerTextoPdf } = require('../../services/pdfExtract');
const { redactarPII } = require('../../services/redactPII');
const { construirMovimientos } = require('../../services/movimientos');

module.exports = function(router, ctx) {
  const { db } = ctx;

  // Perfil de datos del titular a ocultar (config key 'pii_perfil'). Permite redactar
  // nombre/ciudad/dirección aunque el banco los imprima en bruto, sin etiquetas.
  function leerPerfilPII() {
    try {
      const row = db.prepare("SELECT value FROM config WHERE key='pii_perfil'").get();
      if (row && row.value) return JSON.parse(row.value);
    } catch (_) { /* perfil ausente o inválido → solo reglas genéricas */ }
    return {};
  }

  // POST /api/ia/extraer
  // Body: { tarjeta_id, ciclo, pdf_base64, password? }
  // Flujo: extraer texto del PDF → redactar PII → armar movimientos del ciclo.
  // NO llama a la IA: devuelve todo para la vista previa y la confirmación del usuario.
  router.post('/extraer', async (req, res) => {
    try {
      const { tarjeta_id, ciclo, pdf_base64, password } = req.body || {};
      if (!tarjeta_id || !ciclo || !pdf_base64) {
        return res.status(400).json({ error: 'Faltan datos: se requieren tarjeta_id, ciclo y pdf_base64.' });
      }

      let buffer;
      try { buffer = Buffer.from(String(pdf_base64), 'base64'); }
      catch (_) { return res.status(400).json({ error: 'El PDF no se pudo decodificar.' }); }
      if (!buffer || buffer.length === 0) return res.status(400).json({ error: 'El PDF llegó vacío.' });

      const ext = await extraerTextoPdf(buffer, password);
      // PDF protegido: pedir contraseña (o avisar que la ingresada es incorrecta).
      if (ext.necesita_password) {
        return res.json({ necesita_password: true, password_incorrecta: !!ext.password_incorrecta });
      }
      // PDF escaneado sin capa de texto: no hay OCR.
      if (ext.sin_texto) {
        return res.json({ sin_texto: true });
      }

      // Ofuscar PII del titular ANTES de devolver nada (la vista previa muestra ya redactado).
      const perfil = leerPerfilPII();
      const perfilConfigurado = !!(perfil && (perfil.nombre || perfil.direccion || perfil.ciudad));
      const { texto, conteo } = redactarPII(ext.texto, perfil);
      const movimientos = construirMovimientos(db, tarjeta_id, ciclo);
      if (movimientos && movimientos.error) return res.status(404).json({ error: movimientos.error });

      return res.json({
        ok: true,
        paginas: ext.paginas || 0,
        texto_redactado: texto,
        redaccion: conteo,
        perfil_configurado: perfilConfigurado,
        movimientos,
        banco_doc: movimientos.banco_doc,
        banco_doc_existe: movimientos.banco_doc_existe
      });
    } catch (err) {
      console.log('[ia/extraer] error:', err && err.message);
      return res.status(500).json({ error: 'No se pudo procesar el PDF: ' + ((err && err.message) || 'error desconocido') });
    }
  });
};
