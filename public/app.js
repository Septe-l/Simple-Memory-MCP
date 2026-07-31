/* Simple-Memory-MCP WebUI — 依存なしのバニラ JS */

const $ = (sel) => document.querySelector(sel);

const els = {
  status: $("#status"),
  statusDot: $("#statusDot"),
  statusText: $("#statusText"),
  settingsToggle: $("#settingsToggle"),
  settingsPanel: $("#settingsPanel"),
  spaceEditors: $("#spaceEditors"),
  systemPrompt: $("#systemPrompt"),
  copyPrompt: $("#copyPrompt"),
  memoryLevel: $("#memoryLevel"),
  levelLabel: $("#levelLabel"),
  levelGuidance: $("#levelGuidance"),
  semanticWeight: $("#semanticWeight"),
  keywordWeight: $("#keywordWeight"),
  saveSettings: $("#saveSettings"),
  reindexBtn: $("#reindexBtn"),
  reindexForceBtn: $("#reindexForceBtn"),
  resetSettings: $("#resetSettings"),
  indexInfo: $("#indexInfo"),
  addForm: $("#addForm"),
  addContent: $("#addContent"),
  addTags: $("#addTags"),
  addImportance: $("#addImportance"),
  addSubmit: $("#addSubmit"),
  searchInput: $("#searchInput"),
  sortSelect: $("#sortSelect"),
  tagbar: $("#tagbar"),
  resultInfo: $("#resultInfo"),
  selectAll: $("#selectAll"),
  bulkDelete: $("#bulkDelete"),
  results: $("#results"),
  emptyState: $("#emptyState"),
  pager: $("#pager"),
  prevPage: $("#prevPage"),
  nextPage: $("#nextPage"),
  pageInfo: $("#pageInfo"),
  toasts: $("#toasts"),
  spaceTemplate: $("#spaceTemplate"),
  itemTemplate: $("#itemTemplate"),
};

const PAGE_SIZE = 20;
const SPACE_LABEL = { primary: "主空間", secondary: "副空間" };

const state = {
  query: "",
  tag: null,
  sort: "recent",
  page: 0,
  total: 0,
  items: [],
  selected: new Set(),
  settings: null,
  memoryLevels: [],
};

/* ---------- ユーティリティ ---------- */

function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(
    () => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 200);
    },
    kind === "error" ? 7000 : 3000,
  );
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const parseTags = (raw) => [...new Set(raw.split(/[,、]/).map((t) => t.trim()).filter(Boolean))];

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ---------- 設定パネル ---------- */

function readSpaceEditor(node) {
  return {
    id: node.dataset.id,
    enabled: node.querySelector(".space-enabled input").checked,
    language: node.querySelector(".space-language").value,
    baseUrl: node.querySelector(".space-url").value.trim(),
    model: node.querySelector(".space-model").value.trim(),
    queryPrefix: node.querySelector(".space-qprefix").value,
    documentPrefix: node.querySelector(".space-dprefix").value,
  };
}

function setSpaceStatus(node, { text, kind, detail }) {
  const badge = node.querySelector(".space-status");
  badge.textContent = text;
  badge.className = `badge space-status ${kind ?? ""}`;
  node.querySelector(".space-detail").textContent = detail ?? "";
}

function renderSpaceEditor(space) {
  const node = els.spaceTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = space.id;
  node.querySelector(".space-title").textContent = `${SPACE_LABEL[space.id] ?? space.id}（${space.id}）`;
  node.querySelector(".space-enabled input").checked = space.enabled;
  node.querySelector(".space-language").value = space.language;
  node.querySelector(".space-url").value = space.baseUrl;
  node.querySelector(".space-model").value = space.model;
  node.querySelector(".space-qprefix").value = space.queryPrefix;
  node.querySelector(".space-dprefix").value = space.documentPrefix;

  const modelInput = node.querySelector(".space-model");
  const datalist = node.querySelector(".space-models");
  datalist.id = `models-${space.id}`;
  modelInput.setAttribute("list", datalist.id);

  // モデル名を変えたら接頭辞の推奨値を引き直す（手で書き換えていない場合のみ）
  modelInput.addEventListener("change", async () => {
    const q = node.querySelector(".space-qprefix");
    const d = node.querySelector(".space-dprefix");
    try {
      const guessed = await api(`/api/settings/prefixes?model=${encodeURIComponent(modelInput.value.trim())}`);
      q.value = guessed.query;
      d.value = guessed.document;
      if (guessed.query || guessed.document) toast(`${modelInput.value} の推奨接頭辞を設定しました`);
    } catch {
      /* 推奨が取れなくても入力は続けられる */
    }
  });

  node.querySelector(".fetch-models").addEventListener("click", async () => {
    const baseUrl = node.querySelector(".space-url").value.trim();
    try {
      const { models } = await api(`/api/settings/models?baseUrl=${encodeURIComponent(baseUrl)}`);
      datalist.replaceChildren(
        ...models.map((m) => {
          const opt = document.createElement("option");
          opt.value = m;
          return opt;
        }),
      );
      toast(`${models.length} 件のモデルを取得しました（入力欄の候補に出ます）`);
    } catch (err) {
      toast(`モデル一覧を取得できません: ${err.message}`, "error");
    }
  });

  node.querySelector(".test-space").addEventListener("click", async () => {
    setSpaceStatus(node, { text: "確認中…", kind: "" });
    try {
      const result = await api("/api/settings/test", {
        method: "POST",
        body: JSON.stringify(readSpaceEditor(node)),
      });
      if (result.ok) {
        setSpaceStatus(node, { text: "OK", kind: "ok", detail: result.detail });
      } else {
        setSpaceStatus(node, {
          text: result.modelMismatch ? "モデル不一致" : "エラー",
          kind: "ng",
          detail: result.detail,
        });
      }
    } catch (err) {
      setSpaceStatus(node, { text: "エラー", kind: "ng", detail: err.message });
    }
  });

  return node;
}

function renderIndexInfo(index) {
  els.indexInfo.textContent = index
    .map((i) => (i.enabled ? `${i.id}: 索引 ${i.indexed} / 未索引 ${i.stale}` : `${i.id}: 無効`))
    .join("　");
}

function renderMemoryLevel() {
  const level = Number(els.memoryLevel.value);
  const info = state.memoryLevels.find((l) => l.level === level);
  els.levelLabel.textContent = info ? `${info.label}（${level}/${state.memoryLevels.length}）` : `${level}`;
  els.levelGuidance.textContent = info
    ? `${info.guidance}（重要度 ${info.minImportance} 以上を保存）`
    : "";
}

async function loadSettings() {
  const data = await api("/api/settings");
  state.settings = data.settings;
  state.memoryLevels = data.memoryLevels ?? [];
  els.spaceEditors.replaceChildren(...data.settings.spaces.map(renderSpaceEditor));
  els.memoryLevel.max = String(state.memoryLevels.length || 5);
  els.memoryLevel.value = String(data.settings.memoryLevel);
  renderMemoryLevel();
  els.systemPrompt.value = data.systemPrompt ?? "";
  els.semanticWeight.value = data.settings.semanticWeight;
  els.keywordWeight.value = data.settings.keywordWeight;
  renderIndexInfo(data.index);
}

els.memoryLevel.addEventListener("input", renderMemoryLevel);

els.copyPrompt.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.systemPrompt.value);
    toast("System Prompt をコピーしました");
  } catch {
    // クリップボード API が使えない環境（http の別ホストなど）向けのフォールバック
    els.systemPrompt.select();
    toast("選択しました。Cmd/Ctrl + C でコピーしてください");
  }
});

els.settingsToggle.addEventListener("click", () => {
  els.settingsPanel.classList.toggle("hidden");
  if (!els.settingsPanel.classList.contains("hidden")) {
    els.settingsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

els.saveSettings.addEventListener("click", async () => {
  const spaces = [...els.spaceEditors.querySelectorAll(".space-editor")].map(readSpaceEditor);
  els.saveSettings.disabled = true;
  try {
    const data = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        spaces,
        memoryLevel: Number(els.memoryLevel.value),
        semanticWeight: Number(els.semanticWeight.value),
        keywordWeight: Number(els.keywordWeight.value),
      }),
    });
    state.settings = data.settings;
    els.systemPrompt.value = data.systemPrompt ?? els.systemPrompt.value;
    renderIndexInfo(data.index);
    const stale = data.index.filter((i) => i.enabled && i.stale > 0);
    toast(
      stale.length > 0
        ? `設定を保存しました。未索引が ${stale.map((i) => `${i.id}:${i.stale}件`).join("、")} あります — 「埋め込みを再生成」を実行してください`
        : "設定を保存しました",
    );
    await checkHealth();
  } catch (err) {
    toast(`保存に失敗: ${err.message}`, "error");
  } finally {
    els.saveSettings.disabled = false;
  }
});

async function runReindex(force) {
  const btn = force ? els.reindexForceBtn : els.reindexBtn;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "再生成中…";
  try {
    const res = await api("/api/reindex", { method: "POST", body: JSON.stringify({ force }) });
    for (const s of res.spaces) {
      if (s.error) toast(`[${s.id}] ${s.error}`, "error");
    }
    toast(res.spaces.map((s) => `${s.id}: ${s.processed}件成功/${s.failed}件失敗`).join("　"));
    await Promise.all([loadSettings(), load(), checkHealth()]);
  } catch (err) {
    toast(`再生成に失敗: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

els.resetSettings.addEventListener("click", async () => {
  if (!confirm("埋め込みの設定を環境変数（docker compose）の既定値に戻します。よろしいですか？")) return;
  try {
    await api("/api/settings/reset", { method: "POST" });
    await loadSettings();
    await checkHealth();
    toast("既定値に戻しました");
  } catch (err) {
    toast(`リセットに失敗: ${err.message}`, "error");
  }
});

els.reindexBtn.addEventListener("click", () => runReindex(false));
els.reindexForceBtn.addEventListener("click", () => {
  if (confirm("全ての記憶の埋め込みを作り直します。件数によっては時間がかかります。続けますか？")) {
    void runReindex(true);
  }
});

/* ---------- 記憶の描画 ---------- */

function renderTagbar(tags) {
  els.tagbar.replaceChildren();
  if (tags.length === 0) return;

  const makeChip = (label, value) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `tag-chip ${state.tag === value ? "active" : ""}`;
    chip.textContent = label;
    chip.addEventListener("click", () => {
      state.tag = state.tag === value ? null : value;
      state.page = 0;
      void load();
    });
    return chip;
  };

  els.tagbar.append(makeChip("すべて", null));
  for (const { tag, count } of tags) els.tagbar.append(makeChip(`${tag} (${count})`, tag));
}

function renderItem(item) {
  const node = els.itemTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = item.id;

  const checkbox = node.querySelector(".item-select");
  checkbox.checked = state.selected.has(item.id);
  node.classList.toggle("selected", checkbox.checked);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selected.add(item.id);
    else state.selected.delete(item.id);
    node.classList.toggle("selected", checkbox.checked);
    syncSelectionUi();
  });

  node.querySelector(".importance-badge").textContent = `重要度 ${item.importance}`;

  const scoreBadge = node.querySelector(".score-badge");
  if (typeof item.score === "number") {
    scoreBadge.textContent = `関連度 ${item.score.toFixed(2)}`;
    scoreBadge.classList.remove("hidden");
    const parts = Object.entries(item.semanticScores ?? {}).map(([k, v]) => `${k} ${v.toFixed(3)}`);
    parts.push(`キーワード ${item.keywordScore.toFixed(3)}`);
    scoreBadge.title = parts.join(" / ");
  }

  if (!item.vectorSpaces || item.vectorSpaces.length === 0) {
    node.querySelector(".warn-badge").classList.remove("hidden");
  }

  node.querySelector(".content").textContent = item.content;

  const tagsEl = node.querySelector(".tags");
  for (const tag of item.tags) {
    const el = document.createElement("span");
    el.className = "tag";
    el.textContent = `#${tag}`;
    el.title = "このタグで絞り込む";
    el.addEventListener("click", () => {
      state.tag = state.tag === tag ? null : tag;
      state.page = 0;
      void load();
    });
    tagsEl.append(el);
  }

  const spaces = (item.vectorSpaces ?? []).join(", ") || "なし";
  node.querySelector(".meta").textContent =
    `更新 ${formatDate(item.updatedAt)}  ·  作成 ${formatDate(item.createdAt)}  ·  参照 ${item.accessCount} 回  ·  索引 ${spaces}  ·  id ${item.id.slice(0, 8)}`;

  /* --- 編集 --- */
  const form = node.querySelector(".edit-form");
  const editContent = node.querySelector(".edit-content");
  const editTags = node.querySelector(".edit-tags");
  const editImportance = node.querySelector(".edit-importance");

  node.querySelector(".edit-btn").addEventListener("click", () => {
    editContent.value = item.content;
    editTags.value = item.tags.join(", ");
    editImportance.value = String(item.importance);
    form.classList.toggle("hidden");
    if (!form.classList.contains("hidden")) editContent.focus();
  });

  node.querySelector(".cancel-btn").addEventListener("click", () => form.classList.add("hidden"));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const content = editContent.value.trim();
    if (!content) {
      toast("内容が空です", "error");
      return;
    }
    try {
      const res = await api(`/api/memories/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          content,
          tags: parseTags(editTags.value),
          importance: Number(editImportance.value),
        }),
      });
      toast("更新しました");
      for (const w of res.warnings ?? []) toast(w, "error");
      await Promise.all([load(), refreshMeta()]);
    } catch (err) {
      toast(`更新に失敗: ${err.message}`, "error");
    }
  });

  /* --- 削除 --- */
  node.querySelector(".delete-btn").addEventListener("click", async () => {
    const preview = item.content.length > 40 ? `${item.content.slice(0, 40)}…` : item.content;
    if (!confirm(`この記憶を削除します。取り消せません。\n\n「${preview}」`)) return;
    try {
      await api(`/api/memories/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      state.selected.delete(item.id);
      toast("削除しました");
      await Promise.all([load(), refreshMeta()]);
    } catch (err) {
      toast(`削除に失敗: ${err.message}`, "error");
    }
  });

  return node;
}

function syncSelectionUi() {
  const count = state.selected.size;
  els.bulkDelete.disabled = count === 0;
  els.bulkDelete.textContent = count === 0 ? "選択した記憶を削除" : `選択した ${count} 件を削除`;
  els.selectAll.checked = count > 0 && state.items.every((i) => state.selected.has(i.id));
}

function renderWarnings(warnings) {
  document.querySelectorAll(".notice").forEach((el) => el.remove());
  for (const message of warnings ?? []) {
    const el = document.createElement("div");
    el.className = "notice";
    el.textContent = message;
    els.results.before(el);
  }
}

/* ---------- データ取得 ---------- */

async function load() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.tag) params.set("tag", state.tag);
  params.set("sort", state.sort);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(state.page * PAGE_SIZE));

  try {
    const data = await api(`/api/memories?${params}`);
    state.items = data.items;
    state.total = data.total;

    els.results.replaceChildren(...data.items.map(renderItem));
    renderWarnings(data.warnings);

    const scope = state.tag ? `タグ「${state.tag}」` : "";
    if (data.items.length === 0) {
      els.emptyState.classList.remove("hidden");
      els.emptyState.textContent = state.query
        ? `「${state.query}」に一致する記憶はありません。`
        : `${scope ? `${scope}の` : ""}記憶はまだありません。上のフォームから追加してください。`;
      els.resultInfo.textContent = "0 件";
    } else {
      els.emptyState.classList.add("hidden");
      els.resultInfo.textContent =
        data.mode === "search"
          ? `検索結果 ${data.items.length} 件${scope ? `／${scope}` : ""}`
          : `全 ${data.total} 件中 ${state.page * PAGE_SIZE + 1}–${state.page * PAGE_SIZE + data.items.length} 件${scope ? `／${scope}` : ""}`;
    }

    // 検索モードは関連度順の 1 ページのみ。一覧モードだけページングする。
    const pageable = data.mode === "list" && data.total > PAGE_SIZE;
    els.pager.classList.toggle("hidden", !pageable);
    if (pageable) {
      const lastPage = Math.ceil(data.total / PAGE_SIZE) - 1;
      els.prevPage.disabled = state.page === 0;
      els.nextPage.disabled = state.page >= lastPage;
      els.pageInfo.textContent = `${state.page + 1} / ${lastPage + 1} ページ`;
    }

    syncSelectionUi();
  } catch (err) {
    toast(`読み込みに失敗: ${err.message}`, "error");
    els.resultInfo.textContent = "読み込みエラー";
  }
}

async function refreshMeta() {
  try {
    const stats = await api("/api/stats");
    renderTagbar(stats.tags);
    renderIndexInfo(stats.index);
  } catch {
    /* ステータスは best-effort */
  }
}

async function checkHealth() {
  try {
    const [health, stats] = await Promise.all([api("/api/health"), api("/api/stats")]);
    const active = health.spaces.filter((s) => s.enabled);
    const bad = active.filter((s) => !s.ok);

    if (active.length === 0) {
      els.statusDot.className = "dot ng";
      els.statusText.textContent = `記憶 ${stats.total} 件 · 意味検索 無効（キーワード検索のみ）`;
      els.status.title = "設定画面で埋め込みバックエンドを有効にしてください。";
    } else if (bad.length === 0) {
      els.statusDot.className = "dot ok";
      els.statusText.textContent = `記憶 ${stats.total} 件 · ${active.map((s) => `${s.id}:${s.model}`).join(" / ")}`;
      els.status.title = active.map((s) => `${s.id}: ${s.model} @ ${s.baseUrl} (${s.detail})`).join("\n");
    } else {
      els.statusDot.className = "dot ng";
      els.statusText.textContent = `記憶 ${stats.total} 件 · ⚠ ${bad.map((s) => s.id).join(", ")} に問題`;
      els.status.title = bad.map((s) => `${s.id}: ${s.detail}`).join("\n");
      for (const s of bad) {
        if (s.modelMismatch) toast(`[${s.id}] ${s.detail}`, "error");
      }
    }
  } catch (err) {
    els.statusDot.className = "dot ng";
    els.statusText.textContent = "サーバーに接続できません";
    els.status.title = err.message;
  }
}

/* ---------- イベント ---------- */

els.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = els.addContent.value.trim();
  if (!content) return;

  els.addSubmit.disabled = true;
  els.addSubmit.textContent = "追加中…";
  try {
    const res = await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({
        content,
        tags: parseTags(els.addTags.value),
        importance: Number(els.addImportance.value),
      }),
    });
    if (res.duplicateOf) {
      toast(`ほぼ同じ記憶が既にあるため追加しませんでした（類似度 ${res.duplicateOf.similarity.toFixed(2)}）`);
    } else {
      toast("記憶を追加しました");
      els.addContent.value = "";
      els.addTags.value = "";
    }
    for (const w of res.warnings ?? []) toast(w, "error");
    await Promise.all([load(), refreshMeta(), checkHealth()]);
  } catch (err) {
    toast(`追加に失敗: ${err.message}`, "error");
  } finally {
    els.addSubmit.disabled = false;
    els.addSubmit.textContent = "追加";
  }
});

// Cmd/Ctrl + Enter で追加
els.addContent.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") els.addForm.requestSubmit();
});

els.searchInput.addEventListener(
  "input",
  debounce(() => {
    state.query = els.searchInput.value.trim();
    state.page = 0;
    void load();
  }, 280),
);

els.sortSelect.addEventListener("change", () => {
  state.sort = els.sortSelect.value;
  state.page = 0;
  void load();
});

els.selectAll.addEventListener("change", () => {
  if (els.selectAll.checked) for (const item of state.items) state.selected.add(item.id);
  else for (const item of state.items) state.selected.delete(item.id);
  els.results.replaceChildren(...state.items.map(renderItem));
  syncSelectionUi();
});

els.bulkDelete.addEventListener("click", async () => {
  const ids = [...state.selected];
  if (ids.length === 0) return;
  if (!confirm(`${ids.length} 件の記憶を削除します。取り消せません。`)) return;
  try {
    const res = await api("/api/memories/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) });
    state.selected.clear();
    els.selectAll.checked = false;
    toast(`${res.deleted} 件を削除しました`);
    await Promise.all([load(), refreshMeta()]);
  } catch (err) {
    toast(`削除に失敗: ${err.message}`, "error");
  }
});

els.prevPage.addEventListener("click", () => {
  if (state.page > 0) {
    state.page--;
    void load();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});

els.nextPage.addEventListener("click", () => {
  state.page++;
  void load();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

/* ---------- 起動 ---------- */

await loadSettings();
await load();
await refreshMeta();
await checkHealth();
