'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['state', 'activate', 'rename', 'remove', 'login', 'cancelLogin', 'install', 'detect',
  'refreshUsage', 'refreshAll', 'localUsage', 'openExternal', 'openFolder', 'exportVault', 'importPick', 'importApply',
  'updateState', 'checkUpdate', 'installUpdate'];

contextBridge.exposeInMainWorld('api', {
  call: (ch, ...args) => {
    if (!CHANNELS.includes(ch)) throw new Error(`canal inválido: ${ch}`);
    return ipcRenderer.invoke(ch, ...args);
  },
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onUpdate: (fn) => ipcRenderer.on('update', (_e, s) => fn(s)),
});
