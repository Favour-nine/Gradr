// src/components/GradeAssessment.jsx
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import axios from "axios";
import ViewerPanel from "./ViewerPanel.jsx";

const API_BASE = import.meta.env?.VITE_API_BASE || "http://localhost:5000";
const cx = (...a) => a.filter(Boolean).join(" ");

/* Auto-expanding textarea (for rubric comments) */
function AutoTextarea({ value, onChange, minRows = 1, maxRows = 6, className = "", ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = window.getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 20;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBot = parseFloat(cs.paddingBottom) || 0;
    const maxH = line * maxRows + padTop + padBot;
    const needed = el.scrollHeight;
    el.style.height = Math.min(needed, maxH) + "px";
    el.style.overflowY = needed > maxH ? "auto" : "hidden";
  }, [value, minRows, maxRows]);
  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={value}
      onChange={onChange}
      className={className}
      {...props}
    />
  );
}

/* Normalize a grade entry's scores array -> map keyed by criterionId */
function normalizeEntryScores(entry) {
  if (!entry) return entry;
  if (!Array.isArray(entry.scores)) return entry; // already a map
  const byId = {};
  for (const s of entry.scores) {
    if (s && s.criterionId) byId[s.criterionId] = { ...s };
  }
  return { ...entry, scores: byId };
}

export default function GradeAssessment() {
  // ---- Top-level data ----
  const [assessments, setAssessments] = useState([]);
  const [assessmentId, setAssessmentId] = useState("");
  const [assessment, setAssessment] = useState(null); // { id, name, folder, rubricId }
  const [rubric, setRubric] = useState(null);

  // ---- Essays ----
  const [essayItems, setEssayItems] = useState([]);   // [{ base, file, processed, imageUrl, textUrl }]
  const [filter, setFilter] = useState("all");        // all | ungraded | graded | flagged
  const [activeBase, setActiveBase] = useState("");
  const [text, setText] = useState("");
  const [loadingText, setLoadingText] = useState(false);

  // ---- Grades / AI ----
  const [gradesMap, setGradesMap] = useState({});     // base -> normalized entry (scores as map)
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg] = useState("");
  const [ai, setAi] = useState({});                   // criterionId -> suggestion

  // ---------- load assessments once ----------
  useEffect(() => {
    (async () => {
      const res = await axios.get(`${API_BASE}/assessments`);
      setAssessments(res.data || []);
      if (!assessmentId && res.data?.length) setAssessmentId(res.data[0].id);
    })().catch(console.error);
  }, []);

  // ---------- when assessment changes: load details, rubric, essays, grades ----------
  useEffect(() => {
    if (!assessmentId) return;
    (async () => {
      const a = (await axios.get(`${API_BASE}/assessments/${assessmentId}`)).data;
      setAssessment(a);

      const rub = (await axios.get(`${API_BASE}/rubrics/${a.rubricId}`)).data;
      setRubric(rub);

      const folderRes = (await axios.get(`${API_BASE}/jobs/folder/${encodeURIComponent(a.folder)}`)).data;
      const items = (folderRes.items || []).map(i => ({
        base: i.base,
        file: i.file,
        processed: i.processed,
        imageUrl: `${API_BASE}/uploads/${a.folder}/${i.file}`,
        textUrl: `${API_BASE}/uploads/${a.folder}/${i.base}.txt`,
      }));
      setEssayItems(items);

      let map = {};
      try {
        const g = (await axios.get(`${API_BASE}/grades/${assessmentId}`)).data;
        for (const row of g || []) {
          map[row.base] = normalizeEntryScores(row); // ← normalize server shape
        }
      } catch {}
      setGradesMap(map);

      const first = items[0]?.base || "";
      setActiveBase(first);
      setAi({});
      setText("");
    })().catch(console.error);
  }, [assessmentId]);

  // ---------- load text for active essay ----------
  useEffect(() => {
    if (!assessment || !activeBase) return;
    const it = essayItems.find(x => x.base === activeBase);
    if (!it) return;
    if (!it.processed) {
      setText("");
      return;
    }
    (async () => {
      try {
        setLoadingText(true);
        const res = await fetch(it.textUrl);
        setText(res.ok ? await res.text() : "");
      } finally {
        setLoadingText(false);
      }
    })();
  }, [activeBase, essayItems, assessment]);

  // ---------- derived ----------
  const filteredEssays = useMemo(() => {
    if (!essayItems.length) return [];
    if (filter === "all") return essayItems;
    if (filter === "graded") return essayItems.filter(e => gradesMap[e.base]?.status === "graded");
    if (filter === "flagged") return essayItems.filter(e => gradesMap[e.base]?.status === "flagged");
    return essayItems.filter(e => !gradesMap[e.base] || gradesMap[e.base].status !== "graded");
  }, [essayItems, gradesMap, filter]);

  const progress = useMemo(() => {
    const total = essayItems.length;
    const graded = essayItems.filter(e => gradesMap[e.base]?.status === "graded").length;
    return { total, graded };
  }, [essayItems, gradesMap]);

  const activeItem = useMemo(
    () => essayItems.find(x => x.base === activeBase),
    [essayItems, activeBase]
  );

  const currentScores = useMemo(() => {
    const entry = gradesMap[activeBase];
    return entry && !Array.isArray(entry.scores) ? entry.scores : {};
  }, [gradesMap, activeBase]);

  // ---------- scoring helpers ----------
  const setScore = (criterionId, patch) => {
    setGradesMap(prev => {
      const entry = prev[activeBase] || { scores: {}, status: "ungraded", base: activeBase };
      const cur = entry.scores?.[criterionId] || {};
      return {
        ...prev,
        [activeBase]: {
          ...entry,
          scores: { ...(entry.scores || {}), [criterionId]: { ...cur, ...patch, criterionId } }
        }
      };
    });
  };

  const setRating = (criterionId, ratingId) => {
    const r = rubric?.criteria?.find(c => c.id === criterionId)?.ratings?.find(x => x.id === ratingId);
    setScore(criterionId, { ratingId, points: Number(r?.points ?? 0) });
  };
  const setPoints = (criterionId, v) => setScore(criterionId, { points: v === "" ? "" : Number(v) });
  const setComment = (criterionId, v) => setScore(criterionId, { comment: v });

  const rawTotal = useMemo(() => {
    if (!rubric) return 0;
    return rubric.criteria
      .map(c => Number(currentScores[c.id]?.points || 0))
      .reduce((a, b) => a + b, 0);
  }, [rubric, currentScores]);

  const weightedTotal = useMemo(() => {
    if (!rubric) return 0;
    const t = rubric.criteria.reduce((s, c) => {
      const pts = Number(currentScores[c.id]?.points || 0);
      const w = Number(c.weight || 0);
      return s + pts * (w / 100);
    }, 0);
    return Math.round(t);
  }, [rubric, currentScores]);

  const saveGrade = useCallback(async (status = "graded") => {
    if (!assessment || !activeBase || !rubric) return;
    setSaving(true);
    setMsg("");
    try {
      // Convert map -> array to match server contract
      const scoresArray = rubric.criteria.map(c => ({
        criterionId: c.id,
        ratingId: currentScores[c.id]?.ratingId ?? null,
        points: Number(currentScores[c.id]?.points ?? 0),
        comment: currentScores[c.id]?.comment ?? "",
        aiRationale: currentScores[c.id]?.aiRationale ?? "",
        fromAI: !!currentScores[c.id]?.fromAI,
      }));

      const payload = {
        assessmentId: assessment.id,
        base: activeBase,
        total: weightedTotal,
        status,
        scores: scoresArray,
      };

      const res = await axios.post(`${API_BASE}/grades/save`, payload);
      // Normalize the returned entry (array -> map) before storing
      const entry = normalizeEntryScores(res.data?.entry || payload);
      setGradesMap(prev => ({ ...prev, [activeBase]: entry }));
      setMsg("Saved");
      setTimeout(() => setMsg(""), 1200);
    } catch (e) {
      console.error(e);
      setMsg("Save failed");
    } finally {
      setSaving(false);
    }
  }, [assessment, activeBase, rubric, currentScores, weightedTotal]);

  // ---------- AI ----------
  const generateAI = async () => {
    if (!assessment || !activeBase) return;
    try {
      setGenerating(true);
      setMsg("");
      const res = await axios.post(`${API_BASE}/grades/generate`, {
        assessmentId: assessment.id,
        base: activeBase,
      });
      const suggestions = res.data?.suggestions || [];
      const map = {};
      for (const s of suggestions) map[s.criterionId] = s;
      setAi(map);
    } catch (e) {
      console.error(e);
      setMsg("Auto-grade failed");
    } finally {
      setGenerating(false);
    }
  };

  const acceptSuggestion = (criterionId) => {
    const s = ai[criterionId];
    if (!s) return;
    setScore(criterionId, {
      ratingId: s.ratingId ?? null,
      points: Number(s.points ?? 0),
      aiRationale: s.rationale || "",
      fromAI: true,
    });
  };

  const acceptAll = () => {
    if (!rubric) return;
    const next = {};
    for (const c of rubric.criteria) {
      const s = ai[c.id];
      if (!s) continue;
      next[c.id] = {
        criterionId: c.id,
        ratingId: s.ratingId ?? null,
        points: Number(s.points ?? 0),
        aiRationale: s.rationale || "",
        fromAI: true,
        comment: currentScores[c.id]?.comment || "",
      };
    }
    setGradesMap(prev => {
      const entry = prev[activeBase] || { scores: {}, status: "ungraded", base: activeBase };
      return { ...prev, [activeBase]: { ...entry, scores: { ...entry.scores, ...next } } };
    });
  };

  // Essay prev/next
  const goPrev = () => {
    const idx = filteredEssays.findIndex(e => e.base === activeBase);
    if (idx > 0) setActiveBase(filteredEssays[idx - 1].base);
  };
  const goNext = () => {
    const idx = filteredEssays.findIndex(e => e.base === activeBase);
    if (idx >= 0 && idx < filteredEssays.length - 1) setActiveBase(filteredEssays[idx + 1].base);
  };

  // ---------- UI ----------
  return (
    <div className="mx-auto max-w-screen-2xl px-4 pb-12">
      {/* Top toolbar */}
      <div className="sticky top-0 z-20 -mx-4 mb-4 border-b bg-white/80 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={assessmentId}
            onChange={(e) => setAssessmentId(e.target.value)}
            className="h-10 rounded-xl bg-white px-3 text-sm ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {assessments.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>

          <div className="text-sm text-slate-600">
            {progress.graded}/{progress.total} graded
          </div>

          {/* Segmented filter with active blue state */}
          <div className="ml-auto inline-flex whitespace-nowrap rounded-xl bg-slate-100 p-1">
            {[
              { key: "all", label: "All" },
              { key: "ungraded", label: "Ungraded" },
              { key: "graded", label: "Graded" },
              { key: "flagged", label: "Flagged" },
            ].map(({ key, label }) => {
              const active = filter === key;
              return (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={cx(
                    "h-9 rounded-lg px-3 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                    active
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-600 hover:text-slate-900 hover:bg-white/60"
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main layout — keep 3 panels; left slightly narrower to give grader space */}
      <div className="flex gap-4 overflow-x-auto">
        {/* Left: essay list */}
        <div className="w-[260px] shrink-0 rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <div className="flex items-center justify-between border-b border-slate-200 p-3">
            <div className="text-sm font-semibold text-slate-800">Essays</div>
            <div className="text-xs text-slate-500">{filteredEssays.length}</div>
          </div>

          <div className="max-h-[calc(100vh-240px)] overflow-y-auto p-3">
            {filteredEssays.length === 0 && (
              <p className="text-sm text-slate-500">No essays.</p>
            )}
            <ul className="space-y-2">
              {filteredEssays.map(item => {
                const status = gradesMap[item.base]?.status || "ungraded";
                const active = activeBase === item.base;
                const statusClass =
                  status === "graded"
                    ? "bg-green-100 text-green-700"
                    : status === "flagged"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-slate-100 text-slate-700";
                return (
                  <li key={item.base}>
                    <button
                      onClick={() => setActiveBase(item.base)}
                      className={cx(
                        "w-full rounded-lg px-3 py-2 text-left text-sm ring-1 transition",
                        "ring-slate-200 hover:bg-slate-50",
                        active && "bg-blue-600 text-white ring-blue-600 hover:bg-blue-600"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate">{item.base}</span>
                        <span
                          className={cx(
                            "ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                            active ? "bg-white/20 text-white" : statusClass
                          )}
                        >
                          {status}
                        </span>
                      </div>

                      {!item.processed && (
                        <div className={cx(
                          "mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10px]",
                          active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-600"
                        )}>
                          OCR pending
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="sticky bottom-0 border-t border-slate-200 bg-white/90 p-2 backdrop-blur">
            <div className="flex items-center justify-between">
              <button
                onClick={goPrev}
                disabled={filteredEssays.findIndex(e => e.base === activeBase) <= 0}
                className="h-8 rounded-md px-3 text-sm ring-1 ring-slate-200 disabled:opacity-50"
              >
                Prev
              </button>
              <button
                onClick={goNext}
                disabled={filteredEssays.findIndex(e => e.base === activeBase) === filteredEssays.length - 1}
                className="h-8 rounded-md px-3 text-sm ring-1 ring-slate-200 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>

        {/* Center: Viewer (extracted component) */}
        <ViewerPanel
          activeItem={activeItem}
          assessment={assessment}
          paneHeight="65vh"
          onWordSelect={(w) => console.log("clicked word:", w)}
        />

        {/* Right: rubric grader */}
        <div className="w-[420px] shrink-0 rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          {/* header */}
          <div className="flex items-center gap-2 border-b border-slate-200 p-3">
            <h3 className="text-sm font-semibold text-slate-800">Rubric Grader</h3>
            <div className="ml-auto flex gap-2">
              <button
                onClick={generateAI}
                disabled={generating || !activeItem?.processed}
                className={cx(
                  "h-9 rounded-lg px-3 text-sm ring-1 ring-slate-200",
                  generating ? "opacity-60 cursor-not-allowed" : "bg-white hover:bg-slate-50"
                )}
              >
                {generating ? "Grading…" : "Auto grade"}
              </button>
              <button
                onClick={acceptAll}
                disabled={!Object.keys(ai).length}
                className={cx(
                  "h-9 rounded-lg px-3 text-sm ring-1 ring-slate-200",
                  Object.keys(ai).length ? "bg-white hover:bg-slate-50" : "opacity-60 cursor-not-allowed"
                )}
              >
                Accept all
              </button>
            </div>
          </div>

          {/* scroll area */}
          <div className="max-h-[calc(100vh-260px)] overflow-y-auto p-4">
            {!rubric && <p className="text-sm text-slate-500">Loading rubric…</p>}

            {rubric?.criteria.map((c, idx) => {
              const selected = currentScores[c.id]?.ratingId || null;
              const pts = currentScores[c.id]?.points ?? "";
              const sug = ai[c.id];

              return (
                <section key={c.id} className="mb-4 rounded-xl bg-white p-4 shadow-xs ring-1 ring-slate-200">
                  {/* title */}
                  <div className="mb-2 flex items-baseline justify-between">
                    <h4 className="font-medium text-slate-900">{idx + 1}. {c.title}</h4>
                    <span className="text-xs text-slate-500">Weight: {c.weight}%</span>
                  </div>

                  {/* rating pills */}
                  <div className="grid grid-cols-2 gap-2">
                    {c.ratings.map(r => {
                      const active = selected === r.id;
                      return (
                        <button
                          key={r.id}
                          onClick={() => setRating(c.id, r.id)}
                          title={r.description || ""}
                          className={cx(
                            "w-full rounded-lg px-3 py-2 text-left text-sm transition ring-1 ring-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                            active
                              ? "bg-blue-600 text-white ring-blue-600 hover:bg-blue-600"
                              : "bg-slate-50 text-slate-800 ring-slate-200 hover:bg-slate-100"
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{r.label}</span>
                            <span className={active ? "opacity-90" : "text-slate-500"}>
                              ({r.points})
                            </span>
                          </div>
                          {r.description && !active && (
                            <div className="mt-1 text-xs text-slate-500 max-h-10 overflow-hidden">
                              {r.description}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* points + comment */}
                  <div className="mt-3 space-y-3">
                    <label className="block">
                      <span className="block text-xs text-slate-600">Points</span>
                      <input
                        type="number"
                        value={pts}
                        onChange={(e) => setPoints(c.id, e.target.value)}
                        className="mt-1 w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-xs text-slate-600">Comment (optional)</span>
                      <AutoTextarea
                        minRows={1}
                        maxRows={6}
                        value={currentScores[c.id]?.comment || ""}
                        onChange={(e) => setComment(c.id, e.target.value)}
                        placeholder="Short feedback"
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </label>
                  </div>

                  {/* AI suggestion chip */}
                  {sug && (
                    <div className="mt-3 flex items-start justify-between rounded-lg bg-blue-50 p-2 text-xs text-blue-900">
                      <p>
                        <span className="font-semibold">AI:</span> {sug.ratingLabel} ({sug.points}) — {sug.rationale}
                      </p>
                      <button
                        onClick={() => acceptSuggestion(c.id)}
                        className="ml-2 shrink-0 rounded-md px-2 py-1 font-medium underline hover:no-underline"
                      >
                        Accept
                      </button>
                    </div>
                  )}
                </section>
              );
            })}

            {/* sticky footer */}
            <div className="sticky bottom-0 mt-2 rounded-xl bg-white/90 p-3 shadow ring-1 ring-slate-200 backdrop-blur">
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <span className="text-slate-500">Total (weighted):</span>{" "}
                  <span className="font-semibold">{weightedTotal}</span>
                  <span className="ml-2 text-xs text-slate-400">Raw: {rawTotal}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => saveGrade("flagged")}
                    className="h-9 rounded-lg px-3 text-sm ring-1 ring-slate-200 hover:bg-slate-50"
                  >
                    Flag
                  </button>
                  <button
                    onClick={() => saveGrade("graded")}
                    disabled={!activeItem}
                    className={cx(
                      "h-9 rounded-lg bg-blue-600 px-3 text-sm text-white hover:bg-blue-700",
                      !activeItem && "opacity-60 cursor-not-allowed"
                    )}
                    title="Save"
                  >
                    Save & Mark complete
                  </button>
                </div>
              </div>
              {msg && <div className="mt-2 text-xs text-slate-500">{msg}</div>}
            </div>
          </div>
        </div>
        {/* /Right */}
      </div>
    </div>
  );
}
