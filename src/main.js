// Vérif 360 — vérifie si une vidéo YouTube existe en version 360° téléchargeable,
// puis la télécharge (et la réencode pour le Meta Quest si besoin).
// Moteur : yt-dlp (binaire officiel) + ffmpeg (ffmpeg-static).
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

let win = null;
const running = new Map(); // jobId -> ChildProcess

/* ---------- localisation des outils ---------- */
const EXE = process.platform === "win32" ? ".exe" : "";
const binDir = () => path.join(app.getPath("userData"), "bin");
const managedYtdlp = () => path.join(binDir(), "yt-dlp" + EXE);

const EXTRA_PATHS = process.platform === "win32"
  ? []
  : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(os.homedir(), ".local/bin")];

function childEnv() {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: [process.env.PATH || "", ...EXTRA_PATHS].join(sep),
    // permet à yt-dlp d'utiliser Electron comme moteur JavaScript (node)
    ELECTRON_RUN_AS_NODE: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

function which(name) {
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = [...(process.env.PATH || "").split(sep), ...EXTRA_PATHS];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name + EXE);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

function ytdlpPath() {
  if (fs.existsSync(managedYtdlp())) return { path: managedYtdlp(), managed: true };
  const sys = which("yt-dlp");
  return sys ? { path: sys, managed: false } : null;
}

function ffmpegPath() {
  // ffmpeg du système d'abord (Homebrew : encodeur matériel VideoToolbox), sinon celui fourni
  const sys = which("ffmpeg");
  if (sys) return sys;
  try {
    let p = require("ffmpeg-static");
    if (p) {
      p = p.replace("app.asar", "app.asar.unpacked");
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

function run(file, args, { onLine, onErrLine, jobId } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env: childEnv(), windowsHide: true });
    if (jobId) running.set(jobId, child);
    let out = "", err = "", bufO = "", bufE = "";
    const split = (chunk, which) => {
      let buf = (which === "o" ? bufO : bufE) + chunk.toString("utf8");
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop();
      if (which === "o") bufO = buf; else bufE = buf;
      for (const l of lines) (which === "o" ? onLine : onErrLine)?.(l);
    };
    child.stdout.on("data", (c) => { out += c; split(c, "o"); });
    child.stderr.on("data", (c) => { err += c; if (err.length > 200000) err = err.slice(-100000); split(c, "e"); });
    child.on("error", (e) => { err += "\n" + e.message; });
    child.on("close", (code, signal) => {
      if (jobId) running.delete(jobId);
      resolve({ code, signal, out, err });
    });
  });
}

/* ---------- arguments communs yt-dlp ---------- */
function baseArgs(opts = {}) {
  const a = ["--no-playlist", "--no-warnings", "--encoding", "utf-8"];
  const ff = ffmpegPath();
  if (ff) a.push("--ffmpeg-location", ff);
  // moteur JavaScript pour les défis YouTube : Deno s'il est installé, sinon Electron (node)
  if (!which("deno")) a.push("--no-js-runtimes", "--js-runtimes", "node:" + process.execPath);
  if (opts.cookies) a.push("--cookies-from-browser", opts.cookies);
  if (opts.emptyUA) a.push("--user-agent", "");
  return a;
}

function friendlyError(err) {
  const e = String(err || "");
  if (/not a bot|Sign in to confirm/i.test(e))
    return "YouTube demande de prouver qu'on n'est pas un robot. Choisissez votre navigateur dans « Cookies du navigateur » (onglet Options), en étant connecté à YouTube dans ce navigateur, puis relancez.";
  if (/Private video/i.test(e)) return "Cette vidéo est privée.";
  if (/age|inappropriate/i.test(e) && /confirm/i.test(e)) return "Vidéo soumise à une limite d'âge : utilisez les cookies d'un navigateur connecté à YouTube.";
  if (/Unsupported URL|is not a valid URL/i.test(e)) return "Adresse non reconnue. Collez l'adresse complète d'une vidéo YouTube.";
  if (/Video unavailable/i.test(e)) return "Vidéo indisponible (supprimée, bloquée dans votre pays ou réservée aux membres).";
  if (/could not find .*cookies|cookie/i.test(e) && /error/i.test(e)) return "Impossible de lire les cookies de ce navigateur. Fermez-le complètement puis réessayez, ou choisissez-en un autre.";
  if (/HTTP Error 403/i.test(e)) return "YouTube a refusé le téléchargement (erreur 403). Mettez yt-dlp à jour, puis réessayez.";
  const m = e.match(/ERROR:\s*(.+)/);
  return m ? m[1].trim() : e.trim().split("\n").slice(-3).join("\n") || "Erreur inconnue.";
}

/* ---------- IPC : outils ---------- */
ipcMain.handle("tools:status", async () => {
  const y = ytdlpPath();
  let version = null;
  if (y) {
    const r = await run(y.path, ["--version"]);
    version = r.code === 0 ? r.out.trim() : null;
  }
  return {
    ytdlp: y ? { ...y, version } : null,
    ffmpeg: ffmpegPath(),
    jsRuntime: which("deno") ? "Deno" : "Electron (node)",
    platform: process.platform,
  };
});

ipcMain.handle("tools:installYtdlp", async (e) => {
  const asset = {
    darwin: "yt-dlp_macos",
    win32: "yt-dlp.exe",
    linux: process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux",
  }[process.platform];
  if (!asset) throw new Error("Système non pris en charge.");
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  await fsp.mkdir(binDir(), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const tmp = managedYtdlp() + ".part";
  const file = fs.createWriteStream(tmp);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!file.write(chunk)) await new Promise((r) => file.once("drain", r));
    e.sender.send("tools:installProgress", { got, total });
  }
  await new Promise((r, j) => file.end((err) => (err ? j(err) : r())));
  await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, managedYtdlp());
  return true;
});

ipcMain.handle("tools:updateYtdlp", async () => {
  const y = ytdlpPath();
  if (!y) throw new Error("yt-dlp n'est pas installé.");
  if (!y.managed) throw new Error("Ce yt-dlp a été installé hors de l'application (Homebrew, pip…). Mettez-le à jour avec cet outil, par exemple : brew upgrade yt-dlp");
  const r = await run(y.path, ["-U"]);
  if (r.code !== 0) throw new Error(friendlyError(r.err || r.out));
  return (r.out + r.err).trim().split("\n").pop();
});

/* ---------- IPC : analyse ---------- */
ipcMain.handle("video:analyze", async (_e, { url, cookies, emptyUA }) => {
  const y = ytdlpPath();
  if (!y) throw new Error("yt-dlp n'est pas installé.");
  const r = await run(y.path, [...baseArgs({ cookies, emptyUA }), "-J", url], { jobId: "analyze" });
  if (r.signal) throw new Error("Analyse annulée.");
  if (r.code !== 0) throw new Error(friendlyError(r.err));
  let info;
  try { info = JSON.parse(r.out); } catch { throw new Error("Réponse illisible de yt-dlp."); }
  const formats = (info.formats || [])
    .filter((f) => f.vcodec && f.vcodec !== "none" && f.width && f.height)
    .map((f) => ({
      id: f.format_id, ext: f.ext, vcodec: f.vcodec, acodec: f.acodec,
      width: f.width, height: f.height, fps: f.fps || null,
      size: f.filesize || f.filesize_approx || null, tbr: f.tbr || null,
      note: f.format_note || "", protocol: f.protocol || "", hdr: f.dynamic_range && f.dynamic_range !== "SDR" ? f.dynamic_range : "",
    }));
  return {
    id: info.id, title: info.title, uploader: info.uploader || info.channel || "",
    duration: info.duration || null, thumbnail: info.thumbnail || null,
    license: info.license || null, url: info.webpage_url || url,
    uploadDate: info.upload_date || null, liveStatus: info.live_status || null,
    formats,
  };
});

ipcMain.handle("video:cancel", (_e, jobId) => {
  const c = running.get(jobId);
  if (c) { c.kill(process.platform === "win32" ? undefined : "SIGTERM"); return true; }
  return false;
});

/* ---------- IPC : téléchargement ---------- */
ipcMain.handle("video:download", async (e, o) => {
  const y = ytdlpPath();
  if (!y) throw new Error("yt-dlp n'est pas installé.");
  if (!ffmpegPath()) throw new Error("ffmpeg est introuvable : l'image et le son ne peuvent pas être assemblés.");
  await fsp.mkdir(o.outDir, { recursive: true });
  const send = (data) => !e.sender.isDestroyed() && e.sender.send("video:progress", data);

  const tpl = path.join(o.outDir, `%(title).120B [%(id)s]${o.suffix || ""}.%(ext)s`);
  const args = [
    ...baseArgs(o),
    "-f", `${o.formatId}+bestaudio[ext=m4a]/${o.formatId}+bestaudio/${o.formatId}`,
    "--merge-output-format", "mp4",
    "-c", "-R", "20", "--fragment-retries", "20", "--no-mtime",
    "--newline", "--progress",
    "--progress-template", "download:@@P %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s %(info.format_id)s",
    "--print", "after_move:@@F %(filepath)s", "--no-simulate",
    "-o", tpl, o.url,
  ];
  let finalPath = null;
  let lastErr = "";
  const r = await run(y.path, args, {
    jobId: "download",
    onLine: (l) => {
      if (l.startsWith("@@P ")) {
        const [, dl, tot, est, speed, eta, fid] = l.split(" ");
        const n = (v) => (v === "NA" || v === "None" ? null : Number(v));
        send({ phase: fid && fid.startsWith(o.formatId) ? "video" : "audio", done: n(dl), total: n(tot) || n(est), speed: n(speed), eta: n(eta) });
      } else if (l.startsWith("@@F ")) {
        finalPath = l.slice(4).trim();
      }
    },
    onErrLine: (l) => { if (/ERROR/.test(l)) lastErr = l; },
  });
  if (r.signal || (r.code !== 0 && /Interrupted|killed/i.test(r.err))) return { cancelled: true };
  if (r.code !== 0 || !finalPath) throw new Error(friendlyError(lastErr || r.err));

  if (!o.reencode) return { file: finalPath };

  // réencodage H.265 (HEVC) pour une lecture sûre sur Meta Quest
  send({ phase: "encode", done: 0, total: 1 });
  const out = finalPath.replace(/\.[^.]+$/, "") + "_quest.mp4";
  const result = await encode(finalPath, out, o, send);
  if (result.cancelled) return { cancelled: true, file: finalPath };
  if (o.keepOriginal === false) await fsp.unlink(finalPath).catch(() => {});
  return { file: out, original: o.keepOriginal === false ? null : finalPath, encoder: result.encoder };
});

async function encode(input, output, o, send) {
  const ff = ffmpegPath();
  const scale = o.maxWidth ? ["-vf", `scale='min(${o.maxWidth},iw)':-2:flags=lanczos`] : [];
  const common = ["-hide_banner", "-y", "-i", input, "-map", "0:v:0", "-map", "0:a?", ...scale];
  const tail = ["-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-strict", "unofficial", "-progress", "pipe:1", "-nostats", output];
  const durationUs = (o.duration || 0) * 1e6;
  const onLine = (l) => {
    const m = l.match(/^out_time_us=(\d+)/);
    if (m && durationUs) send({ phase: "encode", done: Number(m[1]), total: durationUs });
  };
  const tries = [];
  if (process.platform === "darwin") tries.push({ name: "VideoToolbox (matériel)", v: ["-c:v", "hevc_videotoolbox", "-q:v", "62", "-allow_sw", "1"] });
  tries.push({ name: "x265 (logiciel)", v: ["-c:v", "libx265", "-crf", "20", "-preset", "medium"] });
  let last = null;
  for (const t of tries) {
    const r = await run(ff, [...common, ...t.v, ...tail], { jobId: "download", onLine });
    if (r.signal) { await fsp.unlink(output).catch(() => {}); return { cancelled: true }; }
    if (r.code === 0) return { encoder: t.name };
    last = r.err.split("\n").filter(Boolean).slice(-4).join("\n");
  }
  await fsp.unlink(output).catch(() => {});
  throw new Error("Réencodage impossible : " + last);
}

/* ---------- IPC : divers ---------- */
ipcMain.handle("dialog:chooseFolder", async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: current, properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("dialog:openVideo", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Ouvrir une vidéo 360°",
    properties: ["openFile"],
    filters: [{ name: "Vidéos", extensions: ["mp4", "m4v", "mov", "mkv", "webm"] }, { name: "Tous les fichiers", extensions: ["*"] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return { url: pathToFileURL(r.filePaths[0]).href, name: path.basename(r.filePaths[0]) };
});
ipcMain.handle("video:fileUrl", (_e, p) => ({ url: pathToFileURL(p).href, name: path.basename(p) }));
ipcMain.handle("app:defaultFolder", () => path.join(app.getPath("videos"), "Vidéos 360"));
ipcMain.handle("shell:showItem", (_e, p) => shell.showItemInFolder(p));
ipcMain.handle("shell:openExternal", (_e, u) => { if (/^https:\/\//.test(u)) shell.openExternal(u); });
ipcMain.handle("clipboard:read", () => clipboard.readText());

/* ---------- fenêtre ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 820, minWidth: 680, minHeight: 560,
    title: "Vérif 360", backgroundColor: "#f4f2ee", autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (ev) => ev.preventDefault());
  win.webContents.on("will-prevent-unload", (ev) => {
    const c = dialog.showMessageBoxSync(win, {
      type: "warning", title: "Téléchargement en cours", message: "Un téléchargement est en cours.",
      detail: "Il pourra reprendre là où il s'est arrêté si vous relancez le même téléchargement.",
      buttons: ["Continuer", "Quitter quand même"], defaultId: 0, cancelId: 0,
    });
    if (c === 1) ev.preventDefault();
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  for (const c of running.values()) c.kill();
  app.quit();
});
