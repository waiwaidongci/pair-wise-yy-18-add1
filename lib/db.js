const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { randomUUID } = require('crypto');
const config = require('../project.config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let db = null;

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
  } finally {
    stmt.free();
  }
}

function all(sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function getOne(sql, params = []) {
  return all(sql, params)[0] || null;
}

function transaction(work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    persist();
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function now() {
  return new Date().toISOString();
}

function newId() {
  return randomUUID();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function toRecord(row) {
  if (!row) return null;
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) throw httpError(404, 'unknown collection: ' + name);
  return collection;
}

function validateRequired(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === ''
  );
  if (missing.length) throw httpError(400, '缺少必填字段: ' + missing.join(', '));
}

function addEvent({ recordId, collection, action, status, actor, note, data }) {
  run(
    `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [newId(), recordId, collection, action || '记录', status || '', actor || '', note || '', JSON.stringify(data || {}), now()]
  );
}

function insertRecord(collection, { id, status, data, action, actor, note }) {
  const collectionConfig = findCollection(collection);
  const recordId = id || newId();
  const createdAt = now();
  run(
    `INSERT INTO records (id, collection, status, title, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
    [recordId, collection, status, titleFor(collectionConfig, data), JSON.stringify(data), createdAt, createdAt]
  );
  addEvent({ recordId, collection, action: action || '创建', status, actor, note, data });
  return getRecord(collection, recordId);
}

function updateRecord(collection, id, data, status, event) {
  const collectionConfig = findCollection(collection);
  run(
    `UPDATE records SET status = ?, title = ?, data = ?, updated_at = ?
     WHERE collection = ? AND id = ?;`,
    [status, titleFor(collectionConfig, data), JSON.stringify(data), now(), collection, id]
  );
  if (event) {
    addEvent({
      recordId: id,
      collection,
      action: event.action || '更新',
      status,
      actor: event.actor || '',
      note: event.note || '',
      data: event.data || {}
    });
  }
  return getRecord(collection, id);
}

function getRecord(collection, id) {
  return toRecord(
    getOne('SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;', [collection, id])
  );
}

function listRecords(collection) {
  return all('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;', [collection]).map(toRecord);
}

function listEvents(recordId) {
  return all('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC;', [recordId]).map((event) => ({
    id: event.id,
    action: event.action,
    status: event.status,
    actor: event.actor,
    note: event.note,
    data: JSON.parse(event.data || '{}'),
    createdAt: event.created_at
  }));
}

function seedDatabase() {
  const count = getOne('SELECT COUNT(*) AS count FROM records;').count;
  if (count > 0) return;

  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    insertRecord(seed.collection, {
      id: seed.id || newId(),
      status,
      data,
      action: seed.eventAction || '创建',
      actor: seed.actor || 'system',
      note: seed.note || ''
    });
  }
}

async function init() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
  });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
  db.exec(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
`);
  seedDatabase();
  persist();
}

module.exports = {
  init,
  run,
  all,
  getOne,
  transaction,
  persist,
  now,
  newId,
  httpError,
  toRecord,
  findCollection,
  validateRequired,
  titleFor,
  addEvent,
  insertRecord,
  updateRecord,
  getRecord,
  listRecords,
  listEvents
};
