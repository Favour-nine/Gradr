// src/components/Upload.jsx
import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { CloudUpload } from "lucide-react";

const API_BASE = import.meta.env?.VITE_API_BASE || "http://localhost:5000";
const cx = (...a) => a.filter(Boolean).join(" ");

export default function Upload() {
  // files
  const [files, setFiles] = useState([]);
  const [previews, setPreviews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // folders
  const [folders, setFolders] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderMsg, setFolderMsg] = useState("");

  // status / polling
  const [showStatus, setShowStatus] = useState(false);
  const [statusList, setStatusList] = useState([]);
  const [statusSummary, setStatusSummary] = useState({ total: 0, done: 0 });
  const pollTimerRef = useRef(null);

  const fileInputRef = useRef(null);

  // ---------- helpers ----------
  const sanitizeFolderName = (name) =>
    (name || "").trim().replace(/[\\/:*?"<>|]+/g, "_");

  const handleFiles = (selected) => {
    const list = Array.from(selected);
    setFiles(list);
    setPreviews(list.map((f) => URL.createObjectURL(f)));
  };

  const handleFileChange = (e) => handleFiles(e.target.files);
  const handleDragOver = (e) => {
    e.preventDefault();
    setDragActive(true);
  };
  const handleDragLeave = () => setDragActive(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
  };

  const resetFilesUI = () => {
    setFiles([]);
    setPreviews([]);
  };

  // ---------- load folders ----------
  useEffect(() => {
    (async () => {
      try {
        const res = await axios.get(`${API_BASE}/folders`);
        setFolders(res.data.folders || []);
      } catch { /* ignore */ }
    })();
  }, []);

  // ---------- create folder ----------
  const createFolder = async () => {
    const safe = sanitizeFolderName(newFolderName);
    if (!safe) return;
    setCreatingFolder(true);
    try {
      await axios.post(`${API_BASE}/folders`, { name: safe });
      const res = await axios.get(`${API_BASE}/folders`);
      setFolders(res.data.folders || []);
      setSelectedFolder(safe);
      setNewFolderName("");
      setFolderMsg(`Created folder "${safe}".`);
      setTimeout(() => setFolderMsg(""), 2500);
    } finally {
      setCreatingFolder(false);
    }
  };

  // ---------- polling ----------
  const checkStatus = async () => {
    const folder = (newFolderName.trim() || selectedFolder || "").trim();
    if (!folder) return;

    try {
      const { data } = await axios.get(
        `${API_BASE}/jobs/folder/${encodeURIComponent(folder)}`
      );
      const items = data.items || data.files || [];
      setStatusList(items);
      setStatusSummary({
        total: data.total ?? items.length,
        done: data.done ?? items.filter((i) => i.processed).length,
      });
    } catch (e) {
      console.error("Status error:", e?.response?.data || e.message);
    }
  };

  const startPolling = () => {
    if (pollTimerRef.current) return; // already polling
    pollTimerRef.current = setInterval(checkStatus, 5000);
    checkStatus(); // immediate update
  };

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  // stop when complete
  useEffect(() => {
    if (statusSummary.total > 0 && statusSummary.done >= statusSummary.total) {
      stopPolling();
    }
  }, [statusSummary.done, statusSummary.total]);

  // cleanup on unmount
  useEffect(() => {
    return () => stopPolling();
  }, []);

  // if user changes folder or typed name, reset/stop
  useEffect(() => {
    stopPolling();
    setStatusList([]);
    setStatusSummary({ total: 0, done: 0 });
  }, [selectedFolder, newFolderName]);

  const toggleStatus = () => {
    if (showStatus) {
      stopPolling();
      setShowStatus(false);
      setStatusList([]);
      setStatusSummary({ total: 0, done: 0 });
    } else {
      setShowStatus(true);
      startPolling();
    }
  };

  // ---------- upload ----------
  const canUpload =
    files.length > 0 &&
    (selectedFolder || newFolderName.trim()) &&
    !loading;

  const handleUpload = async () => {
    if (!files.length) return;

    setLoading(true);
    try {
      const folder = sanitizeFolderName(
        newFolderName.trim() || selectedFolder
      );
      if (!folder) {
        alert("Please choose a folder or create one.");
        setLoading(false);
        return;
      }

      // Auto-create if user typed a new folder but didn’t click Create
      if (newFolderName.trim() && !folders.includes(folder)) {
        await axios.post(`${API_BASE}/folders`, { name: folder });
        const res = await axios.get(`${API_BASE}/folders`);
        setFolders(res.data.folders || []);
      }

      const formData = new FormData();
      formData.append("folder", folder);
      files.forEach((f) => formData.append("images", f));

      await axios.post(`${API_BASE}/upload-batch-queue`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      resetFilesUI();
      setShowStatus(true);
      startPolling();
    } catch (err) {
      console.error(err);
      alert("Batch upload failed.");
    } finally {
      setLoading(false);
    }
  };

  // ---------- render ----------
  const pct = statusSummary.total
    ? Math.round((statusSummary.done / statusSummary.total) * 100)
    : 0;

  return (
    <div className="mx-auto max-w-4xl px-4 pb-12">
      <div className="mt-6 rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-2xl font-semibold text-slate-900">Upload</h1>
        <p className="mt-1 text-slate-600">
          Add images to a folder; OCR runs in the background.
        </p>

        {/* Drag & Drop */}
        <div
          className={cx(
            "mt-6 rounded-2xl border-2 border-dashed p-8 text-center transition-colors",
            dragActive ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-white",
            "cursor-pointer"
          )}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="mb-3 flex justify-center">
            <CloudUpload size={72} className="text-blue-500" />
          </div>
          <p className="text-sm text-slate-600">
            Drag and drop images here, or{" "}
            <span className="text-blue-700 underline">click to browse</span>
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {/* Count */}
        {files.length > 0 && (
          <div className="mt-3 text-center text-sm text-slate-600">
            {files.length} file{files.length > 1 ? "s" : ""} selected
          </div>
        )}

        {/* Preview */}
        {previews[0] && (
          <div className="mt-4 text-center">
            <p className="mb-2 text-xs text-slate-500">Preview of first file</p>
            <div className="inline-block overflow-hidden rounded-xl ring-1 ring-slate-200">
              <img
                src={previews[0]}
                alt="Preview"
                className="max-h-64 w-full object-contain bg-slate-50"
              />
            </div>
          </div>
        )}

        {/* Upload Button */}
        <div className="mt-6 text-center">
          <button
            onClick={handleUpload}
            disabled={!canUpload}
            className={cx(
              "h-10 rounded-xl px-5 text-sm font-medium text-white",
              canUpload ? "bg-blue-600 hover:bg-blue-700" : "bg-blue-300 cursor-not-allowed"
            )}
          >
            {loading ? "Uploading..." : "Upload"}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            Choose a folder or create one to enable upload.
          </p>
        </div>

        {/* Folder + Status (centered content) */}
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {/* Choose folder & Status */}
          <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
            <h2 className="text-sm font-semibold text-slate-800 text-center md:text-left">
              Choose folder
            </h2>

            <select
              className="mt-2 h-10 w-full rounded-xl bg-blue-50 px-3 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={selectedFolder}
              onChange={(e) => setSelectedFolder(e.target.value)}
            >
              <option value="">(no folder selected)</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <button
                onClick={toggleStatus}
                className={cx(
                  "h-10 rounded-xl px-3 text-sm ring-1 ring-slate-200",
                  showStatus
                    ? "bg-blue-600 text-white hover:bg-blue-700"
                    : "bg-white hover:bg-slate-50"
                )}
              >
                {showStatus ? "Hide OCR Status" : "Check OCR Status"}
              </button>
              <button
                onClick={() => {
                  if (newFolderName.trim()) {
                    setSelectedFolder(sanitizeFolderName(newFolderName));
                  }
                  if (!showStatus) { setShowStatus(true); startPolling(); }
                  else { checkStatus(); }
                }}
                className="h-10 rounded-xl bg-white px-3 text-sm ring-1 ring-slate-200 hover:bg-slate-50"
              >
                Refresh now
              </button>
            </div>

            {/* Status summary */}
            {showStatus && (
              <div className="mt-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-slate-700">
                    {statusSummary.total ? (
                      <>
                        {statusSummary.done} / {statusSummary.total} complete
                      </>
                    ) : (
                      <>Waiting for jobs…</>
                    )}
                  </div>
                  <span
                    className={cx(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs",
                      pct === 100
                        ? "bg-green-100 text-green-700"
                        : "bg-slate-100 text-slate-700"
                    )}
                  >
                    {pct}%
                  </span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className="h-2 bg-blue-500" style={{ width: `${pct}%` }} />
                </div>

                {/* Status list */}
                {statusList.length > 0 && (
                  <ul className="mt-3 space-y-1 text-sm">
                    {statusList.map((item, idx) => (
                      <li key={idx} className="flex items-center justify-between rounded-lg px-2 py-1 hover:bg-slate-50">
                        <span className="truncate">{item.file}</span>
                        <span
                          className={cx(
                            "ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[11px]",
                            item.processed ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                          )}
                        >
                          {item.processed ? "Done" : "Processing…"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Create new folder */}
          <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
            <h2 className="text-sm font-semibold text-slate-800 text-center md:text-left">
              Create new folder
            </h2>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                className="h-10 flex-1 rounded-xl border-0 px-3 text-sm ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g., EssaySet1"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
              />
              <button
                type="button"
                onClick={createFolder}
                disabled={creatingFolder || !newFolderName.trim()}
                className={cx(
                  "h-10 rounded-xl px-4 text-sm font-medium text-white",
                  creatingFolder || !newFolderName.trim()
                    ? "bg-blue-300 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700"
                )}
              >
                {creatingFolder ? "Creating..." : "Create"}
              </button>
            </div>
            {folderMsg && (
              <p className="mt-2 text-xs text-green-700">{folderMsg}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
