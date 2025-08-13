// backend/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { OpenAI } = require("openai");

// DB helpers (your existing job queue + serials)
const {
  nextSerial,
  enqueueJob,
  getJob,
} = require("./db");

// OCR helpers (new file you generated)
const {
  transcribeLayoutWithGPT,
  transcribeImageWithGPT, // still available for plain transcription if needed
} = require("./gptOcrService");

// -------------------- App & Config --------------------
const app = express();
const PORT = process.env.PORT || 5000;
const MAX_FILES = 50;
const SERIAL_PAD = 3;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "2mb" }));

// -------------------- FS Layout -----------------------
const ROOT = __dirname;
const UPLOADS_DIR = path.join(ROOT, "uploads");
const TEMP_DIR = path.join(ROOT, "temp_uploads");
for (const d of [UPLOADS_DIR, TEMP_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
app.use("/uploads", express.static(UPLOADS_DIR));

// “data/” for simple JSON stores
const DATA_DIR = path.join(ROOT, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const RUBRICS_PATH = path.join(DATA_DIR, "rubrics.json");
const ASSESS_PATH  = path.join(DATA_DIR, "assessments.json");
const GRADES_PATH  = path.join(DATA_DIR, "grades.json"); // NEW

for (const f of [RUBRICS_PATH, ASSESS_PATH, GRADES_PATH]) {
  if (!fs.existsSync(f)) {
    const empty =
      f === GRADES_PATH ? { grades: [] } :
      f === RUBRICS_PATH ? { rubrics: [] } :
      { assessments: [] };
    fs.writeFileSync(f, JSON.stringify(empty, null, 2));
  }
}

// -------------------- Helpers -------------------------
const IMAGE_EXTS = new Set([".jpg",".jpeg",".png",".webp",".tif",".tiff",".bmp",".gif"]);

function sanitizeFolder(name) {
  return (name || "").trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
}
function ensureFolder(folderName) {
  const safe = sanitizeFolder(folderName);
  if (!safe) throw new Error("Folder name is required");
  const folderPath = path.join(UPLOADS_DIR, safe);
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath);
  return { safe, folderPath };
}
function findImagePath(folderPath, baseSafe) {
  const files = fs.readdirSync(folderPath);
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    if (path.basename(f, ext) === baseSafe) return path.join(folderPath, f);
  }
  return null;
}

function loadRubrics() {
  try { return JSON.parse(fs.readFileSync(RUBRICS_PATH, "utf8")); }
  catch { return { rubrics: [] }; }
}
function saveRubrics(data) {
  fs.writeFileSync(RUBRICS_PATH, JSON.stringify(data, null, 2));
}
function loadAssessments() {
  try { return JSON.parse(fs.readFileSync(ASSESS_PATH, "utf8")); }
  catch { return { assessments: [] }; }
}
function saveAssessments(data) {
  fs.writeFileSync(ASSESS_PATH, JSON.stringify(data, null, 2));
}
function loadGrades() {
  try { return JSON.parse(fs.readFileSync(GRADES_PATH, "utf8")); }
  catch { return { grades: [] }; }
}
function saveGrades(data) {
  fs.writeFileSync(GRADES_PATH, JSON.stringify(data, null, 2));
}

function validateRubric(rubric) {
  const issues = [];
  const criteria = Array.isArray(rubric?.criteria) ? rubric.criteria : [];
  if (!criteria.length) issues.push("Rubric requires at least one criterion.");
  criteria.forEach((c, i) => {
    if (!String(c.title || "").trim()) issues.push(`Criterion #${i + 1}: title required.`);
    const w = Number(c.weight);
    if (!Number.isFinite(w) || w < 0) issues.push(`Criterion #${i + 1}: weight must be >= 0.`);
    const ratings = Array.isArray(c.ratings) ? c.ratings : [];
    if (!ratings.length) issues.push(`Criterion #${i + 1}: add at least one rating.`);
    ratings.forEach((r, ri) => {
      if (!String(r.label || "").trim()) issues.push(`Criterion #${i + 1} rating #${ri + 1}: label required.`);
      if (!Number.isFinite(Number(r.points))) issues.push(`Criterion #${i + 1} rating #${ri + 1}: points must be a number.`);
    });
  });
  return issues;
}

// -------------------- Multer --------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// -------------------- Health --------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// -------------------- Folders -------------------------
app.get("/folders", (req, res) => {
  try {
    const folders = fs.readdirSync(UPLOADS_DIR)
      .filter(f => fs.statSync(path.join(UPLOADS_DIR, f)).isDirectory());
    res.json({ folders });
  } catch {
    res.status(500).json({ folders: [] });
  }
});

app.post("/folders", (req, res) => {
  try {
    const { safe, folderPath } = ensureFolder(req.body.name);
    res.json({ success: true, folder: safe, exists: fs.existsSync(folderPath) });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// -------------------- Uploads -------------------------
app.post("/upload-batch-queue", upload.array("images", MAX_FILES), (req, res) => {
  try {
    const { safe: folderName, folderPath } = ensureFolder(req.body.folder);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, error: "No files uploaded" });

    const accepted = [];
    for (const file of files) {
      const serial = nextSerial(folderName);
      const base = `${folderName}_${String(serial).padStart(SERIAL_PAD, "0")}`;
      const ext = path.extname(file.originalname) || ".jpg";
      const imageDestPath = path.join(folderPath, `${base}${ext}`);
      const textDestPath  = path.join(folderPath, `${base}.txt`);
      fs.renameSync(file.path, imageDestPath);
      enqueueJob(folderName, imageDestPath, textDestPath, 0, 0);
      accepted.push({ ok: true, base });
    }

    res.status(202).json({ success: true, accepted });
  } catch (e) {
    console.error("[upload-batch-queue] error:", e);
    try { for (const f of req.files || []) if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
    res.status(500).json({ success: false, error: "Batch upload failed" });
  }
});

app.post("/upload-queue", upload.single("image"), (req, res) => {
  try {
    const { safe: folderName, folderPath } = ensureFolder(req.body.folder);
    if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });

    const serial = nextSerial(folderName);
    const base = `${folderName}_${String(serial).padStart(SERIAL_PAD, "0")}`;
    const ext = path.extname(req.file.originalname) || ".jpg";
    const imageDestPath = path.join(folderPath, `${base}${ext}`);
    const textDestPath  = path.join(folderPath, `${base}.txt`);
    fs.renameSync(req.file.path, imageDestPath);
    enqueueJob(folderName, imageDestPath, textDestPath, 0, 0);

    res.status(202).json({ success: true, base });
  } catch (e) {
    console.error("[upload-queue] error:", e);
    try { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ success: false, error: "Upload failed" });
  }
});

// -------------------- Job Status ----------------------
app.get("/jobs/:id", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

/**
 * GET /jobs/folder/:folderName
 * Return list of image bases + whether .txt exists
 */
app.get("/jobs/folder/:folderName", (req, res) => {
  try {
    const folderName = req.params.folderName.replace(/[\\/:*?"<>|]+/g, "_");
    const folderPath = path.join(UPLOADS_DIR, folderName);
    if (!fs.existsSync(folderPath)) return res.status(404).json({ error: "Folder not found" });

    const files = fs.readdirSync(folderPath);
    const items = [];
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue;
      const base = path.basename(f, ext);
      const txtPath = path.join(folderPath, `${base}.txt`);
      items.push({ file: f, base, processed: fs.existsSync(txtPath) });
    }
    const total = items.length;
    const done = items.filter(i => i.processed).length;
    res.json({ folder: folderName, total, done, items });
  } catch (err) {
    console.error("[status] error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -------------------- Rubrics -------------------------
app.get("/rubrics", (req, res) => {
  const { rubrics } = loadRubrics();
  res.json(rubrics.map(r => ({
    id: r.id,
    name: r.name,
    totalWeight: r.totalWeight ?? r.criteria.reduce((s, c) => s + Number(c.weight || 0), 0)
  })));
});

app.get("/rubrics/:id", (req, res) => {
  const { rubrics } = loadRubrics();
  const r = rubrics.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Rubric not found" });
  res.json(r);
});

app.post("/rubrics", (req, res) => {
  const rubric = req.body;
  const problems = validateRubric(rubric);
  if (problems.length) return res.status(400).json({ error: problems.join("\n") });

  const store = loadRubrics();
  const id = randomUUID();
  const clean = {
    id,
    name: String(rubric.name || `Rubric ${store.rubrics.length + 1}`),
    criteria: rubric.criteria.map(c => ({
      id: c.id || randomUUID(),
      title: String(c.title || "").trim(),
      weight: Number(c.weight || 0),
      ratings: (c.ratings || []).map(r => ({
        id: r.id || randomUUID(),
        label: String(r.label || "").trim(),
        points: Number(r.points || 0),
        description: String(r.description || "").trim(),
      })),
    })),
  };
  clean.totalWeight = Number.isFinite(Number(rubric.totalWeight))
    ? Number(rubric.totalWeight)
    : clean.criteria.reduce((s, c) => s + Number(c.weight || 0), 0);

  store.rubrics.push(clean);
  saveRubrics(store);
  res.status(201).json({ success: true, rubric: { id: clean.id, name: clean.name } });
});

// -------------------- Assessments ---------------------
app.get("/assessments", (req, res) => {
  const { assessments } = loadAssessments();
  res.json(assessments);
});

app.get("/assessments/:id", (req, res) => {
  const { assessments } = loadAssessments();
  const a = assessments.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Assessment not found" });
  res.json(a);
});

app.post("/create-assessment", (req, res) => {
  const { name, folder, rubricMode, rubricId, rubric } = req.body;

  if (!String(name || "").trim())   return res.status(400).json({ error: "Assessment name is required." });
  if (!String(folder || "").trim()) return res.status(400).json({ error: "Folder is required." });

  const rubricsStore = loadRubrics();
  let finalRubricId = rubricId;

  if (rubricMode === "existing") {
    const found = rubricsStore.rubrics.find(r => r.id === rubricId);
    if (!found) return res.status(400).json({ error: "Selected rubric does not exist." });
  } else {
    const problems = validateRubric(rubric);
    if (problems.length) return res.status(400).json({ error: problems.join("\n") });

    const newId = randomUUID();
    const clean = {
      id: newId,
      name: rubric.name || `${name} rubric`,
      criteria: rubric.criteria.map(c => ({
        id: c.id || randomUUID(),
        title: String(c.title || "").trim(),
        weight: Number(c.weight || 0),
        ratings: (c.ratings || []).map(r => ({
          id: r.id || randomUUID(),
          label: String(r.label || "").trim(),
          points: Number(r.points || 0),
          description: String(r.description || "").trim(),
        })),
      })),
    };
    clean.totalWeight = Number.isFinite(Number(rubric.totalWeight))
      ? Number(rubric.totalWeight)
      : clean.criteria.reduce((s, c) => s + Number(c.weight || 0), 0);

    rubricsStore.rubrics.push(clean);
    saveRubrics(rubricsStore);
    finalRubricId = newId;
  }

  const assessmentsStore = loadAssessments();
  const assessment = {
    id: randomUUID(),
    name: String(name).trim(),
    folder: String(folder).trim(),
    rubricId: finalRubricId,
    createdAt: Date.now(),
  };
  assessmentsStore.assessments.push(assessment);
  saveAssessments(assessmentsStore);

  res.status(201).json({ success: true, assessment });
});

// -------------------- OCR (Layout + Words) ------------
/**
 * Preferred: lines + words
 * GET /ocr/layout/:folder/:base?refresh=1
 * -> { lines:[{text,box,words:[...]}], words:[...] }
 */
app.get("/ocr/layout/:folder/:base", async (req, res) => {
  try {
    const folderSafe = req.params.folder.replace(/[\\/:*?"<>|]+/g, "_");
    const baseSafe   = req.params.base.replace(/[\\/:*?"<>|]+/g, "_");
    const refresh    = req.query.refresh === "1";

    const folderPath = path.join(UPLOADS_DIR, folderSafe);
    if (!fs.existsSync(folderPath)) return res.status(404).json({ error: "Folder not found" });

    const cachePath = path.join(folderPath, `${baseSafe}.layout.json`);
    if (!refresh && fs.existsSync(cachePath)) {
      return res.json(JSON.parse(fs.readFileSync(cachePath, "utf8")));
    }

    const imagePath = findImagePath(folderPath, baseSafe);
    if (!imagePath) return res.status(404).json({ error: "Image not found" });

    const data = await transcribeLayoutWithGPT(imagePath);
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
    res.json(data);
  } catch (e) {
    console.error("[/ocr/layout] error:", e);
    res.status(500).json({ error: "OCR layout failed" });
  }
});

/**
 * Words-only convenience
 * GET /ocr/words/:folder/:base?refresh=1
 * -> { words:[{text,box}...] }
 * (Build from layout; ensures consistency.)
 */
app.get("/ocr/words/:folder/:base", async (req, res) => {
  try {
    const folderSafe = req.params.folder.replace(/[\\/:*?"<>|]+/g, "_");
    const baseSafe   = req.params.base.replace(/[\\/:*?"<>|]+/g, "_");
    const refresh    = req.query.refresh === "1";

    const folderPath = path.join(UPLOADS_DIR, folderSafe);
    if (!fs.existsSync(folderPath)) return res.status(404).json({ error: "Folder not found" });

    const layoutCache = path.join(folderPath, `${baseSafe}.layout.json`);
    if (!refresh && fs.existsSync(layoutCache)) {
      const data = JSON.parse(fs.readFileSync(layoutCache, "utf8"));
      return res.json({ words: Array.isArray(data?.words) ? data.words : [] });
    }

    const imagePath = findImagePath(folderPath, baseSafe);
    if (!imagePath) return res.status(404).json({ error: "Image not found" });

    const data = await transcribeLayoutWithGPT(imagePath);
    fs.writeFileSync(layoutCache, JSON.stringify(data, null, 2));
    res.json({ words: Array.isArray(data?.words) ? data.words : [] });
  } catch (e) {
    console.error("[/ocr/words] error:", e);
    res.status(500).json({ error: "OCR words failed" });
  }
});

// -------------------- Grades API ----------------------
/**
 * GET /grades/:assessmentId
 * -> [{ assessmentId, base, total, status, scores:[{criterionId, ratingId, points, comment, aiRationale?, fromAI?}], updatedAt }]
 */
app.get("/grades/:assessmentId", (req, res) => {
  const { grades } = loadGrades();
  const out = grades.filter(g => g.assessmentId === req.params.assessmentId);
  res.json(out);
});

/**
 * POST /grades/save
 * body: { assessmentId, base, total, status, scores:[{criterionId, ratingId, points, comment, aiRationale?, fromAI?}] }
 */
app.post("/grades/save", (req, res) => {
  const payload = req.body || {};
  if (!payload.assessmentId || !payload.base) {
    return res.status(400).json({ error: "assessmentId and base are required" });
  }
  const store = loadGrades();
  const idx = store.grades.findIndex(g => g.assessmentId === payload.assessmentId && g.base === payload.base);
  const entry = {
    assessmentId: payload.assessmentId,
    base: String(payload.base),
    total: Number(payload.total || 0),
    status: String(payload.status || "graded"),
    scores: Array.isArray(payload.scores) ? payload.scores : [],
    updatedAt: Date.now(),
  };
  if (idx >= 0) store.grades[idx] = entry; else store.grades.push(entry);
  saveGrades(store);
  res.json({ success: true, entry });
});

/**
 * POST /grades/generate
 * body: { assessmentId, base }
 * -> { suggestions: [{ criterionId, ratingLabel, ratingId|null, points, rationale }] }
 */
app.post("/grades/generate", async (req, res) => {
  try {
    const { assessmentId, base } = req.body || {};
    if (!assessmentId || !base) return res.status(400).json({ error: "assessmentId and base are required" });

    // Load assessment + rubric
    const { assessments } = loadAssessments();
    const assessment = assessments.find(a => a.id === assessmentId);
    if (!assessment) return res.status(404).json({ error: "Assessment not found" });

    const { rubrics } = loadRubrics();
    const rubric = rubrics.find(r => r.id === assessment.rubricId);
    if (!rubric) return res.status(404).json({ error: "Rubric not found" });

    // Load essay transcription text
    const folderPath = path.join(UPLOADS_DIR, assessment.folder);
    const txtPath = path.join(folderPath, `${base}.txt`);
    if (!fs.existsSync(txtPath)) return res.status(400).json({ error: "Transcription not found for this essay" });
    const essayText = fs.readFileSync(txtPath, "utf8");

    // Build a compact rubric spec for the prompt
    const rubricSpec = rubric.criteria.map(c => ({
      id: c.id,
      title: c.title,
      weight: c.weight,
      ratings: c.ratings.map(r => ({ id: r.id, label: r.label, points: r.points, description: r.description || "" })),
    }));

    const system =
      `You are a strict grader. Return JSON ONLY with this schema:
{ "suggestions": [ { "criterionId": string, "ratingLabel": string, "points": number, "rationale": string } ] }
- ratingLabel must exactly match one of the rubric's rating labels per criterion.
- Do not include any commentary outside of JSON.`;

    const userContent = [
      { type: "text", text:
`Grade the following essay against the rubric.
Return one suggestion object per criterion.
Essay text:
${essayText}

Rubric (JSON):
${JSON.stringify(rubricSpec)}` }
    ];

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent }
      ],
      max_tokens: 1200,
      temperature: 0.2,
      // response_format: { type: "json_object" }, // enable if supported
    });

    // Parse response safely
    const raw = resp.choices?.[0]?.message?.content || "";
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
      parsed = (s >= 0 && e > s) ? JSON.parse(raw.slice(s, e + 1)) : { suggestions: [] };
    }

    const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];

    // Map ratingLabel -> ratingId (case-insensitive)
    const labelToId = {};
    for (const c of rubric.criteria) {
      const map = {};
      for (const r of c.ratings) map[r.label.toLowerCase()] = r.id;
      labelToId[c.id] = map;
    }

    const cleaned = suggestions.map(s => {
      const critId = s.criterionId;
      const label = String(s.ratingLabel || "").trim();
      const ratingId = labelToId[critId]?.[label.toLowerCase()] || null;
      return {
        criterionId: critId,
        ratingLabel: label,
        ratingId,
        points: Number(s.points || 0),
        rationale: String(s.rationale || "").slice(0, 800),
      };
    });

    res.json({ suggestions: cleaned });
  } catch (e) {
    console.error("[/grades/generate] error:", e);
    res.status(500).json({ error: "Auto-grade failed" });
  }
});

// -------------------- Boot ----------------------------
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
