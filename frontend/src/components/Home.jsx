// src/components/Home.jsx
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";

const API_BASE = import.meta.env?.VITE_API_BASE || "http://localhost:5000";
const cx = (...a) => a.filter(Boolean).join(" ");

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [folders, setFolders] = useState([]); // [{ name, total, done }]
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError("");

        const res = await axios.get(`${API_BASE}/folders`);
        const names = res.data?.folders || [];

        const top = names.slice(0, 8);
        const stats = await Promise.all(
          top.map(async (name) => {
            try {
              const r = await axios.get(
                `${API_BASE}/jobs/folder/${encodeURIComponent(name)}`
              );
              return { name, total: r.data?.total ?? 0, done: r.data?.done ?? 0 };
            } catch {
              return { name, total: 0, done: 0 };
            }
          })
        );

        if (!cancelled) setFolders(stats);
      } catch {
        if (!cancelled) setError("Could not load folders.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-screen-2xl px-4 pb-16">
      {/* Hero */}
      <section className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-2xl font-semibold text-slate-900">Welcome to Gradr</h1>
        <p className="mt-2 max-w-2xl text-slate-600">
          Upload essays, auto-transcribe, and grade with rubrics—manually or with AI.
        </p>

        {/* Quick actions */}
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            to="/upload"
            className="inline-flex items-center rounded-xl bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            Upload essays
          </Link>

          <button
            onClick={() => navigate("/assessment?view=create")}
            className="inline-flex items-center rounded-xl bg-white px-4 py-2 ring-1 ring-slate-200 hover:bg-slate-50"
          >
            Create assessment
          </button>
          <button
            onClick={() => navigate("/assessment?view=grade")}
            className="inline-flex items-center rounded-xl bg-white px-4 py-2 ring-1 ring-slate-200 hover:bg-slate-50"
          >
            Grade assessment
          </button>
        </div>
      </section>

      {/* Recent folders */}
      <section className="mt-6 grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">Recent folders</h2>
            {loading && <span className="text-xs text-slate-500">Loading…</span>}
          </div>

          {error && (
            <div className="mb-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
              {error}
            </div>
          )}

          {(!folders || folders.length === 0) && !loading ? (
            <p className="text-sm text-slate-500">
              No folders yet. Try uploading essays to get started.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {folders.map((f) => {
                const pct = f.total ? Math.round((f.done / f.total) * 100) : 0;
                return (
                  <li key={f.name} className="rounded-xl p-4 ring-1 ring-slate-200">
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-slate-900 truncate">{f.name}</div>
                      <div
                        className={cx(
                          "ml-3 inline-flex items-center rounded-full px-2 py-0.5 text-xs",
                          pct === 100
                            ? "bg-green-100 text-green-700"
                            : "bg-slate-100 text-slate-700"
                        )}
                      >
                        {pct}% OCR
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-slate-500">
                      {f.done} / {f.total} transcribed
                    </div>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                      <div className="h-2 bg-blue-500" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() =>
                          navigate(
                            `/assessment?folder=${encodeURIComponent(
                              f.name
                            )}&view=grade`
                          )
                        }
                        className="h-8 rounded-lg px-3 text-xs ring-1 ring-slate-200 hover:bg-slate-50"
                      >
                        Grade from this folder
                      </button>
                      <button
                        onClick={() =>
                          navigate(`/upload?folder=${encodeURIComponent(f.name)}`)
                        }
                        className="h-8 rounded-lg px-3 text-xs ring-1 ring-slate-200 hover:bg-slate-50"
                      >
                        Add more files
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Tips */}
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-sm font-semibold text-slate-800">Tips</h2>
          <ul className="mt-3 space-y-2 text-sm text-slate-600">
            <li>• Click a word in the viewer to see its transcription overlay.</li>
            <li>• Use “Auto grade” to get AI suggestions, then refine.</li>
            <li>• Aim for rubric weights totaling 100%.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
