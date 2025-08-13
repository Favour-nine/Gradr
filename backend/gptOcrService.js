/* eslint-disable no-console */
require("dotenv").config();

const sharp = require("sharp");
const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------- Config --------
const OCR_MODEL = process.env.OCR_MODEL || "gpt-4o-mini";
const OCR_MAX_TOKENS = Number(process.env.OCR_MAX_TOKENS || 1200);
const OCR_IMAGE_MAX_SIDE = Number(process.env.OCR_IMAGE_MAX_SIDE || 1600);
const OCR_IMAGE_FORMAT = (process.env.OCR_IMAGE_FORMAT || "webp").toLowerCase(); // webp|jpeg|png
const OCR_IMAGE_QUALITY = Number(process.env.OCR_IMAGE_QUALITY || 62);
const OCR_RESPECT_EXIF = String(process.env.OCR_RESPECT_EXIF || "true") === "true";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 45000); // <— NEW
const QUIET = String(process.env.QUIET || "false") === "true";

// clamp 0..1
const z01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

// ---------- image prep ----------
async function prepImage(imagePath) {
  const input = sharp(imagePath, { failOn: "none" }); // string, not boolean
  if (OCR_RESPECT_EXIF) input.rotate();

  const meta = await input.metadata();
  let w = meta.width || 0;
  let h = meta.height || 0;

  const maxSide = Math.max(w, h);
  let pipe = input;
  if (maxSide > OCR_IMAGE_MAX_SIDE) {
    const scale = OCR_IMAGE_MAX_SIDE / maxSide;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    pipe = input.resize({ width: w, height: h, fit: "inside", withoutEnlargement: true });
  }

  const fmt = ["webp", "jpeg", "png"].includes(OCR_IMAGE_FORMAT) ? OCR_IMAGE_FORMAT : "webp";
  if (fmt === "webp") pipe = pipe.webp({ quality: OCR_IMAGE_QUALITY });
  if (fmt === "jpeg") pipe = pipe.jpeg({ quality: OCR_IMAGE_QUALITY });
  if (fmt === "png")  pipe = pipe.png();

  const buf = await pipe.toBuffer();
  const mime = fmt === "webp" ? "image/webp" : fmt === "jpeg" ? "image/jpeg" : "image/png";
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  return { width: w, height: h, dataUrl };
}

// ---------- robust JSON extractor ----------
function extractJson(raw) {
  if (!raw || typeof raw !== "string") return null;

  let t = raw
    .replace(/^\uFEFF/, "")
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();

  try { return JSON.parse(t); } catch (_) {}

  const start = t.indexOf("{");
  if (start < 0) return null;

  // find balanced JSON
  let inStr = false, esc = false, depth = 0, end = -1;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  let cand = end > start ? t.slice(start, end + 1) : t.slice(start);

  // remove trailing commas
  cand = cand.replace(/,\s*([}\]])/g, "$1");

  if (end < 0) {
    let d = 0, s = false, e = false;
    for (let i = 0; i < cand.length; i++) {
      const ch = cand[i];
      if (s) {
        if (e) e = false;
        else if (ch === "\\") e = true;
        else if (ch === '"') s = false;
        continue;
      }
      if (ch === '"') { s = true; continue; }
      if (ch === "{") d++;
      else if (ch === "}") d = Math.max(0, d - 1);
    }
    if (d > 0) cand += "}".repeat(d);
  }

  try { return JSON.parse(cand); }
  catch (e) {
    if (!QUIET) console.warn("[OCR] JSON final parse failed. Snippet:", cand.slice(0, 280).replace(/\s+/g, " "));
    return null;
  }
}

// ---------- normalize ----------
function normalizeLayout(o) {
  const out = { width: 0, height: 0, lines: [], words: [] };
  if (!o || typeof o !== "object") return out;

  out.width  = Number(o.width || 0);
  out.height = Number(o.height || 0);

  const lines = Array.isArray(o.lines) ? o.lines : [];
  out.lines = lines.map(l => {
    const b = Array.isArray(l.box) ? l.box : [];
    if (b.length !== 4) return null;
    let [x0,y0,x1,y1] = b.map(z01);
    if (x1 < x0) [x0,x1] = [x1,x0];
    if (y1 < y0) [y0,y1] = [y1,y0];
    return { text: String(l.text || "").trim(), box: [x0,y0,x1,y1] };
  }).filter(Boolean);

  const words = Array.isArray(o.words) ? o.words : [];
  out.words = words.map(w => {
    const b = Array.isArray(w.box) ? w.box : [];
    if (b.length !== 4) return null;
    let [x0,y0,x1,y1] = b.map(z01);
    if (x1 < x0) [x0,x1] = [x1,x0];
    if (y1 < y0) [y0,y1] = [y1,y0];
    return { text: String(w.text || "").trim(), box: [x0,y0,x1,y1] };
  }).filter(Boolean);

  // reading-order index
  const sorted = out.lines.slice().sort((a,b) => (a.box[1]-b.box[1]) || (a.box[0]-b.box[0]));
  const idxMap = new Map(sorted.map((l,i) => [l, i]));
  out.lines = out.lines.map(l => ({ ...l, _i: idxMap.get(l) }));

  return out;
}

// ---------- prompts: boxes only ----------
function systemPrompt() {
  return (
    "Return ONLY a strict JSON object with keys: lines (required) and words (optional).\n" +
    "lines: array of objects { box:[x0,y0,x1,y1], text?:string }. Coordinates normalized 0..1.\n" +
    "Order lines top-to-bottom, left-to-right. Ignore crossed-out text.\n" +
    "If unsure of a word, pick the most likely word. It's OK if line.text is empty.\n" +
    "No commentary, no code fences."
  );
}
function userPrompt(dim) {
  return (
    "Schema:\n" +
    "{ \"lines\": [ { \"box\":[0.0,0.0,1.0,0.1] } ], \"words\":[ {\"text\":\"...\",\"box\":[...]} ] }\n" +
    `Approx image size: ${dim.width}x${dim.height}`
  );
}

// ---------- main ----------
async function transcribeLayoutWithGPT(imagePath) {
  const { width, height, dataUrl } = await prepImage(imagePath);

  let content = [
    { type: "text", text: userPrompt({ width, height }) },
    { type: "image_url", image_url: { url: dataUrl } },
  ];

  const tries = 3;
  let parsed = null, last = "";

  for (let i = 0; i < tries; i++) {
    const controller = new AbortController();                // <— NEW
    const tm = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

    let resp;
    try {
      resp = await openai.chat.completions.create(
        {
          model: OCR_MODEL,
          messages: [
            { role: "system", content: systemPrompt() },
            { role: "user",   content },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: OCR_MAX_TOKENS,
        },
        { signal: controller.signal }                         // <— NEW
      );
    } finally {
      clearTimeout(tm);
    }

    last = resp?.choices?.[0]?.message?.content || "";
    parsed = extractJson(last);
    if (parsed) break;

    content = [
      ...content,
      { type: "text", text: "Your output was not valid JSON. Return the same object again as STRICT valid JSON (no commentary)." },
    ];
  }

  if (!parsed) {
    if (!QUIET) console.warn("[OCR] failed to parse layout JSON. Returning empty layout.");
    return { width, height, lines: [], words: [] };
  }

  const norm = normalizeLayout(parsed);
  if (!norm.width)  norm.width  = width;
  if (!norm.height) norm.height = height;
  return norm;
}

async function transcribeImageWithGPT(imagePath) {
  const layout = await transcribeLayoutWithGPT(imagePath);
  const txt = (layout.lines || []).map(l => (l.text || "").trim()).filter(Boolean).join("\n");
  return txt;
}

module.exports = {
  transcribeLayoutWithGPT,
  transcribeImageWithGPT,
};
