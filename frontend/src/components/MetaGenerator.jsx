import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { toast } from "sonner";
import {
  FolderOpen,
  Play,
  Stop,
  FileCsv,
  FileText,
  Key,
  Sliders,
  Images,
  CheckCircle,
  Warning,
  CircleNotch,
  Circle,
  Sparkle,
  ArrowClockwise,
  ArrowCounterClockwise,
  ShieldCheck,
  Pulse,
  XCircle,
} from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

import { DEFAULT_PROMPT } from "@/constants/prompt";
import { ADOBE_CATEGORIES } from "@/lib/adobeCategories";
import { generateWithFailover, testKey, PING_TIMEOUT_MS } from "@/lib/providers";
import { ErrorKind } from "@/lib/errorKinds";
import {
  getKey,
  hashKey,
  maskKey,
  recordFailure,
  recordSuccess,
  resetAll as resetHealthAll,
  resetKey as resetHealthKey,
  setKeyEnabled,
  snapshot as healthSnapshot,
} from "@/lib/poolRegistry";
import { fileToDownscaledImage, isImageName } from "@/lib/imageUtils";
import {
  pickDirectoryImages,
  moveToDone,
  supportsFileSystemAccess,
  DONE_FOLDER,
} from "@/lib/fsUtils";
import { buildCSV, buildTXT, downloadFile, firstCsvField } from "@/lib/exporters";

// Real Generative Language API model IDs. Unavailable models are skipped
// automatically by the failover engine, but keep this list maintained.
const GEMINI_MODELS = [
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { value: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
];

const DEFAULT_PRIMARY_MODEL = "gemini-2.5-flash";
const DEFAULT_FALLBACK_MODELS = ["gemini-2.5-flash-lite", "gemini-2.0-flash"];

const LS_KEY = "stockmeta:settings";

const loadSettings = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
};

export default function MetaGenerator() {
  const saved = useMemo(loadSettings, []);
  const fsSupported = useMemo(supportsFileSystemAccess, []);

  const [provider, setProvider] = useState(saved.provider || "gemini");
  const [primaryModel, setPrimaryModel] = useState(
    saved.primaryModel || saved.geminiModel || DEFAULT_PRIMARY_MODEL
  );
  const [fallbackModels, setFallbackModels] = useState(
    Array.isArray(saved.fallbackModels) ? saved.fallbackModels : DEFAULT_FALLBACK_MODELS
  );
  const [orModel, setOrModel] = useState(saved.orModel || "openai/gpt-4o-mini");
  const [orFallbackText, setOrFallbackText] = useState(
    typeof saved.orFallbackModels === "string"
      ? saved.orFallbackModels
      : Array.isArray(saved.orFallbackModels)
        ? saved.orFallbackModels.join(", ")
        : ""
  );
  const [autoFallback, setAutoFallback] = useState(saved.autoFallback !== false);
  const [autoProbe, setAutoProbe] = useState(saved.autoProbe !== false);
  const [patientRetry, setPatientRetry] = useState(saved.patientRetry !== false);
  const [apiKeysText, setApiKeysText] = useState(saved.apiKeysText || "");
  const [concurrency, setConcurrency] = useState(saved.concurrency || 3);
  const [category, setCategory] = useState(saved.category || "none");
  const [prompt, setPrompt] = useState(saved.prompt || DEFAULT_PROMPT);

  const [images, setImages] = useState([]);
  const [folderName, setFolderName] = useState("");
  const [processing, setProcessing] = useState(false);
  const [healthVersion, setHealthVersion] = useState(0);
  const [testing, setTesting] = useState(false);

  const dirHandleRef = useRef(null);
  const stopRef = useRef(false);
  const abortRef = useRef(null);
  const imagesRef = useRef(images);
  const uploadInputRef = useRef(null);
  const doneMapRef = useRef({});
  const csvWriteChain = useRef(Promise.resolve());

  const bumpHealth = useCallback(() => setHealthVersion((v) => v + 1), []);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    if (uploadInputRef.current) {
      uploadInputRef.current.setAttribute("webkitdirectory", "");
      uploadInputRef.current.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        provider,
        primaryModel,
        geminiModel: primaryModel, // legacy mirror
        fallbackModels,
        orModel,
        orFallbackModels: orFallbackText,
        autoFallback,
        autoProbe,
        patientRetry,
        apiKeysText,
        concurrency,
        category,
        prompt,
      })
    );
  }, [
    provider,
    primaryModel,
    fallbackModels,
    orModel,
    orFallbackText,
    autoFallback,
    autoProbe,
    patientRetry,
    apiKeysText,
    concurrency,
    category,
    prompt,
  ]);

  const parsedKeys = useMemo(
    () =>
      apiKeysText
        .split("\n")
        .map((k) => k.trim())
        .filter(Boolean),
    [apiKeysText]
  );

  // Deduped key pool with hashes + masked labels (raw keys never leave memory).
  const keyEntries = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const key of parsedKeys) {
      const hash = hashKey(key);
      if (seen.has(hash)) continue;
      seen.add(hash);
      out.push({ hash, key, label: maskKey(key) });
    }
    return out;
  }, [parsedKeys]);

  // Ordered model chain = primary followed by enabled fallbacks.
  const effectiveModels = useMemo(() => {
    if (provider === "gemini") {
      const list = autoFallback ? [primaryModel, ...fallbackModels] : [primaryModel];
      return [...new Set(list.filter(Boolean))];
    }
    const fallbacks = orFallbackText
      .split(/[\n,]+/)
      .map((m) => m.trim())
      .filter(Boolean);
    const list = autoFallback ? [orModel.trim(), ...fallbacks] : [orModel.trim()];
    return [...new Set(list.filter(Boolean))];
  }, [provider, autoFallback, primaryModel, fallbackModels, orModel, orFallbackText]);

  const stats = useMemo(() => {
    const total = images.length;
    let done = 0,
      error = 0,
      processingCount = 0;
    for (const i of images) {
      if (i.status === "done") done++;
      else if (i.status === "error") error++;
      else if (i.status === "processing") processingCount++;
    }
    return { total, done, error, processing: processingCount, finished: done + error };
  }, [images]);

  const progressPct =
    stats.total > 0 ? Math.round((stats.finished / stats.total) * 100) : 0;

  const updateImage = (id, patch) =>
    setImages((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  // Serialized live-write of metadata.csv into the "meta done" folder.
  // Reads any existing file first and APPENDS new rows (dedupe by filename)
  // so results survive page reloads instead of being overwritten.
  const writeDoneCSV = () => {
    if (!dirHandleRef.current) return; // folder mode only
    const cat = category === "none" ? "" : category;
    csvWriteChain.current = csvWriteChain.current.then(async () => {
      try {
        const doneDir = await dirHandleRef.current.getDirectoryHandle(
          DONE_FOLDER,
          { create: true }
        );

        // Read existing metadata.csv (if any) and keep its rows as-is.
        let headerLine = "Filename,Title,Keywords,Category,Releases";
        let existingLines = [];
        const existingNames = new Set();
        try {
          const fh0 = await doneDir.getFileHandle("metadata.csv");
          const text = await (await fh0.getFile()).text();
          const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
          if (lines.length) {
            headerLine = lines[0];
            existingLines = lines.slice(1);
            for (const l of existingLines) {
              const nm = firstCsvField(l);
              if (nm) existingNames.add(nm);
            }
          }
        } catch {
          /* no existing file yet */
        }

        // Only append session rows whose filename isn't already in the file.
        const ordered = imagesRef.current
          .filter((i) => doneMapRef.current[i.id])
          .map((i) => doneMapRef.current[i.id]);
        const newRows = ordered.filter((r) => !existingNames.has(r.name));
        if (!newRows.length && existingLines.length) return;

        const newDataLines = buildCSV(newRows, cat).split("\r\n").slice(1);
        const content = [headerLine, ...existingLines, ...newDataLines].join(
          "\r\n"
        );

        const fh = await doneDir.getFileHandle("metadata.csv", { create: true });
        const w = await fh.createWritable();
        await w.write(content);
        await w.close();
      } catch {
        /* ignore transient write errors */
      }
    });
  };

  const newRow = (name, extra) => ({
    id: crypto.randomUUID(),
    name,
    status: "pending",
    title: "",
    description: "",
    keywords: [],
    error: "",
    usedKey: "",
    usedModel: "",
    ...extra,
  });

  const pickFolder = async () => {
    try {
      const { dirHandle, files } = await pickDirectoryImages();
      dirHandleRef.current = dirHandle;
      doneMapRef.current = {};
      setFolderName(dirHandle.name);
      setImages(files.map((f) => newRow(f.name, { handle: f.handle })));
      if (!files.length) toast.warning("No images found in that folder.");
      else toast.success(`Loaded ${files.length} image(s) from "${dirHandle.name}".`);
    } catch (e) {
      if (e?.name !== "AbortError") toast.error(e.message || "Could not open folder.");
    }
  };

  const onUpload = (e) => {
    const list = Array.from(e.target.files || []).filter((f) => isImageName(f.name));
    dirHandleRef.current = null;
    doneMapRef.current = {};
    setFolderName(list.length ? "Uploaded selection" : "");
    setImages(list.map((f) => newRow(f.name, { file: f })));
    if (list.length) toast.success(`Loaded ${list.length} image(s). (Auto-move disabled in upload mode.)`);
    else toast.warning("No images in the selected folder.");
    e.target.value = "";
  };

  const processOne = async (id, keys, models) => {
    const img = imagesRef.current.find((i) => i.id === id);
    if (!img) return;
    updateImage(id, { status: "processing", error: "", usedKey: "", usedModel: "" });
    try {
      const file = img.handle ? await img.handle.getFile() : img.file;
      const { base64, dataUrl, mimeType } = await fileToDownscaledImage(file);

      const { meta, keyLabel, model } = await generateWithFailover({
        provider,
        models,
        keys,
        prompt,
        base64,
        dataUrl,
        mimeType,
        stopRef,
        onEvent: bumpHealth,
        signal: abortRef.current?.signal,
        patient: patientRetry,
      });

      if (img.handle && dirHandleRef.current) {
        try {
          await moveToDone(dirHandleRef.current, img.handle, img.name);
        } catch {
          /* keep result even if move fails */
        }
      }

      updateImage(id, {
        status: "done",
        title: meta.title,
        description: meta.description,
        keywords: meta.keywords,
        usedKey: keyLabel,
        usedModel: model,
      });

      // Live-append to the CSV inside the "meta done" folder (folder mode only).
      // CSV schema is intentionally unchanged — no usedKey/usedModel here.
      doneMapRef.current[id] = {
        name: img.name,
        title: meta.title,
        description: meta.description,
        keywords: meta.keywords,
      };
      writeDoneCSV();
    } catch (e) {
      updateImage(id, { status: "error", error: e.message || String(e) });
    }
  };

  const start = async () => {
    if (!parsedKeys.length) {
      toast.error("Add at least one API key.");
      return;
    }
    const models = effectiveModels;
    if (!models.length) {
      toast.error("Choose or enter a model.");
      return;
    }
    const queue = imagesRef.current
      .filter((i) => i.status === "pending" || i.status === "error")
      .map((i) => i.id);
    if (!queue.length) {
      toast.warning("No pending images to process.");
      return;
    }

    stopRef.current = false;
    abortRef.current = new AbortController();
    setProcessing(true);

    // Probe unknown/cooling keys in the background; does not delay images.
    if (autoProbe) probeKeys({ all: false });

    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (stopRef.current) return;
        const pos = cursor++;
        if (pos >= queue.length) return;
        await processOne(queue[pos], parsedKeys, models);
      }
    };

    const n = Math.max(1, Math.min(10, Number(concurrency) || 1));
    await Promise.all(Array.from({ length: n }, worker));

    setProcessing(false);
    abortRef.current = null;
    if (stopRef.current)
      toast.info("Stopped. Completed results are ready to download.");
    else toast.success("Processing complete.");
  };

  const stop = () => {
    stopRef.current = true;
    abortRef.current?.abort();
    toast.info("Stopping after in-flight images finish…");
  };

  const ensureAbortController = () => {
    if (!abortRef.current || abortRef.current.signal.aborted) {
      abortRef.current = new AbortController();
    }
    return abortRef.current;
  };

  const retryImage = async (id) => {
    if (!parsedKeys.length) return toast.error("Add at least one API key.");
    if (!effectiveModels.length) return toast.error("Choose or enter a model.");
    stopRef.current = false;
    ensureAbortController();
    await processOne(id, parsedKeys, effectiveModels);
  };

  const retryFailed = async () => {
    if (!parsedKeys.length) return toast.error("Add at least one API key.");
    if (!effectiveModels.length) return toast.error("Choose or enter a model.");
    const ids = imagesRef.current
      .filter((i) => i.status === "error")
      .map((i) => i.id);
    if (!ids.length) return;

    stopRef.current = false;
    ensureAbortController();
    setProcessing(true);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (stopRef.current) return;
        const pos = cursor++;
        if (pos >= ids.length) return;
        await processOne(ids[pos], parsedKeys, effectiveModels);
      }
    };
    const n = Math.max(1, Math.min(10, Number(concurrency) || 1));
    await Promise.all(Array.from({ length: n }, worker));
    setProcessing(false);
    toast.success("Retry finished.");
  };

  const currentModel = () =>
    provider === "gemini" ? primaryModel : orModel.trim();

  // Probe keys with a tiny text-only request and record the health result.
  const probeKeys = useCallback(
    async ({ all = false } = {}) => {
      const model = provider === "gemini" ? primaryModel : orModel.trim();
      if (!model || !keyEntries.length) return;
      const targets = all
        ? keyEntries
        : keyEntries.filter(({ hash }) => {
            const rec = getKey(hash);
            return (
              !rec ||
              rec.status === "unknown" ||
              rec.status === "cooling" ||
              rec.status === "degraded"
            );
          });
      await Promise.all(
        targets.map(async ({ hash, key }) => {
          const result = await testKey(provider, key, model, {
            timeoutMs: PING_TIMEOUT_MS,
            signal: abortRef.current?.signal,
          });
          if (result.ok) {
            recordSuccess(hash, model, result.latencyMs);
          } else if (result.kind && result.kind !== ErrorKind.STOPPED) {
            recordFailure(hash, model, result.kind, null, result.message);
          }
          bumpHealth();
        })
      );
    },
    [provider, primaryModel, orModel, keyEntries, bumpHealth]
  );

  const handleTestKeys = async () => {
    if (!keyEntries.length) return toast.error("Add at least one API key.");
    if (!currentModel()) return toast.error("Choose or enter a model.");
    setTesting(true);
    ensureAbortController();
    toast.info(`Testing ${keyEntries.length} key(s)…`);
    await probeKeys({ all: true });
    setTesting(false);
    toast.success("Key test finished.");
  };

  const handleTestKey = async (entry) => {
    const model = currentModel();
    if (!model) return toast.error("Choose or enter a model.");
    ensureAbortController();
    const result = await testKey(provider, entry.key, model, {
      timeoutMs: PING_TIMEOUT_MS,
      signal: abortRef.current?.signal,
    });
    if (result.ok) recordSuccess(entry.hash, model, result.latencyMs);
    else if (result.kind && result.kind !== ErrorKind.STOPPED)
      recordFailure(entry.hash, model, result.kind, null, result.message);
    bumpHealth();
  };

  const handleResetKey = (hash) => {
    resetHealthKey(hash);
    bumpHealth();
  };

  const handleResetHealth = () => {
    resetHealthAll();
    bumpHealth();
    toast.success("Key health reset.");
  };

  const handleToggleKey = (hash, enabled) => {
    setKeyEnabled(hash, enabled);
    bumpHealth();
  };

  const toggleFallback = (value) => {
    setFallbackModels((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
  };

  const results = useMemo(
    () => images.filter((i) => i.status === "done"),
    [images]
  );
  const csvCategory = category === "none" ? "" : category;

  const downloadCSV = () => {
    if (!results.length) return toast.warning("No completed results yet.");
    downloadFile(
      buildCSV(results, csvCategory),
      "adobe-stock-metadata.csv",
      "text/csv;charset=utf-8;"
    );
  };
  const downloadTXT = () => {
    if (!results.length) return toast.warning("No completed results yet.");
    downloadFile(buildTXT(results), "metadata.txt", "text/plain;charset=utf-8;");
  };

  const clearAll = () => {
    if (processing) return;
    setImages([]);
    setFolderName("");
    dirHandleRef.current = null;
    doneMapRef.current = {};
  };

  return (
    <div className="min-h-screen bg-[#09090B] text-[#FAFAFA]">
      <div className="max-w-[1400px] mx-auto px-5 sm:px-8 py-10">
        {/* Header */}
        <header className="border-b border-white/10 pb-6 mb-8">
          <div className="flex items-center gap-2 label-tech mb-3">
            <Sparkle size={14} weight="fill" className="text-[#FACC15]" />
            Adobe Stock Metadata Generator
          </div>
          <h1 className="font-heading font-black tracking-tight text-4xl leading-none">
            StockMeta
          </h1>
          <p className="text-[#A1A1AA] text-sm mt-3 max-w-2xl">
            Batch-generate submission-ready titles, descriptions and keywords
            from a folder of images using your own Gemini or OpenRouter keys.
            Keys rotate automatically to dodge free-tier limits.
          </p>
        </header>

        {/* Control panel — bento grid */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-px bg-white/10 border border-white/10 mb-8">
          {/* API Keys */}
          <section className="md:col-span-12 lg:col-span-5 bg-[#18181B] p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 label-tech">
                <Key size={14} /> API Keys
              </div>
              <span className="font-mono-tech text-xs text-[#71717A]">
                {parsedKeys.length} key{parsedKeys.length === 1 ? "" : "s"} · rotating
              </span>
            </div>
            <Textarea
              data-testid="api-keys-textarea"
              value={apiKeysText}
              onChange={(e) => setApiKeysText(e.target.value)}
              placeholder={"Paste one API key per line…\nAIzaSy... (Gemini)\nsk-or-... (OpenRouter)"}
              spellCheck={false}
              className="no-resize font-mono-tech text-xs h-[168px] bg-[#0B0B0D] border-white/10 rounded-none focus-visible:ring-1 focus-visible:ring-white leading-relaxed"
            />
            <p className="text-[#71717A] text-xs mt-2 font-mono-tech">
              Image 1 → Key 1, Image 2 → Key 2 … wraps around. Stored only in
              your browser.
            </p>
          </section>

          {/* Options */}
          <section className="md:col-span-6 lg:col-span-4 bg-[#18181B] p-5 space-y-4">
            <div className="flex items-center gap-2 label-tech">
              <Sliders size={14} /> Options
            </div>

            <div className="space-y-1.5">
              <Label className="label-tech">Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger
                  data-testid="provider-select"
                  className="rounded-none bg-[#0B0B0D] border-white/10 font-mono-tech text-sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-none">
                  <SelectItem value="gemini">Google Gemini</SelectItem>
                  <SelectItem value="openrouter">OpenRouter</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="label-tech">Model</Label>
              {provider === "gemini" ? (
                <Select value={primaryModel} onValueChange={setPrimaryModel}>
                  <SelectTrigger
                    data-testid="model-select"
                    className="rounded-none bg-[#0B0B0D] border-white/10 font-mono-tech text-sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-none">
                    {GEMINI_MODELS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="space-y-2">
                  <Input
                    data-testid="openrouter-model-input"
                    value={orModel}
                    onChange={(e) => setOrModel(e.target.value)}
                    placeholder="e.g. openai/gpt-4o-mini"
                    className="rounded-none bg-[#0B0B0D] border-white/10 font-mono-tech text-sm focus-visible:ring-1 focus-visible:ring-white"
                  />
                  <div className="flex flex-wrap gap-2">
                    {["openai/gpt-4o", "openai/gpt-4o-mini"].map((m) => (
                      <button
                        key={m}
                        data-testid={`or-preset-${m}`}
                        onClick={() => setOrModel(m)}
                        className="font-mono-tech text-[11px] px-2 py-1 border border-white/10 text-[#A1A1AA] hover:border-white/40 hover:text-white transition-colors"
                        style={{ transition: "border-color .15s ease, color .15s ease" }}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="label-tech">Fallback models (in order)</Label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="font-mono-tech text-[10px] text-[#71717A]">
                    auto
                  </span>
                  <Switch
                    data-testid="auto-fallback-switch"
                    checked={autoFallback}
                    onCheckedChange={setAutoFallback}
                    className="data-[state=checked]:bg-[#4ADE80] data-[state=unchecked]:bg-[#27272A]"
                  />
                </label>
              </div>

              {provider === "gemini" ? (
                <div className="space-y-1.5">
                  {GEMINI_MODELS.filter((m) => m.value !== primaryModel).map((m) => (
                    <label
                      key={m.value}
                      className="flex items-center gap-2 cursor-pointer group"
                    >
                      <Checkbox
                        data-testid={`fallback-model-checkbox-${m.value}`}
                        checked={fallbackModels.includes(m.value)}
                        onCheckedChange={() => toggleFallback(m.value)}
                        className="rounded-none border-white/20 data-[state=checked]:bg-[#FACC15] data-[state=checked]:text-black data-[state=checked]:border-[#FACC15]"
                      />
                      <span className="font-mono-tech text-[11px] text-[#A1A1AA] group-hover:text-white transition-colors">
                        {m.label}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Input
                    data-testid="or-fallback-input"
                    value={orFallbackText}
                    onChange={(e) => setOrFallbackText(e.target.value)}
                    placeholder="openai/gpt-4o, anthropic/claude-3.5-sonnet"
                    className="rounded-none bg-[#0B0B0D] border-white/10 font-mono-tech text-xs focus-visible:ring-1 focus-visible:ring-white"
                  />
                  <p className="text-[#71717A] text-[10px] font-mono-tech">
                    Comma separated. Tried in order after the primary.
                  </p>
                </div>
              )}

              <div
                data-testid="model-chain-readout"
                className="font-mono-tech text-[10px] text-[#71717A] border border-white/10 px-2 py-1.5 break-all"
                title="Effective model chain"
              >
                <span className="text-[#52525b]">chain/ </span>
                {effectiveModels.length ? effectiveModels.join(" → ") : "—"}
              </div>

              <label className="flex items-center gap-2 cursor-pointer pt-0.5">
                <Switch
                  data-testid="auto-probe-switch"
                  checked={autoProbe}
                  onCheckedChange={setAutoProbe}
                  className="data-[state=checked]:bg-[#4ADE80] data-[state=unchecked]:bg-[#27272A]"
                />
                <span className="font-mono-tech text-[10px] text-[#71717A]">
                  Probe unknown keys on start
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer pt-0.5">
                <Switch
                  data-testid="patient-retry-switch"
                  checked={patientRetry}
                  onCheckedChange={setPatientRetry}
                  className="data-[state=checked]:bg-[#4ADE80] data-[state=unchecked]:bg-[#27272A]"
                />
                <span className="font-mono-tech text-[10px] text-[#71717A]">
                  Wait out rate limits and keep retrying (free-tier)
                </span>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="label-tech">Parallel</Label>
                <Input
                  data-testid="concurrency-input"
                  type="number"
                  min={1}
                  max={10}
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value)}
                  className="rounded-none bg-[#0B0B0D] border-white/10 font-mono-tech text-sm focus-visible:ring-1 focus-visible:ring-white"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="label-tech">Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger
                    data-testid="category-select"
                    className="rounded-none bg-[#0B0B0D] border-white/10 font-mono-tech text-sm"
                  >
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent className="rounded-none max-h-[280px]">
                    <SelectItem value="none">None</SelectItem>
                    {ADOBE_CATEGORIES.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.id}. {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </section>

          {/* Actions */}
          <section className="md:col-span-6 lg:col-span-3 bg-[#18181B] p-5 flex flex-col">
            <div className="flex items-center gap-2 label-tech mb-4">
              <Images size={14} /> Run
            </div>

            {fsSupported ? (
              <Button
                data-testid="select-folder-button"
                onClick={pickFolder}
                disabled={processing}
                className="rounded-none bg-transparent border border-white/20 text-white hover:bg-white hover:text-black font-mono-tech text-sm justify-start gap-2 mb-2"
                style={{ transition: "background-color .15s ease, color .15s ease" }}
              >
                <FolderOpen size={16} weight="bold" /> Select Folder
              </Button>
            ) : (
              <p className="text-[#FACC15] text-xs mb-2 font-mono-tech">
                Folder auto-move needs Chrome/Edge. Using upload mode.
              </p>
            )}

            <button
              data-testid="upload-folder-button"
              onClick={() => uploadInputRef.current?.click()}
              disabled={processing}
              className="text-[#71717A] hover:text-white text-xs font-mono-tech underline underline-offset-4 text-left mb-4 transition-colors disabled:opacity-40"
              style={{ transition: "color .15s ease" }}
            >
              {fsSupported ? "or upload a folder (no auto-move)" : "Upload a folder"}
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={onUpload}
            />

            <div className="grid grid-cols-2 gap-2 mt-auto">
              <Button
                data-testid="start-button"
                onClick={start}
                disabled={processing || !images.length}
                className="rounded-none bg-white text-black hover:bg-white/80 font-mono-tech text-sm gap-2"
                style={{ transition: "background-color .15s ease" }}
              >
                <Play size={15} weight="fill" /> Start
              </Button>
              <Button
                data-testid="stop-button"
                onClick={stop}
                disabled={!processing}
                className="rounded-none bg-[#F87171] text-black hover:bg-[#f87171]/80 font-mono-tech text-sm gap-2"
                style={{ transition: "background-color .15s ease" }}
              >
                <Stop size={15} weight="fill" /> Stop
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-2 mt-2">
              <Button
                data-testid="download-csv-button"
                onClick={downloadCSV}
                disabled={!results.length}
                variant="outline"
                className="rounded-none bg-transparent border-white/20 text-white hover:bg-[#27272A] font-mono-tech text-xs gap-1.5"
              >
                <FileCsv size={15} /> CSV
              </Button>
              <Button
                data-testid="download-txt-button"
                onClick={downloadTXT}
                disabled={!results.length}
                variant="outline"
                className="rounded-none bg-transparent border-white/20 text-white hover:bg-[#27272A] font-mono-tech text-xs gap-1.5"
              >
                <FileText size={15} /> TXT
              </Button>
            </div>
          </section>

          {/* Key health */}
          <section className="md:col-span-12 bg-[#18181B] p-5">
            <KeyHealthPanel
              entries={keyEntries}
              version={healthVersion}
              testing={testing}
              onTestAll={handleTestKeys}
              onResetAll={handleResetHealth}
              onResetKey={handleResetKey}
              onTestKey={handleTestKey}
              onToggle={handleToggleKey}
            />
          </section>
        </div>

        {/* Advanced prompt */}
        <Accordion type="single" collapsible className="border border-white/10 mb-8">
          <AccordionItem value="prompt" className="border-none">
            <AccordionTrigger
              data-testid="prompt-accordion-trigger"
              className="px-5 py-4 hover:no-underline label-tech data-[state=open]:text-white"
            >
              Advanced — Metadata Instruction Prompt
            </AccordionTrigger>
            <AccordionContent className="px-5 pb-5">
              <Textarea
                data-testid="prompt-textarea"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                spellCheck={false}
                className="no-resize font-mono-tech text-xs h-[280px] bg-[#0B0B0D] border-white/10 rounded-none focus-visible:ring-1 focus-visible:ring-white leading-relaxed"
              />
              <button
                data-testid="reset-prompt-button"
                onClick={() => setPrompt(DEFAULT_PROMPT)}
                className="mt-2 text-[#71717A] hover:text-white text-xs font-mono-tech flex items-center gap-1.5 transition-colors"
                style={{ transition: "color .15s ease" }}
              >
                <ArrowClockwise size={13} /> Reset to default
              </button>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        {/* Progress + stats */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-5 font-mono-tech text-xs">
            <span className="text-[#A1A1AA]">
              {folderName ? (
                <>
                  <span className="text-[#71717A]">folder/</span>
                  {folderName}
                </>
              ) : (
                "no folder selected"
              )}
            </span>
            <span className="text-[#4ADE80]" data-testid="stat-done">
              {stats.done} done
            </span>
            {stats.error > 0 && (
              <span className="text-[#F87171]" data-testid="stat-error">
                {stats.error} error
              </span>
            )}
            <span className="text-[#71717A]">{stats.total} total</span>
          </div>
          <div className="flex items-center gap-3">
            {stats.error > 0 && !processing && (
              <button
                data-testid="retry-failed-button"
                onClick={retryFailed}
                className="flex items-center gap-1.5 text-[#FACC15] hover:text-white text-xs font-mono-tech transition-colors"
                style={{ transition: "color .15s ease" }}
              >
                <ArrowClockwise size={13} /> retry {stats.error} failed
              </button>
            )}
            {images.length > 0 && !processing && (
              <button
                data-testid="clear-button"
                onClick={clearAll}
                className="text-[#71717A] hover:text-white text-xs font-mono-tech transition-colors"
                style={{ transition: "color .15s ease" }}
              >
                clear
              </button>
            )}
            <span className="font-mono-tech text-xs text-[#A1A1AA]">
              {progressPct}%
            </span>
          </div>
        </div>
        <div className="h-[2px] w-full bg-white/10 mb-8">
          <div
            data-testid="progress-bar"
            className="h-full bg-white"
            style={{ width: `${progressPct}%`, transition: "width .3s ease" }}
          />
        </div>

        {/* Results table */}
        <div className="border border-white/10">
          <div className="grid grid-cols-[36px_minmax(140px,1.4fr)_2fr_2.4fr] gap-px bg-white/10 label-tech">
            <div className="bg-[#18181B] px-3 py-2.5">#</div>
            <div className="bg-[#18181B] px-3 py-2.5">File / Status</div>
            <div className="bg-[#18181B] px-3 py-2.5">Title</div>
            <div className="bg-[#18181B] px-3 py-2.5">Keywords</div>
          </div>

          {images.length === 0 ? (
            <div
              data-testid="empty-state"
              className="px-6 py-24 text-center relative overflow-hidden"
            >
              <div
                className="absolute inset-0 opacity-[0.06] pointer-events-none"
                style={{
                  backgroundImage:
                    "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
                  backgroundSize: "28px 28px",
                }}
              />
              <div className="relative">
                <Images size={40} className="mx-auto text-[#3f3f46] mb-4" />
                <p className="font-mono-tech text-sm text-[#71717A]">
                  Select a folder to load images and begin.
                </p>
              </div>
            </div>
          ) : (
            <div className="max-h-[560px] overflow-y-auto">
              {images.map((img, idx) => (
                <ResultRow
                  key={img.id}
                  img={img}
                  index={idx + 1}
                  onRetry={retryImage}
                />
              ))}
            </div>
          )}
        </div>

        <footer className="mt-8 text-center">
          <p className="font-mono-tech text-[11px] text-[#52525b]">
            Candidate metadata for human review before submission. Verify
            accuracy & Adobe Stock policy compliance yourself.
          </p>
        </footer>
      </div>
    </div>
  );
}

const KEY_STATUS_META = {
  healthy: { label: "healthy", color: "#4ADE80" },
  degraded: { label: "degraded", color: "#FACC15" },
  cooling: { label: "cooling", color: "#FACC15" },
  invalid: { label: "invalid", color: "#F87171" },
  disabled: { label: "disabled", color: "#71717A" },
  unknown: { label: "unknown", color: "#52525b" },
};

function formatCountdown(ms) {
  if (!(ms > 0)) return "";
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Isolated from the root component so a 1s cooldown tick does not re-render
// the whole results table on large batches.
const KeyHealthPanel = memo(function KeyHealthPanel({
  entries,
  version,
  testing,
  onTestAll,
  onResetAll,
  onResetKey,
  onTestKey,
  onToggle,
}) {
  const [now, setNow] = useState(() => Date.now());
  const snap = healthSnapshot();
  const rows = entries.map((e) => ({
    ...e,
    rec: snap.keys.find((r) => r.hash === e.hash) || null,
  }));

  const anyCooldown = rows.some(
    ({ rec }) =>
      rec && Object.values(rec.cooldowns || {}).some((until) => until > now)
  );

  useEffect(() => {
    if (!anyCooldown) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyCooldown, version]);

  return (
    <div data-version={version}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 label-tech">
          <ShieldCheck size={14} /> Key Health
        </div>
        <div className="flex items-center gap-3">
          <button
            data-testid="test-keys-button"
            onClick={onTestAll}
            disabled={testing || !entries.length}
            className="flex items-center gap-1.5 text-[#FACC15] hover:text-white text-xs font-mono-tech transition-colors disabled:opacity-40"
            style={{ transition: "color .15s ease" }}
          >
            {testing ? (
              <CircleNotch size={13} weight="bold" className="animate-spin" />
            ) : (
              <Pulse size={13} weight="bold" />
            )}
            Test keys
          </button>
          <button
            data-testid="reset-health-button"
            onClick={onResetAll}
            disabled={!entries.length}
            className="flex items-center gap-1.5 text-[#71717A] hover:text-white text-xs font-mono-tech transition-colors disabled:opacity-40"
            style={{ transition: "color .15s ease" }}
          >
            <ArrowCounterClockwise size={13} /> Reset health
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="font-mono-tech text-xs text-[#52525b]">
          Paste API keys above to see health.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <div className="flex items-center gap-3 font-mono-tech text-[10px] text-[#52525b] px-1 pb-1 min-w-[720px]">
            <span className="w-3" />
            <span className="w-28">KEY</span>
            <span className="w-20">STATUS</span>
            <span className="w-20">PASS/FAIL</span>
            <span className="w-16">LATENCY</span>
            <span className="w-20">COOLDOWN</span>
            <span className="flex-1">LAST ERROR</span>
            <span className="w-24" />
            <span className="w-10" />
          </div>
          {rows.map(({ hash, label, rec, key }) => {
            const cooldownRemaining = rec
              ? Math.max(
                  0,
                  ...Object.values(rec.cooldowns || {}).map((until) => until - now),
                  -1
                )
              : 0;
            const status = rec?.status || "unknown";
            const displayStatus =
              cooldownRemaining > 0 &&
              status !== "invalid" &&
              status !== "disabled"
                ? "cooling"
                : status;
            const meta = KEY_STATUS_META[displayStatus] || KEY_STATUS_META.unknown;
            const enabled = status !== "disabled" && status !== "invalid";
            const errTitle = rec?.lastErrorKind
              ? `${rec.lastErrorKind}${rec.lastError ? `: ${rec.lastError}` : ""}`
              : "No errors";

            return (
              <div
                key={hash}
                data-testid={`key-health-row-${hash}`}
                className="flex items-center gap-3 font-mono-tech text-[11px] border-t border-white/10 py-2 min-w-[720px]"
              >
                <span
                  className="w-3 flex justify-center"
                  style={{ color: meta.color }}
                >
                  {enabled ? (
                    <Circle size={8} weight="fill" />
                  ) : (
                    <XCircle size={11} weight="fill" />
                  )}
                </span>
                <span
                  className="w-28 truncate text-[#E4E4E7]"
                  title={label}
                >
                  {label}
                </span>
                <span
                  data-testid={`key-status-${hash}`}
                  className="w-20 truncate"
                  style={{ color: meta.color }}
                >
                  {meta.label}
                </span>
                <span className="w-20 text-[#A1A1AA]">
                  ✓{rec?.successCount || 0} / ✗{rec?.failCount || 0}
                </span>
                <span className="w-16 text-[#71717A]">
                  {rec?.avgLatencyMs ? `${rec.avgLatencyMs}ms` : "—"}
                </span>
                <span className="w-20 text-[#FACC15]">
                  {cooldownRemaining > 0
                    ? formatCountdown(cooldownRemaining)
                    : ""}
                </span>
                <span
                  className="flex-1 truncate text-[#52525b]"
                  title={errTitle}
                >
                  {rec?.lastErrorKind || ""}
                </span>
                <button
                  data-testid={`key-test-${hash}`}
                  onClick={() => onTestKey({ hash, key, label })}
                  className="w-24 text-[10px] text-[#A1A1AA] hover:text-white border border-white/10 hover:border-white/40 px-1.5 py-0.5 transition-colors"
                  style={{ transition: "color .15s ease, border-color .15s ease" }}
                >
                  test
                </button>
                <button
                  data-testid={`key-reset-${hash}`}
                  onClick={() => onResetKey(hash)}
                  className="w-10 text-[10px] text-[#71717A] hover:text-white transition-colors"
                  title="Reset this key"
                >
                  <ArrowCounterClockwise size={12} />
                </button>
                <Switch
                  data-testid={`key-toggle-${hash}`}
                  checked={enabled}
                  onCheckedChange={(v) => onToggle(hash, v)}
                  className="data-[state=checked]:bg-[#4ADE80] data-[state=unchecked]:bg-[#27272A]"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

function StatusBadge({ status, error }) {
  if (status === "done")
    return (
      <span className="flex items-center gap-1.5 text-[#4ADE80]">
        <CheckCircle size={13} weight="fill" /> done
      </span>
    );
  if (status === "processing")
    return (
      <span className="flex items-center gap-1.5 text-[#FACC15]">
        <CircleNotch size={13} weight="bold" className="animate-spin" /> working
      </span>
    );
  if (status === "error")
    return (
      <span
        className="flex items-center gap-1.5 text-[#F87171]"
        title={error}
      >
        <Warning size={13} weight="fill" /> error
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-[#52525b]">
      <Circle size={13} /> pending
    </span>
  );
}

function ResultRow({ img, index, onRetry }) {
  const isProc = img.status === "processing";
  return (
    <div
      data-testid={`result-row-${index}`}
      className="grid grid-cols-[36px_minmax(140px,1.4fr)_2fr_2.4fr] gap-px bg-white/10 border-t border-white/10 first:border-t-0"
    >
      <div className="bg-[#0B0B0D] px-3 py-2.5 font-mono-tech text-xs text-[#52525b]">
        {index}
      </div>
      <div
        className={`px-3 py-2.5 font-mono-tech text-xs ${
          isProc ? "bg-[#1c1a14]" : "bg-[#0B0B0D]"
        }`}
      >
        <div className="truncate text-[#FAFAFA]" title={img.name}>
          {img.name}
        </div>
        <div className="mt-1 text-[11px]">
          <StatusBadge status={img.status} error={img.error} />
        </div>
        {img.status === "done" && (img.usedKey || img.usedModel) && (
          <div className="mt-1 font-mono-tech text-[10px] text-[#71717A] truncate">
            {img.usedKey}
            {img.usedKey && img.usedModel ? " · " : ""}
            {img.usedModel}
            <span data-testid={`used-by-${index}`} className="hidden" />
          </div>
        )}
        {img.status === "error" && (
          <>
            <div className="mt-1 text-[10px] text-[#F87171]/70 line-clamp-2 break-all">
              {img.error}
            </div>
            <button
              data-testid={`retry-button-${index}`}
              onClick={() => onRetry?.(img.id)}
              disabled={isProc}
              className="mt-1.5 flex items-center gap-1 text-[10px] text-[#FACC15] hover:text-white border border-white/10 hover:border-white/40 px-1.5 py-0.5 transition-colors disabled:opacity-40"
              style={{ transition: "color .15s ease, border-color .15s ease" }}
            >
              <ArrowClockwise size={11} /> Retry
            </button>
          </>
        )}
      </div>
      <div className="bg-[#0B0B0D] px-3 py-2.5 text-xs text-[#E4E4E7]">
        {img.title || <span className="text-[#3f3f46]">—</span>}
        {img.description && (
          <div className="mt-1 text-[11px] text-[#71717A] line-clamp-2">
            {img.description}
          </div>
        )}
      </div>
      <div className="bg-[#0B0B0D] px-3 py-2.5">
        {img.keywords?.length ? (
          <div className="flex flex-wrap gap-1">
            {img.keywords.map((k, i) => (
              <span
                key={i}
                className={`font-mono-tech text-[10px] px-1.5 py-0.5 border ${
                  i < 10
                    ? "border-white/25 text-[#FAFAFA]"
                    : "border-white/10 text-[#A1A1AA]"
                }`}
              >
                {k}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-[#3f3f46] text-xs">—</span>
        )}
      </div>
    </div>
  );
}
