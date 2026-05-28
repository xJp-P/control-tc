# Control TC

App de escritorio para gestión personal de tarjetas de crédito. Soporta múltiples bancos con motores de cálculo diferenciados, extractos mensuales, amortización de avances y diferidas, bolsillo, deudas de terceros y actualizaciones automáticas desde GitHub Releases.

---

## Bancos Soportados

| Banco                  | Franquicia        | Compras                             | Intereses INTL en COP                                  | Diferidas             | Extracto                | Tasas automáticas |
|------------------------|-------------------|-------------------------------------|--------------------------------------------------------|-----------------------|-------------------------|-------------------|
| Bancolombia            | Visa              | 1-de-1 sin intereses corrientes     | **Sí** — flag `es_internacional` cobra interés mensual | Configurable por tarjeta: difiere cuota 1→2, o cobra desde cuota 1 | COP único               | Web scraping      |
| Bancolombia            | Mastercard, Amex  | 1-de-1 sin intereses corrientes     | N/A — extracto dual separa USD                          | Igual que Visa Bancolombia | Dual COP/USD            | Web scraping      |
| Nu Colombia            | Mastercard        | 1-de-1 sin intereses corrientes     | No aplicado (sin extracto reconciliado)                 | Cuota 1 sin intereses | COP único               | PDF oficial       |
| RappiCard (Davivienda) | Visa              | 1-de-1 COP sin intereses corrientes | No aplicado (sin extracto reconciliado)                 | Interés desde cuota 1 | COP único               | PDF               |

> **Nota intereses internacionales (INTL):** la lógica de cobro de intereses sobre compras intl pagadas en COP (procesadores como Apple, Rappi, MercadoPago) está validada únicamente con extracto real de **Bancolombia Visa**. Para otras franquicias o bancos se omite hasta tener evidencia de extracto.

---

## Funcionalidades

- **Multi-banco y multi-tarjeta** — motor de cálculo diferenciado por banco y franquicia, tasas MV independientes por tarjeta
- **Bimonetario (COP/USD)** — deuda nativa en dólares para Mastercard/Amex Bancolombia (extracto dual: saldar la porción COP y la USD por separado), bolsillo en USD, y TRM diaria automática del Banco de la República (datos.gov.co) como tasa por defecto y para estimar el cupo usado en COP
- **Compras** — COP y USD, bolsillo (total o parcial), dividir entre personas; flag `Compra internacional` para procesadores intl que cobran en COP (Apple, Rappi, MercadoPago); registro USD opcional. Una compra dividida puede convertirse de vuelta a **100% personal** (fusiona las partes; protege el dinero ya reembolsado por terceros con doble confirmación)
- **Intereses internacionales (INTL)** — cálculo automático de intereses corrientes sobre compras marcadas como `es_internacional` en tarjetas que aplican (hoy: Bancolombia Visa). Desglose en cards "Deuda Personal" (porción propia) y "Me Deben Corte" (porción de terceros). En compras divididas, cada parte recibe su porción proporcional del interés
- **Avances** — tabla de amortización completa, abonos a capital con redistribución cronológica; modelo "saldo facturado" para Bancolombia
- **Diferidas** — amortización a X cuotas con badge de progreso (1/3, 2/3…), diferidas divididas, bolsillo per-cuota (cada cuota guarda monto apartado independiente)
- **Extractos** — auto-generados mensualmente, pago mínimo y total calculados, historial de pagos. Los intereses internacionales se persisten al cerrar el extracto y permanecen fieles aunque cambien las compras o tasas después
- **Dashboard** — cupo total con barra de progreso, deuda vs disponible, desglose por tarjeta, intereses del mes con detalle "Int Intl", me deben (vista global y por tarjeta)
- **Terceros** — tracking de deudas por persona, abonos parciales, intl interest atribuido al tercero correspondiente
- **Proyecciones** — pagos futuros a N meses
- **Sistema** — tema claro/oscuro, backup y restauración de BD, mover BD a ubicación personalizada (iCloud, OneDrive…), changelog en-app, historial de acciones
- **Boot protegido** — al abrir, una pantalla de carga busca actualizaciones (hasta 60s) **antes** de conectar la base de datos; si hay una nueva versión se instala primero, protegiendo tus datos de bugs en código viejo. Maneja sin-internet (vista offline con Continuar/Cerrar) y errores de descarga (cerrar o continuar bajo tu riesgo)

---

## Nota para usuarios de Mac

Al abrir la app por primera vez, macOS puede mostrar un mensaje diciendo que la app **"está dañada y no puede abrirse"**. Esto ocurre porque la app no tiene un certificado de Apple Developer (que cuesta $99/año), pero la app es completamente segura.

**Para solucionarlo, sigue estos pasos:**

1. **No** hagas clic en "Mover al basurero" — dale a **Cancelar**
2. Abre la app **Terminal** (puedes buscarla en Spotlight con `Cmd + Espacio` y escribir "Terminal")
3. Copia y pega el siguiente comando en la Terminal y presiona **Enter**:

```
xattr -cr /Applications/Control\ TC.app
```

4. Cierra la Terminal
5. Abre la app normalmente — ahora debería funcionar sin problemas

> Este paso solo es necesario **la primera vez** que instalas la app. Las actualizaciones posteriores no requieren repetirlo.

---

## Base de Datos

El esquema SQLite se crea y migra automáticamente al iniciar la app. La BD **no** está en el repositorio — cada usuario gestiona sus propios backups.

Ruta por defecto: `%APPDATA%\CreditCardManager\data.db` (Windows). La ubicación real se resuelve vía `db_location.json` en esa carpeta y puede apuntarse a un destino personalizado (Desktop, iCloud, OneDrive, etc.) desde la app.

---

## Estructura del Proyecto

```
├── desktop/
│   ├── main.js          # Proceso principal Electron: ventana, IPC handlers, auto-updater
│   └── preload.js       # Bridge seguro Electron ↔ frontend (contextBridge)
├── backend/
│   ├── app.js           # Factory createApp: monta Express y todas las rutas
│   ├── config/
│   │   └── db.js        # Paths de BD, initDb (schema + migraciones + syncData)
│   ├── engine/
│   │   └── amortizacion.js  # Motores de cálculo: avances y diferidas (funciones puras)
│   ├── helpers/
│   │   ├── dates.js     # Utilidades de fecha: hoyLocal, addMonths, daysBetween
│   │   ├── banco.js     # Detección banco/franquicia: esNuBank, nuOpts, isDualExtracto, aplicaIntInternacional
│   │   ├── scraper.js   # Web scraping y extracción de texto PDF para tasas
│   │   └── log.js       # Factory de logAction y tjNombre (requiere DB)
│   └── routes/
│       ├── config.js        # GET/PUT /api/config
│       ├── tarjetas.js      # CRUD /api/tarjetas + actualizar-tasas
│       ├── personas.js      # CRUD /api/personas
│       ├── compras.js       # CRUD /api/compras + bolsillo
│       ├── avances.js       # CRUD /api/avances + abonos
│       ├── abonos.js        # PUT/DELETE /api/abonos/:id
│       ├── diferidas.js     # CRUD /api/diferidas
│       ├── pagos.js         # CRUD /api/pagos (con lógica de reversión)
│       ├── extractos.js     # /api/extractos + pagar (incluye helper calcExtracto)
│       ├── abonoCapital.js  # /api/abono-capital (preview + apply)
│       ├── terceros.js      # /api/terceros (toggle + abonar)
│       ├── dashboard.js     # /api/dashboard
│       ├── proyecciones.js  # /api/proyecciones
│       └── misc.js          # /api/backup, /api/log, /api/sync, /api/scrape-tasas
├── public/
│   └── index.html       # UI completa en React 18 UMD (un solo archivo)
├── build/
│   ├── icon.ico         # Icono Windows
│   └── icon.png         # Icono general (Mac y otros)
└── .github/
    └── workflows/
        └── build.yml    # CI/CD: compila y publica releases en GitHub
```

---

## Desarrollo Local

```bash
# Instalar dependencias (una sola vez)
npm install

# Ejecutar en desarrollo
npm start          # Electron completo
npm run dev        # Electron con DevTools abiertos
npm run server     # Solo el backend Express (para depurar sin Electron)
```

> Los instaladores **no** se crean localmente. Se lanzan desde **GitHub Actions → Build Instaladores → Run workflow**. El workflow compila para Windows (NSIS) y Mac (DMG + ZIP) y publica el release automáticamente.

---

## Stack Tecnológico

| Componente     | Tecnología                                                        |
|----------------|-------------------------------------------------------------------|
| Escritorio     | Electron 33                                                       |
| Backend        | Express 4 (local en `127.0.0.1:3500`)                            |
| Base de datos  | SQLite via `better-sqlite3`                                       |
| Frontend       | React 18 UMD (sin build step, todo en `public/index.html`)       |
| Instalador Win | NSIS (electron-builder)                                           |
| Instalador Mac | DMG + ZIP (electron-builder)                                      |
| Auto-update    | electron-updater + GitHub Releases                                |
| CI/CD          | GitHub Actions (`.github/workflows/build.yml`)                    |
