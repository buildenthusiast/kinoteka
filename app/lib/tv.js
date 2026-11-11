'use strict';
// Български телевизии с официално безплатно излъчване онлайн.
// Пускат се само от сайтовете/плейърите на самите телевизии (в отделен прозорец),
// без прихващане на потоци и без чужди източници.
//   page  — официалната страница „На живо“ на телевизията
//   embed — официалният плейър, който самата страница вгражда (по-чист изглед)
const BUILTIN = [
  { id: 'bnt1', name: 'БНТ 1', group: 'БНТ', desc: 'Основният канал на Българската национална телевизия', color: '#c8102e',
    page: 'https://tv.bnt.bg/bnt1/', embed: 'https://i.cdn.bg/live/4eViE8vGzI' },
  { id: 'bnt2', name: 'БНТ 2', group: 'БНТ', desc: 'Култура, регионите и класика', color: '#1f6fb2',
    page: 'https://tv.bnt.bg/bnt2/', embed: 'https://i.cdn.bg/live/ZBPbdxDHm7' },
  { id: 'bnt3', name: 'БНТ 3', group: 'БНТ', desc: 'Спорт', color: '#1d8a4e',
    page: 'https://tv.bnt.bg/bnt3/', embed: 'https://i.cdn.bg/live/OQ70Ds9Lcp' },
  { id: 'bnt4', name: 'БНТ 4', group: 'БНТ', desc: 'За българите по света', color: '#7a3fb0',
    page: 'https://tv.bnt.bg/bnt4/', embed: 'https://i.cdn.bg/live/ls4wHAbTmY' }
];

const httpsOnly = (u) => { try { const x = new URL(String(u).trim()); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };

function list(custom = []) {
  return [...BUILTIN.map(c => ({ ...c, builtin: true })),
    ...custom.filter(c => c && httpsOnly(c.page)).map(c => ({ id: c.id, name: c.name, group: 'Мои', desc: new URL(c.page).hostname, color: '#3a4157', page: c.page }))];
}

// CSS само за вградения плейър — да запълва прозореца
const EMBED_CSS = 'html,body{margin:0!important;padding:0!important;background:#000!important;width:100%!important;height:100%!important;overflow:hidden!important}' +
  'video{width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important}';

module.exports = { BUILTIN, list, httpsOnly, EMBED_CSS };
