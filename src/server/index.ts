/**
 * Munder Difflin — standalone WebSocket server for VM deployment.
 *
 * Run on the VM: node out/server.js  (or: MUNDER_PORT=3456 node out/server.js)
 * Run on Mac:   MUNDER_REMOTE=ws://vm-ip:3456 npm run dev
 *
 * Protocol (all messages are JSON):
 *   Client → Server: { type:'invoke', id:string, channel:string, args:any[] }
 *   Server → Client: { type:'result', id:string, result:any }
 *                    { type:'error',  id:string, error:string }
 *                    { type:'event',  channel:string, data:any }
 *
 * No Electron imports — runs as plain Node.js.
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as nodePty from 'node-pty';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
  statSync, renameSync, appendFileSync
} from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebexPoller, postWebexMessage } from '../main/webex-poller';

// ─── Paths ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.MUNDER_PORT ?? '3456', 10);
/** Parent of the hive dir — where agents work. Set via MUNDER_HOME or config. */
const HARNESS_HOME = process.env.MUNDER_HOME ?? join(homedir(), 'ClaudeTerminalHarness');
const CONFIG_FILE = join(homedir(), '.munder-difflin', 'config.json');
mkdirSync(join(homedir(), '.munder-difflin'), { recursive: true });

function hiveRoot(): string { return join(HARNESS_HOME, 'hive'); }

// ─── Config ─────────────────────────────────────────────────────────────────
function readConfig(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function writeConfig(patch: Record<string, unknown>): void {
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
}

// ─── PTY manager ────────────────────────────────────────────────────────────
interface PtyEntry { pty: nodePty.IPty; id: string; cwd: string; command: string; }
const ptys = new Map<string, PtyEntry>();
let ptySeq = 0;

// ─── Webex poller ────────────────────────────────────────────────────────────
let webexPoller: WebexPoller | null = null;

// ─── Handler registry ────────────────────────────────────────────────────────
type PushFn = (channel: string, data: unknown) => void;
type HandlerFn = (args: unknown[], push: PushFn) => unknown | Promise<unknown>;
const handlers = new Map<string, HandlerFn>();
function handle(channel: string, fn: HandlerFn) { handlers.set(channel, fn); }

// ─── Hive helpers ────────────────────────────────────────────────────────────
function hiveFile(rel: string): string { return join(hiveRoot(), rel); }
function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch { return fallback; }
}
function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
function atomicWrite(path: string, content: string): void {
  const tmp = path + '.tmp.' + randomBytes(4).toString('hex');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ─── Register handlers ───────────────────────────────────────────────────────

handle('app:info', () => ({
  version: process.env.npm_package_version ?? '0.0.0',
  platform: process.platform,
  serverMode: true,
}));

handle('config:get', () => readConfig());
handle('config:update', ([patch]) => {
  writeConfig(patch as Record<string, unknown>);
  return readConfig();
});

// PTY
handle('pty:spawn', ([opts], push) => {
  const o = (opts ?? {}) as {
    id?: string; command?: string; cmd?: string; args?: string[];
    cwd?: string; cols?: number; rows?: number; env?: Record<string, string>;
  };
  const id = o.id ?? `pty-${++ptySeq}`;
  const cwd = o.cwd ?? HARNESS_HOME;
  // command (preferred) or cmd (legacy), fallback to shell
  const exe = o.command ?? o.cmd ?? (process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL ?? 'bash'));
  try {
    const p = nodePty.spawn(exe, o.args ?? [], {
      name: 'xterm-256color',
      cols: o.cols ?? 80,
      rows: o.rows ?? 24,
      cwd,
      env: { ...process.env, ...(o.env ?? {}) } as Record<string, string>,
    });
    p.onData((data) => push(`pty:data:${id}`, data));
    p.onExit((e) => {
      push(`pty:exit:${id}`, e);
      ptys.delete(id);
    });
    ptys.set(id, { pty: p, id, cwd, command: exe });
    return { ok: true, id, cwd };
  } catch (err) {
    console.error('[server] pty:spawn failed:', (err as Error).message);
    return { ok: false, error: (err as Error).message };
  }
});

handle('pty:write', ([id, data]) => {
  ptys.get(id as string)?.pty.write(data as string);
});
handle('pty:resize', ([id, cols, rows]) => {
  ptys.get(id as string)?.pty.resize(cols as number, rows as number);
});
handle('pty:kill', ([id]) => {
  const e = ptys.get(id as string);
  if (e) { try { e.pty.kill(); } catch { /* noop */ } ptys.delete(id as string); }
});
handle('pty:list', () =>
  Array.from(ptys.values()).map(({ id, cwd, command }) => ({
    id, cwd, command, pid: 0, lastOutputAt: Date.now(), hasOutput: true,
  }))
);
handle('pty:redraw', () => { /* no-op in server mode */ });

// Hive — tasks
handle('hive:tasks', () => readJson(hiveFile('tasks.json'), { tasks: [] }));
handle('hive:addTask', ([task]) => {
  const ledger = readJson<{ tasks: unknown[] }>(hiveFile('tasks.json'), { tasks: [] });
  ledger.tasks.push(task);
  writeJson(hiveFile('tasks.json'), ledger);
  return { ok: true };
});
handle('hive:deleteTask', ([id]) => {
  const ledger = readJson<{ tasks: { id: unknown }[] }>(hiveFile('tasks.json'), { tasks: [] });
  ledger.tasks = ledger.tasks.filter((t) => t.id !== id);
  writeJson(hiveFile('tasks.json'), ledger);
  return { ok: true };
});

// Hive — roster / registry
handle('roster:readSync', () => {
  return readJson<unknown[]>(hiveFile('registry.json'), []);
});
handle('roster:write', ([roster]) => {
  writeJson(hiveFile('registry.json'), roster);
  return { ok: true };
});

// Hive — fleet
handle('fleet:get', () => {
  const fleetDir = hiveFile('fleet');
  if (!existsSync(fleetDir)) return {};
  const result: Record<string, unknown> = {};
  for (const f of readdirSync(fleetDir)) {
    if (!f.endsWith('.json')) continue;
    const id = f.replace(/\.json$/, '');
    result[id] = readJson(join(fleetDir, f), {});
  }
  return result;
});

// Hive — board
handle('hive:board', () => {
  const p = hiveFile('board.md');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
});

// Hive — agent memory
handle('hive:memory', ([agentId]) => {
  const p = hiveFile(`agents/${agentId}/memory.md`);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
});

// Hive — log
handle('hive:log', ([limit]) => {
  const p = hiveFile('log.jsonl');
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const count = typeof limit === 'number' ? limit : 200;
  return lines.slice(-count).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
});

// Hive — agent context
handle('hive:agentContext', ([agentId]) => {
  const base = hiveFile(`agents/${agentId}`);
  return {
    identity: existsSync(join(base, 'identity.md')) ? readFileSync(join(base, 'identity.md'), 'utf8') : '',
    memory: existsSync(join(base, 'memory.md')) ? readFileSync(join(base, 'memory.md'), 'utf8') : '',
  };
});

// Hive — agent directory
handle('hive:agentDirectory', ([agentId]) => {
  return hiveFile(`agents/${agentId}`);
});

// Hive — inbox
handle('hive:inbox', ([agentId]) => {
  const dir = hiveFile(`agents/${agentId}/inbox`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(dir, f), {}));
});

// Hive — send message to agent
handle('hive:message', ([msg]) => {
  const m = msg as { to: string; from?: string; subject?: string; body?: string; act?: string };
  const dest = m.to === 'god' ? 'god' : m.to;
  const inboxDir = hiveFile(`agents/${dest}/inbox`);
  mkdirSync(inboxDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `${ts}-${randomBytes(3).toString('hex')}`;
  const full: Record<string, unknown> = {
    ...m,
    id, conversation: `conv-${randomBytes(3).toString('hex')}`,
    in_reply_to: (m as Record<string, unknown>).in_reply_to ?? null,
    from: m.from ?? 'server',
    to: dest,
    act: m.act ?? 'inform',
    subject: m.subject ?? '',
    body: m.body ?? '',
    hops: 0, requires_reply: false, needs_human: false,
    created_at: new Date().toISOString(),
  };
  atomicWrite(join(inboxDir, `${id}.json`), JSON.stringify(full, null, 2));
  appendFileSync(hiveFile('log.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), type: 'message', agentId: dest, payload: full
  }) + '\n');
  return { ok: true, id };
});

// Hive — usage
handle('hive:agentUsage', ([agentId]) => {
  const p = hiveFile(`agents/${agentId}/usage.json`);
  return existsSync(p) ? readJson(p, {}) : {};
});

// Hive — enqueue to agent (write to PTY stdin via hive channel)
handle('hive:enqueueToAgent', ([agentId, text]) => {
  // Find the PTY for this agent via registry
  const registry = readJson<{ id: string; ptyId?: string }[]>(hiveFile('registry.json'), []);
  const entry = registry.find((r) => r.id === agentId);
  const ptyId = entry?.ptyId;
  if (ptyId) {
    ptys.get(ptyId)?.pty.write((text as string) + '\n');
    return { ok: true };
  }
  return { ok: false, error: 'agent PTY not found' };
});

// Workers
handle('workers:list', () => {
  const registry = readJson<{ id: string; status?: string }[]>(hiveFile('registry.json'), []);
  return registry.filter((r) => r.status !== 'archived');
});
handle('workers:stop', ([agentId]) => {
  const registry = readJson<{ id: string; ptyId?: string; status?: string }[]>(hiveFile('registry.json'), []);
  const entry = registry.find((r) => r.id === agentId);
  if (entry?.ptyId) { ptys.get(entry.ptyId)?.pty.kill(); ptys.delete(entry.ptyId); }
  return { ok: true };
});

// Filesystem
handle('fs:readFile', ([path]) => {
  try { return readFileSync(path as string, 'utf8'); }
  catch (e) { throw new Error(`fs:readFile: ${(e as Error).message}`); }
});
handle('fs:writeFile', ([path, content]) => {
  writeFileSync(path as string, content as string, 'utf8');
  return { ok: true };
});
handle('fs:listDir', ([path]) => {
  try {
    return readdirSync(path as string).map((name) => {
      const full = join(path as string, name);
      const st = statSync(full);
      return { name, path: full, isDir: st.isDirectory(), size: st.size };
    });
  } catch { return []; }
});
handle('fs:statAbs', ([path]) => {
  try { const st = statSync(path as string); return { exists: true, isDir: st.isDirectory(), size: st.size }; }
  catch { return { exists: false }; }
});

// Session
handle('session:resolveCwd', () => HARNESS_HOME);

// History (stub — store in a simple file)
const HISTORY_FILE = join(homedir(), '.munder-difflin', 'history.json');
handle('history:list', () => readJson<unknown[]>(HISTORY_FILE, []));
handle('history:add', ([entry]) => {
  const h = readJson<unknown[]>(HISTORY_FILE, []);
  h.unshift(entry);
  writeFileSync(HISTORY_FILE, JSON.stringify(h.slice(0, 500), null, 2));
  return { ok: true };
});

// Telemetry stubs
handle('telemetry:snapshot', () => ({}));
handle('telemetry:usage', () => ({}));
handle('telemetry:spans', () => []);

// Control stubs
handle('control:breakerState', () => ({ state: 'ok' }));
handle('control:setBreakerState', () => ({ ok: true }));
handle('control:snapshot', () => ({}));

// Skills stubs (return empty — client shows no catalog in server mode)
handle('skills:catalog', () => []);
handle('skills:local', () => []);

// Slack stubs (slack runs on Mac client, not VM)
handle('slack:status', () => ({ running: false }));
handle('slack:start', () => ({ ok: false, error: 'slack runs on the Mac client' }));
handle('slack:stop', () => ({ ok: true }));

// Webex poller
handle('webex-poll:status', () => ({ running: webexPoller?.isRunning() ?? false }));
handle('webex-poll:start', (_, push) => {
  const cfg = readConfig();
  if (!cfg.webexPollEnabled || !cfg.webexPollBotToken) return { ok: false, error: 'disabled or missing token' };
  webexPoller?.stop();
  webexPoller = new WebexPoller({
    botToken: cfg.webexPollBotToken as string,
    roomId: cfg.webexPollRoomId as string | undefined,
    pollIntervalMs: cfg.webexPollIntervalMs as number | undefined,
    onMessage: (m) => push('webex-poll:incomingMessage', m),
  });
  return webexPoller.start();
});
handle('webex-poll:stop', () => { webexPoller?.stop(); webexPoller = null; return { ok: true }; });
handle('webex-poll:reply', ([arg]) => {
  const m = arg as { roomId: string; text: string };
  const cfg = readConfig();
  return postWebexMessage({ botToken: cfg.webexPollBotToken as string, roomId: m.roomId, text: m.text });
});
handle('webex-poll:setConfig', ([patch]) => {
  const p = patch as { botToken?: string; roomId?: string; pollIntervalMs?: number; enabled?: boolean };
  const next: Record<string, unknown> = {};
  if (typeof p.botToken === 'string') next.webexPollBotToken = p.botToken.trim() || undefined;
  if (typeof p.roomId === 'string') next.webexPollRoomId = p.roomId.trim() || undefined;
  if (typeof p.pollIntervalMs === 'number') next.webexPollIntervalMs = p.pollIntervalMs;
  if (typeof p.enabled === 'boolean') next.webexPollEnabled = p.enabled;
  writeConfig(next);
  if (!next.webexPollEnabled) { webexPoller?.stop(); webexPoller = null; }
  else if (webexPoller) webexPoller.updateConfig({ botToken: next.webexPollBotToken as string, roomId: next.webexPollRoomId as string });
  return { ok: true };
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, mode: 'munder-difflin-server', ptys: ptys.size }));
});

const wss = new WebSocketServer({ server: httpServer });

/** All connected clients, each with a push helper. */
const clients = new Set<WebSocket>();

function broadcast(channel: string, data: unknown) {
  const msg = JSON.stringify({ type: 'event', channel, data });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[server] client connected (total: ${clients.size})`);

  const push: PushFn = (channel, data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'event', channel, data }));
    }
  };

  ws.on('message', async (raw) => {
    let msg: { type: string; id?: string; channel?: string; args?: unknown[] };
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    if (msg.type === 'invoke' && msg.id && msg.channel) {
      const handler = handlers.get(msg.channel);
      if (!handler) {
        ws.send(JSON.stringify({ type: 'error', id: msg.id, error: `unknown channel: ${msg.channel}` }));
        return;
      }
      try {
        const result = await handler(msg.args ?? [], push);
        ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', id: msg.id, error: (e as Error).message }));
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[server] client disconnected (total: ${clients.size})`);
  });
  ws.on('error', (e) => console.error('[server] ws error:', e.message));
});

// ─── Auto-start webex if configured ─────────────────────────────────────────
const cfg = readConfig();
if (cfg.webexPollEnabled && cfg.webexPollBotToken) {
  webexPoller = new WebexPoller({
    botToken: cfg.webexPollBotToken as string,
    roomId: cfg.webexPollRoomId as string | undefined,
    pollIntervalMs: cfg.webexPollIntervalMs as number | undefined,
    onMessage: (m) => broadcast('webex-poll:incomingMessage', m),
  });
  webexPoller.start().then((r) => {
    if (!r.ok) console.error('[server] webex-poll auto-start failed:', r.error);
    else console.log('[server] webex-poll polling started');
  });
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Munder Difflin server listening on ws://0.0.0.0:${PORT}`);
  console.log(`[server] HARNESS_HOME: ${HARNESS_HOME}`);
  console.log(`[server] CONFIG_FILE:  ${CONFIG_FILE}`);
});
