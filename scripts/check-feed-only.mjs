#!/usr/bin/env node
// Isolated checks for feed-only mode. Uses a temporary HOME and never the real one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedger } from '../adapters/ledger.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_HOME = os.homedir();
const results = [];
const pass = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function writeTraceHook(file) {
  const hook = `${file}.mjs`;
  fs.writeFileSync(hook, `import fs from 'node:fs';
const logFile = process.env.TRACE_FILE;
const orig = {
  readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, openSync: fs.openSync,
  watch: fs.watch, existsSync: fs.existsSync, statSync: fs.statSync,
};
function note(op, p) {
  if (typeof p !== 'string' || !logFile || p === logFile) return;
  if (p.startsWith('/usr') || p.startsWith('/dev') || p.startsWith('/proc') || p.startsWith('/sys') || p.startsWith('/lib')) return;
  try { fs.appendFileSync(logFile, op + '\\t' + p + '\\n'); } catch {}
}
for (const name of Object.keys(orig)) {
  fs[name] = function (p, ...rest) { note(name, p); return orig[name].apply(this, [p, ...rest]); };
}
`);
  return hook;
}

function startServer({ home, port, config, trace }) {
  const hook = writeTraceHook(trace);
  fs.writeFileSync(trace, '');
  const child = spawn(process.execPath, ['--import', hook, 'server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      OFFICE_PORT: String(port),
      OFFICE_CONFIG: config || path.join(ROOT, 'office.config.json'),
      TRACE_FILE: trace,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${log}`)), 8000);
    child.stdout.on('data', () => { if (log.includes('Head Office is open')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}\n${log}`)); });
  });
  return { child, ready, log: () => log, stop() { child.kill('SIGTERM'); } };
}

function getRaw(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function postJson(port, pathname, body, headers = {}) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function snapshot(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/stream?client=check&visible=0' }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const m = buf.match(/event: snapshot\ndata: (.*)\n/);
        if (m) { req.destroy(); resolve({ raw: buf, data: JSON.parse(m[1]) }); }
      });
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('snapshot timeout')); }, 4000);
  });
}

async function waitFor(port, pred, label) {
  let last;
  for (let i = 0; i < 30; i++) {
    last = await snapshot(port);
    if (pred(last.data, last.raw)) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function listenLines(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const hit = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => {
    const cols = l.trim().split(/\s+/);
    return cols[1]?.endsWith(':' + hex) && cols[3] === '0A';
  });
  return { v4: hit('/proc/net/tcp'), v6: hit('/proc/net/tcp6') };
}

function tracePaths(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')[1]).filter(Boolean);
}

const CACHE_MARK = ['Application Support', 'Grok Bot', 'sand-client', '.claude', '.codex', 'plan-usage', 'adapters/grok', 'adapters/claude-code', 'adapters/codex', 'adapters/usage'];

function unitLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-unit-'));
  const file = path.join(dir, 'ledger.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    agents: [
      { id: 'doug', tasks: [{ title: 'Open the shop', status: 'working', owner: 'doug' }, { status: 'done' }, { title: '' }] },
      { tasks: [{ title: 'no id' }] },
      { id: 'vita', private: true, activity: 'keep me', tasks: [{ title: 'noted', owner: 'vita' }] },
    ],
  }));
  const rows = readLedger(file);
  pass('ledger reader drops tasks with no title', rows.find((a) => a.id === 'doug').tasks.length === 1, JSON.stringify(rows.find((a) => a.id === 'doug').tasks));
  pass('ledger reader keeps owner and status', rows.find((a) => a.id === 'doug').tasks[0].owner === 'doug' && rows.find((a) => a.id === 'doug').tasks[0].status === 'working');
  pass('ledger reader drops rows with no id', rows.every((a) => a.id));
  pass('ledger reader does not add a missing status', !('status' in rows.find((a) => a.id === 'vita')));
  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  unitLedger();
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'office.config.json'), 'utf8'));
  const names = shipped.roster.map((p) => p.name).join(',');
  pass('shipped roster has the eight assistants', names === 'Jody,Dean,Quinn,Doug,Poppy,Mel,Bell,Vita', names);
  pass('shipped config is feed-only', shipped.feedOnly === true && shipped.adapters.grok === false);
  pass('Quinn reports to Dean in config', shipped.roster.find((p) => p.id === 'quinn').reportsTo === 'dean');
  pass('Bell reports to Mel in config', shipped.roster.find((p) => p.id === 'bell').reportsTo === 'mel');
  pass('Vita is private in config', shipped.roster.find((p) => p.id === 'vita').private === true);

  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-feed-'));
  const traceA = path.join(homeA, 'trace.log');
  const portA = await freePort();
  const serverA = startServer({ home: homeA, port: portA, trace: traceA });
  try {
    await serverA.ready;
    await sleep(6500);
    const snap = await snapshot(portA);
    const ids = snap.data.agents.map((a) => a.id).sort();
    const want = ['bell', 'dean', 'doug', 'jody', 'mel', 'poppy', 'quinn', 'vita'].map((id) => `roster:${id}`).sort();
    pass('feed-only starts and lists eight distinct agents', JSON.stringify(ids) === JSON.stringify(want), ids.join(','));
    const quinn = snap.data.agents.find((a) => a.id === 'roster:quinn');
    const bell = snap.data.agents.find((a) => a.id === 'roster:bell');
    pass('Quinn reports to Dean at runtime', quinn?.reportsTo === 'dean' && quinn?.reportsToName === 'Dean', JSON.stringify({ reportsTo: quinn?.reportsTo, reportsToName: quinn?.reportsToName }));
    pass('Bell reports to Mel at runtime', bell?.reportsTo === 'mel' && bell?.reportsToName === 'Mel');
    pass('feed-only reports feedOnly on the snapshot', snap.data.config.feedOnly === true && snap.data.config.wings.length === 0);
    const paths = tracePaths(traceA);
    const bad = paths.filter((p) => CACHE_MARK.some((m) => p.includes(m)) || p.startsWith(REAL_HOME));
    pass('feed-only opens no cache directories and no adapter modules', bad.length === 0, bad.slice(0, 8).join(' | ') || `${paths.length} traced paths`);
    pass('feed-only trace never used the real home', paths.every((p) => !p.startsWith(REAL_HOME)));

    const lines = listenLines(portA);
    pass('listens on 127.0.0.1 only', lines.v4.length === 1 && lines.v4[0].includes('0100007F:') && lines.v6.length === 0, `v4=${lines.v4.length} v6=${lines.v6.length}`);

    const unauth = await postJson(portA, '/api/event', { agentId: 'custom:nope', status: 'idle' });
    pass('event API rejects a missing token', unauth.status === 401, String(unauth.status));
    const token = fs.readFileSync(path.join(homeA, '.head-office', 'token'), 'utf8').trim();
    const posted = await postJson(portA, '/api/event', { agentId: 'custom:lamp', name: 'Lamp', source: 'custom', status: 'working', activity: 'On' }, { 'x-office-token': token });
    const after = await waitFor(portA, (d) => d.agents.some((a) => a.id === 'custom:lamp' && a.status === 'working'), 'custom agent');
    pass('event API still accepts a posted agent', posted.status === 200 && after.data.agents.some((a) => a.id === 'custom:lamp'), String(posted.status));

    const badHost = await getRaw(portA, '/api/stream', { host: 'evil.example' });
    pass('non-local Host is rejected', badHost.status === 403, String(badHost.status));
  } finally {
    serverA.stop();
    await sleep(200);
  }

  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-ledger-'));
  const traceB = path.join(homeB, 'trace.log');
  const ledgerFile = path.join(homeB, 'hudson-task-ledger.json');
  const sentinel = 'SENTINEL-PRIVATE-MEAL-PLAN';
  fs.writeFileSync(ledgerFile, JSON.stringify({
    version: 1,
    agents: [
      { id: 'jody', status: 'idle', updatedAt: '2026-11-05T18:00:00Z' },
      { id: 'doug', tasks: [{ id: 'shift-1', title: 'Cover the front desk', status: 'working', owner: 'doug', updatedAt: '2026-11-05T18:00:00Z' }] },
    ],
  }));
  const configB = path.join(homeB, 'office.config.json');
  fs.writeFileSync(configB, JSON.stringify({
    ...shipped,
    feedOnly: true,
    adapters: { grok: true, claude: true, codex: true, usage: true },
    ledger: { path: ledgerFile },
  }));
  const portB = await freePort();
  const serverB = startServer({ home: homeB, port: portB, config: configB, trace: traceB });
  try {
    await serverB.ready;
    const loaded = await waitFor(portB, (d) => d.agents.find((a) => a.id === 'roster:doug')?.task?.title === 'Cover the front desk', 'doug task');
    const doug = loaded.data.agents.find((a) => a.id === 'roster:doug');
    pass('ledger task loads with status and owner', doug.task.status === 'working' && doug.task.owner === 'doug' && doug.task.title === 'Cover the front desk');
    pass('ledger does not invent a task for an unlisted assistant', !loaded.data.agents.find((a) => a.id === 'roster:poppy')?.task);

    fs.writeFileSync(ledgerFile, JSON.stringify({
      version: 1,
      agents: [
        { id: 'jody', status: 'working', activity: 'Scheduling the week', updatedAt: '2026-11-05T19:00:00Z', tasks: [{ id: 'day', title: 'Scheduling the week', status: 'working', owner: 'jody' }] },
        { id: 'doug', tasks: [{ id: 'shift-1', title: 'Cover the front desk', status: 'done', owner: 'doug' }] },
        { id: 'vita', private: true, status: 'working', activity: sentinel, tasks: [{ id: 'meal', title: sentinel, status: 'working', owner: 'vita' }] },
      ],
    }));
    const updated = await waitFor(portB, (d) => d.agents.find((a) => a.id === 'roster:jody')?.status === 'working', 'jody update');
    const jody = updated.data.agents.find((a) => a.id === 'roster:jody');
    const vita = updated.data.agents.find((a) => a.id === 'roster:vita');
    pass('ledger file change is reflected', jody.status === 'working' && jody.activity === 'Scheduling the week' && jody.ledgerAt === '2026-11-05T19:00:00Z');
    pass('public snapshot has no Vita private text', !updated.raw.includes(sentinel) && vita.private === true && vita.task == null && vita.activity === 'Working' && !(vita.log || []).some((l) => (l.text || '').includes(sentinel)));
    pass('public feed has no Vita private text', !(updated.data.feed || []).some((f) => JSON.stringify(f).includes(sentinel)));

    const token = fs.readFileSync(path.join(homeB, '.head-office', 'token'), 'utf8').trim();
    const locked = await getRaw(portB, '/api/private/roster%3Avita');
    pass('private feed rejects a missing token', locked.status === 401, String(locked.status));
    const opened = await getRaw(portB, '/api/private/roster%3Avita', { 'x-office-token': token });
    pass('token holder can read Vita\'s private feed', opened.status === 200 && opened.body.includes(sentinel), String(opened.status));

    const leaked = await postJson(portB, '/api/event', {
      agentId: 'roster:vita', status: 'needs_you', activity: `${sentinel}-EVENT`, pending: { id: 'vita-q', title: sentinel, detail: `${sentinel}-DETAIL`, kind: 'question' },
    }, { 'x-office-token': token });
    const afterEvent = await waitFor(portB, (d) => d.agents.find((a) => a.id === 'roster:vita')?.status === 'needs_you', 'vita event');
    pass('posted private event stays out of the public stream', leaked.status === 200 && !afterEvent.raw.includes(`${sentinel}-EVENT`) && !afterEvent.raw.includes(`${sentinel}-DETAIL`));

    await sleep(1000);
    const paths = tracePaths(traceB);
    const bad = paths.filter((p) => CACHE_MARK.some((m) => p.includes(m)) || (p.startsWith(REAL_HOME) && !p.startsWith(homeB)));
    pass('feedOnly wins even if every adapter flag is true', bad.length === 0, bad.slice(0, 6).join(' | '));
  } finally {
    serverB.stop();
    await sleep(200);
  }

  const homeC = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-legacy-'));
  const traceC = path.join(homeC, 'trace.log');
  const configC = path.join(homeC, 'office.config.json');
  fs.writeFileSync(configC, JSON.stringify({ port: 4317, agents: {}, grok: { private: [] }, claude: { maxOnFloor: 6 } }));
  const portC = await freePort();
  const serverC = startServer({ home: homeC, port: portC, config: configC, trace: traceC });
  try {
    await serverC.ready;
    await sleep(1200);
    const paths = tracePaths(traceC);
    const grokDir = path.join(homeC, 'Library', 'Application Support', 'Grok Bot', 'sand-client-persistence');
    const claudeDir = path.join(homeC, '.claude', 'projects');
    const codexDir = path.join(homeC, '.codex');
    const usageFile = path.join(homeC, 'Library', 'Application Support', 'Claude', 'plan-usage-history.json');
    pass('feedOnly false still starts the cache readers', paths.includes(grokDir) && paths.includes(claudeDir) && paths.includes(codexDir) && paths.includes(usageFile));
    pass('legacy readers stay inside the temporary home', paths.every((p) => !p.startsWith(REAL_HOME)));
  } finally {
    serverC.stop();
    await sleep(200);
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
    fs.rmSync(homeC, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
