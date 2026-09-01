// public/js/iconos.js — Catalogo de iconos SVG y el componente que los pinta.
//
// Convencion del proyecto: la UI no usa emojis, solo estos SVG en viewBox 24x24.


// ── SVG Icon component (same style as Proyecto_PTM) ──
const ICONS = {
  home:       'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10',
  'credit-card': 'M21 4H3a2 2 0 00-2 2v12a2 2 0 002 2h18a2 2 0 002-2V6a2 2 0 00-2-2z M1 10h22',
  activity:   'M22 12h-4l-3 9L9 3l-3 9H2',
  settings:   'M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z M12 15a3 3 0 100-6 3 3 0 000 6z',
  plus:       'M12 5v14 M5 12h14',
  menu:       'M3 12h18 M3 6h18 M3 18h18',
  sun:        'M12 17a5 5 0 100-10 5 5 0 000 10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42',
  moon:       'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z',
  users:      'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75',
  trending:   'M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6',
  'bar-chart': 'M12 20V10 M18 20V4 M6 20v-4',
  check:      'M20 6L9 17l-5-5',
  cart:       'M9 22a1 1 0 100-2 1 1 0 000 2z M20 22a1 1 0 100-2 1 1 0 000 2z M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6',
  dollar:     'M12 1v22 M17 5H9.5a3.5 3.5 0 100 7h5a3.5 3.5 0 010 7H6',
  calendar:   'M19 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2z M16 2v4 M8 2v4 M3 10h18',
  clipboard:  'M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2 M15 2H9a1 1 0 00-1 1v2a1 1 0 001 1h6a1 1 0 001-1V3a1 1 0 00-1-1z',
  edit:       'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7 M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  trash:      'M3 6h18 M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2',
  globe:      'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M2 12h20 M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z',
  alert:      'M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
  save:       'M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z M17 21v-8H7v8 M7 3v5h8',
  download:   'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  folder:     'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z',
  refresh:    'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0020.49 15',
  ban:        'M12 21a9 9 0 100-18 9 9 0 000 18z M5.64 5.64l12.72 12.72',
  undo:       'M3 7v6h6 M21 17a9 9 0 00-9-9 9 9 0 00-6.69 3L3 13',
  calculator: 'M4 2h16a2 2 0 012 2v16a2 2 0 01-2 2H4a2 2 0 01-2-2V4a2 2 0 012-2z M8 8h8v3H8z M8 14h2v2H8z M12 14h2v2h-2z M16 14h2v2h-2z M8 18h2v2H8z M12 18h2v2h-2z M16 18h2v2h-2z',
  bulb:       'M9 18h6 M10 22h4 M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8a6 6 0 00-12 0c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 018.91 14',
  'chevron-right': 'M9 18l6-6-6-6',
  'chevron-down':  'M6 9l6 6 6-6',
  'chevron-up':    'M18 15l-6-6-6 6',
  sparkles:   'M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z M19 14l.8 2.2 2.2.8-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z M6 4l.6 1.7L8 6.3l-1.4.6L6 8.5l-.6-1.6L4 6.3l1.4-.6z',
};
function Ico({ name, size = 18, sw = 1.8, color = 'currentColor', style, className }) {
  const d = ICONS[name]; if (!d) return null;
  const paths = d.split(' M ');
  const pathEls = paths.map((p, i) => e('path', { key: i, d: i === 0 ? p : 'M ' + p }));
  return e('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round', style, className }, pathEls);
}
