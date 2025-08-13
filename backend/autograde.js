// autograde.js
// A small service that scores an essay against a rubric using the OpenAI API.
// - Exposes: autoGradeEssay({ essayText, rubric, model }) -> { suggestions, total }
// - Robust JSON parsing and rating resolution.

const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function summarizeRubric(rubric) {
  // Reduce payload size but keep everything the model needs.
  return {
    totalWeight:
      rubric.totalWeight ?? rubric.criteria.reduce((s, c) => s + Number(c.weight || 0), 0),
    criteria: rubric.criteria.map((c) => ({
      id: c.id,
      title: c.title,
      weight: Number(c.weight || 0),
      ratings: (c.ratings || []).map((r) => ({
        id: r.id,
        label: r.label,
        points: Number(r.points || 0),
        // no description unless you want richer guidance. Keep prompt lean first.
      })),
    })),
  };
}

function buildSystemPrompt() {
  return (
    "You are a careful, fair grading assistant. " +
    "Score the essay using ONLY the provided rubric. " +
    "Return STRICT JSON with the required schema. Do not add prose outside JSON."
  );
}

function buildUserPrompt(essayText, rubricSummary) {
  // Constrain the model to choose from provided rating labels and points per criterion.
  return [
    {
      type: "text",
      text:
        "Rubric (JSON):\n" +
        JSON.stringify(rubricSummary) +
        "\n\nEssay text to grade:\n" +
        essayText,
    },
    {
      type: "text",
      text:
        "Return ONLY JSON with this schema:\n" +
        JSON.stringify(
          {
            suggestions: [
              {
                criterionId: "string",
                // ratingLabel must be one of the labels under the matching criterion
                ratingLabel: "string",
                points: 0,
                rationale: "short reason",
              },
            ],
            total: 0,
          },
          null,
          2
        ) +
        "\nRules:\n- For each criterion, pick exactly ONE ratingLabel from the allowed list for that criterion.\n- Set points to the points value of that rating.\n- Provide a SHORT rationale (1–2 sentences).\n- total is the SUM of points across criteria.\n- Output STRICT JSON, no markdown fences.",
    },
  ];
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

function resolveToRatingIds(rubric, modelOutput) {
  // Map model suggested labels to your rubric's rating IDs. Fallback by nearest points.
  const byCrit = Object.fromEntries(rubric.criteria.map((c) => [c.id, c]));

  const suggestions = (modelOutput?.suggestions || []).map((s) => {
    const c = byCrit[s.criterionId];
    if (!c) return null;

    // try label match (case-insensitive)
    const labelLc = String(s.ratingLabel || "").toLowerCase();
    let chosen = c.ratings.find((r) => String(r.label).toLowerCase() === labelLc);

    // fallback: nearest points
    if (!chosen && Number.isFinite(Number(s.points))) {
      const pts = Number(s.points);
      chosen = c.ratings.reduce((best, r) => {
        if (!best) return r;
        const d = Math.abs(Number(r.points) - pts);
        const bd = Math.abs(Number(best.points) - pts);
        return d < bd ? r : best;
      }, null);
    }

    if (!chosen) return null;

    return {
      criterionId: c.id,
      ratingId: chosen.id,
      ratingLabel: chosen.label,
      points: Number(chosen.points),
      rationale: String(s.rationale || ""),
    };
  }).filter(Boolean);

  const total = suggestions.reduce((s, x) => s + Number(x.points || 0), 0);
  return { suggestions, total };
}

async function autoGradeEssay({ essayText, rubric, model = process.env.GRADER_MODEL || "gpt-4o-mini" }) {
  if (!essayText || !rubric) throw new Error("essayText and rubric are required");

  const rubricSummary = summarizeRubric(rubric);

  const resp = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(essayText, rubricSummary) },
    ],
    max_tokens: 1200,
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() || "";
  let json = safeJsonParse(raw);

  // Sometimes models wrap JSON in ``` — attempt a salvage.
  if (!json) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) json = safeJsonParse(m[0]);
  }
  if (!json) throw new Error("Model did not return valid JSON");

  return resolveToRatingIds(rubricSummary, json);
}

module.exports = { autoGradeEssay };

/* ----------------------------
   SERVER ROUTES (paste below your other routes in server.js)
   Requires: const { autoGradeEssay } = require("./autograde");
   Also add simple file-backed grades store similar to rubrics/assessments.
-----------------------------*/

// In server.js, add near the other data paths:
// const GRADES_PATH = path.join(DATA_DIR, "grades.json");
// if (!fs.existsSync(GRADES_PATH)) fs.writeFileSync(GRADES_PATH, JSON.stringify({ grades: [] }, null, 2));
// function loadGrades(){ try { return JSON.parse(fs.readFileSync(GRADES_PATH, "utf8")); } catch { return { grades: [] }; } }
// function saveGrades(data){ fs.writeFileSync(GRADES_PATH, JSON.stringify(data, null, 2)); }

// helper: read essay text from uploads
function readEssayText(uploadRoot, folder, base) {
  const txt = path.join(uploadRoot, folder, `${base}.txt`);
  if (!fs.existsSync(txt)) return null;
  return fs.readFileSync(txt, "utf8");
}

// Example routes to paste into server.js
// app.get("/grades/:assessmentId", (req, res) => {
//   const store = loadGrades();
//   const items = store.grades.filter(g => g.assessmentId === req.params.assessmentId);
//   res.json(items);
// });

// app.get("/grades/:assessmentId/:base", (req, res) => {
//   const store = loadGrades();
//   const g = store.grades.find(x => x.assessmentId === req.params.assessmentId && x.base === req.params.base);
//   if (!g) return res.status(404).json({ error: "Not found" });
//   res.json(g);
// });

// app.post("/grades/save", (req, res) => {
//   const { assessmentId, base, scores, total, status } = req.body;
//   if (!assessmentId || !base) return res.status(400).json({ error: "assessmentId and base required" });
//   const store = loadGrades();
//   const now = Date.now();
//   const idx = store.grades.findIndex(x => x.assessmentId === assessmentId && x.base === base);
//   const entry = { assessmentId, base, scores, total, status: status || "graded", updatedAt: now };
//   if (idx >= 0) store.grades[idx] = entry; else store.grades.push(entry);
//   saveGrades(store);
//   res.json({ success: true, entry });
// });

// app.post("/grades/generate", async (req, res) => {
//   try {
//     const { assessmentId, base, accept } = req.body; // accept=true to immediately save as graded
//     if (!assessmentId || !base) return res.status(400).json({ error: "assessmentId and base required" });
//
//     const assessmentsStore = loadAssessments();
//     const a = assessmentsStore.assessments.find(x => x.id === assessmentId);
//     if (!a) return res.status(404).json({ error: "Assessment not found" });
//
//     const rubricsStore = loadRubrics();
//     const rubric = rubricsStore.rubrics.find(r => r.id === a.rubricId);
//     if (!rubric) return res.status(404).json({ error: "Rubric not found" });
//
//     const essayText = readEssayText(UPLOADS_DIR, a.folder, base);
//     if (!essayText) return res.status(409).json({ error: "No OCR text found for this file yet." });
//
//     const { suggestions, total } = await autoGradeEssay({ essayText, rubric });
//
//     if (accept) {
//       const store = loadGrades();
//       const entry = { assessmentId, base, scores: suggestions, total, status: "graded", updatedAt: Date.now() };
//       const idx = store.grades.findIndex(x => x.assessmentId === assessmentId && x.base === base);
//       if (idx >= 0) store.grades[idx] = entry; else store.grades.push(entry);
//       saveGrades(store);
//     } else {
//       // stash as AI suggestion without overwriting human grades
//       const store = loadGrades();
//       const entry = { assessmentId, base, ai: { suggestions, total }, status: "ai_suggested", updatedAt: Date.now() };
//       const idx = store.grades.findIndex(x => x.assessmentId === assessmentId && x.base === base);
//       if (idx >= 0) store.grades[idx] = { ...store.grades[idx], ...entry }; else store.grades.push(entry);
//       saveGrades(store);
//     }
//
//     res.json({ success: true, suggestions, total });
//   } catch (e) {
//     console.error("[grades/generate]", e);
//     res.status(500).json({ error: e.message || "Generation failed" });
//   }
// });

// Optional: bulk autograde missing essays for an assessment
// app.post("/assessments/:id/autograde", async (req, res) => {
//   const mode = req.query.mode || "missing"; // "missing" | "all"
//   const assessmentsStore = loadAssessments();
//   const a = assessmentsStore.assessments.find(x => x.id === req.params.id);
//   if (!a) return res.status(404).json({ error: "Assessment not found" });
//
//   // scan uploads folder for images and text presence (reuse logic from /jobs/folder/:folderName)
//   const folderPath = path.join(UPLOADS_DIR, a.folder);
//   if (!fs.existsSync(folderPath)) return res.status(404).json({ error: "Folder not found" });
//   const files = fs.readdirSync(folderPath);
//   const imageExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".gif"]);
//   const bases = files
//     .filter((f) => imageExts.has(path.extname(f).toLowerCase()))
//     .map((f) => path.basename(f, path.extname(f)));
//
//   const gradesStore = loadGrades();
//   const already = new Set(
//     gradesStore.grades.filter(g => g.assessmentId === a.id && g.status === "graded").map(g => g.base)
//   );
//
//   const toDo = bases.filter(b => {
//     if (!fs.existsSync(path.join(folderPath, `${b}.txt`))) return false; // skip if no text yet
//     if (mode === "all") return true;
//     return !already.has(b);
//   });
//
//   const rubricsStore = loadRubrics();
//   const rubric = rubricsStore.rubrics.find(r => r.id === a.rubricId);
//   if (!rubric) return res.status(404).json({ error: "Rubric not found" });
//
//   const results = [];
//   for (const base of toDo) {
//     const essayText = fs.readFileSync(path.join(folderPath, `${base}.txt`), "utf8");
//     const { suggestions, total } = await autoGradeEssay({ essayText, rubric });
//     const entry = { assessmentId: a.id, base, scores: suggestions, total, status: "graded", updatedAt: Date.now() };
//     const idx = gradesStore.grades.findIndex(x => x.assessmentId === a.id && x.base === base);
//     if (idx >= 0) gradesStore.grades[idx] = entry; else gradesStore.grades.push(entry);
//     results.push({ base, total });
//   }
//   saveGrades(gradesStore);
//   res.json({ success: true, count: results.length, results });
// });
