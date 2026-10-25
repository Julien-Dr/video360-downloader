"use strict";
/* Lecteur vidéo 360° : rendu WebGL d'une vidéo équirectangulaire sur la sphère.
   Projections : 360 mono, 360 stéréo haut/bas, 360 stéréo côte à côte,
   180 stéréo côte à côte, 180 mono, à plat. Pour la stéréo, seul l'œil gauche est affiché. */
(function () {
  const P = (s) => document.querySelector(s);
  const MODES = { mono360: 0, tb360: 1, lr360: 2, lr180: 3, mono180: 4, flat: 5 };
  const DEFAULT_FOV = 80;

  const ui = {
    root: P("#player"), canvas: P("#pl-canvas"), video: P("#pl-video"),
    title: P("#pl-title"), proj: P("#pl-proj"), close: P("#pl-close"),
    play: P("#pl-play"), seek: P("#pl-seek"), time: P("#pl-time"),
    mute: P("#pl-mute"), vol: P("#pl-vol"), reset: P("#pl-reset"), fs: P("#pl-fs"),
    err: P("#pl-error"), hint: P("#pl-hint"), spin: P("#pl-loading"),
  };
  const view = { yaw: 0, pitch: 0, fov: DEFAULT_FOV, keys: new Set() };
  let gl, prog, tex, loc = {}, raf = 0, needUpload = false, lastTime = -1, objectUrl = null, idleTimer = 0;

  /* ---------- WebGL ---------- */
  const VS = `attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS = `
precision highp float;
varying vec2 v;
uniform sampler2D tex;
uniform float yaw, pitch, tanHalf, aspect, videoAspect;
uniform int mode;
const float PI = 3.14159265359;
void main() {
  if (mode == 5) {
    vec2 uv = v * 0.5 + 0.5;
    float s = aspect / videoAspect;
    if (s > 1.0) uv.x = (uv.x - 0.5) * s + 0.5; else uv.y = (uv.y - 0.5) / s + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    gl_FragColor = texture2D(tex, vec2(uv.x, 1.0 - uv.y));
    return;
  }
  vec3 d = normalize(vec3(v.x * tanHalf * aspect, v.y * tanHalf, -1.0));
  float cp = cos(pitch), sp = sin(pitch);
  d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  float cy = cos(yaw), sy = sin(yaw);
  d = vec3(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy);
  float lon = atan(d.x, -d.z);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float u, w = 0.5 - lat / PI;
  if (mode == 3 || mode == 4) {
    if (abs(lon) > PI * 0.5) { gl_FragColor = vec4(0.04, 0.04, 0.04, 1.0); return; }
    u = lon / PI + 0.5;
  } else {
    u = lon / (2.0 * PI) + 0.5;
  }
  if (mode == 1) w *= 0.5;
  if (mode == 2 || mode == 3) u *= 0.5;
  gl_FragColor = texture2D(tex, vec2(u, w));
}`;

  function initGL() {
    gl = ui.canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL indisponible sur cet ordinateur.");
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const ap = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
    for (const n of ["tex", "yaw", "pitch", "tanHalf", "aspect", "videoAspect", "mode"]) loc[n] = gl.getUniformLocation(prog, n);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(ui.canvas.clientWidth * dpr), h = Math.round(ui.canvas.clientHeight * dpr);
    if (ui.canvas.width !== w || ui.canvas.height !== h) { ui.canvas.width = w; ui.canvas.height = h; }
    gl.viewport(0, 0, w, h);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    // déplacement clavier continu
    const step = (view.fov / DEFAULT_FOV) * 0.025;
    if (view.keys.has("ArrowLeft")) view.yaw -= step;
    if (view.keys.has("ArrowRight")) view.yaw += step;
    if (view.keys.has("ArrowUp")) view.pitch += step;
    if (view.keys.has("ArrowDown")) view.pitch -= step;
    clampView();

    const vid = ui.video;
    if (vid.readyState >= 2 && (needUpload || !vid.paused || vid.currentTime !== lastTime)) {
      try {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vid);
        needUpload = false; lastTime = vid.currentTime;
      } catch (e) {
        showError("Impossible d'afficher cette vidéo : " + e.message);
        cancelAnimationFrame(raf);
        return;
      }
    }
    resize();
    gl.uniform1i(loc.tex, 0);
    gl.uniform1f(loc.yaw, view.yaw);
    gl.uniform1f(loc.pitch, view.pitch);
    gl.uniform1f(loc.tanHalf, Math.tan((view.fov * Math.PI) / 360));
    gl.uniform1f(loc.aspect, ui.canvas.width / Math.max(1, ui.canvas.height));
    gl.uniform1f(loc.videoAspect, (vid.videoWidth || 16) / (vid.videoHeight || 9));
    gl.uniform1i(loc.mode, MODES[ui.proj.value] ?? 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    updateTime();
  }

  function clampView() {
    const lim = (89 * Math.PI) / 180;
    view.pitch = Math.max(-lim, Math.min(lim, view.pitch));
    if (ui.proj.value === "lr180" || ui.proj.value === "mono180") {
      const ylim = Math.PI / 2;
      view.yaw = Math.max(-ylim, Math.min(ylim, view.yaw));
    } else {
      view.yaw = ((view.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    }
    view.fov = Math.max(30, Math.min(120, view.fov));
  }

  /* ---------- projection automatique ---------- */
  function guessProjection(name, w, h) {
    const n = (name || "").toLowerCase();
    if (/_180_?(lr|sbs)|180.*(lr|sbs)|(lr|sbs).*180/.test(n)) return "lr180";
    if (/_180\b|_180[_.]/.test(n)) return "mono180";
    if (/_360_?(tb|ou)|_tb[_.]|_ou[_.]|top.?bottom/.test(n)) return "tb360";
    if (/_360_?(lr|sbs)|_lr[_.]|_sbs[_.]/.test(n)) return "lr360";
    if (!w || !h) return "mono360";
    const r = w / h;
    if (Math.abs(r - 2) < 0.06) return "mono360";
    if (Math.abs(r - 1) < 0.04) return "tb360";
    return "flat";
  }

  /* ---------- interface ---------- */
  const fmt = (s) => {
    if (!isFinite(s)) return "0:00";
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
  };
  let seeking = false;
  function updateTime() {
    const v = ui.video;
    if (!seeking && v.duration) ui.seek.value = String((v.currentTime / v.duration) * 1000);
    ui.time.textContent = `${fmt(v.currentTime)} / ${fmt(v.duration)}`;
  }
  function setPlayIcon() {
    ui.play.textContent = ui.video.paused ? "▶" : "❚❚";
    ui.play.setAttribute("aria-label", ui.video.paused ? "Lire" : "Pause");
  }
  function setMuteIcon() { ui.mute.textContent = ui.video.muted || ui.video.volume === 0 ? "🔇" : "🔊"; }
  function showError(msg) { ui.err.textContent = msg; ui.err.hidden = false; ui.spin.hidden = true; }
  function resetView() { view.yaw = 0; view.pitch = 0; view.fov = DEFAULT_FOV; }
  function poke() {
    ui.root.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!ui.video.paused) ui.root.classList.add("idle"); }, 2500);
  }

  function open({ url, name, file }) {
    if (!gl) {
      try { initGL(); } catch (e) {
        gl = null;
        ui.root.hidden = false;
        document.body.classList.add("playing-360");
        showError("Le lecteur 360° a besoin de WebGL, indisponible ici (" + e.message + ").");
        return;
      }
    }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    if (file) { objectUrl = URL.createObjectURL(file); url = objectUrl; name = file.name; }
    ui.err.hidden = true;
    ui.spin.hidden = false;
    ui.title.textContent = name || "Vidéo";
    ui.title.title = name || "";
    ui.root.hidden = false;
    document.body.classList.add("playing-360");
    resetView();
    ui.proj.value = guessProjection(name);
    ui.video.src = url;
    ui.video.load();
    ui.hint.hidden = false;
    setTimeout(() => (ui.hint.hidden = true), 4000);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
    poke();
    ui.canvas.focus();
  }

  function close() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    ui.video.pause();
    ui.video.removeAttribute("src");
    ui.video.load();
    cancelAnimationFrame(raf);
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    ui.root.hidden = true;
    document.body.classList.remove("playing-360");
  }

  // vidéo
  ui.video.addEventListener("loadedmetadata", () => {
    // le suffixe du nom (_360, _360_TB, _180_LR…) prime ; sinon on déduit des dimensions
    const name = ui.title.title;
    ui.proj.value = /_(360|180)/i.test(name)
      ? guessProjection(name)
      : guessProjection("", ui.video.videoWidth, ui.video.videoHeight);
    needUpload = true;
  });
  ui.video.addEventListener("loadeddata", () => { ui.spin.hidden = true; needUpload = true; ui.video.play().catch(() => {}); });
  ui.video.addEventListener("waiting", () => (ui.spin.hidden = false));
  ui.video.addEventListener("playing", () => (ui.spin.hidden = true));
  ui.video.addEventListener("seeked", () => (needUpload = true));
  ui.video.addEventListener("play", () => { setPlayIcon(); poke(); });
  ui.video.addEventListener("pause", () => { setPlayIcon(); poke(); });
  ui.video.addEventListener("volumechange", setMuteIcon);
  ui.video.addEventListener("error", () => {
    const c = ui.video.error?.code;
    showError(c === 4
      ? "Ce fichier ne peut pas être lu ici : codec ou format non pris en charge. Une version réencodée (_quest.mp4) se lit en général sans problème."
      : "Erreur de lecture de la vidéo.");
  });

  // contrôles
  ui.play.onclick = () => (ui.video.paused ? ui.video.play() : ui.video.pause());
  ui.seek.addEventListener("input", () => {
    seeking = true;
    if (ui.video.duration) ui.time.textContent = `${fmt((ui.seek.value / 1000) * ui.video.duration)} / ${fmt(ui.video.duration)}`;
  });
  ui.seek.addEventListener("change", () => {
    if (ui.video.duration) ui.video.currentTime = (ui.seek.value / 1000) * ui.video.duration;
    seeking = false;
  });
  ui.mute.onclick = () => { ui.video.muted = !ui.video.muted; };
  ui.vol.addEventListener("input", () => { ui.video.volume = Number(ui.vol.value); ui.video.muted = ui.video.volume === 0; });
  ui.reset.onclick = resetView;
  ui.fs.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : ui.root.requestFullscreen()).catch(() => {});
  ui.close.onclick = close;
  ui.proj.addEventListener("change", () => { resetView(); ui.canvas.focus(); });

  // regard à la souris (glisser) et zoom (molette)
  let drag = null;
  ui.canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: false };
    ui.canvas.setPointerCapture(e.pointerId);
    ui.canvas.classList.add("grabbing");
  });
  ui.canvas.addEventListener("pointermove", (e) => {
    poke();
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    const radPerPx = ((view.fov * Math.PI) / 180) / Math.max(1, ui.canvas.clientHeight);
    view.yaw -= dx * radPerPx;
    view.pitch += dy * radPerPx;
    drag.x = e.clientX; drag.y = e.clientY;
  });
  const endDrag = (e) => {
    if (drag && !drag.moved && e.type === "pointerup") ui.video.paused ? ui.video.play() : ui.video.pause();
    drag = null;
    ui.canvas.classList.remove("grabbing");
  };
  ui.canvas.addEventListener("pointerup", endDrag);
  ui.canvas.addEventListener("pointercancel", endDrag);
  ui.canvas.addEventListener("wheel", (e) => { e.preventDefault(); view.fov += e.deltaY * 0.05; clampView(); }, { passive: false });
  ui.canvas.addEventListener("dblclick", () => ui.fs.click());

  // clavier
  document.addEventListener("keydown", (e) => {
    if (ui.root.hidden || e.target.tagName === "SELECT" || e.target.tagName === "INPUT" && e.target.type !== "range") return;
    poke();
    if (e.key.startsWith("Arrow")) { view.keys.add(e.key); e.preventDefault(); }
    else if (e.key === " ") { e.preventDefault(); ui.play.click(); }
    else if (e.key === "f" || e.key === "F") ui.fs.click();
    else if (e.key === "r" || e.key === "R") resetView();
    else if (e.key === "m" || e.key === "M") ui.mute.click();
    else if (e.key === "+" || e.key === "=") view.fov -= 5;
    else if (e.key === "-") view.fov += 5;
    else if (e.key === "Escape" && !document.fullscreenElement) close();
  });
  document.addEventListener("keyup", (e) => view.keys.delete(e.key));
  window.addEventListener("blur", () => view.keys.clear());

  setPlayIcon(); setMuteIcon();
  window.player360 = { open, close };
})();
