// worker.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");

const { claimJobs, completeJob, failJob, db } = require("./db");
const { transcribeImageWithGPT } = require("./gptOcrService");

// -------- Tunables (env overrides) --------
const CORES            = os.cpus()?.length || 4;
const CONCURRENCY      = Number(process.env.WORKER_CONCURRENCY || Math.max(4, CORES));
const POLL_MS          = Number(process.env.WORKER_POLL_MS || 500);   // faster loop
const MAX_ATTEMPTS     = Number(process.env.WORKER_MAX_ATTEMPTS || 3);

const BACKOFF_BASE     = Number(process.env.WORKER_BACKOFF_BASE || 5);   // seconds
const BACKOFF_FACTOR   = Number(process.env.WORKER_BACKOFF_FACTOR || 2); // exponential
const BACKOFF_JITTER   = Number(process.env.WORKER_BACKOFF_JITTER || 0.2); // ±20%

function backoffSeconds(attempts) {
  const raw = BACKOFF_BASE * Math.pow(BACKOFF_FACTOR, attempts);
  const jitter = 1 + (Math.random() * 2 - 1) * BACKOFF_JITTER; // 0.8..1.2 by default
  return Math.max(1, Math.floor(raw * jitter));
}

// Prevent overlapping loops if POLL_MS < processing time
let running = false;

async function workOne(job) {
  const { id, image_path, text_path, attempts } = job;
  try {
    if (!fs.existsSync(image_path)) throw new Error("Image missing on disk");

    const transcription = await transcribeImageWithGPT(image_path);
    fs.writeFileSync(text_path, transcription ?? "", "utf-8");

    completeJob(id);
    console.log(`[worker] done job ${id} -> ${path.basename(text_path)}`);
  } catch (e) {
    const backoff = backoffSeconds(attempts); // seconds until re-queue
    failJob(id, attempts, e?.message || String(e), MAX_ATTEMPTS, backoff);
    console.error(
      `[worker] fail job ${id} (attempt ${attempts + 1}/${MAX_ATTEMPTS}) -> retry in ${backoff}s:`,
      e?.message || e
    );
  }
}

async function loop() {
  if (running) return; // avoid re-entrancy
  running = true;
  try {
    const jobs = claimJobs(CONCURRENCY);
    if (!jobs.length) return;
    await Promise.allSettled(jobs.map((j) => workOne(j)));
  } catch (e) {
    console.error("[worker] loop error:", e);
  } finally {
    running = false;
  }
}

console.log(
  `🧵 Worker started (concurrency=${CONCURRENCY}, poll=${POLL_MS}ms, max_attempts=${MAX_ATTEMPTS})`
);
const timer = setInterval(loop, POLL_MS);

// Graceful shutdown so in-flight jobs can finish
function shutdown(sig) {
  console.log(`\n[worker] received ${sig}, shutting down...`);
  clearInterval(timer);
  const wait = () => {
    if (!running) process.exit(0);
    setTimeout(wait, 200);
  };
  wait();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
