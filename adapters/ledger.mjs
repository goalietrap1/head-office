// External task ledger. Reads one JSON snapshot and watches it for changes.
// Fields that are absent stay absent: this module never fills in a title, status, or owner.

import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_STATUSES = new Set([
  'thinking', 'coding', 'terminal', 'browsing', 'reading', 'working', 'delegating',
  'needs_you', 'error', 'done', 'idle', 'offline',
]);

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function taskOf(row) {
  if (!row || typeof row !== 'object') return null;
  const title = text(row.title);
  if (!title) return null;
  const task = { title };
  const id = text(row.id);
  if (id) task.id = id;
  if (typeof row.status === 'string' && LEDGER_STATUSES.has(row.status)) task.status = row.status;
  const owner = text(row.owner);
  if (owner) task.owner = owner;
  if (typeof row.updatedAt === 'string' || typeof row.updatedAt === 'number') task.updatedAt = row.updatedAt;
  if (row.private === true) task.private = true;
  return task;
}

function agentOf(row) {
  if (!row || typeof row !== 'object') return null;
  const id = text(row.id);
  if (!id) return null;
  const agent = { id };
  const name = text(row.name);
  if (name) agent.name = name;
  const role = text(row.role);
  if (role) agent.role = role;
  const theme = text(row.theme);
  if (theme) agent.theme = theme;
  const color = text(row.color);
  if (color) agent.color = color;
  if (row.reportsTo === null) agent.reportsTo = null;
  else {
    const reportsTo = text(row.reportsTo);
    if (reportsTo) agent.reportsTo = reportsTo;
  }
  if (typeof row.private === 'boolean') agent.private = row.private;
  if (typeof row.status === 'string' && LEDGER_STATUSES.has(row.status)) agent.status = row.status;
  if (typeof row.activity === 'string') agent.activity = row.activity.slice(0, 160);
  if (typeof row.updatedAt === 'string' || typeof row.updatedAt === 'number') agent.updatedAt = row.updatedAt;
  if (Array.isArray(row.tasks)) agent.tasks = row.tasks.map(taskOf).filter(Boolean);
  return agent;
}

// Accepts `{ version, agents: [...] }` or a bare array. Throws if the file is not a snapshot.
export function readLedger(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.agents) ? raw.agents : null;
  if (!list) {
    const err = new Error('ledger needs an agents array');
    err.code = 'EBADLEDGER';
    throw err;
  }
  return list.map(agentOf).filter(Boolean);
}

// fs.watch on the parent directory, plus one read now. No interval.
export function watchLedger(file, onChange) {
  let timer = null;
  let watcher = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { onChange(readLedger(file), null); }
      catch (err) { onChange(null, err); }
    }, 80);
  };
  try {
    watcher = fs.watch(path.dirname(file), (_, name) => {
      if (name && name !== path.basename(file)) return;
      fire();
    });
  } catch (err) {
    onChange(null, err);
    return () => {};
  }
  fire();
  return () => { clearTimeout(timer); watcher?.close(); };
}
