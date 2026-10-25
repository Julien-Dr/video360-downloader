"use strict";
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(k));
  return n;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem("v360:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("v360:" + k, JSON.stringify(v)); } catch {} },
};

/* ---------- formatage ---------- */
const fmtSize = (b) => {
  if (b == null || !isFinite(b)) return "—";
  if (b < 1024) return b + " o";
  const u = ["Ko", "Mo", "Go", "To"]; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b < 10 ? 1 : 0).replace(".", ",") + " " + u[i];
};
const fmtDur = (s) => {
  if (s == null || !isFinite(s) || s < 0) return "—";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")}` : m ? `${m} min ${String(r).padStart(2, "0")} s` : `${r} s`;
};
const kLabel = (w) => (w >= 7600 ? "8K" : w >= 5700 ? "5,7K" : w >= 3800 ? "4K" : w >= 2500 ? "2,5K" : "");

/* ---------- classification d'un format ---------- */
function kind(f) {
  const r = f.width / f.height;
  if (Math.abs(r - 2) < 0.06) return "360";
  if (Math.abs(r - 1) < 0.04 && f.width >= 1440) return "stereo";
  if (Math.abs(r - 1.5) < 0.04 && f.width >= 1440) return "eac";
  return "flat";
}
const KIND = {
  "360": ["b-360", "360° mono"],
  stereo: ["b-stereo", "360° stéréo (probable)"],
  eac: ["b-eac", "Cubemap EAC"],
  flat: ["b-flat", "À plat"],
};
function codec(f) {
  const c = (f.vcodec || "").toLowerCase();
  if (c.startsWith("avc")) return "H.264";
  if (c.startsWith("hev") || c.startsWith("hvc")) return "H.265";
  if (c.startsWith("vp9") || c.startsWith("vp09")) return "VP9";
  if (c.startsWith("av01")) return "AV1";
  return c.split(".")[0] || "?";
}
function questNote(f) {
  const c = codec(f);
  if (c === "H.265") return ["q-ok", "Lisible directement"];
  if (c === "H.264") return f.width <= 4096 ? ["q-ok", "Lisible directement"] : ["q-warn", "À réencoder (H.264 > 4K)"];
  return ["q-warn", "Réencodage conseillé"];
}
const needsReencode = (f) => questNote(f)[0] === "q-warn";
const is360 = (f) => kind(f) === "360" || kind(f) === "stereo";

/* ---------- état ---------- */
const state = {
  info: null, uaUsed: false, selected: null, suffixTouched: false,
  folder: store.get("folder", null), busy: false, downloading: false, tools: null,
};

/* ---------- outils ---------- */
async function refreshTools() {
  const t = (state.tools = await window.api.toolsStatus());
  const chip = $("#tools-chip");
  if (t.ytdlp?.version) {
    chip.textContent = `yt-dlp ${t.ytdlp.version} · ffmpeg ${t.ffmpeg ? "✓" : "✗"}`;
    chip.className = "chip " + (t.ffmpeg ? "ok" : "bad");
    chip.title = `yt-dlp : ${t.ytdlp.path}\nffmpeg : ${t.ffmpeg || "introuvable"}\nMoteur JavaScript : ${t.jsRuntime}\n\nCliquer pour mettre yt-dlp à jour.`;
  } else {
    chip.textContent = "yt-dlp manquant";
    chip.className = "chip bad";
  }
  $("#setup").hidden = !!t.ytdlp?.version;
  $("#btn-analyze").disabled = !t.ytdlp?.version;
}

$("#btn-install").onclick = async () => {
  const btn = $("#btn-install");
  btn.disabled = true; btn.textContent = "Téléchargement…";
  $("#install-bar").hidden = false;
  try {
    await window.api.installYtdlp();
    await refreshTools();
  } catch (e) {
    showError("Installation impossible : " + cleanErr(e));
  } finally {
    btn.disabled = false; btn.textContent = "Installer yt-dlp"; $("#install-bar").hidden = true;
  }
};
window.api.onInstallProgress(({ got, total }) => {
  $("#install-bar i").style.width = total ? ((got / total) * 100).toFixed(1) + "%" : "50%";
});

$("#tools-chip").onclick = async () => {
  if (!state.tools?.ytdlp) return;
  if (!confirm("Mettre yt-dlp à jour ?\n\nÀ faire si YouTube refuse les téléchargements : il change régulièrement son fonctionnement.")) return;
  const chip = $("#tools-chip");
  chip.textContent = "Mise à jour…";
  try { const msg = await window.api.updateYtdlp(); alert(msg || "yt-dlp est à jour."); }
  catch (e) { showError(cleanErr(e)); }
  await refreshTools();
};

/* ---------- erreurs ---------- */
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
function showError(msg) { const d = $("#error"); d.textContent = msg; d.hidden = false; }
function hideError() { $("#error").hidden = true; }

/* ---------- analyse ---------- */
$("#btn-paste").onclick = async () => {
  const t = (await window.api.readClipboard()).trim();
  if (t) { $("#url").value = t; $("#url").focus(); }
};

$("#form").onsubmit = async (e) => {
  e.preventDefault();
  if (state.busy || state.downloading) return;
  const url = $("#url").value.trim();
  if (!url) return;
  hideError();
  $("#result").hidden = true;
  $("#done").hidden = true;
  setBusy(true, "Analyse en cours…", "yt-dlp interroge YouTube.");
  const cookies = $("#opt-cookies").value || null;
  const ua = $("#opt-ua").value;
  try {
    let info = await window.api.analyze({ url, cookies, emptyUA: ua === "always" });
    let uaUsed = ua === "always";
    if (ua === "auto" && !info.formats.some(is360)) {
      setBusy(true, "Pas de 360° trouvée, deuxième essai…", "Avec l'astuce « user-agent vide ».");
      try {
        const alt = await window.api.analyze({ url, cookies, emptyUA: true });
        if (alt.formats.some(is360)) { info = alt; uaUsed = true; }
      } catch {}
    }
    state.info = info; state.uaUsed = uaUsed;
    render();
  } catch (err) {
    const msg = cleanErr(err);
    if (msg !== "Analyse annulée.") showError(msg);
  } finally {
    setBusy(false);
  }
};
$("#btn-cancel-analyze").onclick = () => window.api.cancel("analyze");

function setBusy(on, title, sub) {
  state.busy = on;
  $("#busy").hidden = !on;
  if (title) $("#busy-title").textContent = title;
  if (sub) $("#busy-sub").textContent = sub;
  $("#btn-analyze").disabled = on || !state.tools?.ytdlp?.version;
}

/* ---------- rendu du résultat ---------- */
function sortFormats(list) {
  return [...list].sort((a, b) => b.width * b.height - a.width * a.height || (b.fps || 0) - (a.fps || 0) || (b.tbr || 0) - (a.tbr || 0));
}

function render() {
  const i = state.info;
  $("#result").hidden = false;
  $("#thumb").src = i.thumbnail || "";
  $("#thumb").hidden = !i.thumbnail;
  $("#v-title").textContent = i.title;
  $("#v-sub").textContent = [i.uploader, i.duration ? fmtDur(i.duration) : null, i.uploadDate ? i.uploadDate.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1") : null].filter(Boolean).join(" · ");

  const lic = $("#v-license");
  lic.replaceChildren();
  if (i.license && /creative commons/i.test(i.license)) {
    lic.append(el("span", { class: "lic cc" }, "Licence Creative Commons : réutilisation autorisée en citant l'auteur"));
  } else {
    lic.append(el("span", { class: "lic std" }, "Licence YouTube standard : téléchargement soumis à l'accord de l'auteur"));
  }

  const f360 = sortFormats(i.formats.filter(is360));
  const eac = sortFormats(i.formats.filter((f) => kind(f) === "eac"));
  const flatBest = sortFormats(i.formats.filter((f) => kind(f) === "flat"))[0];
  const v = $("#verdict");
  v.replaceChildren();
  if (i.liveStatus === "is_live") {
    v.className = "verdict no";
    v.append(el("span", { class: "ico" }, "⏺"), el("div", {}, el("b", {}, "Vidéo en direct"), "Attendez la fin du direct pour la télécharger."));
  } else if (f360.length) {
    const best = f360[0];
    v.className = "verdict yes";
    v.append(el("span", { class: "ico" }, "✅"), el("div", {},
      el("b", {}, "Oui, la version 360° est téléchargeable"),
      `Meilleure qualité : ${best.width}×${best.height}${kLabel(best.width) ? " (" + kLabel(best.width) + ")" : ""} · ${codec(best)}${best.fps ? " · " + best.fps + " img/s" : ""}${kind(best) === "stereo" ? " · probablement stéréo haut/bas" : ""}.`,
      state.uaUsed ? el("div", { class: "muted" }, "Trouvée grâce à l'astuce « user-agent vide », qui sera aussi utilisée pour le téléchargement.") : null,
    ));
  } else if (eac.length) {
    v.className = "verdict maybe";
    v.append(el("span", { class: "ico" }, "🧊"), el("div", {},
      el("b", {}, "Seulement au format cubemap (EAC)"),
      "YouTube ne fournit ici que sa projection interne en cube. Les lecteurs du Quest attendent de l'équirectangulaire : ce fichier s'afficherait déformé sans conversion."));
  } else {
    v.className = "verdict no";
    v.append(el("span", { class: "ico" }, "⚠️"), el("div", {},
      el("b", {}, "Non : seule une version à plat est disponible"),
      flatBest ? `La meilleure image proposée est ${flatBest.width}×${flatBest.height} (16:9), sans la sphère complète. ` : "",
      "Vérifiez que c'est bien une vidéo 360° (icône de boussole sur YouTube). Sinon, essayez les cookies d'un navigateur connecté (Options).",
    ));
  }

  // présélection
  state.selected = (f360[0] || eac[0] || null)?.id ?? null;
  state.suffixTouched = false;
  $("#show-all").checked = !f360.length && !eac.length;
  renderFormats();
  $("#dl-card").hidden = !state.selected && !$("#show-all").checked;
  updateDlOptions();
}

function renderFormats() {
  const i = state.info;
  const showAll = $("#show-all").checked;
  const list = sortFormats(i.formats.filter((f) => showAll || ((is360(f) || kind(f) === "eac") && f.height >= 720)));
  const tb = $("#formats");
  tb.replaceChildren();
  if (!list.length) {
    tb.append(el("tr", {}, el("td", { colspan: 7, class: "muted" }, "Aucun format 360° — cochez la case ci-dessous pour tout afficher.")));
    return;
  }
  for (const f of list) {
    const [kc, kl] = KIND[kind(f)];
    const [qc, ql] = questNote(f);
    const tr = el("tr", { "data-id": f.id, class: f.id === state.selected ? "sel" : "", onclick: () => select(f.id) },
      el("td", {}, el("input", { type: "radio", name: "fmt", checked: f.id === state.selected, "aria-label": `${f.width}×${f.height}` })),
      el("td", {}, el("b", {}, `${f.width}×${f.height}`), kLabel(f.width) ? el("span", { class: "muted" }, " " + kLabel(f.width)) : null),
      el("td", {}, el("span", { class: "badge " + kc }, kl)),
      el("td", {}, codec(f), f.hdr ? el("span", { class: "muted" }, " " + f.hdr) : null),
      el("td", {}, f.fps ?? "—"),
      el("td", {}, f.size ? fmtSize(f.size) : "—"),
      el("td", { class: qc }, ql),
    );
    tb.append(tr);
  }
}
$("#show-all").onchange = () => { renderFormats(); $("#dl-card").hidden = !state.selected && !$("#show-all").checked; };

function select(id) {
  state.selected = id;
  renderFormats();
  $("#dl-card").hidden = false;
  updateDlOptions();
}

function selectedFormat() { return state.info?.formats.find((f) => f.id === state.selected) || null; }

function updateDlOptions() {
  const f = selectedFormat();
  $("#btn-download").disabled = !f || state.downloading;
  if (!f) return;
  if (!state.suffixTouched) $("#opt-suffix").value = kind(f) === "360" ? "_360" : kind(f) === "stereo" ? "_360_TB" : "";
  $("#opt-reencode").checked = needsReencode(f);
  $("#reencode-hint").textContent = needsReencode(f)
    ? `(conseillé : ${codec(f)} n'est pas lu par tous les lecteurs du casque)`
    : `(facultatif : ${codec(f)} est déjà lisible)`;
  $("#opt-maxw").value = f.width > 5760 ? "5760" : "";
  toggleReencodeFields();
}
const toggleReencodeFields = () => {
  const on = $("#opt-reencode").checked;
  $("#maxw-field").hidden = !on; $("#keep-field").hidden = !on;
};
$("#opt-reencode").onchange = toggleReencodeFields;
$("#opt-suffix").onchange = () => { state.suffixTouched = true; };

/* ---------- dossier ---------- */
async function initFolder() {
  if (!state.folder) state.folder = await window.api.defaultFolder();
  $("#folder").textContent = state.folder;
  $("#folder").title = state.folder;
}
$("#btn-folder").onclick = async () => {
  const p = await window.api.chooseFolder(state.folder);
  if (p) { state.folder = p; store.set("folder", p); initFolder(); }
};

/* ---------- téléchargement ---------- */
let t0 = 0;
$("#btn-download").onclick = async () => {
  const f = selectedFormat();
  if (!f || state.downloading) return;
  hideError();
  $("#done").hidden = true;
  state.downloading = true;
  window.onbeforeunload = () => "";
  $("#btn-download").hidden = true; $("#btn-cancel-dl").hidden = false;
  $("#btn-analyze").disabled = true;
  $("#progress").hidden = false;
  setProgress("Préparation…", 0, "");
  t0 = performance.now();
  try {
    const r = await window.api.download({
      url: state.info.url, formatId: f.id, emptyUA: state.uaUsed,
      cookies: $("#opt-cookies").value || null, outDir: state.folder,
      suffix: $("#opt-suffix").value, reencode: $("#opt-reencode").checked,
      maxWidth: Number($("#opt-maxw").value) || null, keepOriginal: $("#opt-keep").checked,
      duration: state.info.duration,
    });
    if (r.cancelled) {
      showError("Téléchargement annulé. En relançant le même téléchargement, il reprendra là où il s'est arrêté.");
    } else {
      const d = $("#done");
      d.replaceChildren(
        el("div", {}, el("b", {}, "Terminé. "), r.file.split(/[\\/]/).pop(),
          r.encoder ? el("div", { class: "muted" }, `Réencodé avec ${r.encoder}.`) : null),
        el("div", { class: "done-actions" },
          el("button", { class: "primary", onclick: async () => window.player360.open(await window.api.fileUrl(r.file)) }, "Lire en 360°"),
          el("button", { onclick: () => window.api.showItem(r.file) }, "Afficher le fichier")),
      );
      d.hidden = false;
    }
  } catch (e) {
    showError(cleanErr(e));
  } finally {
    state.downloading = false;
    window.onbeforeunload = null;
    $("#btn-download").hidden = false; $("#btn-cancel-dl").hidden = true;
    $("#progress").hidden = true;
    $("#btn-analyze").disabled = !state.tools?.ytdlp?.version;
    updateDlOptions();
  }
};
$("#btn-cancel-dl").onclick = () => window.api.cancel("download");

let encStart = 0;
window.api.onProgress((p) => {
  if (p.phase === "encode") {
    if (!p.done) encStart = performance.now();
    const pct = p.total ? (p.done / p.total) * 100 : 0;
    const el_ = (performance.now() - encStart) / 1000;
    const eta = pct > 1 ? (el_ * (100 - pct)) / pct : null;
    setProgress(`Réencodage pour le Quest : ${pct.toFixed(0)} %`, pct, eta ? `reste environ ${fmtDur(eta)}` : "peut être long pour une vidéo 8K");
    return;
  }
  const pct = p.total ? (p.done / p.total) * 100 : 0;
  const what = p.phase === "video" ? "Image" : "Son";
  setProgress(`${what} : ${pct.toFixed(0)} % · ${fmtSize(p.done)}${p.total ? " / " + fmtSize(p.total) : ""}`, pct,
    [p.speed ? fmtSize(p.speed) + "/s" : null, p.eta != null ? "reste " + fmtDur(p.eta) : null].filter(Boolean).join(" · "));
});
function setProgress(label, pct, meta) {
  $("#p-fill").style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + "%";
  $("#p-label").textContent = label;
  $("#p-meta").textContent = meta || "";
}

/* ---------- lecteur 360° ---------- */
$("#btn-player").onclick = async () => {
  const v = await window.api.openVideo();
  if (v) window.player360.open(v);
};
// glisser-déposer d'une vidéo de l'ordinateur sur la fenêtre
let dragDepth = 0;
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; $("#drop-hint").hidden = false; });
window.addEventListener("dragover", (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop-hint").hidden = true; } });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0; $("#drop-hint").hidden = true;
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("video/") || /\.(mp4|m4v|mov|mkv|webm)$/i.test(x.name));
  if (f) window.player360.open({ file: f });
});

/* ---------- démarrage ---------- */
for (const id of ["opt-cookies", "opt-ua"]) {
  const s = $("#" + id);
  s.value = store.get(id, s.value);
  s.onchange = () => store.set(id, s.value);
}
initFolder();
refreshTools();
$("#url").focus();
