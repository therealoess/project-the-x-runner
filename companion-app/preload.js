// Project THE X Runner — preload bridge.
//
// Exposes a minimal, locked-down API to the renderer so the UI never
// touches Node directly. Every method is a single IPC call that the
// main process implements. Renderer can't access fs / spawn / require.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('THEX', {
  getState:            ()        => ipcRenderer.invoke('get_state'),
  pair:                (args)    => ipcRenderer.invoke('pair', args),
  unpair:              ()        => ipcRenderer.invoke('unpair'),
  start:               ()        => ipcRenderer.invoke('start'),
  stop:                ()        => ipcRenderer.invoke('stop'),
  quit:                ()        => ipcRenderer.invoke('quit'),
  openExternal:        (url)     => ipcRenderer.invoke('open_external', url),
  toggleOpenAtLogin:   (on)      => ipcRenderer.invoke('toggle_open_at_login', on),
  applyUpdate:         ()        => ipcRenderer.invoke('apply_update'),

  // Push events from main → renderer.
  onRunnerState: (cb) => ipcRenderer.on('runner_state', (_e, p) => cb(p)),
  onLog:         (cb) => ipcRenderer.on('log',          (_e, p) => cb(p)),
  onStats:       (cb) => ipcRenderer.on('stats',        (_e, p) => cb(p))
});
