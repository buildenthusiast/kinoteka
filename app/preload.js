const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('api', {
  getLibrary: inv('library:get'),
  addFolder: inv('library:addFolder'),
  removeFolder: inv('library:removeFolder'),
  rescan: inv('library:rescan'),
  setSettings: inv('settings:set'),
  setProgress: inv('progress:set'),
  open: inv('media:open'),
  subs: inv('media:subs'),
  loadSubFile: inv('media:loadSubFile'),
  stop: inv('media:stop'),
  intro: inv('intro:get'),
  addStats: inv('stats:add'),
  searchSubs: inv('subs:search'),
  downloadSubs: inv('subs:download'),
  showFile: inv('shell:showFile'),
  openExternal: inv('shell:openExternal'),
  fullscreen: inv('win:fullscreen'),
  restart: inv('app:restart'),
  version: inv('app:version'),
  checkUpdate: inv('app:checkUpdate'),
  on: (ch, fn) => { const h = (_e, p) => fn(p); ipcRenderer.on(ch, h); return () => ipcRenderer.off(ch, h); }
});
