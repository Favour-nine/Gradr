// src/components/Assessment.jsx
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import CreateAssessment from "./CreateAssessment";
import GradeAssessment from "./GradeAssessment";
import ReviewAssessment from "./ReviewAssessment";

const cx = (...a) => a.filter(Boolean).join(" ");

function normalizeView(v) {
  const allowed = new Set(["create", "grade", "review"]);
  return allowed.has(v) ? v : "create";
}

export default function Assessment() {
  const location = useLocation();
  const navigate = useNavigate();

  // Parse search params
  const search = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const initialView = normalizeView(search.get("view") || "create");
  const folderHint = search.get("folder") || "";

  const [view, setView] = useState(initialView);

  // Keep local state synced if the URL changes externally
  useEffect(() => setView(initialView), [initialView]);

  const switchView = (nextView) => {
    const sp = new URLSearchParams(location.search);
    sp.set("view", nextView);
    // Keep any other params (e.g., &folder=...) intact
    navigate({ pathname: location.pathname, search: sp.toString() });
    setView(nextView);
  };

  return (
    <div className="mx-auto max-w-screen-2xl px-4 pb-12 mt-16">
      <h1 className="mb-4 text-2xl font-semibold text-slate-900"></h1>

      {/* Tabs */}
      <div className="mb-6 flex flex-wrap gap-2">
        {[
          ["create", "Create Assessment"],
          ["grade", "Grade Assessment"],
          ["review", "Review Assessment"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => switchView(key)}
            className={cx(
              "h-9 rounded-xl px-3 text-sm ring-1 ring-slate-200",
              view === key ? "bg-blue-600 text-white" : "bg-white hover:bg-slate-50"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Panels */}
      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        {view === "create" && <CreateAssessment />}
        {view === "grade" && <GradeAssessment initialFolderHint={folderHint} />}
        {view === "review" && <ReviewAssessment />}
      </div>
    </div>
  );
}
