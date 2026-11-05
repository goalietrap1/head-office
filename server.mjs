// Head Office relay.
// Agents (via zero-token hooks) POST small status events here; the office page
// subscribes over Server-Sent Events. No model is ever called to report status.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readLedger, watchLedger } from './adapters/ledger.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const expand = (p) => p.replace(/^~(?=$|\/)/, os.homedir());

const configPath = process.env.OFFICE_CONFIG
  ? (path.isAbsolute(expand(process.env.OFFICE_CONFIG)) ? expand(process.env.OFFICE_CONFIG) : path.resolve(expand(process.env.OFFICE_CONFIG)))
  : path.join(ROOT, 'office.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const configDir = path.dirname(configPath);
const PORT = Number(process.env.OFFICE_PORT || config.port || 4317);
const QUIET_MS = (config.quietAfterMinutes ?? 10) * 60_000;
const FORGET_MS = (config.forgetClaudeSessionAfterMinutes ?? 120) * 60_000;
// How long a finished chat keeps its panel on Claude's monitor before it's put away.
const LINGER_MS = (config.claude?.lingerSeconds ?? 8) * 1000;
const MAX_ON_FLOOR = config.claude?.maxOnFloor ?? 6;

// Coding agents that each get one character at a command desk in their own studio, with every
// open chat as a panel on its monitor: Claude Code, and Codex (CLI or app) when it's installed.
const STUDIOS = {
  claude: { name: 'Claude', color: '#D97757', ...config.claude },
  codex: { name: 'Codex', color: '#ECEBF3', ...config.codex },
};
const isStudio = (source) => !!STUDIOS[source];
// feedOnly forces every cache adapter off, including when adapters.* is also true.
// With feedOnly false, adapters.<name>: false turns that one reader off.
// Codex still honours codex.enabled, and otherwise opens only when Codex is installed.
const FEED_ONLY = config.feedOnly === true;
const adapterFlag = (name) => (config.adapters && Object.prototype.hasOwnProperty.call(config.adapters, name) ? config.adapters[name] !== false : null);
const adapterEnabled = (name) => {
  if (FEED_ONLY) return false;
  if (adapterFlag(name) === false) return false;
  return true;
};
function codexDesired() {
  if (FEED_ONLY || config.adapters?.codex === false || config.codex?.enabled === false) return 'off';
  if (config.codex?.enabled === true || config.adapters?.codex === true) return 'on';
  return 'auto';
}
let codexOn = false;
const wings = () => (codexOn ? ['codex'] : []);

const STATUS_WORD = {
  thinking: 'Thinking', coding: 'Coding', terminal: 'In terminal', browsing: 'Browsing', reading: 'Reading',
  working: 'Working', delegating: 'Delegating', needs_you: 'Needs you', error: 'Error', done: 'Done', idle: 'Idle', offline: 'Offline',
};

// A per-machine token. Custom headers force a CORS preflight (which we never
// grant), so random websites can't fake events or approve permissions.
const TOKEN_DIR = path.join(os.homedir(), '.head-office');
const TOKEN_FILE = path.join(TOKEN_DIR, 'token');
fs.mkdirSync(TOKEN_DIR, { recursive: true });
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
fs.writeFileSync(path.join(TOKEN_DIR, 'url'), `http://127.0.0.1:${PORT}`);

// ---------------------------------------------------------------- state

const agents = new Map();
const feed = [];
const decisions = new Map(); // approvalId -> { agentId, decision, waiters: [] }
const clients = new Map();   // SSE response -> { id, visible }
const visibleViewers = () => [...clients.values()].filter((c) => c.visible).length;

const endedSessions = new Map(); // studio session id -> when its SessionEnd hook fired

// Questions you waved off. Keys are pending ids, plus `@agentId` for "everything this
// agent said up to now" (Claude's session reader re-derives its question each scan).
// Saved to disk so a restart doesn't bring them back.
const LAYOUT_FILE = path.join(TOKEN_DIR, 'layout.json');
const DISMISSED_FILE = path.join(TOKEN_DIR, 'dismissed.json');
const dismissed = new Map(Object.entries((() => { try { return JSON.parse(fs.readFileSync(DISMISSED_FILE, 'utf8')); } catch { return {}; } })()));
const saveDismissed = () => {
  const cutoff = Date.now() - 7 * 86_400_000;
  for (const [k, ts] of dismissed) if (ts < cutoff) dismissed.delete(k);
  try { fs.writeFileSync(DISMISSED_FILE, JSON.stringify(Object.fromEntries(dismissed))); } catch {}
};
const calm = (a) => ({ status: 'idle', activity: isStudio(a.source) ? 'Waiting for your next prompt' : 'Free for a new task', pending: null });
const isDismissed = (agent, pending, at) => !!pending && (dismissed.has(pending.id) || (at && at <= (dismissed.get(`@${agent.id}`) || 0)));
const WORKING = new Set(['thinking', 'coding', 'browsing', 'terminal', 'reading', 'working', 'delegating']);

function baseAgent(id, fields) {
  return {
    id, name: id, role: '', theme: 'ops', color: '#8A8FA3', source: 'custom',
    status: 'idle', activity: 'Free for a new task', detail: '', cwd: '',
    since: Date.now(), updatedAt: Date.now(), log: [], pending: null, task: null,
    ...fields,
  };
}

for (const [id, overrides] of Object.entries(config.agents || {})) {
  if (!id.startsWith('grok:') && !agents.has(id)) agents.set(id, baseAgent(id, { source: id.split(':')[0], ...overrides }));
}

const officeId = (raw) => (raw && String(raw).includes(':') ? String(raw) : `roster:${raw}`);
const ROSTER = (Array.isArray(config.roster) ? config.roster : []).filter((p) => p && typeof p.id === 'string' && p.id.trim());
const rosterPrivate = new Set(ROSTER.filter((p) => p.private === true).map((p) => officeId(p.id.trim())));
const rosterById = new Map(ROSTER.map((p) => [officeId(p.id.trim()), p]));

function seedRoster() {
  for (const person of ROSTER) {
    const id = officeId(person.id.trim());
    if (agents.has(id)) continue;
    const priv = person.private === true;
    agents.set(id, baseAgent(id, {
      source: 'roster',
      name: typeof person.name === 'string' && person.name.trim() ? person.name.trim() : person.id.trim(),
      role: typeof person.role === 'string' ? person.role : '',
      theme: person.theme || 'ops',
      color: person.color || '#8A8FA3',
      reportsTo: person.reportsTo || null,
      private: priv,
      status: 'idle',
      activity: priv ? 'Idle' : 'Free for a new task',
      privateDetail: priv ? {} : null,
    }));
  }
}
seedRoster();

function reportsToName(agent) {
  if (!agent.reportsTo) return null;
  const id = String(agent.reportsTo).includes(':') ? agent.reportsTo : officeId(agent.reportsTo);
  return agents.get(id)?.name || null;
}

// Public projections never carry privateDetail, private task titles, or private activity text.
function viewAgent(agent) {
  const { log = [], privateDetail, tasks, ...rest } = agent;
  const view = {
    ...rest,
    reportsToName: reportsToName(agent),
    log: log.slice(-25).map((e) => (agent.private ? { ...e, text: '' } : e)),
  };
  delete view.privateDetail;
  if (agent.private) {
    view.activity = STATUS_WORD[agent.status] || 'Idle';
    view.detail = '';
    view.task = null;
    view.tasks = null;
    view.pending = agent.pending
      ? { id: agent.pending.id, kind: agent.pending.kind || 'question', title: 'Needs you', detail: '', canResolve: !!agent.pending.canResolve, createdAt: agent.pending.createdAt }
      : null;
  } else {
    view.tasks = Array.isArray(tasks) ? tasks.filter((t) => !t?.private) : null;
  }
  return view;
}

function broadcast(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients.keys()) res.write(frame);
}

function pushFeed(agent, text, status) {
  const entry = { ts: Date.now(), agentId: agent.id, name: agent.name, color: agent.color, status, text: agent.private ? '' : text };
  agent.log.push(entry);
  if (agent.log.length > 60) agent.log.splice(0, agent.log.length - 60);
  feed.push(entry);
  if (feed.length > 200) feed.splice(0, feed.length - 200);
  broadcast('feed', entry);
}

function setStatus(agent, patch, { log = true } = {}) {
  const prevStatus = agent.status, prevActivity = agent.activity;
  Object.assign(agent, patch, { updatedAt: Date.now() });
  if (agent.status !== prevStatus) agent.since = Date.now();
  if (WORKING.has(agent.status) || agent.status === 'needs_you') agent.activeAt = Date.now();
  if (log && (agent.status !== prevStatus || agent.activity !== prevActivity) && agent.activity) {
    pushFeed(agent, agent.activity, agent.status);
  }
  broadcast('agent', viewAgent(agent));
}

function removeAgent(id) {
  if (agents.delete(id)) broadcast('remove', { id });
}

// Studio chats (Claude, Codex) only get a panel on their studio's monitor while they're doing
// something: working, waiting on you, or finished a few seconds ago (long enough to see the check
// mark). The rest rest off screen (`away`), listed in the panel, and come back the moment they wake up.
let floorTimer = null;
function updateFloor() {
  const now = Date.now();
  clearTimeout(floorTimer); floorTimer = null;
  const rank = (a) => (a.pending?.canResolve ? 0 : WORKING.has(a.status) ? 1 : a.status === 'needs_you' ? 2 : 3);
  const ends = [];
  for (const source of Object.keys(STUDIOS)) {
    const max = STUDIOS[source].maxOnFloor ?? MAX_ON_FLOOR;
    const wanted = [...agents.values()]
      .filter((a) => a.source === source && (rank(a) < 3 || now - (a.activeAt || 0) < LINGER_MS))
      .sort((a, b) => rank(a) - rank(b) || (b.activeAt || 0) - (a.activeAt || 0));
    // Approvals always get a panel (you'll want to click them); everyone else shares the screen.
    const floor = new Set(wanted.filter((a, i) => rank(a) === 0 || i < max).map((a) => a.id));
    for (const a of agents.values()) {
      if (a.source !== source) continue;
      const away = !floor.has(a.id);
      if (a.away !== away) { a.away = away; broadcast('agent', viewAgent(a)); }
    }
    ends.push(...wanted.filter((a) => rank(a) === 3).map((a) => (a.activeAt || 0) + LINGER_MS - now));
  }
  // Put a finished chat away right when its linger ends, not at the next scan.
  if (ends.length) floorTimer = setTimeout(updateFloor, Math.max(250, Math.min(...ends) + 50));
}

// One normalized event shape for every adapter:
// { agentId, name?, role?, theme?, color?, source?, cwd?, status, activity?, detail?,
//   task?, pending?: { id, title, detail, kind, canResolve }, clearPending?, remove? }
function ingest(ev) {
  if (!ev || typeof ev.agentId !== 'string') throw new Error('agentId required');
  if (ev.remove) { if (isStudio(ev.agentId.split(':')[0])) endedSessions.set(ev.agentId, Date.now()); return removeAgent(ev.agentId); }

  let agent = agents.get(ev.agentId);
  if (!agent) {
    const studio = STUDIOS[ev.source];
    agent = baseAgent(ev.agentId, {
      source: ev.source || 'custom',
      name: studio?.name || ev.name || ev.agentId,
      color: studio?.color || ev.color || '#8A8FA3',
      theme: studio ? ev.source : (ev.theme || 'ops'),
      away: studio ? true : undefined,
      shape: ev.shape || 'blob',
      role: ev.role || (studio ? path.basename(ev.cwd || '') || studio.name : ''),
      private: rosterPrivate.has(ev.agentId) || ev.private === true,
      ...(config.agents?.[ev.agentId] || {}),
    });
    agents.set(agent.id, agent);
  }
  if (rosterPrivate.has(agent.id) || ev.private === true) agent.private = true;
  else if (ev.private === false) agent.private = false;

  if (agent.private) {
    const detail = { ...(agent.privateDetail || {}) };
    if (ev.activity !== undefined) detail.activity = String(ev.activity).slice(0, 160);
    if (ev.detail !== undefined) detail.detail = String(ev.detail).slice(0, 500);
    if (ev.task !== undefined) detail.task = ev.task;
    if (ev.pending) detail.pending = ev.pending;
    agent.privateDetail = detail;
    ev = {
      ...ev,
      activity: ev.activity !== undefined ? (STATUS_WORD[ev.status || agent.status] || 'Idle') : undefined,
      detail: ev.detail !== undefined ? '' : undefined,
      task: ev.task !== undefined ? null : undefined,
      pending: ev.pending ? { id: ev.pending.id, kind: ev.pending.kind || 'question', title: 'Needs you', detail: '', canResolve: !!ev.pending.canResolve } : ev.pending,
    };
  }

  if (ev.viaHook) agent.lastHookAt = Date.now();
  const patch = {};
  for (const k of ['name', 'role', 'theme', 'shape', 'cwd', 'detail', 'task', 'reportsTo']) if (ev[k] !== undefined) patch[k] = ev[k];
  if (ev.status) patch.status = ev.status;
  if (ev.activity !== undefined) patch.activity = String(ev.activity).slice(0, 160);

  if (ev.pending && dismissed.has(ev.pending.id)) {
    Object.assign(patch, calm(agent));
  } else if (ev.pending) {
    patch.pending = { createdAt: Date.now(), kind: 'approval', canResolve: false, ...ev.pending };
    patch.status = 'needs_you';
    if (ev.pending.canResolve && ev.pending.id && !decisions.has(ev.pending.id)) {
      decisions.set(ev.pending.id, { agentId: agent.id, decision: null, waiters: [] });
    }
  } else if (ev.clearPending || (agent.pending && ev.status && ev.status !== 'needs_you')) {
    if (agent.pending?.id) resolveDecision(agent.pending.id, null, { fromAgent: true });
    patch.pending = null;
  }
  // Hook ids like "<session>:question" repeat, so once the agent moves on, a new question can show again.
  if (!ev.pending && ev.status && ev.status !== 'needs_you') {
    for (const k of dismissed.keys()) if (k.startsWith(`${agent.id.replace(/^\w+:/, '')}:`)) dismissed.delete(k);
  }
  setStatus(agent, patch);
  if (isStudio(agent.source)) updateFloor();
}

// "I don't need to act on this": clear the question without answering it.
function dismiss(agentId) {
  const agent = agents.get(agentId);
  if (!agent?.pending) return false;
  const p = agent.pending;
  dismissed.set(p.id, Date.now());
  dismissed.set(`@${agent.id}`, Date.now());
  if (p.canResolve) { dismissed.set(`${p.id}:terminal`, Date.now()); resolveDecision(p.id, null, { fromAgent: true }); }
  saveDismissed();
  pushFeed(agent, `You dismissed: ${p.title}`, 'idle');
  setStatus(agent, calm(agent), { log: false });
  return true;
}

function resolveDecision(id, decision, { fromAgent = false } = {}) {
  const d = decisions.get(id);
  if (!d) return false;
  d.decision = decision;
  for (const w of d.waiters) w(decision);
  d.waiters = [];
  setTimeout(() => decisions.delete(id), 60_000);
  const agent = agents.get(d.agentId);
  if (agent && !fromAgent && agent.pending?.id === id) {
    setStatus(agent, {
      pending: null,
      status: decision === 'allow' ? 'working' : 'thinking',
      activity: decision === 'allow' ? `You approved: ${agent.pending.title}` : `You declined: ${agent.pending.title}`,
    });
  }
  return true;
}

// Keep the picture honest when an agent goes quiet without telling us.
setInterval(() => {
  const now = Date.now();
  for (const a of agents.values()) {
    const age = now - a.updatedAt;
    if (a.source === 'grok') continue; // the Grok watcher keeps these honest itself
    if (a.source === 'roster' || a.source === 'ledger') continue; // the ledger snapshot is the status
    if (isStudio(a.source) && !a.id.includes(':demo')) continue; // the session readers handle these
    if (WORKING.has(a.status) && age > QUIET_MS) setStatus(a, { status: 'idle', activity: 'Quiet for a while' });
    else if (a.status === 'done' && age > 45_000) setStatus(a, calm(a), { log: false });
  }
  updateFloor();
}, 10_000);

// Cache adapters are loaded only when that adapter is enabled. feedOnly never reaches these.
const PRIVATE = new Set((config.grok?.private || []).map((n) => n.toLowerCase()));
function syncGrok(readGrokBots, grokAppRunning) {
  const running = grokAppRunning();
  const seen = new Set();
  for (const bot of readGrokBots({ private: PRIVATE, primary: config.grok?.primary })) {
    seen.add(bot.id);
    const { status, activity, pending, task, grokId, pinned, ...profile } = bot;
    const fields = { ...profile, source: 'grok', ...(config.agents?.[`grok:${bot.name}`] || {}) };
    const live = running
      ? { status, activity, task, pending: pending ? { createdAt: Date.now(), ...pending } : null }
      : { status: 'offline', activity: 'Open the Grok Bot app to see live status', task, pending: null };
    let agent = agents.get(bot.id);
    const isNew = !agent;
    if (isNew) { agent = baseAgent(bot.id, fields); agents.set(bot.id, agent); }
    const profileChanged = Object.entries(fields).some(([k, v]) => JSON.stringify(agent[k]) !== JSON.stringify(v));
    Object.assign(agent, fields);
    if (isDismissed(agent, live.pending)) Object.assign(live, calm(agent));
    if (agent.pending && live.pending?.id === agent.pending.id) live.pending = agent.pending; // keep when it first appeared
    const changed = isNew || profileChanged || agent.status !== live.status || agent.activity !== live.activity
      || agent.pending?.id !== live.pending?.id || JSON.stringify(agent.task) !== JSON.stringify(live.task);
    if (changed) setStatus(agent, live, { log: !isNew || live.status !== 'idle' });
  }
  for (const a of [...agents.values()]) if (a.source === 'grok' && !seen.has(a.id)) removeAgent(a.id);
}

// Claude Code and Codex sessions, read from each tool's own local session files
// (adapters/claude-code/sessions.mjs, adapters/codex/sessions.mjs). Works with no setup. When the
// hooks are installed they send faster, richer updates (and Approve/Decline), so a session's hook
// events win for 30 s after each one.
function syncStudio(source, sessions) {
  const studio = STUDIOS[source], seen = new Set();
  for (const sess of sessions) {
    if (endedSessions.has(sess.id) && sess.lastAt < endedSessions.get(sess.id) + 5000) continue; // closed, don't bring it back
    seen.add(sess.id);
    let agent = agents.get(sess.id);
    const isNew = !agent;
    if (isNew) {
      agent = baseAgent(sess.id, { source, name: studio.name, color: studio.color, theme: source, away: true });
      agents.set(sess.id, agent);
    }
    const role = clipTitle(sess.title) || sess.project;
    const profile = { role, cwd: sess.cwd || agent.cwd, lastAt: sess.lastAt, activeAt: Math.max(agent.activeAt || 0, sess.lastAt || 0) };
    const hookFresh = Date.now() - (agent.lastHookAt || 0) < 30_000;
    const live = hookFresh ? {} : { status: sess.status, activity: sess.activity, task: sess.task, pending: sess.pending || (agent.pending?.canResolve ? agent.pending : null) };
    if (isDismissed(agent, live.pending, sess.lastAt)) Object.assign(live, calm(agent));
    if (live.pending && agent.pending?.id === live.pending.id) live.pending = agent.pending;
    const changed = isNew || agent.role !== role || (!hookFresh && (agent.status !== live.status || agent.activity !== live.activity || agent.pending?.id !== live.pending?.id || JSON.stringify(agent.task) !== JSON.stringify(live.task)));
    if (changed) setStatus(agent, { ...profile, ...live }, { log: !isNew || live.status !== 'idle' });
    else Object.assign(agent, profile);
  }
  for (const a of [...agents.values()]) {
    if (a.source === source && !seen.has(a.id) && !a.id.includes(':demo') && Date.now() - (a.lastHookAt || 0) > 60_000) removeAgent(a.id);
  }
  updateFloor();
}
const clipTitle = (t) => { t = String(t || '').trim(); return t.length > 32 ? t.slice(0, 31) + '…' : t; };

let usage = null;

function publicTask(t) {
  if (!t || t.private) return null;
  const out = { title: t.title };
  if (t.id) out.id = t.id;
  if (t.status) out.status = t.status;
  if (t.owner) out.owner = t.owner;
  if (t.updatedAt !== undefined) out.updatedAt = t.updatedAt;
  return out;
}

function applyLedger(rows) {
  for (const row of rows) {
    const id = officeId(row.id);
    let agent = agents.get(id);
    const isNew = !agent;
    if (!agent) {
      agent = baseAgent(id, { source: 'ledger', name: row.name || row.id, private: row.private === true });
      agents.set(id, agent);
    }
    if (rosterPrivate.has(id) || row.private === true) agent.private = true;
    else if (row.private === false) agent.private = false;
    const beforeDetail = JSON.stringify(agent.privateDetail || null);
    const patch = {};
    for (const k of ['name', 'role', 'theme', 'color', 'reportsTo']) if (row[k] !== undefined) patch[k] = row[k];
    if (row.status) patch.status = row.status;
    if (row.updatedAt !== undefined) patch.ledgerAt = row.updatedAt;
    if (agent.private) {
      const detail = { ...(agent.privateDetail || {}) };
      if (row.activity !== undefined) detail.activity = row.activity;
      if (row.tasks) {
        detail.tasks = row.tasks;
        detail.task = row.tasks.length === 1 ? row.tasks[0] : null;
      }
      agent.privateDetail = detail;
      agent.tasks = null;
      patch.task = null;
      patch.detail = '';
      if (row.status || row.activity !== undefined) patch.activity = STATUS_WORD[row.status || agent.status] || 'Idle';
    } else {
      if (row.activity !== undefined) patch.activity = row.activity;
      if (row.tasks) {
        const pub = row.tasks.map(publicTask).filter(Boolean);
        const hidden = row.tasks.filter((t) => t.private);
        agent.tasks = pub;
        patch.task = pub.length === 1 ? pub[0] : null;
        const nextDetail = { ...(agent.privateDetail || {}) };
        if (hidden.length) nextDetail.tasks = hidden;
        else delete nextDetail.tasks;
        agent.privateDetail = Object.keys(nextDetail).length ? nextDetail : null;
      }
    }
    agent.fromLedger = true;
    const changed = isNew || Object.entries(patch).some(([k, v]) => JSON.stringify(agent[k]) !== JSON.stringify(v));
    const detailChanged = JSON.stringify(agent.privateDetail || null) !== beforeDetail;
    if (changed || detailChanged) {
      setStatus(agent, patch, { log: !isNew && (!!patch.status || (!agent.private && patch.activity !== undefined)) });
    }
  }
}

function ledgerPath() {
  const p = config.ledger?.path ?? config.ledgerPath;
  if (!p || typeof p !== 'string') return null;
  const expanded = expand(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
}

let ledgerNote = null;
function startLedger() {
  const file = ledgerPath();
  if (!file) return;
  watchLedger(file, (rows, err) => {
    if (err) {
      const sig = `${err.code || ''}:${err.message}`;
      if (sig !== ledgerNote) {
        ledgerNote = sig;
        if (err.code === 'ENOENT') console.log(`Ledger file not found (${file}). Roster only, until it appears.`);
        else console.log(`Ledger not loaded: ${err.code === 'EBADLEDGER' ? err.message : 'invalid JSON'}`);
      }
      return;
    }
    ledgerNote = null;
    applyLedger(rows);
  });
}

async function startAdapters() {
  if (adapterEnabled('grok')) {
    const { readGrokBots, watchGrokBots, grokAppRunning } = await import('./adapters/grok/watch.mjs');
    watchGrokBots(() => syncGrok(readGrokBots, grokAppRunning));
  }
  if (adapterEnabled('claude')) {
    const { readClaudeSessions, watchClaudeSessions } = await import('./adapters/claude-code/sessions.mjs');
    watchClaudeSessions(() => syncStudio('claude', readClaudeSessions({ activeMs: FORGET_MS })));
  }
  const codexMode = codexDesired();
  if (codexMode !== 'off') {
    const { readCodexSessions, watchCodexSessions, codexInstalled } = await import('./adapters/codex/sessions.mjs');
    codexOn = codexMode === 'on' || codexInstalled();
    if (codexOn) watchCodexSessions(() => syncStudio('codex', readCodexSessions({ activeMs: FORGET_MS })));
  }
  if (adapterEnabled('usage')) {
    const { watchUsage } = await import('./adapters/usage.mjs');
    watchUsage((u) => { usage = u; broadcast('usage', u); });
  }
}

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ttf': 'font/ttf', '.txt': 'text/plain' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 256_000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  // Refuse DNS-rebinding: only answer to our own loopback host names.
  const host = (req.headers.host || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return json(res, 403, { error: 'bad host' });

  const url = new URL(req.url, 'http://x');
  const authed = req.headers['x-office-token'] === TOKEN;

  try {
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ agents: [...agents.values()].map(viewAgent), feed: feed.slice(-60), usage, config: { studios: STUDIOS, wings: wings(), feedOnly: FEED_ONLY } })}\n\n`);
      clients.set(res, { id: url.searchParams.get('client') || crypto.randomUUID(), visible: url.searchParams.get('visible') === '1' });
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!authed) return json(res, 401, { error: 'missing x-office-token' });

      if (req.method === 'POST' && url.pathname === '/api/event') {
        const body = await readBody(req);
        for (const ev of Array.isArray(body) ? body : [body]) ingest(ev);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/decision') {
        const { id, decision } = await readBody(req);
        if (!['allow', 'deny'].includes(decision)) return json(res, 400, { error: 'decision must be allow or deny' });
        return json(res, resolveDecision(id, decision) ? 200 : 404, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/dismiss') {
        const { agentId } = await readBody(req);
        return json(res, dismiss(agentId) ? 200 : 404, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/presence') {
        const { client, visible } = await readBody(req);
        for (const c of clients.values()) if (c.id === client) c.visible = !!visible;
        return json(res, 200, { visibleViewers: visibleViewers() });
      }
      // Long-poll used by the Claude Code PermissionRequest hook.
      if (req.method === 'GET' && url.pathname.startsWith('/api/decision/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/decision/'.length));
        const wait = Math.min(Number(url.searchParams.get('wait') || 0), 600) * 1000;
        const d = decisions.get(id);
        if (!d) return json(res, 404, { decision: null });
        if (d.decision || !wait) return json(res, 200, { decision: d.decision });
        const timer = setTimeout(() => finish(null), wait);
        const finish = (decision) => { clearTimeout(timer); json(res, 200, { decision }); };
        d.waiters.push(finish);
        req.on('close', () => { clearTimeout(timer); d.waiters = d.waiters.filter((w) => w !== finish); });
        return;
      }
      // The office floor plan (its size and every piece of furniture), saved by the page.
      if (url.pathname === '/api/layout') {
        if (req.method === 'GET') { try { return json(res, 200, JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8'))); } catch { return json(res, 200, null); } }
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (!body || !Array.isArray(body.items)) return json(res, 400, { error: 'layout needs items' });
          fs.writeFileSync(LAYOUT_FILE, JSON.stringify(body));
          return json(res, 200, { ok: true });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/viewers') return json(res, 200, { viewers: clients.size, visibleViewers: visibleViewers() });
      if (req.method === 'GET' && url.pathname.startsWith('/api/private/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/private/'.length));
        const agent = agents.get(id);
        if (!agent) return json(res, 404, { error: 'not found' });
        if (!agent.private && !agent.privateDetail) return json(res, 200, { private: false });
        const detail = agent.privateDetail || {};
        return json(res, 200, {
          private: !!agent.private,
          id: agent.id,
          name: agent.name,
          status: agent.status,
          updatedAt: agent.updatedAt,
          ledgerAt: agent.ledgerAt || null,
          detail: {
            activity: detail.activity,
            task: detail.task || null,
            tasks: detail.tasks || null,
            pending: detail.pending || null,
            detail: detail.detail,
          },
        });
      }
      return json(res, 404, { error: 'not found' });
    }

    // Static files. index.html gets the token injected (same-origin pages only can read it).
    let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'nope' });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: 'not found' });
    let data = fs.readFileSync(file);
    if (file.endsWith('index.html')) data = data.toString('utf8').replace('__OFFICE_TOKEN__', TOKEN).replace('__OFFICE_WINGS__', wings().join(' '));
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch (err) {
    json(res, 400, { error: String(err.message || err) });
  }
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log(`Head Office is already running at http://127.0.0.1:${PORT} — just open that link.`);
  console.log(`(To run a fresh copy, stop the other one first, or start this one with OFFICE_PORT=4318 npm start.)`);
  process.exit(0);
});

async function boot() {
  startLedger();
  await startAdapters();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Head Office is open at http://127.0.0.1:${PORT}`);
    console.log(`  agents on the roster: ${[...agents.values()].map((a) => a.name).join(', ') || '(none yet)'}`);
    if (FEED_ONLY) console.log('  feed-only: cache adapters are off');
    if (codexOn) console.log('  Codex found: the OpenAI wing is open');
  });
}
boot();
