# Remote Mode — VM Server + Mac Client

Run the heavy lifting (PTY terminals, agents, hive, Webex) on a Linux VM while
the Electron UI runs on your Mac, connected over WebSocket.

```
Mac (Electron app)                    Linux VM
┌─────────────────────────┐           ┌──────────────────────────┐
│  Renderer (React/Pixi)  │           │  PTY processes           │
│  window + display       │  ←─WS──→  │  hive / agents           │
│  thin IPC proxy         │           │  config / Webex poller   │
└─────────────────────────┘           └──────────────────────────┘
```

---

## VM — Server setup

### 1. Prerequisites

```bash
# Node.js 18+
node --version

# A C/C++ toolchain (for node-pty native addon)
sudo apt-get install -y build-essential python3

# At least one agent CLI on PATH
npm install -g @anthropic-ai/claude-code   # claude
# or: codex, opencode, etc.
```

### 2. Clone and install

```bash
git clone git@github.com:sfakam/munder-difflin.git
cd munder-difflin
npm install
```

### 3. Build the server

```bash
npm run server:build
# Compiles src/server/index.ts → out/server/server/index.js
```

### 4. Start the server

```bash
# Defaults: port 3456, harness home ~/ClaudeTerminalHarness
node out/server/server/index.js

# With overrides:
MUNDER_PORT=3456 \
MUNDER_HOME=/path/to/your/harness \
node out/server/server/index.js
```

You should see:
```
[server] Munder Difflin server listening on ws://0.0.0.0:3456
[server] HARNESS_HOME: /home/you/ClaudeTerminalHarness
[server] CONFIG_FILE:  /home/you/.munder-difflin/config.json
```

### 5. Open the port (or use SSH tunnel — see Mac step 3)

```bash
# UFW
sudo ufw allow 3456/tcp

# iptables
sudo iptables -A INPUT -p tcp --dport 3456 -j ACCEPT
```

---

## Mac — Client setup

### 1. Prerequisites

- **Node.js 18+** and npm
- **Xcode Command Line Tools** (for node-pty / better-sqlite3)
  ```bash
  xcode-select --install
  ```
- Same repo cloned locally

#### macOS 26+ — SDK header fix

macOS 26 moved the public C++ stdlib headers into the SDK directory. Native
addons built with `node-gyp` won't find them unless you add the SDK to the
include path. Add the following to your `~/.zshrc` (or `~/.bashrc`):

```bash
export SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
export SDKROOT="$SDK"
export CPLUS_INCLUDE_PATH="$SDK/usr/include/c++/v1:$SDK/usr/include"
export CPATH="$SDK/usr/include"
```

Then reload your shell (`source ~/.zshrc`) before running `npm install`.

### 2. Clone and install

```bash
git clone git@github.com:sfakam/munder-difflin.git
cd munder-difflin
npm install
```

### 3. Connect to the VM

> **Important:** always use `npm run dev:remote`, not `npm run dev`.
> `dev:remote` boots `remote-entry.js` which proxies all IPC over WebSocket.
> `npm run dev` starts the full local Electron process and ignores `MUNDER_REMOTE`.

**Option A — Direct connection** (VM port 3456 open to the corporate/internal network):

```bash
MUNDER_REMOTE=ws://YOUR_VM_HOSTNAME:3456 npm run dev:remote
```

**Option B — SSH tunnel** (recommended; no firewall changes needed):

```bash
# In a separate terminal, keep this running:
ssh -N -L 3456:localhost:3456 user@your-vm-hostname

# Then start the app pointing at the local tunnel:
MUNDER_REMOTE=ws://localhost:3456 npm run dev:remote
```

**Option C — Add to your shell profile** so you never have to type it:

```bash
# ~/.zshrc or ~/.bashrc
export MUNDER_REMOTE=ws://localhost:3456
# then just:
npm run dev:remote
```

The Electron window opens on your Mac. All agent terminals, hive coordination,
and file operations run on the VM.

---

## Environment variables

| Variable | Where | Default | Description |
|----------|-------|---------|-------------|
| `MUNDER_PORT` | VM | `3456` | Port the WS server binds to |
| `MUNDER_HOME` | VM | `~/ClaudeTerminalHarness` | Harness home (hive lives here) |
| `MUNDER_REMOTE` | Mac | _(unset = local mode)_ | WS URL of the VM server |

---

## Keeping it running on the VM

### systemd service

```ini
# /etc/systemd/system/munder-difflin.service
[Unit]
Description=Munder Difflin WS Server
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/munder-difflin
ExecStart=/usr/bin/node out/server/server/index.js
Restart=on-failure
RestartSec=5
Environment=MUNDER_PORT=3456
Environment=MUNDER_HOME=/home/YOUR_USER/ClaudeTerminalHarness

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now munder-difflin
sudo systemctl status munder-difflin
```

### Or with pm2

```bash
npm install -g pm2
pm2 start out/server/server/index.js --name munder-difflin \
  --env MUNDER_PORT=3456 --env MUNDER_HOME=~/ClaudeTerminalHarness
pm2 save
pm2 startup   # auto-start on reboot
```

---

## What runs where

| Feature | VM | Mac |
|---------|----|----|
| PTY terminals (claude, codex, …) | ✓ | |
| Hive (memory, mailboxes, tasks) | ✓ | |
| Config read/write | ✓ | |
| Webex Poller | ✓ | |
| Slack webhook | | ✓ (local) |
| Electron window / display | | ✓ |
| Pixi.js office floor | | ✓ |
| xterm.js terminal rendering | | ✓ |

---

## Troubleshooting

**`ECONNREFUSED` on Mac**
- Is the server running on the VM? Check `systemctl status munder-difflin` or the terminal you started it in.
- Is the port reachable? `nc -zv your-vm-ip 3456`
- If using SSH tunnel, is the tunnel still open?

**PTY spawns but nothing appears**
- Make sure the agent CLI (`claude`, `codex`, etc.) is installed on the VM, not just the Mac.
- Check `PATH` inside the server process: `echo $PATH` on the VM.

**`node-pty` fails to load**
- Run `npm install` again — `postinstall` rebuilds the native addon.
- Ensure build tools are installed: `sudo apt-get install -y build-essential python3`

**Config or hive not persisting**
- `MUNDER_HOME` on the VM must point to the same directory every run.
- For systemd/pm2, set it explicitly in the service definition.
