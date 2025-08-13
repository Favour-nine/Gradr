// db.js
const Database = require("better-sqlite3");

// Allow overriding DB location (e.g., absolute path in production)
const DB_PATH = process.env.DB_PATH || process.env.DB_FILE || "gradr.db";
const db = new Database(DB_PATH);

// --- Performance/robustness PRAGMAs ---
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");     // good balance of durability & speed
db.pragma("temp_store = MEMORY");
db.pragma("foreign_keys = ON");
db.pragma("mmap_size = 268435456");    // 256 MB; adjust via env if needed
db.pragma("cache_size = -16000");      // ~16MB page cache (negative => KB)

// tables
db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    folder TEXT PRIMARY KEY,
    last_serial INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder TEXT NOT NULL,
    image_path TEXT NOT NULL,
    text_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',         -- queued | processing | done | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), -- epoch seconds
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Existing index
  CREATE INDEX IF NOT EXISTS jobs_status_idx
    ON jobs(status, available_at);

  -- Help the claimant ordering (priority, available_at, id)
  CREATE INDEX IF NOT EXISTS jobs_claim_idx
    ON jobs(status, available_at, priority, id);

  -- Speed up folder views
  CREATE INDEX IF NOT EXISTS jobs_folder_idx
    ON jobs(folder);

  CREATE INDEX IF NOT EXISTS jobs_folder_status_idx
    ON jobs(folder, status);
`);

// ---------- serial helpers ----------
const upsertFolder = db.prepare(`
  INSERT INTO folders(folder, last_serial) VALUES(?, 0)
  ON CONFLICT(folder) DO NOTHING;
`);
const incSerial = db.prepare(`
  UPDATE folders SET last_serial = last_serial + 1 WHERE folder = ?;
`);
const getSerial = db.prepare(`
  SELECT last_serial FROM folders WHERE folder = ?;
`);

function nextSerial(folder) {
  const tx = db.transaction((f) => {
    upsertFolder.run(f);
    incSerial.run(f);
    const row = getSerial.get(f);
    return row.last_serial;
  });
  return tx(folder);
}

// ---------- job helpers ----------
const insertJob = db.prepare(`
  INSERT INTO jobs (folder, image_path, text_path, status, attempts, priority, available_at)
  VALUES (@folder, @image_path, @text_path, 'queued', 0, @priority, @available_at)
`);

function enqueueJob(folder, image_path, text_path, priority = 0, delaySeconds = 0) {
  insertJob.run({
    folder,
    image_path,
    text_path,
    priority,
    available_at: Math.floor(Date.now() / 1000) + delaySeconds
  });
}

// Requeue any "processing" jobs that look stuck (no update for N seconds)
const STALE_SECS = Number(process.env.WORKER_STALE_SECS || 15 * 60); // default 15 min
const requeueStaleStmt = db.prepare(`
  UPDATE jobs
  SET status = 'queued',
      available_at = strftime('%s','now'),
      updated_at = strftime('%s','now'),
      last_error = COALESCE(last_error, '') || CASE WHEN last_error IS NULL OR last_error = '' THEN '' ELSE '\n' END || '[auto] requeued stale processing job'
  WHERE status = 'processing'
    AND updated_at <= (strftime('%s','now') - @stale)
`);

function requeueStaleJobs(staleSeconds = STALE_SECS) {
  return requeueStaleStmt.run({ stale: staleSeconds }).changes;
}

const claimStmt = db.prepare(`
  SELECT id, folder, image_path, text_path, attempts
  FROM jobs
  WHERE status='queued' AND available_at <= strftime('%s','now')
  ORDER BY priority DESC, available_at ASC, id ASC
  LIMIT @limit
`);

const markProcessing = db.prepare(`
  UPDATE jobs
  SET status='processing',
      updated_at=strftime('%s','now')
  WHERE id=@id AND status='queued'
`);

function claimJobs(limit) {
  const tx = db.transaction((lim) => {
    // First, opportunistically requeue stale "processing" jobs
    requeueStaleJobs();

    const rows = claimStmt.all({ limit: lim });
    const claimed = [];
    for (const r of rows) {
      const res = markProcessing.run({ id: r.id });
      if (res.changes === 1) claimed.push(r);
    }
    return claimed;
  });
  return tx(limit);
}

const markDone = db.prepare(`
  UPDATE jobs
  SET status='done',
      updated_at=strftime('%s','now'),
      last_error=NULL
  WHERE id=@id
`);

const markFail = db.prepare(`
  UPDATE jobs
  SET status = CASE WHEN @final=1 THEN 'failed' ELSE 'queued' END,
      attempts = attempts + 1,
      last_error = @err,
      available_at = @next_time,
      updated_at = strftime('%s','now')
  WHERE id=@id
`);

function completeJob(id) {
  markDone.run({ id });
}

function failJob(id, attempts, err, maxAttempts, backoffSeconds) {
  const final = attempts + 1 >= maxAttempts ? 1 : 0;
  const next_time = final
    ? Math.floor(Date.now() / 1000)
    : Math.floor(Date.now() / 1000) + backoffSeconds;
  markFail.run({
    id,
    err: String(err).slice(0, 2000),
    final,
    next_time
  });
}

const getJobStmt = db.prepare(`SELECT * FROM jobs WHERE id = ?`);
const listJobsByFolderStmt = db.prepare(`
  SELECT * FROM jobs
  WHERE folder = ?
  ORDER BY id DESC
  LIMIT @limit OFFSET @offset
`);
const countsByFolderStmt = db.prepare(`
  SELECT status, COUNT(*) as cnt
  FROM jobs
  WHERE folder=?
  GROUP BY status
`);

function getJob(id) { return getJobStmt.get(id); }
function listJobsByFolder(folder, limit=50, offset=0) {
  return listJobsByFolderStmt.all({ 0: folder, limit, offset });
}
function jobCounts(folder) { return countsByFolderStmt.all(folder); }

// Optional maintenance helpers
const purgeDoneStmt = db.prepare(`
  DELETE FROM jobs WHERE status='done' AND updated_at <= (strftime('%s','now') - @age)
`);
const purgeFailedStmt = db.prepare(`
  DELETE FROM jobs WHERE status='failed' AND updated_at <= (strftime('%s','now') - @age)
`);

function purgeOldJobs(days = 7) {
  const age = days * 24 * 60 * 60;
  const tx = db.transaction(() => {
    const d = purgeDoneStmt.run({ age }).changes;
    const f = purgeFailedStmt.run({ age }).changes;
    return { deletedDone: d, deletedFailed: f };
  });
  return tx();
}

module.exports = {
  nextSerial,
  enqueueJob,
  claimJobs,
  completeJob,
  failJob,
  getJob,
  listJobsByFolder,
  jobCounts,
  requeueStaleJobs,   // exported for visibility (optional)
  purgeOldJobs,       // optional maintenance
  db
};
