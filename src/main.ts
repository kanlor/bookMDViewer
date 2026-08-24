import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import frontMatterPlugin from "markdown-it-front-matter";
import hljs from "highlight.js";
import DOMPurify from "dompurify";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

// hljs theme CSS as strings, so HTML export can be fully self-contained.
import hljsLightCss from "highlight.js/styles/github.css?inline";
import hljsDarkCss from "highlight.js/styles/github-dark.css?inline";

// ---------- Color theme (system / light / dark) ----------
type ThemePref = "system" | "light" | "dark";
const systemDarkMQ = window.matchMedia("(prefers-color-scheme: dark)");
let themePref = (localStorage.getItem("theme") as ThemePref | null) ?? "system";

// Whether the *effective* theme is dark, given the user's preference.
function currentDark(): boolean {
  return themePref === "dark" || (themePref === "system" && systemDarkMQ.matches);
}

// highlight.js theme is swapped by rewriting this <style> element's contents.
const hljsStyle = document.createElement("style");
hljsStyle.textContent = currentDark() ? hljsDarkCss : hljsLightCss;
document.head.appendChild(hljsStyle);

let lastFrontMatter = "";

const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (str, lang) => {
    // Leave mermaid blocks untouched so we can render them lazily later.
    if (lang === "mermaid") {
      return `<pre class="mermaid">${md.utils.escapeHtml(str)}</pre>`;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${
          hljs.highlight(str, { language: lang }).value
        }</code></pre>`;
      } catch {
        /* fall through to plain escaping */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
})
  .use(taskLists, { enabled: true, label: true })
  .use(frontMatterPlugin, (fm: string) => {
    lastFrontMatter = fm;
  });

// Disable setext headings so `text` immediately above `---` / `===` stays a
// paragraph + horizontal rule (the usual intent) instead of becoming a heading
// that pollutes the outline.
md.disable("lheading");

const content = document.getElementById("content") as HTMLElement;
const toc = document.getElementById("toc") as HTMLElement;
const layout = document.getElementById("layout") as HTMLElement;
const tocToggle = document.getElementById("toc-toggle") as HTMLButtonElement;
const editor = document.getElementById("editor") as HTMLTextAreaElement;
const editToggle = document.getElementById("edit-toggle") as HTMLButtonElement;
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
const exportBtn = document.getElementById("export-btn") as HTMLButtonElement;
const fontInc = document.getElementById("font-inc") as HTMLButtonElement;
const fontDec = document.getElementById("font-dec") as HTMLButtonElement;
const wideToggle = document.getElementById("wide-toggle") as HTMLButtonElement;
const themeToggle = document.getElementById("theme-toggle") as HTMLButtonElement;
const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
const filesBtn = document.getElementById("files-btn") as HTMLButtonElement;
const filesPanel = document.getElementById("files") as HTMLElement;
const findBar = document.getElementById("find-bar") as HTMLElement;
const findInput = document.getElementById("find-input") as HTMLInputElement;
const findCount = document.getElementById("find-count") as HTMLElement;
const replaceInput = document.getElementById("replace-input") as HTMLInputElement;
const closeModal = document.getElementById("close-modal") as HTMLElement;
const closeDocBtn = document.getElementById("close-doc-btn") as HTMLButtonElement;
const toastEl = document.getElementById("toast") as HTMLElement;
const appWindow = getCurrentWindow();
const sbPathEl = document.getElementById("sb-path") as HTMLElement;
const sbOutlineEl = document.getElementById("sb-outline") as HTMLElement;
const sbStatsEl = document.getElementById("sb-stats") as HTMLElement;
const sbFileinfoEl = document.getElementById("sb-fileinfo") as HTMLElement;
const EMPTY_STATE_HTML = `<div class="empty-state">
  <h1>KanlorOne MDViewer</h1>
  <p>拖放 <code>.md</code> 文件到此处，或 <a id="empty-open" href="#">打开文件</a>。</p>
  <p class="app-version"><a id="about-open" href="#">关于 / About</a></p>
  <div id="recent-list"></div>
</div>`;
let closeAction: "window" | "doc" | "switch" = "window";
let pendingSwitchPath: string | null = null;
let currentPath: string | null = null;
let currentText = "";
let currentEncoding = "";
type ViewMode = "read" | "source" | "live";
let viewMode: ViewMode = "read";
let dirty = false;
let suppressReloadUntil = 0;
let spy: IntersectionObserver | null = null;

// Build the left-hand outline from the rendered headings.
function buildToc(): void {
  spy?.disconnect();
  toc.innerHTML = "";
  const headings = Array.from(
    content.querySelectorAll<HTMLElement>("h1, h2, h3"),
  );

  if (headings.length < 2) {
    layout.classList.remove("has-toc");
    return;
  }
  layout.classList.add("has-toc");

  const links = new Map<string, HTMLAnchorElement>();
  headings.forEach((h, i) => {
    h.id = `h-${i}`;
    const a = document.createElement("a");
    a.href = `#h-${i}`;
    a.textContent = h.textContent ?? "";
    a.className = `toc-link toc-${h.tagName.toLowerCase()}`;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      // Expand any collapsed <details> the heading lives inside, otherwise it's
      // hidden and scrollIntoView can't reach it (e.g. unclosed <details>).
      let p: HTMLElement | null = h.parentElement;
      while (p && p !== content) {
        if (p instanceof HTMLDetailsElement) p.open = true;
        p = p.parentElement;
      }
      h.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    toc.appendChild(a);
    links.set(h.id, a);
  });

  // Scroll-spy: highlight the heading currently near the top.
  spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          toc.querySelector(".active")?.classList.remove("active");
          const link = links.get(e.target.id);
          link?.classList.add("active");
          link?.scrollIntoView({ block: "nearest" });
        }
      }
    },
    { root: content, rootMargin: "0px 0px -80% 0px", threshold: 0 },
  );
  headings.forEach((h) => spy!.observe(h));
}

// Add a "copy" button to each highlighted code block (skips mermaid diagrams).
function addCopyButtons(): void {
  content
    .querySelectorAll<HTMLPreElement>("pre.hljs")
    .forEach((pre) => {
      if (pre.querySelector(".copy-btn")) return; // already added
      pre.classList.add("has-copy");
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.title = "复制";
      btn.setAttribute("aria-label", "复制代码");
      btn.textContent = "📋";
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const code = pre.querySelector("code")?.textContent ?? "";
        try {
          await navigator.clipboard.writeText(code);
          btn.textContent = "✓";
          btn.classList.add("copied");
          window.setTimeout(() => {
            btn.textContent = "📋";
            btn.classList.remove("copied");
          }, 1400);
        } catch {
          toast("复制失败");
        }
      });
      pre.appendChild(btn);
    });
}

// ---------- Resizable table columns (drag the header borders) ----------
const MIN_COL_W = 40;

// Per-file, per-table storage key so column widths are remembered on reopen.
function tableKey(tableIndex: number): string | null {
  if (!currentPath) return null;
  return `colw:${currentPath}::${tableIndex}`;
}
function loadColWidths(tableIndex: number): number[] | null {
  const key = tableKey(tableIndex);
  if (!key) return null;
  try {
    const arr = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(arr) && arr.every((n) => typeof n === "number")
      ? arr
      : null;
  } catch {
    return null;
  }
}
function saveColWidths(tableIndex: number, widths: number[]): void {
  const key = tableKey(tableIndex);
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(widths.map((w) => Math.round(w))));
}

// Give every table a drag handle on each header cell's right edge. The first
// drag (or a stored width) switches the table to a fixed layout with an
// explicit <colgroup>, after which columns can be widened or narrowed freely.
function makeTablesResizable(): void {
  content.querySelectorAll<HTMLTableElement>("table").forEach((table, tIndex) => {
    // Wrap once for horizontal scrolling when columns exceed the viewport.
    if (!table.parentElement?.classList.contains("md-table-wrap")) {
      const wrap = document.createElement("div");
      wrap.className = "md-table-wrap";
      table.parentNode?.insertBefore(wrap, table);
      wrap.appendChild(table);
    }

    const cells = Array.from(
      table.querySelectorAll<HTMLTableCellElement>("thead th"),
    );
    if (cells.length < 1) return;

    const getColgroup = (): HTMLElement => {
      let cg = table.querySelector("colgroup");
      if (!cg) {
        cg = document.createElement("colgroup");
        for (let i = 0; i < cells.length; i++) {
          cg.appendChild(document.createElement("col"));
        }
        table.insertBefore(cg, table.firstChild);
      }
      return cg as HTMLElement;
    };

    const applyFixed = (widths: number[]): void => {
      const cols = Array.from(getColgroup().children) as HTMLElement[];
      widths.forEach((w, i) => {
        if (cols[i]) cols[i].style.width = `${w}px`;
      });
      table.classList.add("resizable");
      table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
    };

    // Restore remembered widths (only if the column count still matches).
    const stored = loadColWidths(tIndex);
    if (stored && stored.length === cells.length) applyFixed(stored);

    const ensureFixed = (): void => {
      if (table.classList.contains("resizable")) return;
      applyFixed(cells.map((c) => c.getBoundingClientRect().width));
    };

    cells.forEach((th, i) => {
      th.classList.add("has-resizer");
      const handle = document.createElement("div");
      handle.className = "col-resizer";
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        ensureFixed();
        const cols = Array.from(getColgroup().children) as HTMLElement[];
        const startX = e.clientX;
        const startW =
          parseFloat(cols[i].style.width) ||
          cells[i].getBoundingClientRect().width;
        document.body.classList.add("col-resizing");
        const onMove = (me: MouseEvent): void => {
          const w = Math.max(MIN_COL_W, startW + (me.clientX - startX));
          cols[i].style.width = `${w}px`;
          table.style.width = `${cols.reduce(
            (a, c) => a + (parseFloat(c.style.width) || 0),
            0,
          )}px`;
        };
        const onUp = (): void => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          document.body.classList.remove("col-resizing");
          saveColWidths(
            tIndex,
            cols.map((c) => parseFloat(c.style.width) || 0),
          );
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
      th.appendChild(handle);
    });
  });
}

// Resolve relative-path images against the open file's folder via the asset protocol.
function resolveImages(): void {
  if (!currentPath) return;
  const dir = currentPath.replace(/[\\/][^\\/]*$/, "");
  content.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    // Skip absolute URLs (http:, data:, asset:, file:, …) and protocol-relative.
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return;
    const abs = `${dir}/${src}`.replace(/\\/g, "/");
    img.src = convertFileSrc(abs);
  });
}

function formatFmValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function buildFmCard(data: Record<string, unknown>): HTMLElement | null {
  const card = document.createElement("div");
  card.className = "fm-card";
  const used = new Set<string>();

  if (typeof data.title === "string" && data.title.trim()) {
    const t = document.createElement("div");
    t.className = "fm-title";
    t.textContent = data.title;
    card.appendChild(t);
  }
  used.add("title");

  if (typeof data.description === "string" && data.description.trim()) {
    const d = document.createElement("div");
    d.className = "fm-desc";
    d.textContent = data.description;
    card.appendChild(d);
  }
  used.add("description");

  const meta = document.createElement("div");
  meta.className = "fm-meta";
  const dateVal = data.pubDate ?? data.date ?? data.published;
  ["pubDate", "date", "published"].forEach((k) => used.add(k));
  if (dateVal) {
    const s = document.createElement("span");
    s.className = "fm-chip fm-date";
    s.textContent = `📅 ${formatFmValue(dateVal)}`;
    meta.appendChild(s);
  }
  used.add("tags");
  if (Array.isArray(data.tags)) {
    data.tags.forEach((tag) => {
      const c = document.createElement("span");
      c.className = "fm-chip fm-tag";
      c.textContent = `#${String(tag)}`;
      meta.appendChild(c);
    });
  }
  used.add("draft");
  if (data.draft === true) {
    const b = document.createElement("span");
    b.className = "fm-chip fm-badge";
    b.textContent = "Draft";
    meta.appendChild(b);
  }
  if (meta.childNodes.length) card.appendChild(meta);

  const rest = Object.keys(data).filter((k) => {
    if (used.has(k)) return false;
    const v = data[k];
    if (v === null || v === "" || v === undefined) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
  if (rest.length) {
    const dl = document.createElement("dl");
    dl.className = "fm-dl";
    rest.forEach((k) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = formatFmValue(data[k]);
      dl.append(dt, dd);
    });
    card.appendChild(dl);
  }

  return card.childNodes.length ? card : null;
}

// Parse YAML front matter (lazy-loaded) and prepend a metadata card.
async function renderFrontMatter(): Promise<void> {
  if (!lastFrontMatter.trim()) return;
  try {
    const yaml = await import("js-yaml");
    const data = yaml.load(lastFrontMatter);
    if (!data || typeof data !== "object") return;
    const card = buildFmCard(data as Record<string, unknown>);
    if (card) content.prepend(card);
  } catch (e) {
    console.error("front matter parse failed", e);
  }
}

async function renderMarkdown(
  text: string,
  preserveScroll = false,
): Promise<void> {
  const scrollTop = content.scrollTop;
  lastFrontMatter = "";
  // Sanitize rendered HTML to neutralise scripts / event handlers in untrusted docs.
  content.innerHTML = DOMPurify.sanitize(md.render(text), {
    ADD_TAGS: ["pre"],
    ADD_ATTR: ["class"],
  });
  await renderFrontMatter();
  resolveImages();
  addCopyButtons();
  makeTablesResizable();
  buildToc();

  // Lazily pull in mermaid only when a diagram is actually present.
  const diagrams = content.querySelectorAll<HTMLElement>("pre.mermaid");
  if (diagrams.length > 0) {
    const mermaid = (await import("mermaid")).default;
    // Re-initialise each render so diagrams follow the current theme.
    mermaid.initialize({
      startOnLoad: false,
      theme: currentDark() ? "dark" : "default",
      securityLevel: "strict",
    });
    try {
      await mermaid.run({ nodes: Array.from(diagrams) });
    } catch (e) {
      console.error("mermaid render failed", e);
    }
    // Click a rendered diagram to open it in the zoom/pan lightbox.
    diagrams.forEach((pre) => {
      const svg = pre.querySelector("svg");
      if (!svg) return;
      pre.classList.add("mermaid-zoomable");
      pre.addEventListener("click", () => openDiagram(svg));
    });
  }

  // New documents start at the top; only hot-reload / live-edit keep position.
  content.scrollTop = preserveScroll ? scrollTop : 0;
  if (viewMode === "live") makeContentEditable();
  void updateStatusBar();
}

// Live (WYSIWYG) mode: make the rendered article contenteditable and push edits
// back to the markdown source via turndown.
let td: unknown = null;
async function getTurndown(): Promise<{ turndown: (html: string) => string }> {
  if (!td) td = (await import("turndown")).default;
  const T = td as new () => { turndown: (html: string) => string };
  return new T();
}
let liveBound = false;
function makeContentEditable(): void {
  content.contentEditable = "true";
  // Avoid triggering edit on our own injected UI (copy buttons, resizers).
  content.querySelectorAll(".copy-btn, .col-resizer, .mermaid-zoomable").forEach(
    (el) => (el as HTMLElement).contentEditable = "false",
  );
  if (liveBound) return;
  liveBound = true;
  content.addEventListener(
    "input",
    () => {
      if (viewMode !== "live") return;
      // Debounced round-trip: HTML -> Markdown -> currentText/editor buffer.
      window.clearTimeout((content as unknown as { _liveTimer?: number })._liveTimer);
      (content as unknown as { _liveTimer?: number })._liveTimer = window.setTimeout(
        async () => {
          const T = await getTurndown();
          // Strip injected UI (front-matter card, copy buttons, col resizers,
          // find highlights, diagram lightbox hooks) before converting back.
          const clone = content.cloneNode(true) as HTMLElement;
          clone.querySelectorAll(".fm-card, .copy-btn, .col-resizer, .fm-mark, .mermaid-zoomable").forEach(
            (el) => el.remove(),
          );
          const mdText = T.turndown(clone.innerHTML);
          currentText = mdText;
          editor.value = mdText;
          dirty = true;
          setTitle();
        },
        250,
      );
    },
    { passive: true },
  );
}

function setTitle(): void {
  const name = currentPath?.split(/[\\/]/).pop() ?? "KanlorOne MDViewer";
  document.title = `${dirty ? "● " : ""}${name} — KanlorOne MDViewer`;
  saveBtn.hidden = viewMode === "read";
  saveBtn.disabled = !dirty;
  saveBtn.textContent = dirty ? "💾 保存*" : "💾 已保存";
  closeDocBtn.hidden = !currentPath;
}

// ---------- Status bar ----------

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function updateStatusBar(): Promise<void> {
  if (!currentPath) {
    sbPathEl.textContent = "未打开文件";
    sbOutlineEl.textContent = "H1:0 / H2:0";
    sbStatsEl.textContent = "中文:0 总字:0 图:0 表:0 代码:0";
    sbFileinfoEl.textContent = "--";
    return;
  }
  sbPathEl.textContent = currentPath;
  // Outline
  const h1Count = content.querySelectorAll("h1").length;
  const h2Count = content.querySelectorAll("h2").length;
  sbOutlineEl.textContent = `H1:${h1Count} / H2:${h2Count}`;
  // Content stats
  const imgCount = content.querySelectorAll("img").length;
  const tableCount = content.querySelectorAll("table").length;
  const codeCount = content.querySelectorAll("pre.hljs").length;
  const cjkRe = /[一-鿿㐀-䶿豈-﫿]/g;
  const cjkCount = (currentText.match(cjkRe) ?? []).length;
  sbStatsEl.textContent = `中文:${cjkCount} 总字:${currentText.length} 图:${imgCount} 表:${tableCount} 代码:${codeCount}`;
  // File properties (async)
  try {
    const meta = await invoke<{ size: number; modified_secs: number }>(
      "file_meta",
      { path: currentPath },
    );
    const sizeStr = formatFileSize(meta.size);
    const dateStr = new Date(meta.modified_secs * 1000).toLocaleString();
    const encStr = currentEncoding || "?";
    sbFileinfoEl.textContent = `${encStr} | ${sizeStr} | ${dateStr}`;
  } catch {
    sbFileinfoEl.textContent = "--";
  }
}

// Close the current document and return to the home / empty-state screen.
function goHome(): void {
  currentPath = null;
  currentText = "";
  currentEncoding = "";
  dirty = false;
  if (viewMode !== "read") {
    setViewMode("read");
  }
  content.innerHTML = EMPTY_STATE_HTML;
  buildToc();
  renderRecents();
  if (filesOpen) void renderFiles(null);
  setTitle();
  void updateStatusBar();
}

async function openFile(
  path: string,
  watch = true,
  preserveScroll = false,
): Promise<void> {
  try {
    const result = await invoke<{ text: string; encoding: string }>("read_md", { path });
    currentPath = path;
    currentText = result.text;
    currentEncoding = result.encoding;
    dirty = false;
    addRecent(path);
    if (viewMode !== "read") editor.value = result.text;
    setTitle();
    await renderMarkdown(result.text, preserveScroll);
    if (watch) {
      await invoke("watch_file", { path });
    }
    if (filesOpen) void renderFiles(dirOf(path));
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><p>${String(e)}</p></div>`;
    buildToc();
  }
}

// ---------- Edit mode + live preview ----------

let previewTimer: number | undefined;
function schedulePreview(): void {
  dirty = editor.value !== currentText;
  setTitle();
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(
    () => void renderMarkdown(editor.value, true),
    180,
  );
}

// Three display modes:
//   read   — pure preview (rendered article only)
//   source — split: source editor (left) + live preview (right)
//   live   — single-pane WYSIWYG: rendered content is contenteditable, edits
//            round-trip back to the markdown source via turndown
const MODE_META: Record<ViewMode, { label: string; title: string }> = {
  read: { label: "👁 阅读", title: "阅读模式（纯预览）" },
  source: { label: "✎ 源码", title: "源码模式（左侧源码 + 右侧预览）" },
  live: { label: "✏ 实时", title: "实时预览（点击内容即可编辑）" },
};

async function setViewMode(mode: ViewMode): Promise<void> {
  const prev = viewMode;
  // Leaving live mode: disable contenteditable.
  if (prev === "live") {
    content.contentEditable = "false";
  }
  viewMode = mode;
  layout.classList.toggle("mode-edit", mode === "source");
  layout.classList.toggle("mode-live", mode === "live");
  editToggle.textContent = MODE_META[mode].label;
  editToggle.title = MODE_META[mode].title;

  if (mode === "source") {
    // Sync the editor buffer with the latest source (preserve unsaved edits).
    if (prev !== "source" && !dirty) editor.value = currentText;
    editor.focus();
  } else if (mode === "live") {
    // Re-render with contenteditable enabled and sync currentText from any
    // source-mode edits.
    if (prev === "source") currentText = editor.value;
    makeContentEditable();
    void renderMarkdown(currentText, true);
  } else {
    // read: re-render from currentText (reflect source-mode edits).
    if (prev === "source") currentText = editor.value;
    void renderMarkdown(currentText, true);
  }
  setTitle();
}

function cycleViewMode(): void {
  const order: ViewMode[] = ["read", "source", "live"];
  const next = order[(order.indexOf(viewMode) + 1) % order.length];
  void setViewMode(next);
}

function toggleEdit(): void {
  cycleViewMode();
}

async function save(): Promise<void> {
  if (!currentPath || !dirty) return;
  try {
    // Ignore the watcher event our own write is about to trigger.
    suppressReloadUntil = Date.now() + 1000;
    await invoke("write_md", { path: currentPath, content: editor.value });
    currentText = editor.value;
    dirty = false;
    setTitle();
  } catch (e) {
    console.error("save failed", e);
  }
}

editToggle.addEventListener("click", toggleEdit);
editor.addEventListener("input", schedulePreview);
saveBtn.addEventListener("click", () => void save());

// ---------- Toast ----------
let toastTimer: number | undefined;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2800);
}

// ---------- Export to standalone HTML (with TOC sidebar) ----------
const EXPORT_CSS = `
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--code-bg:#f6f8fa;--accent:#0969da;--stripe:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#30363d;--code-bg:#161b22;--accent:#4493f8;--stripe:#161b22}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;display:flex;align-items:flex-start}
.toc{flex:0 0 264px;width:264px;position:sticky;top:0;max-height:100vh;overflow:auto;padding:24px 12px 40px;border-right:1px solid var(--border);font-size:13.5px;line-height:1.5}
.toc a{display:block;padding:3px 10px;margin:1px 0;color:var(--muted);text-decoration:none;border-left:2px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toc a:hover{color:var(--fg);background:var(--code-bg)}
.toc .l1{font-weight:600}.toc .l2{padding-left:22px}.toc .l3{padding-left:34px;font-size:13px}
.markdown-body{flex:1;min-width:0;max-width:860px;margin:0 auto;padding:32px 40px 80px;word-wrap:break-word}
.markdown-body h1,.markdown-body h2{border-bottom:1px solid var(--border);padding-bottom:.3em}
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{margin-top:1.4em;margin-bottom:.6em;font-weight:600;line-height:1.25}
.markdown-body a{color:var(--accent);text-decoration:none}.markdown-body a:hover{text-decoration:underline}
.markdown-body code{background:var(--code-bg);padding:.2em .4em;border-radius:6px;font-size:85%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.markdown-body pre{background:var(--code-bg);padding:16px;border-radius:8px;overflow:auto;line-height:1.45}
.markdown-body pre code{background:transparent;padding:0;font-size:90%}
.markdown-body blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:4px solid var(--border)}
.markdown-body table{border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow:auto;margin:1em 0}
.markdown-body th,.markdown-body td{border:1px solid var(--border);padding:6px 13px}
.markdown-body tr:nth-child(2n){background:var(--stripe)}
.markdown-body img{max-width:100%}
.markdown-body hr{border:none;border-top:1px solid var(--border);margin:1.6em 0}
.markdown-body .task-list-item{list-style:none}
.markdown-body .task-list-item input{margin:0 .4em .25em -1.4em}
.markdown-body pre.mermaid{background:transparent;text-align:center;padding:8px 0}
`;

function buildExportHtml(): string {
  // Clone so we don't mutate the live DOM.
  const article = content.cloneNode(true) as HTMLElement;
  // Copy buttons are UI-only — strip them from the exported document.
  article.querySelectorAll(".copy-btn").forEach((b) => b.remove());
  // Strip column-resize scaffolding so exported tables use the default layout.
  article.querySelectorAll(".col-resizer").forEach((h) => h.remove());
  article.querySelectorAll<HTMLTableElement>("table.resizable").forEach((t) => {
    t.classList.remove("resizable");
    t.removeAttribute("style");
    t.querySelector("colgroup")?.remove();
  });
  article.querySelectorAll(".md-table-wrap").forEach((w) => {
    const t = w.querySelector("table");
    if (t) w.replaceWith(t);
  });
  const headings = Array.from(
    article.querySelectorAll<HTMLElement>("h1, h2, h3"),
  );

  let tocHtml = "";
  if (headings.length >= 2) {
    const items = headings
      .map((h, i) => {
        if (!h.id) h.id = `h-${i}`;
        const level = h.tagName.toLowerCase().replace("h", "l");
        const label = (h.textContent ?? "").replace(/[<>&]/g, "");
        return `<a class="${level}" href="#${h.id}">${label}</a>`;
      })
      .join("\n");
    tocHtml = `<nav class="toc">\n${items}\n</nav>\n`;
  }

  const title = currentPath?.split(/[\\/]/).pop()?.replace(/\.(md|markdown|txt)$/i, "") ?? "Document";
  const themeCss = currentDark() ? hljsDarkCss : hljsLightCss;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>${EXPORT_CSS}</style>
<style>${themeCss}</style>
</head>
<body>
${tocHtml}<article class="markdown-body">
${article.innerHTML}
</article>
</body>
</html>`;
}

async function exportHtml(): Promise<void> {
  if (!currentPath) {
    toast("没有打开的文件");
    return;
  }
  // Make sure the preview reflects the latest source (e.g. while editing).
  if (viewMode === "source") await renderMarkdown(editor.value, true);

  const base = currentPath.replace(/\.(md|markdown|txt)$/i, "");
  const out = `${base}.html`;
  try {
    await invoke("write_md", { path: out, content: buildExportHtml() });
    toast(`已导出 ${out.split(/[\\/]/).pop()}`);
  } catch (e) {
    toast(`导出失败: ${String(e)}`);
  }
}

exportBtn.addEventListener("click", () => void exportHtml());

// ---------- Synced scrolling (editor <-> preview) ----------
let syncing = false;
function syncScroll(from: HTMLElement, to: HTMLElement): void {
  if (syncing || viewMode !== "source") return;
  syncing = true;
  const max = from.scrollHeight - from.clientHeight;
  const ratio = max > 0 ? from.scrollTop / max : 0;
  to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
  requestAnimationFrame(() => {
    syncing = false;
  });
}
editor.addEventListener("scroll", () => syncScroll(editor, content));
content.addEventListener("scroll", () => syncScroll(content, editor));

// ---------- Close confirmation when there are unsaved changes ----------
function showCloseModal(): void {
  closeModal.hidden = false;
}
function hideCloseModal(): void {
  closeModal.hidden = true;
}
(document.getElementById("modal-cancel") as HTMLButtonElement).addEventListener(
  "click",
  hideCloseModal,
);
function finishClose(): void {
  dirty = false;
  if (closeAction === "doc") {
    goHome();
  } else if (closeAction === "switch") {
    if (pendingSwitchPath) void openFile(pendingSwitchPath);
  } else {
    void appWindow.destroy();
  }
}
(document.getElementById("modal-discard") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    hideCloseModal();
    finishClose();
  },
);
(document.getElementById("modal-save") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    await save();
    hideCloseModal();
    finishClose();
  },
);

// Close the current document (back to home), confirming if there are edits.
closeDocBtn.addEventListener("click", () => {
  if (dirty) {
    closeAction = "doc";
    showCloseModal();
  } else {
    goHome();
  }
});

// Content font scaling (persisted).
let fontScale = parseFloat(localStorage.getItem("fontScale") ?? "1") || 1;
function applyFontScale(): void {
  fontScale = Math.min(2.6, Math.max(0.6, Math.round(fontScale * 10) / 10));
  document.documentElement.style.setProperty("--content-scale", String(fontScale));
  localStorage.setItem("fontScale", String(fontScale));
}
function bumpFont(delta: number): void {
  fontScale += delta;
  applyFontScale();
}
fontInc.addEventListener("click", () => bumpFont(0.1));
fontDec.addEventListener("click", () => bumpFont(-0.1));
applyFontScale();

// Wide-content mode: fill the available width instead of the centered column.
// Defaults to wide when the user has no saved preference yet.
let wideContent = (localStorage.getItem("wideContent") ?? "true") === "true";
function applyWide(): void {
  layout.classList.toggle("wide-content", wideContent);
  wideToggle.classList.toggle("on", wideContent);
  localStorage.setItem("wideContent", String(wideContent));
}
function toggleWide(): void {
  wideContent = !wideContent;
  applyWide();
}
wideToggle.addEventListener("click", toggleWide);
applyWide();

// Cycle the color theme: system → light → dark → system.
const THEME_ICON: Record<ThemePref, string> = {
  system: "🖥️",
  light: "☀️",
  dark: "🌙",
};
const THEME_TITLE: Record<ThemePref, string> = {
  system: "主题:跟随系统 (点击切换)",
  light: "主题:亮色 (点击切换)",
  dark: "主题:暗色 (点击切换)",
};
function applyTheme(): void {
  document.documentElement.dataset.theme = themePref;
  hljsStyle.textContent = currentDark() ? hljsDarkCss : hljsLightCss;
  themeToggle.textContent = THEME_ICON[themePref];
  themeToggle.title = THEME_TITLE[themePref];
  localStorage.setItem("theme", themePref);
  // Re-render the open document so mermaid diagrams pick up the new theme
  // (highlighted code recolors automatically via the swapped <style>).
  if (currentPath) {
    void renderMarkdown(viewMode === "source" ? editor.value : currentText, true);
  }
}
function cycleTheme(): void {
  themePref =
    themePref === "system" ? "light" : themePref === "light" ? "dark" : "system";
  applyTheme();
}
themeToggle.addEventListener("click", cycleTheme);
// Follow live OS theme changes while in "system" mode.
systemDarkMQ.addEventListener("change", () => {
  if (themePref === "system") applyTheme();
});
applyTheme();

// ---------- Settings: reading font (separate Latin + CJK) ----------
// Each option is a fallback stack; unavailable fonts degrade gracefully, and
// the browser's last-resort fallback still renders glyphs a font lacks.
interface FontOption {
  id: string;
  label: string;
  stack: string; // families only (no generic); empty = system default
  generic?: string; // appended after the CJK families
}
const DEFAULT_LATIN_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial';
const LATIN_FONTS: FontOption[] = [
  { id: "system", label: "系统预设 Sans", stack: DEFAULT_LATIN_STACK, generic: "sans-serif" },
  { id: "serif", label: "Serif (Georgia)", stack: 'Georgia, "Times New Roman"', generic: "serif" },
  { id: "helvetica", label: "Helvetica / Arial", stack: "Helvetica, Arial", generic: "sans-serif" },
  { id: "verdana", label: "Verdana", stack: "Verdana, Geneva", generic: "sans-serif" },
  { id: "mono", label: "等宽 Mono", stack: "ui-monospace, Consolas", generic: "monospace" },
];
const CJK_FONTS: FontOption[] = [
  { id: "system", label: "系统默认", stack: "" },
  { id: "jhenghei", label: "微软正黑体", stack: '"Microsoft JhengHei", "Microsoft YaHei"' },
  { id: "pingfang", label: "苹方 PingFang", stack: '"PingFang TC", "PingFang SC"' },
  { id: "notosans", label: "思源黑体 Noto Sans", stack: '"Noto Sans TC", "Noto Sans CJK TC"' },
  { id: "notoserif", label: "思源宋体 Noto Serif", stack: '"Noto Serif TC", "Noto Serif CJK TC"' },
  { id: "kai", label: "标楷体", stack: '"DFKai-SB", "BiauKai", "Kaiti TC"' },
];

const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const settingsModal = document.getElementById("settings-modal") as HTMLElement;
const fontLatinSel = document.getElementById("font-latin") as HTMLSelectElement;
const fontCjkSel = document.getElementById("font-cjk") as HTMLSelectElement;
const fontLatinCustomEl = document.getElementById("font-latin-custom") as HTMLInputElement;
const fontCjkCustomEl = document.getElementById("font-cjk-custom") as HTMLInputElement;
const fontList = document.getElementById("font-list") as HTMLDataListElement;

function fillFontSelect(sel: HTMLSelectElement, opts: FontOption[]): void {
  opts.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.label;
    sel.appendChild(opt);
  });
  // "Custom" lets the user type any installed font family by name.
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "自定义… / Custom…";
  sel.appendChild(custom);
}
fillFontSelect(fontLatinSel, LATIN_FONTS);
fillFontSelect(fontCjkSel, CJK_FONTS);

let fontLatinId = localStorage.getItem("fontLatin") ?? "system";
let fontCjkId = localStorage.getItem("fontCjk") ?? "system";
let fontLatinCustom = localStorage.getItem("fontLatinCustom") ?? "";
let fontCjkCustom = localStorage.getItem("fontCjkCustom") ?? "";

// Turn a typed font name into a CSS family fragment (quote it unless the user
// already typed a comma-separated stack of their own).
function toFamily(v: string): string {
  const t = v.trim();
  if (!t) return "";
  return t.includes(",") ? t : `"${t.replace(/["']/g, "")}"`;
}

function applyReadingFont(): void {
  const latin = LATIN_FONTS.find((f) => f.id === fontLatinId) ?? LATIN_FONTS[0];
  const latinStack = fontLatinId === "custom" ? toFamily(fontLatinCustom) : latin.stack;
  const latinGeneric = fontLatinId === "custom" ? "sans-serif" : latin.generic ?? "sans-serif";
  const cjkStack =
    fontCjkId === "custom"
      ? toFamily(fontCjkCustom)
      : (CJK_FONTS.find((f) => f.id === fontCjkId) ?? CJK_FONTS[0]).stack;

  const parts = [latinStack, cjkStack, latinGeneric,
    '"Apple Color Emoji"', '"Segoe UI Emoji"'].filter(Boolean);
  document.documentElement.style.setProperty("--reading-font", parts.join(", "));

  fontLatinSel.value = fontLatinId;
  fontCjkSel.value = fontCjkId;
  fontLatinCustomEl.hidden = fontLatinId !== "custom";
  fontCjkCustomEl.hidden = fontCjkId !== "custom";
  fontLatinCustomEl.value = fontLatinCustom;
  fontCjkCustomEl.value = fontCjkCustom;

  localStorage.setItem("fontLatin", fontLatinId);
  localStorage.setItem("fontCjk", fontCjkId);
  localStorage.setItem("fontLatinCustom", fontLatinCustom);
  localStorage.setItem("fontCjkCustom", fontCjkCustom);
}
fontLatinSel.addEventListener("change", () => {
  fontLatinId = fontLatinSel.value;
  applyReadingFont();
  if (fontLatinId === "custom") fontLatinCustomEl.focus();
});
fontCjkSel.addEventListener("change", () => {
  fontCjkId = fontCjkSel.value;
  applyReadingFont();
  if (fontCjkId === "custom") fontCjkCustomEl.focus();
});
fontLatinCustomEl.addEventListener("input", () => {
  fontLatinCustom = fontLatinCustomEl.value;
  applyReadingFont();
});
fontCjkCustomEl.addEventListener("input", () => {
  fontCjkCustom = fontCjkCustomEl.value;
  applyReadingFont();
});
(document.getElementById("settings-reset") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    fontLatinId = "system";
    fontCjkId = "system";
    applyReadingFont();
  },
);

// Populate the autocomplete list with actually-installed fonts (once). Uses the
// Local Font Access API — available on WebView2/Windows; on WKWebView (macOS)
// and WebKitGTK (Linux) it's absent, so users just type the name manually.
let fontsQueried = false;
async function populateInstalledFonts(): Promise<void> {
  if (fontsQueried) return;
  fontsQueried = true;
  const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> })
    .queryLocalFonts;
  if (typeof query !== "function") return;
  try {
    const fonts = await query();
    const seen = new Set<string>();
    for (const f of fonts) {
      if (f.family && !seen.has(f.family)) {
        seen.add(f.family);
        const o = document.createElement("option");
        o.value = f.family;
        fontList.appendChild(o);
      }
    }
  } catch {
    /* unsupported or permission denied — manual typing still works */
  }
}

function openSettings(): void {
  settingsModal.hidden = false;
  void populateInstalledFonts();
}
function closeSettings(): void {
  settingsModal.hidden = true;
}
settingsBtn.addEventListener("click", openSettings);
(document.getElementById("settings-close") as HTMLButtonElement).addEventListener(
  "click",
  closeSettings,
);
// Click the dimmed backdrop (outside the box) to dismiss.
settingsModal.addEventListener("click", (ev) => {
  if (ev.target === settingsModal) closeSettings();
});
applyReadingFont();

// ---------- About dialog (version info + QR codes) ----------
const aboutModal = document.getElementById("about-modal") as HTMLElement;
const aboutVersion = document.getElementById("about-version") as HTMLElement;
aboutVersion.textContent = `v${__APP_VERSION__}`;
document.getElementById("about-close")?.addEventListener("click", () => {
  aboutModal.hidden = true;
});

// ---------- Open file dialog + recent files ----------
async function openViaDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "KanlorOne MDViewer", extensions: ["md", "markdown", "txt"] }],
  });
  if (typeof selected === "string") await openFile(selected);
}
openBtn.addEventListener("click", () => void openViaDialog());
// Delegated so the empty-state links keep working after goHome() rebuilds them.
content.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;
  if (target.closest("#empty-open")) {
    ev.preventDefault();
    void openViaDialog();
  } else if (target.closest("#about-open")) {
    ev.preventDefault();
    aboutModal.hidden = false;
  }
});

function getRecents(): string[] {
  try {
    return JSON.parse(localStorage.getItem("recents") ?? "[]") as string[];
  } catch {
    return [];
  }
}
function addRecent(path: string): void {
  const list = getRecents().filter((p) => p !== path);
  list.unshift(path);
  localStorage.setItem("recents", JSON.stringify(list.slice(0, 8)));
}
function renderRecents(): void {
  const host = document.getElementById("recent-list");
  if (!host) return;
  host.innerHTML = "";
  const list = getRecents();
  if (!list.length) return;
  const h = document.createElement("h3");
  h.textContent = "最近打开";
  host.appendChild(h);
  list.forEach((p) => {
    const a = document.createElement("a");
    a.className = "recent-item";
    a.href = "#";
    const name = document.createElement("span");
    name.className = "rf-name";
    name.textContent = p.split(/[\\/]/).pop() ?? p;
    const full = document.createElement("span");
    full.className = "rf-path";
    full.textContent = p;
    a.append(name, full);
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      void openFile(p);
    });
    host.appendChild(a);
  });
}

// ---------- File explorer panel ----------
interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}
interface DirListing {
  dir: string;
  parent: string | null;
  entries: DirEntry[];
}

let filesOpen = localStorage.getItem("filesOpen") === "true";

function dirOf(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, "");
}

function fileRow(
  label: string,
  icon: string,
  onClick: () => void,
  opts: { active?: boolean; muted?: boolean; onContext?: (ev: MouseEvent) => void } = {},
): HTMLElement {
  const a = document.createElement("a");
  a.className = "file-item";
  if (opts.active) a.classList.add("active");
  if (opts.muted) a.classList.add("muted");
  a.href = "#";
  const ic = document.createElement("span");
  ic.className = "fi-icon";
  ic.textContent = icon;
  const nm = document.createElement("span");
  nm.className = "fi-name";
  nm.textContent = label;
  a.append(ic, nm);
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    onClick();
  });
  if (opts.onContext) a.addEventListener("contextmenu", opts.onContext);
  return a;
}

// Right-click context menu for files.
let fileMenuEl: HTMLElement | null = null;
function closeFileMenu(): void {
  fileMenuEl?.remove();
  fileMenuEl = null;
}
function showFileMenu(ev: MouseEvent, path: string): void {
  ev.preventDefault();
  closeFileMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  const item = document.createElement("button");
  item.textContent = "在新窗口打开";
  item.addEventListener("click", () => {
    closeFileMenu();
    void invoke("open_new_window", { path });
  });
  menu.appendChild(item);
  document.body.appendChild(menu);
  // Keep within the viewport.
  const mw = 180;
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - mw)}px`;
  menu.style.top = `${ev.clientY}px`;
  fileMenuEl = menu;
}
window.addEventListener("click", closeFileMenu);
window.addEventListener("blur", closeFileMenu);

async function renderFiles(dir: string | null): Promise<void> {
  if (!dir) {
    filesPanel.innerHTML = "";
    const hint = document.createElement("div");
    hint.className = "files-hint";
    hint.textContent = "打开文件后可浏览其目录";
    filesPanel.appendChild(hint);
    return;
  }
  let listing: DirListing;
  try {
    listing = await invoke<DirListing>("list_dir", { path: dir });
  } catch (e) {
    // Keep the current view; just report (e.g. typed a path that doesn't exist).
    toast(String(e));
    return;
  }

  filesPanel.innerHTML = "";

  // "Only md" filter checkbox
  const filterRow = document.createElement("div");
  filterRow.className = "files-filter";
  const filterCb = document.createElement("input");
  filterCb.type = "checkbox";
  filterCb.id = "files-md-only";
  filterCb.checked = localStorage.getItem("filesMdOnly") === "true";
  const filterLabel = document.createElement("label");
  filterLabel.htmlFor = "files-md-only";
  filterLabel.textContent = "仅文本(md/txt)";
  filterRow.append(filterCb, filterLabel);
  filterCb.addEventListener("change", () => {
    localStorage.setItem("filesMdOnly", String(filterCb.checked));
    void renderFiles(listing.dir);
  });
  filesPanel.appendChild(filterRow);

  // Editable full-path bar — type a folder and press Enter to jump there.
  const pathInput = document.createElement("input");
  pathInput.className = "files-path";
  pathInput.value = listing.dir;
  pathInput.spellcheck = false;
  pathInput.title = listing.dir;
  pathInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const v = pathInput.value.trim();
      if (v) void renderFiles(v);
    } else if (ev.key === "Escape") {
      pathInput.value = listing.dir;
      pathInput.blur();
    }
  });
  filesPanel.appendChild(pathInput);

  if (listing.parent) {
    filesPanel.appendChild(
      fileRow("..", "📁", () => void renderFiles(listing.parent), {
        muted: true,
      }),
    );
  }
  for (const entry of listing.entries) {
    // Apply text-only filter (show md/txt, hide other file types).
    const mdOnly = localStorage.getItem("filesMdOnly") === "true";
    if (mdOnly && !entry.is_dir && !/\.(md|markdown|txt)$/i.test(entry.name)) continue;
    if (entry.is_dir) {
      filesPanel.appendChild(
        fileRow(entry.name, "📁", () => void renderFiles(entry.path)),
      );
    } else {
      const isText = /\.(md|markdown|txt)$/i.test(entry.name);
      const icon = isText ? "📄" : "🗎";
      const onClick = isText
        ? () => switchToFile(entry.path)
        : () => toast(`暂不支持打开 ${entry.name}`);
      filesPanel.appendChild(
        fileRow(entry.name, icon, onClick, {
          active: entry.path === currentPath,
          muted: !isText,
          onContext: (ev) => showFileMenu(ev, entry.path),
        }),
      );
    }
  }

  // Bottom: recent files history
  const recents = getRecents().filter(p => p !== currentPath).slice(0, 6);
  if (recents.length > 0) {
    const sep = document.createElement("div");
    sep.className = "files-sep";
    filesPanel.appendChild(sep);
    const rh = document.createElement("div");
    rh.className = "files-head";
    rh.textContent = "最近打开";
    filesPanel.appendChild(rh);
    for (const p of recents) {
      const name = p.split(/[\\/]/).pop() ?? p;
      const a = fileRow(name, "📄", () => void openFile(p));
      a.title = p;
      filesPanel.appendChild(a);
    }
  }
}

function switchToFile(path: string): void {
  if (path === currentPath) return;
  if (dirty) {
    closeAction = "switch";
    pendingSwitchPath = path;
    showCloseModal();
  } else {
    void openFile(path);
  }
}

function toggleFiles(): void {
  filesOpen = !filesOpen;
  layout.classList.toggle("files-open", filesOpen);
  localStorage.setItem("filesOpen", String(filesOpen));
  if (filesOpen) void renderFiles(currentPath ? dirOf(currentPath) : null);
}
filesBtn.addEventListener("click", toggleFiles);
// Restore persisted state on load.
if (filesOpen) layout.classList.add("files-open");

// ---------- Mermaid diagram lightbox (click to zoom/pan) ----------
const diagramModal = document.getElementById("diagram-modal") as HTMLElement;
const diagramStage = document.getElementById("diagram-stage") as HTMLElement;
const dgZoomLabel = document.getElementById("dg-zoom") as HTMLElement;
let dgEl: HTMLElement | null = null;
let dgScale = 1;
let dgX = 0;
let dgY = 0;
let dgNatW = 0;
let dgNatH = 0;

function dgApply(): void {
  if (dgEl) dgEl.style.transform = `translate(${dgX}px, ${dgY}px) scale(${dgScale})`;
  dgZoomLabel.textContent = `${Math.round(dgScale * 100)}%`;
}
function dgFit(): void {
  const sw = diagramStage.clientWidth;
  const sh = diagramStage.clientHeight;
  if (!dgNatW || !dgNatH) return;
  dgScale = Math.min(sw / dgNatW, sh / dgNatH, 1) || 1;
  dgX = (sw - dgNatW * dgScale) / 2;
  dgY = (sh - dgNatH * dgScale) / 2;
  dgApply();
}
function dgZoomAt(cx: number, cy: number, factor: number): void {
  const ns = Math.min(8, Math.max(0.1, dgScale * factor));
  const k = ns / dgScale;
  dgX = cx - (cx - dgX) * k;
  dgY = cy - (cy - dgY) * k;
  dgScale = ns;
  dgApply();
}
function openDiagram(svg: SVGElement): void {
  diagramStage.innerHTML = "";
  const card = document.createElement("div");
  card.className = "dg-card";
  const clone = svg.cloneNode(true) as SVGElement;
  const vb = (svg as SVGSVGElement).viewBox?.baseVal;
  clone.removeAttribute("style");
  if (vb && vb.width && vb.height) {
    clone.setAttribute("width", String(vb.width));
    clone.setAttribute("height", String(vb.height));
  }
  card.appendChild(clone);
  diagramStage.appendChild(card);
  dgEl = card;
  diagramModal.hidden = false;
  dgNatW = card.offsetWidth;
  dgNatH = card.offsetHeight;
  dgFit();
}
function closeDiagram(): void {
  diagramModal.hidden = true;
  diagramStage.innerHTML = "";
  dgEl = null;
}

diagramStage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = diagramStage.getBoundingClientRect();
    dgZoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  },
  { passive: false },
);
let dgDragging = false;
let dgLastX = 0;
let dgLastY = 0;
diagramStage.addEventListener("mousedown", (e) => {
  dgDragging = true;
  dgLastX = e.clientX;
  dgLastY = e.clientY;
  diagramStage.classList.add("grabbing");
});
window.addEventListener("mousemove", (e) => {
  if (!dgDragging) return;
  dgX += e.clientX - dgLastX;
  dgY += e.clientY - dgLastY;
  dgLastX = e.clientX;
  dgLastY = e.clientY;
  dgApply();
});
window.addEventListener("mouseup", () => {
  dgDragging = false;
  diagramStage.classList.remove("grabbing");
});
function dgCenterZoom(factor: number): void {
  dgZoomAt(diagramStage.clientWidth / 2, diagramStage.clientHeight / 2, factor);
}
(document.getElementById("dg-zoomin") as HTMLButtonElement).addEventListener("click", () => dgCenterZoom(1.25));
(document.getElementById("dg-zoomout") as HTMLButtonElement).addEventListener("click", () => dgCenterZoom(0.8));
(document.getElementById("dg-reset") as HTMLButtonElement).addEventListener("click", dgFit);
(document.getElementById("dg-close") as HTMLButtonElement).addEventListener("click", closeDiagram);

// ---------- Find in document (Ctrl+F) + replace ----------
// Custom find that highlights all matches in the DOM and never steals focus,
// unlike window.find() which scrolls and blurs the input while typing.
interface FindMatch {
  el: Text;
  start: number;
  end: number;
}
let findMatches: FindMatch[] = [];
let findCurrent = -1;
let findQuery = "";
const findMarkCls = "fm-mark"; // all-match highlight
const findCurCls = "fm-current"; // current-match highlight

function openFind(): void {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
}
function closeFind(): void {
  findBar.hidden = true;
  clearHighlights();
}
function clearHighlights(): void {
  // Unwrap any <mark class="fm-mark"> we created back to plain text nodes.
  const marks = content.querySelectorAll("mark.fm-mark");
  marks.forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
    parent.normalize();
  });
  findMatches = [];
  findCurrent = -1;
  findCount.textContent = "";
}
function unhighlightCurrent(): void {
  const cur = content.querySelector(`mark.${findCurCls}`);
  cur?.classList.remove(findCurCls);
}

function runFind(backwards: boolean, selectNew = true): void {
  const q = findInput.value;
  if (!q) {
    clearHighlights();
    return;
  }
  if (q !== findQuery) {
    // Query changed: re-scan the document.
    clearHighlights();
    findQuery = q;
    const walker = document.createTreeWalker(
      content,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(n) {
          // Skip text inside our own find marks / editor / script / style.
          let p = n.parentElement;
          while (p && p !== content) {
            if (p.classList.contains("fm-mark") || p.tagName === "SCRIPT" || p.tagName === "STYLE") {
              return NodeFilter.FILTER_REJECT;
            }
            p = p.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    const lower = q.toLowerCase();
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue ?? "";
      const lowerText = text.toLowerCase();
      let idx = lowerText.indexOf(lower);
      while (idx !== -1) {
        findMatches.push({ el: node as Text, start: idx, end: idx + q.length });
        idx = lowerText.indexOf(lower, idx + q.length);
      }
    }
    // Wrap matches in <mark> elements. Group by text node and rebuild each node
    // once so multiple matches inside the same node all highlight correctly.
    const byNode = new Map<Text, FindMatch[]>();
    for (const m of findMatches) {
      const arr = byNode.get(m.el) ?? [];
      arr.push(m);
      byNode.set(m.el, arr);
    }
    for (const [node, ms] of byNode) {
      const text = node.nodeValue ?? "";
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of ms) {
        if (m.start > last) frag.appendChild(document.createTextNode(text.slice(last, m.start)));
        const mark = document.createElement("mark");
        mark.className = findMarkCls;
        mark.textContent = text.slice(m.start, m.end);
        (m as unknown as { mark: HTMLElement }).mark = mark;
        frag.appendChild(mark);
        last = m.end;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode?.replaceChild(frag, node);
    }
    if (findMatches.length === 0) {
      findCount.textContent = "0/0";
      return;
    }
  }
  if (findMatches.length === 0) return;
  // Move to previous/next match.
  if (selectNew) {
    findCurrent = backwards
      ? (findCurrent <= 0 ? findMatches.length - 1 : findCurrent - 1)
      : (findCurrent < 0 ? 0 : (findCurrent + 1) % findMatches.length);
  }
  unhighlightCurrent();
  const cur = (findMatches[findCurrent] as unknown as { mark?: HTMLElement }).mark;
  cur?.classList.add(findCurCls);
  cur?.scrollIntoView({ block: "center" });
  findCount.textContent = `${findCurrent + 1}/${findMatches.length}`;
}

function runReplaceOne(): void {
  if (!findQuery || findMatches.length === 0 || findCurrent < 0) return;
  const repl = replaceInput.value;
  const idx = findCurrent;
  const source = currentText;
  const lower = findQuery.toLowerCase();
  // Find the Nth occurrence in the source to replace exactly the highlighted one.
  let pos = -1;
  for (let i = 0; i <= idx; i++) {
    pos = source.toLowerCase().indexOf(lower, pos + 1);
    if (pos === -1) break;
  }
  if (pos === -1) return;
  const newSource = source.slice(0, pos) + repl + source.slice(pos + findQuery.length);
  currentText = newSource;
  editor.value = newSource; // keep the editor buffer in sync so save() works
  dirty = true;
  setTitle();
  if (viewMode === "source") schedulePreview();
  // Re-scan after replacement.
  findQuery = "";
  void renderMarkdown(currentText, true).then(() => {
    runFind(false);
  });
}

function runReplaceAll(): void {
  if (!findQuery || findMatches.length === 0) return;
  const repl = replaceInput.value;
  const source = currentText;
  const lower = findQuery.toLowerCase();
  const newSource = source.toLowerCase().split(lower).join(repl);
  currentText = newSource;
  editor.value = newSource; // keep the editor buffer in sync so save() works
  dirty = true;
  setTitle();
  if (viewMode === "source") schedulePreview();
  findQuery = "";
  void renderMarkdown(currentText, true).then(() => {
    runFind(false);
  });
}

findInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    runFind(ev.shiftKey);
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeFind();
  }
});
replaceInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    runReplaceOne();
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeFind();
  }
});
findInput.addEventListener("input", () => runFind(false));
replaceInput.addEventListener("input", () => {
  // Re-render count (query may have changed the match count already handled by findInput).
});
(document.getElementById("find-next") as HTMLButtonElement).addEventListener("click", () => runFind(false));
(document.getElementById("find-prev") as HTMLButtonElement).addEventListener("click", () => runFind(true));
(document.getElementById("replace-one") as HTMLButtonElement).addEventListener("click", runReplaceOne);
(document.getElementById("replace-all") as HTMLButtonElement).addEventListener("click", runReplaceAll);
(document.getElementById("find-close") as HTMLButtonElement).addEventListener("click", closeFind);

// Collapse / expand the outline.
function toggleToc(): void {
  layout.classList.toggle("toc-collapsed");
}
tocToggle.addEventListener("click", toggleToc);
window.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey && (ev.key === "\\" || ev.key === "|")) {
    // Shift turns "\" into "|" on many layouts; treat both as the same chord.
    ev.preventDefault();
    if (ev.shiftKey) toggleWide();
    else toggleToc();
  } else if (ev.ctrlKey && (ev.key === "e" || ev.key === "E")) {
    ev.preventDefault();
    toggleEdit();
  } else if (ev.ctrlKey && (ev.key === "s" || ev.key === "S")) {
    ev.preventDefault();
    void save();
  } else if (ev.ctrlKey && (ev.key === "=" || ev.key === "+")) {
    ev.preventDefault();
    bumpFont(0.1);
  } else if (ev.ctrlKey && ev.key === "-") {
    ev.preventDefault();
    bumpFont(-0.1);
  } else if (ev.ctrlKey && (ev.key === "o" || ev.key === "O")) {
    ev.preventDefault();
    void openViaDialog();
  } else if (ev.ctrlKey && (ev.key === "f" || ev.key === "F")) {
    ev.preventDefault();
    openFind();
  } else if (ev.ctrlKey && (ev.key === "b" || ev.key === "B")) {
    ev.preventDefault();
    toggleFiles();
  } else if (ev.key === "Escape" && !diagramModal.hidden) {
    closeDiagram();
  } else if (ev.key === "Escape" && !settingsModal.hidden) {
    closeSettings();
  } else if (ev.key === "Escape" && !findBar.hidden) {
    closeFind();
  }
});

// ---------- Format shortcuts (headings / paragraph / lists) ----------
// Apply or toggle a Markdown prefix on the current line(s) of the source.
// Works in source mode (cursor in editor) and live mode (edits the buffer).
// "block" formats prefix the current line(s); "inline" formats wrap the
// selection (or insert a template when nothing is selected).
interface FmtDef {
  prefix?: string; // block prefix, or "" for special-cased formats
  inline?: {
    before: string;
    after: string;
    placeholder?: string;
  };
}
const FMT_DEFS: Record<string, FmtDef> = {
  h1: { prefix: "# " },
  h2: { prefix: "## " },
  h3: { prefix: "### " },
  h4: { prefix: "#### " },
  h5: { prefix: "##### " },
  para: { prefix: "" },
  ol: { prefix: "1. " },
  ul: { prefix: "- " },
  blockquote: { prefix: "> " },
  codeblock: { prefix: "```" },
  hr: { prefix: "---" },
  bold: { inline: { before: "**", after: "**", placeholder: "粗体文字" } },
  italic: { inline: { before: "*", after: "*", placeholder: "斜体文字" } },
  code: { inline: { before: "`", after: "`", placeholder: "代码" } },
  link: { inline: { before: "[", after: "](url)", placeholder: "链接文字" } },
  image: { inline: { before: "![", after: "](url)", placeholder: "图片说明" } },
};

function applyFormatOnLine(text: string, prefix: string, lineStart: number): {
  text: string;
  delta: number;
} {
  // Read current line from the caret position.
  const lineEnd = text.indexOf("\n", lineStart);
  const end = lineEnd === -1 ? text.length : lineEnd;
  const line = text.slice(lineStart, end);
  const leading = line.match(/^(\s*)/)?.[1] ?? "";
  const content = line.slice(leading.length);
  if (prefix === "") {
    // Paragraph: strip any single heading/list/quote prefix already present.
    const stripped = content.replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+)/, "");
    return { text: text.slice(0, lineStart) + leading + stripped + text.slice(end), delta: 0 };
  }
  // Code block: wrap/unwrap the whole line (or selection) in ``` fences.
  if (prefix === "```") {
    const isFenced = /^```/.test(content);
    if (isFenced) {
      return { text: text.slice(0, lineStart) + leading + content.replace(/^```\s*/, "") + text.slice(end), delta: -4 };
    }
    return { text: text.slice(0, lineStart) + leading + "```\n" + content + "\n```" + text.slice(end), delta: 4 };
  }
  // Toggle: if the line already starts with this prefix, remove it.
  const stripRe = prefix === "1. " ? /^\d+\.\s+/ : prefix === "- " ? /^[-*+]\s+/ : new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (stripRe.test(content)) {
    const removed = content.replace(stripRe, "");
    return { text: text.slice(0, lineStart) + leading + removed + text.slice(end), delta: -prefix.length };
  }
  // Otherwise prepend the prefix.
  const inserted = leading + prefix + content;
  return { text: text.slice(0, lineStart) + inserted + text.slice(end), delta: prefix.length };
}

function applyFormat(fmt: string): void {
  if (!currentPath) {
    toast("未打开文件");
    return;
  }
  const def = FMT_DEFS[fmt];
  if (!def) return;
  const ta = editor;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const src = ta.value;

  // Inline formats wrap the selection (or insert a placeholder).
  if (def.inline) {
    const { before, after, placeholder } = def.inline;
    const selected = src.slice(start, end);
    let newText: string;
    let selStart: number;
    let selEnd: number;
    if (selected) {
      // Toggle: if already wrapped, unwrap.
      if (selected.startsWith(before) && selected.endsWith(after)) {
        newText = src.slice(0, start) + selected.slice(before.length, selected.length - after.length) + src.slice(end);
        selStart = start;
        selEnd = end - before.length - after.length;
      } else {
        newText = src.slice(0, start) + before + selected + after + src.slice(end);
        selStart = start + before.length;
        selEnd = end + before.length;
      }
    } else {
      // No selection: insert template with the placeholder selected.
      const ph = placeholder ?? "";
      newText = src.slice(0, start) + before + ph + after + src.slice(end);
      selStart = start + before.length;
      selEnd = selStart + ph.length;
    }
    ta.value = newText;
    ta.setSelectionRange(selStart, selEnd);
    currentText = newText;
    dirty = true;
    setTitle();
    if (viewMode === "source" || viewMode === "live") {
      schedulePreview();
    } else {
      void renderMarkdown(newText, true);
    }
    return;
  }

  const prefix = def.prefix!;
  const ta2 = editor;
  const start2 = ta2.selectionStart;
  const end2 = ta2.selectionEnd;
  if (start2 === end2) {
    const lineStart = src.lastIndexOf("\n", start2 - 1) + 1;
    const r = applyFormatOnLine(src, prefix, lineStart);
    ta2.value = r.text;
    const newPos = start2 + r.delta;
    ta2.setSelectionRange(newPos, newPos);
  } else {
    // Apply to each selected line.
    const selStartLine = src.lastIndexOf("\n", start2 - 1) + 1;
    const selEnd = src.indexOf("\n", end2);
    const lastLineEnd = selEnd === -1 ? src.length : selEnd;
    const lines = src.slice(selStartLine, lastLineEnd).split("\n");
    const processed = lines.map((l) => {
      const leading = l.match(/^(\s*)/)?.[1] ?? "";
      const content = l.slice(leading.length);
      if (prefix === "") return leading + content.replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+)/, "");
      if (prefix === "```") {
        return /^```/.test(content)
          ? leading + content.replace(/^```\s*/, "")
          : leading + "```\n" + content + "\n```";
      }
      const stripRe = prefix === "1. " ? /^\d+\.\s+/ : prefix === "- " ? /^[-*+]\s+/ : new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      if (stripRe.test(content)) return leading + content.replace(stripRe, "");
      return leading + prefix + content;
    });
    ta2.value = src.slice(0, selStartLine) + processed.join("\n") + src.slice(lastLineEnd);
    ta2.setSelectionRange(selStartLine, selStartLine + processed.join("\n").length);
  }
  currentText = ta2.value;
  dirty = true;
  setTitle();
  if (viewMode === "source" || viewMode === "live") {
    schedulePreview();
  } else {
    void renderMarkdown(ta2.value, true);
  }
}

// Bind the format buttons.
(document.getElementById("fmt-h1") as HTMLButtonElement).addEventListener("click", () => applyFormat("h1"));
(document.getElementById("fmt-h2") as HTMLButtonElement).addEventListener("click", () => applyFormat("h2"));
(document.getElementById("fmt-h3") as HTMLButtonElement).addEventListener("click", () => applyFormat("h3"));
(document.getElementById("fmt-h4") as HTMLButtonElement).addEventListener("click", () => applyFormat("h4"));
(document.getElementById("fmt-h5") as HTMLButtonElement).addEventListener("click", () => applyFormat("h5"));
(document.getElementById("fmt-para") as HTMLButtonElement).addEventListener("click", () => applyFormat("para"));
(document.getElementById("fmt-ol") as HTMLButtonElement).addEventListener("click", () => applyFormat("ol"));
(document.getElementById("fmt-ul") as HTMLButtonElement).addEventListener("click", () => applyFormat("ul"));
(document.getElementById("fmt-blockquote") as HTMLButtonElement).addEventListener("click", () => applyFormat("blockquote"));
(document.getElementById("fmt-codeblock") as HTMLButtonElement).addEventListener("click", () => applyFormat("codeblock"));
(document.getElementById("fmt-hr") as HTMLButtonElement).addEventListener("click", () => applyFormat("hr"));
(document.getElementById("fmt-bold") as HTMLButtonElement).addEventListener("click", () => applyFormat("bold"));
(document.getElementById("fmt-italic") as HTMLButtonElement).addEventListener("click", () => applyFormat("italic"));
(document.getElementById("fmt-code") as HTMLButtonElement).addEventListener("click", () => applyFormat("code"));
(document.getElementById("fmt-link") as HTMLButtonElement).addEventListener("click", () => applyFormat("link"));
(document.getElementById("fmt-image") as HTMLButtonElement).addEventListener("click", () => applyFormat("image"));

// Keyboard shortcuts:
//   Ctrl+1..5 headings, Ctrl+` paragraph, Ctrl+B bold, Ctrl+I italic
//   Alt+1 ordered, Alt+2 unordered, Alt+3 code block, Alt+4 image,
//   Alt+5 blockquote, Alt+6 link, Alt+7 horizontal rule, Alt+` inline code
window.addEventListener("keydown", (ev) => {
  const fmtKey = (() => {
    if (ev.ctrlKey && !ev.altKey) {
      if (ev.key >= "1" && ev.key <= "5") return "h" + ev.key;
      if (ev.key === "`") return "para";
      if (ev.key === "b" || ev.key === "B") return "bold";
      if (ev.key === "i" || ev.key === "I") return "italic";
    }
    if (ev.altKey && !ev.ctrlKey) {
      if (ev.key === "1") return "ol";
      if (ev.key === "2") return "ul";
      if (ev.key === "3") return "codeblock";
      if (ev.key === "4") return "image";
      if (ev.key === "5") return "blockquote";
      if (ev.key === "6") return "link";
      if (ev.key === "7") return "hr";
      if (ev.key === "`") return "code";
    }
    return null;
  })();
  if (fmtKey && FMT_DEFS[fmtKey] !== undefined) {
    ev.preventDefault();
    applyFormat(fmtKey);
  }
});

// Smart Ctrl+A: in read/live mode, or when focus is outside the source editor,
// select the entire rendered article (so Ctrl+C into Word keeps heading/table/
// list styles). Inside the source editor it keeps the default select-all.
window.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey && (ev.key === "a" || ev.key === "A")) {
    const active = document.activeElement;
    const inEditor = active === editor;
    const inInput =
      active === findInput ||
      active === replaceInput ||
      (active as HTMLElement | null)?.isContentEditable;
    if (inEditor || inInput) return; // let the browser select the field's own text
    ev.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(content);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
});

// Open external links in the user's default browser instead of navigating
// the webview away from the document.
content.addEventListener("click", (ev) => {
  const anchor = (ev.target as HTMLElement).closest("a");
  if (anchor) {
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      ev.preventDefault();
      void openUrl(href);
    }
  }
});

// ---------- Window size persistence ----------
// macOS is single-instance and, when a window's Space is re-activated, the OS
// sometimes resizes it to fill the screen. We remember the user's size and
// restore it on focus so switching desktops keeps the chosen width.
interface WinSize {
  width: number;
  height: number;
}
// Matches the window's minWidth/minHeight in tauri.conf.json. Sizes below this
// are degenerate (e.g. the OS reports 0×0 while minimized) and must never be
// saved or restored — doing so shrinks the window to an unusable sliver.
const MIN_WIN_W = 400;
const MIN_WIN_H = 300;
function isSaneSize(w: unknown, h: unknown): w is number {
  return (
    typeof w === "number" &&
    typeof h === "number" &&
    w >= MIN_WIN_W &&
    h >= MIN_WIN_H
  );
}
function loadWinSize(): WinSize | null {
  try {
    const s = JSON.parse(localStorage.getItem("winSize") ?? "null");
    // Reject degenerate stored values so an upgrade auto-heals a corrupt size.
    return s && isSaneSize(s.width, s.height)
      ? { width: s.width, height: s.height }
      : null;
  } catch {
    return null;
  }
}
function saveWinSize(width: number, height: number): void {
  // Never persist a minimized / degenerate size.
  if (!isSaneSize(width, height)) return;
  localStorage.setItem(
    "winSize",
    JSON.stringify({ width: Math.round(width), height: Math.round(height) }),
  );
}

let suppressWinSaveUntil = 0;
let winSaveTimer: number | undefined;
let monitorWidth = 0; // cached (physical px) so the resize handler stays sync

async function refreshMonitorWidth(): Promise<void> {
  try {
    const m = await currentMonitor();
    if (m) monitorWidth = m.size.width;
  } catch {
    /* ignore */
  }
}

async function setupWindowSize(): Promise<void> {
  await refreshMonitorWidth();

  // Restore the last size on launch (skip if already maximized).
  const saved = loadWinSize();
  if (saved && !(await appWindow.isMaximized())) {
    try {
      await appWindow.setSize(new PhysicalSize(saved.width, saved.height));
    } catch {
      /* ignore */
    }
  }

  // Persist user resizes (debounced). Skips saving while suppressed and ignores
  // a width that fills the monitor — that's the Spaces-switch jump, not a drag.
  await appWindow.onResized(({ payload }) => {
    if (Date.now() < suppressWinSaveUntil) return;
    if (monitorWidth && payload.width >= monitorWidth - 2) return;
    // Ignore minimized / degenerate sizes (0×0 etc.) — saveWinSize also guards.
    if (!isSaneSize(payload.width, payload.height)) return;
    const { width, height } = payload;
    window.clearTimeout(winSaveTimer);
    winSaveTimer = window.setTimeout(() => saveWinSize(width, height), 300);
  });

  // On regaining focus, restore the saved size only if the window isn't
  // maximized (prevents shrinking from fullscreen on alt-tab).
  await appWindow.onFocusChanged(({ payload: focused }) => {
    if (!focused) return;
    void refreshMonitorWidth().then(async () => {
      if (await appWindow.isMaximized()) return;
      const s = loadWinSize();
      if (!s) return;
      suppressWinSaveUntil = Date.now() + 600;
      void appWindow.setSize(new PhysicalSize(s.width, s.height));
    });
  });
}

async function init(): Promise<void> {
  // Remember/restore the window size (see setupWindowSize).
  await setupWindowSize();

  // Hot reload when the watched file changes on disk. Skip while editing or
  // when the change came from our own save.
  await listen<string>("md-changed", () => {
    if (currentPath && viewMode === "read" && Date.now() > suppressReloadUntil) {
      void openFile(currentPath, false, true);
    }
  });

  // macOS delivers file-association opens at runtime.
  await listen<string>("open-file", (ev) => {
    void openFile(ev.payload);
  });

  // Drag-and-drop a .md / .txt file onto the window.
  await getCurrentWebview().onDragDropEvent((ev) => {
    if (ev.payload.type === "drop") {
      const file = ev.payload.paths.find((p) => /\.(md|markdown|txt)$/i.test(p));
      if (file) {
        void openFile(file);
      }
    }
  });

  // Intercept window close when there are unsaved edits.
  await appWindow.onCloseRequested((event) => {
    if (dirty) {
      event.preventDefault();
      closeAction = "window";
      showCloseModal();
    }
  });

  // Signal the backend that listeners are ready, flushing any file-open
  // requests that arrived during cold start (fixes macOS first-open blank).
  await invoke("frontend_ready");

  // Sync the mode button label with the initial (read) mode.
  editToggle.textContent = MODE_META[viewMode].label;
  editToggle.title = MODE_META[viewMode].title;

  // Populate the empty-state recent-files list.
  renderRecents();

  // Restore the file-explorer panel if it was left open.
  if (filesOpen) void renderFiles(null);

  // File the app was launched with (Windows / Linux association).
  const initial = await invoke<string | null>("get_initial_path");
  if (initial) {
    await openFile(initial);
    // Optional `--edit` flag opens straight into source (split) mode.
    if (await invoke<boolean>("start_in_edit")) {
      await setViewMode("source");
    }
  }

  // Optional `--zoom=<factor>` flag scales the whole UI.
  const zoom = await invoke<number>("start_zoom");
  if (zoom && zoom > 0) {
    await getCurrentWebview().setZoom(zoom);
  }
}

void init();
