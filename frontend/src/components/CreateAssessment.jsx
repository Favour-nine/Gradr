// src/components/CreateAssessment.jsx
import { useEffect, useMemo, useState } from "react";
import axios from "axios";

const API_BASE = import.meta.env?.VITE_API_BASE || "http://localhost:5000";
const uid =
  () =>
    (crypto?.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 9));

const cx = (...a) => a.filter(Boolean).join(" ");

export default function CreateAssessment({ folders: foldersProp }) {
  // Folders
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [folders, setFolders] = useState(foldersProp || []);

  // Rubrics
  const [rubricMode, setRubricMode] = useState("existing"); // "existing" | "new" | "import"
  const [rubrics, setRubrics] = useState([]);
  const [loadingRubrics, setLoadingRubrics] = useState(false);
  const [selectedRubricId, setSelectedRubricId] = useState("");

  // Assessment meta
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");

  // Builder
  const [criteria, setCriteria] = useState([]);
  const [importText, setImportText] = useState("");

  // UX
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // Load folders if not provided
  useEffect(() => {
    if (foldersProp && foldersProp.length) return;
    (async () => {
      try {
        setLoadingFolders(true);
        const res = await axios.get(`${API_BASE}/folders`);
        setFolders(res.data.folders || []);
      } catch {
        setFolders([]);
      } finally {
        setLoadingFolders(false);
      }
    })();
  }, [foldersProp]);

  // Load existing rubrics
  useEffect(() => {
    (async () => {
      try {
        setLoadingRubrics(true);
        const res = await axios.get(`${API_BASE}/rubrics`);
        setRubrics(Array.isArray(res.data) ? res.data : (res.data?.rubrics || []));
      } catch {
        setRubrics([]);
      } finally {
        setLoadingRubrics(false);
      }
    })();
  }, []);

  const totalWeight = useMemo(
    () => criteria.reduce((s, c) => s + Number(c.weight || 0), 0),
    [criteria]
  );

  const canSaveBase = name.trim() && folder;
  const canSaveExisting = rubricMode === "existing" && selectedRubricId;
  const canSaveNewOrImport =
    (rubricMode === "new" || rubricMode === "import") &&
    criteria.length > 0 &&
    criteria.every((c) => c.title?.trim()) &&
    totalWeight > 0;

  const canSave = canSaveBase && (canSaveExisting || canSaveNewOrImport);

  // ---------- builder helpers ----------
  const addCriterion = () => {
    setCriteria((prev) => [
      ...prev,
      { id: uid(), title: "", weight: "", ratings: [] },
    ]);
  };

  const duplicateCriterion = (id) => {
    setCriteria((prev) => {
      const src = prev.find((c) => c.id === id);
      if (!src) return prev;
      const clone = {
        ...src,
        id: uid(),
        title: `${src.title || "Untitled"} (copy)`,
        ratings: (src.ratings || []).map((r) => ({ ...r, id: uid() })),
      };
      const i = prev.findIndex((c) => c.id === id);
      const next = [...prev];
      next.splice(i + 1, 0, clone);
      return next;
    });
  };

  const removeCriterion = (id) => {
    setCriteria((prev) => prev.filter((c) => c.id !== id));
  };

  const moveCriterion = (id, dir) => {
    setCriteria((prev) => {
      const i = prev.findIndex((c) => c.id === id);
      if (i < 0) return prev;
      const j = dir === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= prev.length) return prev;
      const copy = [...prev];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  };

  const updateCriterion = (id, patch) => {
    setCriteria((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const addRating = (criterionId) => {
    setCriteria((prev) =>
      prev.map((c) => {
        if (c.id !== criterionId) return c;
        const next = { id: uid(), label: "", points: "", description: "" };
        return { ...c, ratings: [...(c.ratings || []), next] };
      })
    );
  };

  const updateRating = (criterionId, ratingId, patch) => {
    setCriteria((prev) =>
      prev.map((c) => {
        if (c.id !== criterionId) return c;
        return {
          ...c,
          ratings: (c.ratings || []).map((r) => (r.id === ratingId ? { ...r, ...patch } : r)),
        };
      })
    );
  };

  const removeRating = (criterionId, ratingId) => {
    setCriteria((prev) =>
      prev.map((c) => {
        if (c.id !== criterionId) return c;
        return { ...c, ratings: (c.ratings || []).filter((r) => r.id !== ratingId) };
      })
    );
  };

  const moveRating = (criterionId, ratingId, dir) => {
    setCriteria((prev) =>
      prev.map((c) => {
        if (c.id !== criterionId) return c;
        const idx = (c.ratings || []).findIndex((r) => r.id === ratingId);
        if (idx < 0) return c;
        const j = dir === "up" ? idx - 1 : idx + 1;
        if (j < 0 || j >= c.ratings.length) return c;
        const arr = [...c.ratings];
        [arr[idx], arr[j]] = [arr[j], arr[idx]];
        return { ...c, ratings: arr };
      })
    );
  };

  const autoBalance = () => {
    if (!criteria.length) return;
    const even = Math.floor(100 / criteria.length);
    const remainder = 100 - even * criteria.length;
    setCriteria((prev) =>
      prev.map((c, i) => ({ ...c, weight: i === 0 ? even + remainder : even }))
    );
  };

  // ---------- validation ----------
  const validate = (criteria) => {
    const issues = [];
    criteria.forEach((c, idx) => {
      if (!c.title?.trim()) issues.push(`Criterion #${idx + 1}: title is required.`);
      const wNum = Number(c.weight);
      if (!Number.isFinite(wNum) || wNum < 0)
        issues.push(`Criterion #${idx + 1}: weight must be a non-negative number.`);
      if (!c.ratings?.length)
        issues.push(`Criterion #${idx + 1}: add at least one rating.`);
      c.ratings?.forEach((r, ri) => {
        if (!r.label?.trim())
          issues.push(`Criterion #${idx + 1} rating #${ri + 1}: label is required.`);
        if (!Number.isFinite(Number(r.points)))
          issues.push(
            `Criterion #${idx + 1} rating #${ri + 1}: points must be a number.`
          );
      });
    });
    return issues;
  };

  // ---------- import ----------
  const applyImport = () => {
    try {
      const obj = JSON.parse(importText);
      const imported = obj?.criteria || obj;
      if (!Array.isArray(imported))
        throw new Error("JSON should be an array of criteria or { criteria }.");
      const norm = imported.map((c) => ({
        id: c.id || uid(),
        title: c.title ?? "",
        weight: c.weight ?? "",
        ratings: (c.ratings || []).map((r) => ({
          id: r.id || uid(),
          label: r.label ?? "",
          points: r.points ?? "",
          description: r.description ?? "",
        })),
      }));
      setCriteria(norm);
      setInfo("Imported rubric applied to builder.");
      setError("");
      setRubricMode("import");
    } catch (e) {
      setError(e.message || "Invalid JSON.");
    }
  };

  // ---------- save ----------
  const handleSave = async (e) => {
    e.preventDefault();
    setError("");
    setInfo("");

    let payload = { name: name.trim(), folder };

    if (rubricMode === "existing") {
      if (!selectedRubricId) {
        setError("Please select a rubric.");
        return;
      }
      payload = { ...payload, rubricMode, rubricId: selectedRubricId };
    } else {
      const problems = validate(criteria);
      if (problems.length) {
        setError(problems.join("\n"));
        return;
      }
      const cleanCriteria = criteria.map((c) => ({
        id: c.id,
        title: c.title.trim(),
        weight: Number(c.weight || 0),
        ratings: (c.ratings || []).map((r) => ({
          id: r.id,
          label: r.label.trim(),
          points: Number(r.points || 0),
          description: r.description?.trim() || "",
        })),
      }));
      payload = {
        ...payload,
        rubricMode,
        rubric: { criteria: cleanCriteria, totalWeight },
      };
    }

    try {
      setSaving(true);
      await axios.post(`${API_BASE}/create-assessment`, payload);
      setInfo("Assessment saved!");
    } catch (err) {
      setError(err?.response?.data?.message || "Failed to save assessment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-6">
      {/* Card container */}
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h3 className="text-base font-semibold text-slate-900">Create Assessment</h3>

        {/* Meta row */}
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="text-sm text-slate-700">Assessment Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Midterm Essay Rubric"
              className="mt-1 w-full rounded-xl border-0 ring-1 ring-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-700">Source Folder (student essays)</span>
            <select
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              disabled={loadingFolders}
              className="mt-1 w-full rounded-xl border-0 ring-1 ring-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
            >
              <option value="">
                {loadingFolders ? "Loading…" : "Select folder"}
              </option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Rubric source segmented control */}
        <div className="mt-6">
          <div className="text-sm font-medium text-slate-700">Rubric source</div>
          <div className="mt-2 inline-flex overflow-hidden rounded-xl ring-1 ring-slate-200">
            {[
              { key: "existing", label: "Use existing" },
              { key: "new", label: "Create new" },
              { key: "import", label: "Import JSON" },
            ].map((opt, i, arr) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setRubricMode(opt.key)}
                className={cx(
                  "px-3 py-2 text-sm",
                  "focus:outline-none",
                  rubricMode === opt.key
                    ? "bg-blue-600 text-white"
                    : "bg-white hover:bg-slate-50",
                  i !== arr.length - 1 && "border-r border-slate-200"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Existing picker */}
          {rubricMode === "existing" && (
            <div className="mt-4 max-w-xl">
              <label className="block">
                <span className="text-sm text-slate-700">Choose a rubric</span>
                <select
                  value={selectedRubricId}
                  onChange={(e) => setSelectedRubricId(e.target.value)}
                  disabled={loadingRubrics}
                  className="mt-1 w-full rounded-xl border-0 ring-1 ring-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
                >
                  <option value="">
                    {loadingRubrics ? "Loading…" : "Select rubric"}
                  </option>
                  {rubrics.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name || r.id}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-1 text-xs text-slate-500">
                Selecting an existing rubric won’t modify it.
              </p>
            </div>
          )}

          {/* Import JSON */}
          {rubricMode === "import" && (
            <div className="mt-4">
              <label className="block">
                <span className="text-sm text-slate-700">Paste rubric JSON</span>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  rows={6}
                  className="mt-1 w-full rounded-xl border-0 ring-1 ring-slate-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder='{"criteria":[{"title":"","weight":0,"ratings":[{"label":"","points":0,"description":""}]}]}'
                />
              </label>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={applyImport}
                  className="h-9 rounded-lg px-3 text-sm ring-1 ring-slate-200 hover:bg-slate-50"
                >
                  Apply to builder
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setImportText("");
                    setCriteria([]);
                  }}
                  className="h-9 rounded-lg px-3 text-sm ring-1 ring-slate-200 hover:bg-slate-50"
                >
                  Clear
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">IDs are normalized automatically.</p>
            </div>
          )}
        </div>

        {/* Builder */}
        {(rubricMode === "new" || rubricMode === "import") && (
          <div className="mt-6">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium text-slate-800">Rubric Builder</div>
              <div className="text-sm">
                Total weight:{" "}
                <span
                  className={totalWeight === 100 ? "text-green-600" : "text-amber-600"}
                >
                  {totalWeight}%
                </span>
                {totalWeight !== 100 && (
                  <button
                    type="button"
                    onClick={autoBalance}
                    className="ml-2 h-8 rounded-lg px-2 text-xs ring-1 ring-slate-200 hover:bg-slate-50"
                  >
                    Auto-balance
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-4">
              {criteria.map((c, ci) => (
                <div
                  key={c.id}
                  className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
                >
                  {/* Criterion header */}
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <label className="flex-1">
                      <span className="text-sm text-slate-700">Criterion title</span>
                      <input
                        value={c.title}
                        onChange={(e) => updateCriterion(c.id, { title: e.target.value })}
                        placeholder="e.g., Analysis & argument"
                        className="mt-1 w-full rounded-xl border-0 ring-1 ring-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </label>

                    <label className="w-full sm:w-40">
                      <span className="text-sm text-slate-700">Weight (%)</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={c.weight}
                        onChange={(e) =>
                          updateCriterion(c.id, {
                            weight: e.target.value === "" ? "" : Number(e.target.value),
                          })
                        }
                        className="mt-1 w-full rounded-xl border-0 ring-1 ring-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </label>

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => moveCriterion(c.id, "up")}
                        disabled={ci === 0}
                        title="Move up"
                        className={cx(
                          "h-9 rounded-lg px-3 text-sm ring-1 ring-slate-200 hover:bg-slate-50",
                          ci === 0 && "opacity-50 cursor-not-allowed"
                        )}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveCriterion(c.id, "down")}
                        disabled={ci === criteria.length - 1}
                        title="Move down"
                        className={cx(
                          "h-9 rounded-lg px-3 text-sm ring-1 ring-slate-200 hover:bg-slate-50",
                          ci === criteria.length - 1 && "opacity-50 cursor-not-allowed"
                        )}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => duplicateCriterion(c.id)}
                        className="h-9 rounded-lg px-3 text-sm ring-1 ring-slate-200 hover:bg-slate-50"
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        onClick={() => removeCriterion(c.id)}
                        className="h-9 rounded-lg px-3 text-sm text-rose-600 ring-1 ring-slate-200 hover:bg-rose-50"
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  {/* Ratings */}
                  <div className="mt-4">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-sm font-medium text-slate-800">Ratings</div>
                      <button
                        type="button"
                        onClick={() => addRating(c.id)}
                        className="h-8 rounded-lg px-3 text-sm ring-1 ring-slate-200 hover:bg-slate-50"
                      >
                        + Add rating
                      </button>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead className="bg-slate-50">
                          <tr>
                            <th className="px-2 py-2 text-left font-medium text-slate-700">
                              Label
                            </th>
                            <th className="px-2 py-2 text-left font-medium text-slate-700">
                              Points
                            </th>
                            <th className="px-2 py-2 text-left font-medium text-slate-700">
                              Descriptor
                            </th>
                            <th className="w-36 px-2 py-2 text-left font-medium text-slate-700">
                              Actions
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {(c.ratings || []).map((r, ri) => (
                            <tr key={r.id} className="border-t">
                              <td className="px-2 py-2">
                                <input
                                  value={r.label}
                                  onChange={(e) =>
                                    updateRating(c.id, r.id, { label: e.target.value })
                                  }
                                  placeholder="e.g., Excellent"
                                  className="w-full rounded-lg border-0 ring-1 ring-slate-200 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                              </td>
                              <td className="px-2 py-2">
                                <input
                                  type="number"
                                  min="0"
                                  max="100"
                                  value={r.points}
                                  onChange={(e) =>
                                    updateRating(c.id, r.id, {
                                      points: e.target.value === "" ? "" : Number(e.target.value),
                                    })
                                  }
                                  className="w-28 rounded-lg border-0 ring-1 ring-slate-200 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                              </td>
                              <td className="px-2 py-2">
                                <textarea
                                  value={r.description}
                                  onChange={(e) =>
                                    updateRating(c.id, r.id, { description: e.target.value })
                                  }
                                  placeholder="Describe what qualifies for this rating"
                                  className="w-full rounded-lg border-0 ring-1 ring-slate-200 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                              </td>
                              <td className="px-2 py-2">
                                <div className="flex gap-1">
                                  <button
                                    type="button"
                                    onClick={() => moveRating(c.id, r.id, "up")}
                                    disabled={ri === 0}
                                    title="Move up"
                                    className={cx(
                                      "h-8 rounded-lg px-2 text-xs ring-1 ring-slate-200 hover:bg-slate-50",
                                      ri === 0 && "opacity-50 cursor-not-allowed"
                                    )}
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => moveRating(c.id, r.id, "down")}
                                    disabled={ri === (c.ratings?.length || 0) - 1}
                                    title="Move down"
                                    className={cx(
                                      "h-8 rounded-lg px-2 text-xs ring-1 ring-slate-200 hover:bg-slate-50",
                                      ri === (c.ratings?.length || 0) - 1 &&
                                        "opacity-50 cursor-not-allowed"
                                    )}
                                  >
                                    ↓
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => removeRating(c.id, r.id)}
                                    className="h-8 rounded-lg px-2 text-xs text-rose-600 ring-1 ring-slate-200 hover:bg-rose-50"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                          {!c.ratings?.length && (
                            <tr>
                              <td
                                colSpan={4}
                                className="px-2 py-3 text-sm text-slate-500"
                              >
                                No ratings yet.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={addCriterion}
                className="h-9 rounded-lg px-3 text-sm ring-1 ring-slate-200 hover:bg-slate-50"
              >
                + Add criterion
              </button>
            </div>
          </div>
        )}

        {/* Save footer */}
        <div className="mt-6 flex items-center gap-3">
          <button
            type="submit"
            disabled={!canSave || saving}
            className={cx(
              "h-10 rounded-xl px-4 text-white",
              (!canSave || saving)
                ? "bg-blue-300 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-700"
            )}
          >
            {saving ? "Saving…" : "Save Assessment"}
          </button>
          {error && (
            <p className="text-sm text-rose-600 whitespace-pre-line">{error}</p>
          )}
          {info && <p className="text-sm text-green-700">{info}</p>}
        </div>
      </div>
    </form>
  );
}
