/**
 * remote-entry.ts — Electron entry point for Mac when the heavy lifting runs
 * on a remote VM server.
 *
 * Usage (Mac):
 *   MUNDER_REMOTE=ws://vm-ip:3456 electron out/main/remote-entry.js
 *   — or —
 *   MUNDER_REMOTE=ws://vm-ip:3456 npm run dev:remote
 *
 * This file:
 *   1. Creates the BrowserWindow (window lives on Mac — display, menus, etc.)
 *   2. Connects to the VM WebSocket server
 *   3. Registers every IPC channel as a proxy: renderer → WS → server → renderer
 *   4. Forwards server-pushed events → renderer (PTY data, hive events, etc.)
 *
 * No local hive, no local PTY manager, no local config writes — all of that
 * happens on the VM.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import WebSocket from 'ws';

// ─── Connection ──────────────────────────────────────────────────────────────
const REMOTE_URL = process.env.MUNDER_REMOTE ?? 'ws://localhost:3456';
let ws: WebSocket | null = null;
let mainWindow: BrowserWindow | null = null;

/** Pending invoke callbacks, keyed by message id. */
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let msgSeq = 0;

function send(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Send an invoke to the server and await its result. */
function invoke(channel: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `${++msgSeq}`;
    pending.set(id, { resolve, reject });
    send({ type: 'invoke', id, channel, args });
    // 30 s timeout per call
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`invoke timeout: ${channel}`));
      }
    }, 30_000);
  });
}

function connectWS() {
  console.log(`[remote] connecting to ${REMOTE_URL}`);
  ws = new WebSocket(REMOTE_URL);

  ws.on('open', () => {
    console.log('[remote] connected to server');
    mainWindow?.webContents.send('remote:connected', { url: REMOTE_URL });
  });

  ws.on('message', (raw) => {
    let msg: { type: string; id?: string; result?: unknown; error?: string; channel?: string; data?: unknown };
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    if (msg.type === 'result' && msg.id) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg.result); }
    } else if (msg.type === 'error' && msg.id) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.reject(new Error(msg.error ?? 'server error')); }
    } else if (msg.type === 'event' && msg.channel) {
      // Forward push events from server to the renderer
      mainWindow?.webContents.send(msg.channel, msg.data);
    }
  });

  ws.on('close', () => {
    console.log('[remote] disconnected — reconnecting in 3 s');
    mainWindow?.webContents.send('remote:disconnected', {});
    ws = null;
    setTimeout(connectWS, 3_000);
  });

  ws.on('error', (e) => console.error('[remote] ws error:', e.message));
}

// ─── IPC proxy ───────────────────────────────────────────────────────────────
/**
 * Every channel the renderer can invoke via window.cth is registered here as a
 * WS proxy. Unknown channels return a graceful stub so the renderer never hangs.
 *
 * Pattern: channels ending in :start/:stop/:status/:setConfig are always proxied.
 * PTY channels proxy with the id from args for the push-event subscription.
 */
const PROXY_CHANNELS: string[] = [
  // App
  'app:info', 'app:copyToClipboard', 'app:readClipboard', 'app:openExternal',
  // Config
  'config:get', 'config:update', 'config:ensureHome', 'config:changeHome',
  // PTY
  'pty:spawn', 'pty:write', 'pty:resize', 'pty:kill', 'pty:list', 'pty:redraw',
  // Hive
  'hive:tasks', 'hive:addTask', 'hive:deleteTask', 'hive:board',
  'hive:memory', 'hive:log', 'hive:agentContext', 'hive:agentDirectory',
  'hive:inbox', 'hive:message', 'hive:agentUsage', 'hive:enqueueToAgent',
  'hive:memoryStatus', 'hive:memoryWakeUp', 'hive:hookEvent',
  'hive:agentSpawned', 'hive:agentArchived', 'hive:contextUpdate',
  // Fleet / roster / workers
  'fleet:get', 'roster:readSync', 'roster:write', 'workers:list', 'workers:stop',
  // Session / history
  'session:resolveCwd', 'history:list', 'history:add', 'history:search',
  // Filesystem / git
  'fs:readFile', 'fs:writeFile', 'fs:listDir', 'fs:statAbs', 'fs:readBinary',
  'git:status', 'git:log', 'git:diff', 'git:branch', 'git:branches',
  'git:isRepo', 'git:mainRepo', 'git:aheadBehind', 'git:logGraph',
  'git:compareRefs', 'git:showFile', 'git:checkout', 'git:commitFiles', 'git:worktrees',
  // Telemetry / control
  'telemetry:snapshot', 'telemetry:usage', 'telemetry:spans', 'telemetry:event',
  'control:breakerState', 'control:setBreakerState', 'control:snapshot',
  'control:steer', 'control:pause', 'control:resume', 'control:halt',
  'control:approvalRequest', 'control:autoDelivery', 'control:gateTool',
  // Skills
  'skills:catalog', 'skills:local', 'skills:install', 'skills:uninstall',
  'skills:reveal',
  // Webex
  'webex-poll:start', 'webex-poll:stop', 'webex-poll:status',
  'webex-poll:reply', 'webex-poll:setConfig',
  // Slack (runs on Mac — proxy to server which stubs it)
  'slack:start', 'slack:stop', 'slack:status', 'slack:reply', 'slack:setConfig',
  'slack:replyScriptPath',
  // Webhooks, triggers (stubs)
  'webhook:start', 'webhook:stop', 'webhook:status', 'webhook:setConfig',
  'webhooks:list', 'webhooks:save', 'webhooks:delete', 'webhooks:status',
  'webhooks:generateSecret', 'triggers:getContext', 'triggers:setContext',
  'org:getTrigger', 'org:setTrigger',
  // Missions
  'missions:save',
  // GitHub
  'github:issues', 'github:ciRuns',
  // Hire
  'hire:import', 'hire:drainPending', 'hire:openFile',
  // Realtime stubs
  'realtime:hasKey', 'realtime:mintToken', 'realtime:setSessionLive',
  // Provider keys
  'providerKey:has', 'providerKey:set', 'providerKey:clear',
  // Misc
  'app:info', 'app:resetAll', 'app:setLoginItem', 'app:setNotifications',
  'update:current', 'update:status', 'update:checkNow',
  'dialog:chooseFolder', 'dialog:attachFiles',
  'tools:status', 'hero:payload',
];

function registerProxies() {
  for (const channel of PROXY_CHANNELS) {
    // Guard against double-registration (electron throws)
    try {
      ipcMain.handle(channel, async (_evt, ...args: unknown[]) => {
        try { return await invoke(channel, args); }
        catch (e) {
          console.warn(`[remote] invoke failed for ${channel}:`, (e as Error).message);
          return null;
        }
      });
    } catch {
      // channel already registered — skip
    }
  }

  // app:openExternal is fire-and-forget on Mac
  ipcMain.handle('app:openExternal', (_evt, url: unknown) => {
    if (typeof url === 'string') shell.openExternal(url);
  });
}

// ─── Window ──────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Munder Difflin (remote)',
    backgroundColor: '#FFF8E7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  registerProxies();
  createWindow();
  connectWS();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('will-quit', () => {
  ws?.close();
});
