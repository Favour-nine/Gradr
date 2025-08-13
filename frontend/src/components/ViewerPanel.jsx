import React, { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = import.meta.env?.VITE_API_BASE || "http://localhost:5000";
const cx = (...a) => a.filter(Boolean).join(" ");
const layoutCache = new Map(); // `${folder}/${base}` -> { lines, words, width, height }

export default function ViewerPanel({
  activeItem,   // { base, imageUrl, textUrl, processed }
  assessment,   // { folder }
  paneHeight = "65vh",
  onWordSelect, // optional
}) {
  const containerRef = useRef(null);
  const imgRef = useRef(null);

  const imageUrl = activeItem?.imageUrl || "";
  const base     = activeItem?.base || "";
  const folder   = assessment?.folder || "";
  const textUrl  = activeItem?.textUrl || "";
  const processed = !!activeItem?.processed;

  const cacheKey = `${folder}/${base}`;

  const [mode, setMode] = useState("image");
  useEffect(() => setMode("image"), [cacheKey]);

  const [nat, setNat]   = useState({ w: 0, h: 0 });
  const [disp, setDisp] = useState({ w: 0, h: 0, offX: 0, offY: 0 });

  const [layout, setLayout] = useState({ lines: [], words: [], width: 0, height: 0 });
  const [loadingLayout, setLoadingLayout] = useState(false);
  const [layoutErr, setLayoutErr] = useState("");
  const [generating, setGenerating] = useState(false);

  const [text, setText] = useState("");
  const [textLines, setTextLines] = useState([]);
  const [loadingText, setLoadingText] = useState(false);

  const [showAll, setShowAll] = useState(false);
  const [hit, setHit] = useState(null);

  useEffect(() => {
    setLayout({ lines: [], words: [], width: 0, height: 0 });
    setLayoutErr("");
    setShowAll(false);
    setHit(null);
    setText("");
    setTextLines([]);
    setLoadingText(false);
  }, [cacheKey]);

  // text
  useEffect(() => {
    let abort = false;
    if (!processed || !textUrl) { setText(""); setTextLines([]); return; }
    (async () => {
      try {
        setLoadingText(true);
        const r = await fetch(textUrl);
        const t = r.ok ? await r.text() : "";
        if (!abort) {
          setText(t);
          const lines = t.split(/\r?\n/).map(s => s.trim()).filter((s, i, arr) => s.length || arr.length > 1);
          setTextLines(lines);
        }
      } finally {
        if (!abort) setLoadingText(false);
      }
    })();
    return () => { abort = true; };
  }, [processed, textUrl]);

  // layout (cached)
  useEffect(() => {
    if (!base || !folder) return;
    const cached = layoutCache.get(cacheKey);
    if (cached) { setLayout(cached); return; }

    let abort = false;
    setLoadingLayout(true);
    fetch(`${API_BASE}/ocr/layout/${encodeURIComponent(folder)}/${encodeURIComponent(base)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(data => {
        if (abort) return;
        const safe = {
          lines: Array.isArray(data?.lines) ? data.lines : [],
          words: Array.isArray(data?.words) ? data.words : [],
          width: Number(data?.width || 0),
          height: Number(data?.height || 0),
        };
        const sorted = safe.lines.slice().sort((a,b) => (a.box?.[1]-b.box?.[1]) || (a.box?.[0]-b.box?.[0]));
        const idx = new Map(sorted.map((l,i) => [l, i]));
        safe.lines = safe.lines.map(l => ({ ...l, _i: idx.get(l) ?? 0 }));

        layoutCache.set(cacheKey, safe);
        setLayout(safe);
        if (!safe.lines.length && !safe.words.length) setLayoutErr("No boxes available.");
      })
      .catch(e => {
        console.error("layout fetch error:", e);
        if (!abort) setLayoutErr("No boxes available.");
      })
      .finally(() => !abort && setLoadingLayout(false));

    return () => { abort = true; };
  }, [API_BASE, cacheKey, base, folder]);

  // force-generate layout with client timeout
  const generateLayout = async () => {
    if (!base || !folder || generating) return;
    setGenerating(true);
    setLayoutErr("");
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 60000); // 60s client timeout
      const url = `${API_BASE}/ocr/layout/${encodeURIComponent(folder)}/${encodeURIComponent(base)}?refresh=1`;

      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(to);

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const safe = {
        lines: Array.isArray(data?.lines) ? data.lines : [],
        words: Array.isArray(data?.words) ? data.words : [],
        width: Number(data?.width || 0),
        height: Number(data?.height || 0),
      };
      const sorted = safe.lines.slice().sort((a,b) => (a.box?.[1]-b.box?.[1]) || (a.box?.[0]-b.box?.[0]));
      const idx = new Map(sorted.map((l,i) => [l, i]));
      safe.lines = safe.lines.map(l => ({ ...l, _i: idx.get(l) ?? 0 }));

      layoutCache.set(cacheKey, safe);
      setLayout(safe);
      if (!safe.lines.length && !safe.words.length) setLayoutErr("No boxes detected.");
    } catch (e) {
      if (e?.name === "AbortError") {
        setLayoutErr("Generation timed out. Try again.");
      } else {
        console.error("generate layout error:", e);
        setLayoutErr("Failed to generate word map.");
      }
    } finally {
      setGenerating(false);
    }
  };

  // geometry
  const computeGeometry = () => {
    const c = containerRef.current;
    if (!c || !nat.w || !nat.h) return;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    const s = Math.min(cw / nat.w, ch / nat.h);
    const dw = nat.w * s;
    const dh = nat.h * s;
    const offX = (cw - dw) / 2;
    const offY = (ch - dh) / 2;
    setDisp({ w: dw, h: dh, offX, offY });
  };
  const onImgLoad = (e) => {
    setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
    computeGeometry();
  };
  useEffect(() => {
    const ro = new ResizeObserver(computeGeometry);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [nat.w, nat.h]);

  const boxes = useMemo(() => {
    if (layout.lines?.length) return layout.lines;
    return layout.words || [];
  }, [layout]);

  // click -> show Nth line from .txt
  const onClick = (evt) => {
    if (!boxes.length) return;
    const rect = containerRef.current.getBoundingClientRect();
    const px = evt.clientX - rect.left - disp.offX;
    const py = evt.clientY - rect.top  - disp.offY;
    if (px < 0 || py < 0 || px > disp.w || py > disp.h) return;

    const nx = px / disp.w;
    const ny = py / disp.h;

    let target = null, bestArea = Infinity;
    for (const b of boxes) {
      const box = b.box || [];
      if (box.length !== 4) continue;
      const [x0,y0,x1,y1] = box;
      if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1) {
        const area = (x1 - x0) * (y1 - y0);
        if (area < bestArea) { bestArea = area; target = b; }
      }
    }
    if (!target) return;

    const [x0,y0,x1,y1] = target.box;
    const left   = disp.offX + x0 * disp.w;
    const top    = disp.offY + y0 * disp.h;
    const width  = (x1 - x0) * disp.w;
    const height = (y1 - y0) * disp.h;

    const idx = typeof target._i === "number"
      ? target._i
      : boxes.slice().sort((a,b) => (a.box[1]-b.box[1]) || (a.box[0]-b.box[0])).indexOf(target);

    const t = (textLines[idx] || "").trim();
    setHit({ text: t || `Line ${idx + 1}`, rect: { left, top: Math.max(0, top - 6), width, height } });

    if (onWordSelect && layout.words?.length) onWordSelect(target);
  };

  const status = useMemo(() => {
    if (mode === "text") {
      if (!processed) return "No transcription (OCR pending).";
      if (loadingText) return "Loading text…";
      return text ? "" : "No text.";
    }
    if (!imageUrl) return "No image.";
    if (loadingLayout) return "Detecting boxes…";
    if (generating) return "Generating…";
    if (layoutErr) return layoutErr;
    if (!boxes.length) return "No boxes detected.";
    return "Click a line.";
  }, [mode, processed, loadingText, text, imageUrl, loadingLayout, generating, layoutErr, boxes.length]);

  return (
    <div className="min-w-[640px] flex-1 min-h-0 rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-slate-800">Viewer</h3>

          <div className="flex items-center rounded-lg ring-1 ring-slate-200 overflow-hidden">
            {["image", "text", "split"].map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cx(
                  "px-3 py-1.5 text-xs",
                  mode === m ? "bg-blue-600 text-white" : "bg-white hover:bg-slate-50"
                )}
              >
                {m === "image" ? "Image (i)" : m === "text" ? "Text (t)" : "Split (x)"}
              </button>
            ))}
          </div>

          {(mode !== "text") && (
            <label className="ml-2 inline-flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                className="accent-blue-600"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                disabled={!boxes.length}
              />
              Show boxes
            </label>
          )}

          <span className="ml-2 text-xs text-slate-500">{status}</span>
        </div>

        <div className="flex items-center gap-2">
          {(mode !== "text") && imageUrl && !boxes.length && (
            <button
              onClick={generateLayout}
              disabled={generating}
              className={cx(
                "h-8 rounded-md px-3 text-xs ring-1 ring-slate-200",
                generating ? "opacity-60 cursor-not-allowed" : "bg-white hover:bg-slate-50"
              )}
              title="Run GPT to create a word/line map"
            >
              {generating ? "Generating…" : "Generate word map"}
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-4">
        {mode === "image" && (
          <div
            ref={containerRef}
            className="relative w-full overflow-hidden rounded-xl bg-slate-50 ring-1 ring-slate-200"
            style={{ height: paneHeight }}
            onClick={onClick}
          >
            {imageUrl ? (
              <img
                ref={imgRef}
                src={imageUrl}
                alt={activeItem?.base || "essay"}
                onLoad={onImgLoad}
                className="h-full w-full select-none object-contain"
                draggable={false}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">
                No image.
              </div>
            )}

            {showAll && boxes.map((b, i) => {
              const [x0,y0,x1,y1] = b.box || [0,0,1,1];
              const left = disp.offX + x0 * disp.w;
              const top  = disp.offY + y0 * disp.h;
              const width  = (x1 - x0) * disp.w;
              const height = (y1 - y0) * disp.h;
              return (
                <div
                  key={i}
                  className="pointer-events-none absolute rounded-[2px] ring-1 ring-blue-400/70"
                  style={{ left, top, width, height }}
                />
              );
            })}

            {hit && (
              <>
                <div
                  className="pointer-events-none absolute rounded-md bg-blue-500/10 ring-2 ring-blue-500/90"
                  style={hit.rect}
                />
                <div
                  className="pointer-events-none absolute -translate-y-2 rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow"
                  style={{
                    left: hit.rect.left,
                    top: Math.max(0, hit.rect.top - 28),
                    maxWidth: 520,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={hit.text}
                >
                  {hit.text}
                </div>
              </>
            )}
          </div>
        )}

        {mode === "text" && (
          <div
            className="w-full overflow-hidden rounded-xl bg-white ring-1 ring-slate-200"
            style={{ height: paneHeight }}
          >
            <pre className="h-full w-full overflow-auto p-4 text-sm leading-relaxed whitespace-pre-wrap break-words">
              {processed ? (loadingText ? "Loading…" : (text || "No text.")) : "No text (OCR pending)."}
            </pre>
          </div>
        )}

        {mode === "split" && (
          <div className="grid grid-cols-2 gap-3">
            <div
              ref={containerRef}
              className="relative w-full overflow-hidden rounded-xl bg-slate-50 ring-1 ring-slate-200"
              style={{ height: paneHeight }}
              onClick={onClick}
            >
              {imageUrl ? (
                <img
                  ref={imgRef}
                  src={imageUrl}
                  alt={activeItem?.base || "essay"}
                  onLoad={onImgLoad}
                  className="h-full w-full select-none object-contain"
                  draggable={false}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">
                  No image.
                </div>
              )}

              {showAll && boxes.map((b, i) => {
                const [x0,y0,x1,y1] = b.box || [0,0,1,1];
                const left = disp.offX + x0 * disp.w;
                const top  = disp.offY + y0 * disp.h;
                const width  = (x1 - x0) * disp.w;
                const height = (y1 - y0) * disp.h;
                return (
                  <div
                    key={i}
                    className="pointer-events-none absolute rounded-[2px] ring-1 ring-blue-400/70"
                    style={{ left, top, width, height }}
                  />
                );
              })}

              {hit && (
                <>
                  <div
                    className="pointer-events-none absolute rounded-md bg-blue-500/10 ring-2 ring-blue-500/90"
                    style={hit.rect}
                  />
                  <div
                    className="pointer-events-none absolute -translate-y-2 rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow"
                    style={{
                      left: hit.rect.left,
                      top: Math.max(0, hit.rect.top - 28),
                      maxWidth: 520,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={hit.text}
                  >
                    {hit.text}
                  </div>
                </>
              )}
            </div>

            <div
              className="w-full overflow-hidden rounded-xl bg-white ring-1 ring-slate-200"
              style={{ height: paneHeight }}
            >
              <pre className="h-full w-full overflow-auto p-4 text-sm leading-relaxed whitespace-pre-wrap break-words">
                {processed ? (loadingText ? "Loading…" : (text || "No text.")) : "No text (OCR pending)."}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
