/**
 * WebexPoller — poll the Webex REST API for new messages and hand them to
 * the harness. No webhook or public tunnel required: works behind firewalls and
 * NAT without any inbound URL.
 *
 * Flow:
 *   1. start(): fetch the bot's personId (self-filter) then begin polling.
 *   2. Poll /v1/rooms every pollIntervalMs sorted by lastActivity.
 *      Rooms whose lastActivity hasn't advanced are skipped — zero wasted
 *      fetches for idle spaces.
 *   3. For each changed room (optionally filtered to one roomId), fetch up to
 *      50 recent messages, process oldest-first, and emit new ones via onMessage.
 *   4. Outbound: postWebexMessage() POSTs /v1/messages with roomId + text.
 *
 * Deliberately free of any `electron` import so it can be unit-tested as a
 * plain Node module.
 */

const WEBEX_API = 'https://webexapis.com/v1';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const RATE_LIMIT_BASE_SECS = 10;
const RATE_LIMIT_MAX_RETRIES = 4;

export interface WebexPollerOptions {
  botToken: string;
  /** When set, only this room's messages are forwarded (others are skipped). */
  roomId?: string;
  /** Polling interval in ms. Defaults to 5 000. */
  pollIntervalMs?: number;
  onMessage: (m: WebexInboundMessage) => void | Promise<void>;
}

export interface WebexInboundMessage {
  text: string;
  roomId: string;
  messageId: string;
  personEmail: string;
  isMention: boolean;
  isGroup: boolean;
}

interface WebexRoom {
  id: string;
  title: string;
  type: 'direct' | 'group';
  lastActivity: string;
}

interface WebexMessage {
  id: string;
  roomId: string;
  personId: string;
  personEmail: string;
  text?: string;
  mentionedPeople?: string[];
  created: string;
}

export class WebexPoller {
  private botToken: string;
  private roomId?: string;
  private pollIntervalMs: number;
  private readonly onMessage: (m: WebexInboundMessage) => void | Promise<void>;

  private botPersonId = '';
  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-room cursor: ISO timestamp of last processed message. */
  private readonly roomCursor = new Map<string, string>();
  /** Per-room lastActivity from Webex — skip the room when unchanged. */
  private readonly roomActivity = new Map<string, string>();

  constructor(opts: WebexPollerOptions) {
    this.botToken = opts.botToken;
    this.roomId = opts.roomId?.trim() || undefined;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onMessage = opts.onMessage;
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.connected) return { ok: false, error: 'already running' };
    if (!this.botToken) return { ok: false, error: 'missing bot token' };
    try {
      const me = await this.apiFetch<{ id: string; displayName?: string }>('/people/me');
      this.botPersonId = me.id;
      console.log(`[webex-poller] started as ${me.displayName ?? me.id} (roomFilter: ${this.roomId ?? 'all rooms'}, interval: ${this.pollIntervalMs}ms)`);
    } catch (e) {
      console.error('[webex-poller] failed to fetch bot identity:', errMsg(e));
      return { ok: false, error: `could not fetch bot identity: ${errMsg(e)}` };
    }
    this.connected = true;
    void this.poll();
    return { ok: true };
  }

  stop(): void {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  isRunning(): boolean {
    return this.connected;
  }

  /** Update credentials without restarting. Called when config changes. */
  updateConfig(opts: Partial<Pick<WebexPollerOptions, 'botToken' | 'roomId' | 'pollIntervalMs'>>): void {
    if (opts.botToken !== undefined) this.botToken = opts.botToken;
    if (opts.roomId !== undefined) this.roomId = opts.roomId?.trim() || undefined;
    if (opts.pollIntervalMs !== undefined) this.pollIntervalMs = opts.pollIntervalMs;
  }

  private async apiFetch<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
    const url = path.startsWith('http') ? path : `${WEBEX_API}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
      },
    });

    if (res.status === 429) {
      if (attempt >= RATE_LIMIT_MAX_RETRIES) {
        throw new Error(`Webex API ${path} → 429: rate limited after ${attempt} retries`);
      }
      const retryAfterSecs = parseInt(res.headers.get('Retry-After') ?? String(RATE_LIMIT_BASE_SECS), 10);
      const delaySecs = retryAfterSecs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delaySecs * 1000));
      return this.apiFetch<T>(path, init, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Webex API ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  private async pollRoom(room: WebexRoom): Promise<void> {
    const cursor = this.roomCursor.get(room.id);
    const isGroup = room.type === 'group';

    console.log(`[webex-poller] polling room "${room.title}" (${room.type}) cursor=${cursor ?? 'none'}`);

    const result = await this.apiFetch<{ items: WebexMessage[] }>(
      `/messages?roomId=${encodeURIComponent(room.id)}&max=50`,
    );

    console.log(`[webex-poller] got ${result.items.length} messages from "${room.title}"`);

    // Process oldest-first so the cursor advances monotonically.
    const messages = [...result.items].reverse();
    let newCursor = cursor;

    for (const msg of messages) {
      if (cursor && msg.created <= cursor) {
        continue;
      }
      if (msg.personId === this.botPersonId) {
        console.log(`[webex-poller] skipping own message ${msg.id}`);
        if (!newCursor || msg.created > newCursor) newCursor = msg.created;
        continue;
      }

      const text = (msg.text ?? '').trim();
      if (!text) {
        if (!newCursor || msg.created > newCursor) newCursor = msg.created;
        continue;
      }

      const isMention = isGroup
        ? (msg.mentionedPeople ?? []).includes(this.botPersonId)
        : true;

      console.log(`[webex-poller] ✉ new message from ${msg.personEmail} in "${room.title}": ${text.slice(0, 80)}`);

      const inbound: WebexInboundMessage = {
        text,
        roomId: room.id,
        messageId: msg.id,
        personEmail: msg.personEmail,
        isMention,
        isGroup,
      };

      try { void this.onMessage(inbound); } catch { /* delivery is best-effort */ }

      if (!newCursor || msg.created > newCursor) newCursor = msg.created;
    }

    if (newCursor && newCursor !== cursor) {
      this.roomCursor.set(room.id, newCursor);
    }
  }

  private async poll(): Promise<void> {
    try {
      const { items: rooms } = await this.apiFetch<{ items: WebexRoom[] }>(
        '/rooms?sortBy=lastactivity&max=100',
      );

      console.log(`[webex-poller] poll tick — ${rooms.length} rooms visible (filter: ${this.roomId ?? 'all'})`);

      for (const room of rooms) {
        // If a specific roomId is configured, skip all others.
        if (this.roomId && room.id !== this.roomId) {
          continue;
        }

        const prev = this.roomActivity.get(room.id);
        if (prev === room.lastActivity) {
          continue; // no new activity in this room
        }

        console.log(`[webex-poller] activity change in "${room.title}" (${room.type}) — prev=${prev ?? 'never'} now=${room.lastActivity}`);

        try {
          await this.pollRoom(room);
        } catch (err) {
          const msg = errMsg(err);
          // 403 or "Failed to get activity" = bot can't read this room; skip permanently this session
          if (msg.includes('→ 403') || msg.includes('Failed to get activity')) {
            console.warn(`[webex-poller] no read access to "${room.title}" (${room.id}) — skipping`);
            this.roomActivity.set(room.id, room.lastActivity);
            continue;
          }
          console.warn(`[webex-poller] pollRoom error for "${room.title}":`, msg);
        }

        this.roomActivity.set(room.id, room.lastActivity);
      }
    } catch (err) {
      console.warn('[webex-poller] poll error:', errMsg(err));
    }

    if (this.connected) {
      this.pollTimer = setTimeout(() => void this.poll(), this.pollIntervalMs);
    }
  }
}

/**
 * Post a message to a Webex room. No SDK — raw fetch, matching the repo's
 * zero-dependency approach. The bot token is passed in by the caller and never
 * logged.
 */
export async function postWebexMessage(opts: {
  botToken: string;
  roomId: string;
  text: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (!opts.botToken) return { ok: false, error: 'missing bot token' };
  if (!opts.roomId?.trim()) return { ok: false, error: 'missing roomId' };
  if (!opts.text?.trim()) return { ok: false, error: 'missing text' };
  try {
    const res = await fetch(`${WEBEX_API}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ roomId: opts.roomId, text: opts.text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `${res.status}: ${body.slice(0, 200)}` };
    }
    const json = await res.json() as { id?: string };
    return { ok: true, messageId: json.id };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
