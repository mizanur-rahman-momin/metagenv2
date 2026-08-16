import { useEffect, useMemo, useRef, useState } from "react";
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
  UploadSimple,
  Sparkle,
  ArrowClockwise,
} from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { generateMetadata } from "@/lib/providers";
import { fileToDownscaledImage, isImageName } from "@/lib/imageUtils";
import {
  pickDirectoryImages,
  moveToDone,
  supportsFileSystemAccess,
} from "@/lib/fsUtils";
import { buildCSV, buildTXT, downloadFile } from "@/lib/exporters";

const GEMINI_MODELS = [
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
];

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
  const [geminiModel, setGeminiModel] = useState(
    saved.geminiModel || "gemini-2.5-flash"
  );
  const [orModel, setOrModel] = useState(saved.orModel || "openai/gpt-4o-mini");
  const [apiKeysText, setApiKeysText] = useState(saved.apiKeysText || "");
  const [concurrency, setConcurrency] = useState(saved.concurrency || 3);
  const [category, setCategory] = useState(saved.category || "none");
  const [prompt, setPrompt] = useState(saved.prompt || DEFAULT_PROMPT);

  const [images, setImages] = useState([]);
  const [folderName, setFolderName] = useState("");
  const [processing, setProcessing] = useState(false);

  const dirHandleRef = useRef(null);
  const stopRef = useRef(false);
  const imagesRef = useRef(images);
  const uploadInputRef = useRef(null);

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
        geminiModel,
        orModel,
        apiKeysText,
        concurrency,
        category,
        prompt,
      })
    );
  }, [provider, geminiModel, orModel, apiKeysText, concurrency, category, prompt]);

  const parsedKeys = useMemo(
    () =>
      apiKeysText
        .split("\n")
        .map((k) => k.trim())
        .filter(Boolean),
    [apiKeysText]
  );

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

  const newRow = (name, extra) => ({
    id: crypto.randomUUID(),
    name,
    status: "pending",
    title: "",
    description: "",
    keywords: [],
    error: "",
    ...extra,
  });

  const pickFolder = async () => {
    try {
      const { dirHandle, files } = await pickDirectoryImages();
      dirHandleRef.current = dirHandle;
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
    setFolderName(list.length ? "Uploaded selection" : "");
    setImages(list.map((f) => newRow(f.name, { file: f })));
    if (list.length) toast.success(`Loaded ${list.length} image(s). (Auto-move disabled in upload mode.)`);
    else toast.warning("No images in the selected folder.");
    e.target.value = "";
  };

  const processOne = async (id, keys, keyIndex, model) => {
    const img = imagesRef.current.find((i) => i.id === id);
    if (!img) return;
    updateImage(id, { status: "processing", error: "" });
    try {
      const file = img.handle ? await img.handle.getFile() : img.file;
      const { base64, dataUrl, mimeType } = await fileToDownscaledImage(file);

      let meta;
      try {
        meta = await generateMetadata({
          provider,
          model,
          apiKey: keys[keyIndex],
          base64,
          dataUrl,
          mimeType,
          prompt,
        });
      } catch (e1) {
        if (keys.length > 1) {
          const alt = (keyIndex + 1) % keys.length;
          meta = await generateMetadata({
            provider,
            model,
            apiKey: keys[alt],
            base64,
            dataUrl,
            mimeType,
            prompt,
          });
        } else {
          throw e1;
        }
      }

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
      });
    } catch (e) {
      updateImage(id, { status: "error", error: e.message || String(e) });
    }
  };

  const start = async () => {
    if (!parsedKeys.length) {
      toast.error("Add at least one API key.");
      return;
    }
    const model = provider === "gemini" ? geminiModel : orModel.trim();
    if (!model) {
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
    setProcessing(true);

    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (stopRef.current) return;
        const pos = cursor++;
        if (pos >= queue.length) return;
        await processOne(queue[pos], parsedKeys, pos % parsedKeys.length, model);
      }
    };

    const n = Math.max(1, Math.min(10, Number(concurrency) || 1));
    await Promise.all(Array.from({ length: n }, worker));

    setProcessing(false);
    if (stopRef.current)
      toast.info("Stopped. Completed results are ready to download.");
    else toast.success("Processing complete.");
  };

  const stop = () => {
    stopRef.current = true;
    toast.info("Stopping after in-flight images finish…");
  };

  const getModel = () => (provider === "gemini" ? geminiModel : orModel.trim());

  const retryImage = async (id) => {
    if (!parsedKeys.length) return toast.error("Add at least one API key.");
    const model = getModel();
    const idx = imagesRef.current.findIndex((i) => i.id === id);
    await processOne(id, parsedKeys, (idx < 0 ? 0 : idx) % parsedKeys.length, model);
  };

  const retryFailed = async () => {
    if (!parsedKeys.length) return toast.error("Add at least one API key.");
    const model = getModel();
    const ids = imagesRef.current
      .filter((i) => i.status === "error")
      .map((i) => i.id);
    if (!ids.length) return;

    stopRef.current = false;
    setProcessing(true);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (stopRef.current) return;
        const pos = cursor++;
        if (pos >= ids.length) return;
        const gid = ids[pos];
        const idx = imagesRef.current.findIndex((i) => i.id === gid);
        await processOne(gid, parsedKeys, (idx < 0 ? pos : idx) % parsedKeys.length, model);
      }
    };
    const n = Math.max(1, Math.min(10, Number(concurrency) || 1));
    await Promise.all(Array.from({ length: n }, worker));
    setProcessing(false);
    toast.success("Retry finished.");
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
                <Select value={geminiModel} onValueChange={setGeminiModel}>
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
