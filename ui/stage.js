/*
 * MilkDrop Visualizer stage — the plugin's single window.
 *
 * Renders Butterchurn (WebGL2 MilkDrop) at full window resolution and reacts
 * to the audio of the file playing in IINA. Audio reality: a plugin webview
 * has no tap on IINA's output, so the default source decodes the same file in
 * a muted <audio> element kept in sync with IINA (real FFT of the actual
 * song); mic/loopback and an ambient beat are the fallbacks. The current
 * source's live level is shown in the top-right meter.
 */
(function () {
  "use strict";

  // ------------------------------------------------------------ preset data
  var PACKS = [];
  var fastPresets = {};
  if (window.butterchurnPresets) PACKS.push(butterchurnPresets.getPresets());
  if (window.butterchurnPresetsExtra) PACKS.push(butterchurnPresetsExtra.getPresets());
  if (window.butterchurnPresetsExtra2) PACKS.push(butterchurnPresetsExtra2.getPresets());
  if (window.butterchurnPresetsMD1) PACKS.push(butterchurnPresetsMD1.getPresets());
  PACKS.forEach(function (p) { for (var n in p) fastPresets[n] = p[n]; });

  var INDEX = window.MILKDROP_INDEX || [];
  var META = window.MILKDROP_META || { total: INDEX.length, fastPackTotal: 395, archiveTotal: 0 };
  var byName = {};
  INDEX.forEach(function (p) { byName[p.name] = p; });
  // MilkDrop Originals — the 552 presets released with MilkDrop, named
  // "Creator - Title" as in the source folder — merge in as their own
  // collection. Rows are [name, chunkKey|null, aliasOf|null] from
  // originals-index.js. A null chunk means the name already exists in the
  // main catalog: the entry still lists under Originals, but resolution
  // keeps using the catalog's verified conversion (byName is not
  // overwritten). aliasOf covers case-only filename differences: the row
  // keeps the folder name while resolution looks the preset object up
  // under the catalog's exact name.
  (window.__MILKDROP_ORIGINALS_INDEX__ || []).forEach(function (r) {
    var e = { name: r[0], packs: ["originals"], chunk: r[1], orig: true, aliasOf: r[2] || null };
    INDEX.push(e);
    if (!byName[e.name]) byName[e.name] = e;
  });
  // Ryan Geiss's own favorite presets (favorite_presets_2013_12.zip from
  // geisswerks.com) merge the same way: rows are [name, chunkKey|null,
  // aliasOf|null] from geiss-index.js; names already known resolve through
  // the existing catalog/Originals entry.
  (window.__MILKDROP_GEISS_INDEX__ || []).forEach(function (r) {
    var e = { name: r[0], packs: ["geiss"], chunk: r[1], geiss: true, aliasOf: r[2] || null };
    INDEX.push(e);
    if (!byName[e.name]) byName[e.name] = e;
  });
  function splitName(full) {
    var i = full.indexOf(" - ");
    if (i <= 0) return { author: "", title: full };
    return { author: full.slice(0, i).trim(), title: full.slice(i + 3).trim() };
  }
  // Display cleanup for picker rows: a few catalog names carry a leading
  // "_" or "-" sorting prefix on the author (e.g. "_Geiss") — strip it.
  function cleanAuthor(a) {
    return (a || "").replace(/^[\s_\-]+/, "").trim();
  }
  // Author grouping: the same author appears under several casings and
  // sort prefixes across the catalog ("Flexi" / "flexi", "_Geiss"), and a
  // plain name sort scatters them into many separate header groups. The
  // group KEY is the cleaned author, lowercased with whitespace collapsed;
  // the DISPLAY casing is the most frequent cleaned casing for that key
  // across the whole catalog, so each author gets exactly one group,
  // spelled one way, in every list.
  function authorKey(name) {
    return cleanAuthor(splitName(name).author).toLowerCase().replace(/\s+/g, " ");
  }
  var authorDisplay = {};
  (function () {
    var counts = {};
    INDEX.forEach(function (p) {
      var disp = cleanAuthor(splitName(p.name).author);
      if (!disp) return;
      var k = disp.toLowerCase().replace(/\s+/g, " ");
      counts[k] = counts[k] || {};
      counts[k][disp] = (counts[k][disp] || 0) + 1;
    });
    Object.keys(counts).forEach(function (k) {
      var best = "", bn = -1;
      Object.keys(counts[k]).forEach(function (d) { if (counts[k][d] > bn) { bn = counts[k][d]; best = d; } });
      authorDisplay[k] = best;
    });
  })();
  // "All" holds each UNIQUE preset once. Originals and Geiss' Favorites
  // overlap the catalog (and each other), so the merged INDEX repeats most
  // names; this view collapses exact duplicates and case-only variants
  // (the same preset under two casings, e.g. "Flexi - …" vs "flexi - …")
  // to the first occurrence — a catalog entry wins over a collection row,
  // an Originals row over a Geiss one. The collections themselves keep
  // their own full lists and names.
  var uniqueAllNames = (function () {
    var seen = {}, out = [];
    INDEX.forEach(function (p) {
      var k = p.name.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1; out.push(p.name);
    });
    return out;
  })();
  var chunkCache = {}, chunkWaiters = {};
  // Chunk keys: a NUMBER is a main-catalog archive chunk
  // (lib/archive/chunk-NN.js -> window.__MILKDROP_ARCHIVE__); a STRING is
  // a lazy collection chunk — "o…" = MilkDrop Originals
  // (lib/originals/<key>.js -> window.__MILKDROP_ORIGINALS__), "g…" =
  // Geiss' Favorites (lib/geiss/<key>.js -> window.__MILKDROP_GEISS__).
  function loadChunk(key, cb) {
    if (chunkCache[key]) { cb(null); return; }
    if (chunkWaiters[key]) { chunkWaiters[key].push(cb); return; }
    chunkWaiters[key] = [cb];
    var sc = document.createElement("script");
    sc.src = typeof key === "string"
      ? (key.charAt(0) === "g" ? "lib/geiss/" + key + ".js" : "lib/originals/" + key + ".js")
      : "lib/archive/chunk-" + (key < 10 ? "0" : "") + key + ".js";
    sc.onload = function () {
      chunkCache[key] = true;
      var w = chunkWaiters[key] || []; delete chunkWaiters[key];
      w.forEach(function (f) { f(null); });
    };
    sc.onerror = function () {
      var w = chunkWaiters[key] || []; delete chunkWaiters[key];
      w.forEach(function (f) { f(new Error("chunk " + key + " failed")); });
    };
    document.head.appendChild(sc);
  }
  var resolvedCache = {};
  function resolvePreset(name, cb) {
    var entry = byName[name];
    var key = entry && entry.aliasOf ? entry.aliasOf : name;
    if (fastPresets[key]) { cb(null, fastPresets[key]); return; }
    if (resolvedCache[name]) { cb(null, resolvedCache[name]); return; }
    if (!entry || entry.chunk === null || entry.chunk === undefined) { cb(new Error("not found")); return; }
    loadChunk(entry.chunk, function (err) {
      if (err) { cb(err); return; }
      var registry = typeof entry.chunk === "string"
        ? (entry.chunk.charAt(0) === "g" ? window.__MILKDROP_GEISS__ : window.__MILKDROP_ORIGINALS__)
        : window.__MILKDROP_ARCHIVE__;
      var pack = (registry || {})[entry.chunk] || {};
      var obj = pack[key];
      if (!obj) { cb(new Error("missing in chunk")); return; }
      resolvedCache[name] = obj;
      cb(null, obj);
    });
  }

  // ------------------------------------------------------------ collections
  function names(pred) { return INDEX.filter(pred).map(function (p) { return p.name; }); }
  function inPack(id) { return function (p) { return (p.packs || []).indexOf(id) >= 0; }; }
  var COLLECTIONS = [
    { id: "all", label: "All", picker: true, list: function () { return uniqueAllNames.slice(); } },
    { id: "originals", label: "MilkDrop Originals", picker: true, list: function () { return names(inPack("originals")); } },
    { id: "geiss", label: "Geiss' Favorites", picker: true, list: function () { return names(inPack("geiss")); } },
    { id: "favorites", label: "Favorites", picker: true, list: function () { return settings ? settings.favorites.slice() : []; } },
    { id: "recent", label: "Recent", list: function () { return recentList.slice(); } },
    { id: "main", label: "Main Pack", list: function () { return names(inPack("main")); } },
    { id: "extra", label: "Extra", list: function () { return names(inPack("extra")); } },
    { id: "extra2", label: "Extra 2", list: function () { return names(inPack("extra2")); } },
    { id: "md1", label: "MD1 Classics", list: function () { return names(inPack("md1")); } },
    { id: "archive", label: "Archive (slow load)", list: function () { return names(function (p) { return typeof p.chunk === "number"; }); } },
  ];
  function collectionById(id) { for (var i = 0; i < COLLECTIONS.length; i++) if (COLLECTIONS[i].id === id) return COLLECTIONS[i]; return COLLECTIONS[0]; }
  function poolFor(s) {
    // Unknown or retired collection ids (e.g. a stored "minimal" from
    // before Essentials was removed) fall back to "all" via
    // collectionById's COLLECTIONS[0] fallback.
    var list = collectionById(s.collection || "all").list();
    if (!list.length) list = collectionById("all").list();
    // Stepping pools are name lists: a preset that appears in several
    // collections (catalog + Originals + Geiss rows of "all") must enter
    // the pool once, or Next can draw the same name twice in a row.
    var seen = new Set(), out = [];
    list.forEach(function (n) { if (!seen.has(n)) { seen.add(n); out.push(n); } });
    return out;
  }

  // ------------------------------------------------------------ dom
  function $(id) { return document.getElementById(id); }
  var canvas = $("viz"), tap = $("tap");
  var state = { hasMedia: false, playing: false, paused: true, position: 0, duration: 0, path: "", url: "", audioOnly: true, volume: 100 };
  var settings = { autoLaunch: true, audioSource: "ambient", cycle: true, cycleSeconds: 30, random: true, blendSeconds: 2.7, preset: "", collection: "all", favorites: [], recent: [] };
  var initReceived = false, bootstrapped = false;
  var recentList = [];
  var currentPreset = "";

  function vizLog(text) {
    try { if (window.iina) iina.postMessage("viz-log", { text: text }); } catch (e) {}
    try { console.log("[MilkDrop] " + text); } catch (e) {}
  }
  window.addEventListener("error", function (ev) { vizLog("window error: " + (ev.message || ev.type)); });
  var toastTimer = 0;
  // Bridge telemetry + local autonomy state. The stage must work even if the
  // IINA message bridge never answers: presets, cycling and favorites are
  // driven LOCALLY first, and the plugin is only notified.
  var msgOut = 0, msgIn = 0, lastRecvName = "", lastRecvAt = 0;
  var lastLoadAt = 0, loadsCount = 0, lastLoadError = "", failStreak = 0;
  var pluginVersionSeen = "";
  function lsGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { window.localStorage.setItem(key, val); return true; } catch (e) { return false; } }
  var storageOk = (function () { try { window.localStorage.setItem("__md_probe", "1"); window.localStorage.removeItem("__md_probe"); return true; } catch (e) { return false; } })();
  var lastRms = 0;
  var storedFavs = [];
  try { storedFavs = JSON.parse(lsGet("MilkDrop.favorites") || lsGet("milkdrop.favorites") || "[]"); if (!Array.isArray(storedFavs)) storedFavs = []; } catch (e) { storedFavs = []; }
  function toast(text) {
    var el = $("toast");
    el.textContent = text; el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 3400);
  }

  // ------------------------------------------------------------ audio engine
  function unwrap(mod) {
    if (!mod) return null;
    if (mod.createVisualizer || mod.getPresets || mod.getImages) return mod;
    if (mod.default) return unwrap(mod.default);
    return mod;
  }
  var BC = unwrap(window.butterchurn);
  var actx = null, analyser = null, tapGain = null, mediaSrc = null, streamSrc = null, micStream = null;
  var noiseNodes = null, visualizer = null;
  var activeSource = "", fileDecodeFailed = false, lastSyncAt = 0, silenceSeconds = 0, warnedSilence = false;
  var userGesturedAt = 0;
  document.addEventListener("pointerdown", function () {
    userGesturedAt = Date.now();
    if (actx && actx.state === "suspended") actx.resume();
  }, true);

  var AC = window.AudioContext || window.webkitAudioContext;
  function ensureCtx() {
    if (!AC) return false;
    if (!actx) {
      try { actx = new AC(); } catch (e) { return false; }
      tapGain = actx.createGain(); tapGain.gain.value = 1;
      analyser = actx.createAnalyser(); analyser.fftSize = 2048;
      tapGain.connect(analyser);
    }
    if (actx.state === "suspended" && Date.now() - userGesturedAt < 4000) actx.resume();
    return true;
  }
  function stopNoise() {
    if (!noiseNodes) return;
    try { noiseNodes.src.stop(); } catch (e) {}
    try { noiseNodes.src.disconnect(); noiseNodes.gain.disconnect(); } catch (e) {}
    noiseNodes = null;
  }
  function startAmbient() {
    if (!ensureCtx()) return;
    stopNoise();
    var sr = actx.sampleRate, dur = 2.0, buf = actx.createBuffer(2, sr * dur, sr);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch), beatLen = Math.floor(sr * 60 / 122);
      for (var i = 0; i < d.length; i++) {
        var ph = i % beatLen, t = ph / sr, v = 0;
        if (ph < sr * 0.22) v += Math.sin(2 * Math.PI * (58 - 26 * t / 0.22) * t) * Math.exp(-t * 9) * 0.95;
        var barPos = (i % (beatLen * 4)) / sr;
        var hat = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
        if (ph > beatLen / 2 && ph < beatLen / 2 + sr * 0.03) v += (hat - 0.5) * 0.22;
        if (barPos > 1.9) v += Math.sin(2 * Math.PI * 220 * t) * 0.055 * Math.exp(-(barPos - 1.9) * 2);
        d[i] = v * 0.85;
      }
    }
    var src = actx.createBufferSource(); src.buffer = buf; src.loop = true;
    var g = actx.createGain(); g.gain.value = 1.0;
    src.connect(g); g.connect(tapGain); src.start();
    noiseNodes = { src: src, gain: g };
  }
  function stopFileTap() {
    if (mediaSrc) { try { mediaSrc.disconnect(); } catch (e) {} mediaSrc = null; }
    try { tap.pause(); } catch (e) {}
  }
  function stopMic() {
    if (streamSrc) { try { streamSrc.disconnect(); } catch (e) {} streamSrc = null; }
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
  }
  function connectMic(stream) {
    micStream = stream;
    if (streamSrc) try { streamSrc.disconnect(); } catch (e) {}
    streamSrc = actx.createMediaStreamSource(stream);
    streamSrc.connect(tapGain);
  }
  function startMic(reason) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showFallback("Microphone unavailable", "This window can't capture audio here. The ambient beat keeps the visuals alive; switch Audio back to File to retry the synced decode.");
      setSource("ambient", reason); return;
    }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } })
      .then(function (stream) { if (activeSource === "mic") connectMic(stream); else stream.getTracks().forEach(function (t) { t.stop(); }); })
      .catch(function (err) {
        showFallback("Microphone blocked" + (reason === "auto" ? " (file audio unavailable)" : ""),
          "macOS denied microphone access for IINA (System Settings → Privacy & Security → Microphone). Using the ambient beat meanwhile.");
        setSource("ambient", reason);
      });
  }
  function setSource(kind, reason) {
    if (!ensureCtx()) {
      showFallback("Web Audio unavailable", "This WebView has no AudioContext, so nothing can drive the visuals. Quit and relaunch IINA; if it persists, tell me exactly what the Log Viewer shows for MilkDrop.");
      activeSource = "none";  return;
    }
    if (kind !== "file") stopDecoded();
    if (kind !== "file") stopFileTap();
    if (kind !== "mic") stopMic();
    if (kind !== "ambient") stopNoise();
    if (kind === "file") { enterFileMode(reason); }
    else if (kind === "mic") { startMic(reason); activeSource = "mic"; }
    else if (kind === "ambient") { startAmbient(); activeSource = "ambient"; }
    else activeSource = "none";
    if (kind !== "file") { silenceSeconds = 0; warnedSilence = false;  }
    vizLog("audio source -> " + kind + " (" + (reason || "") + "), actx=" + (actx ? actx.state : "none"));
  }
  // ---------- plugin-fed decode: the reliable way to hear the file ----------
  // The stage's own <audio> tap is unreliable in WKWebView (file:// media is
  // origin-tainted, so a MediaElementSource outputs silence). The plugin reads
  // the file with a binary FileHandle and streams the bytes here as base64;
  // we decodeAudioData() them and play the buffer in sync with mpv.
  var feedId = 0, feedExpectedId = 0, feedChunks = [], feedPending = false, feedTimer = 0, feedPath = "";
  var decodedBuffer = null, decodedPath = "";
  var bufNode = null, bufStartedCtx = 0, bufStartedPos = 0, bufSpeed = 1;
  function enterFileMode(reason) {
    stopDecoded(); stopMic(); stopNoise();
    if (!ensureCtx()) { activeSource = "none";  return; }
    if (!state.hasMedia || !state.path) { activeSource = "none"; feedPath = "";  return; }
    if (/^https?:\/\//i.test(state.path)) { startTapMode("stream"); return; }
    feedExpectedId = ++feedId;
    feedChunks = []; feedPending = true; feedPath = state.path;
    activeSource = "decode";
    silenceSeconds = 0; warnedSilence = false;
    
    vizLog("decode: requesting bytes for " + state.path + " (feed " + feedExpectedId + ")");
    post("request-audio", { id: feedExpectedId, path: state.path });
    clearTimeout(feedTimer);
    feedTimer = setTimeout(function () {
      if (feedPending) { feedPending = false; vizLog("decode: feed timed out"); startTapMode("timeout"); }
    }, 20000);
  }
  function startTapMode(reason) {
    feedPending = false; clearTimeout(feedTimer);
    stopBuf(); stopMic(); stopNoise();
    activeSource = "file";
    if (!mediaSrc) {
      try { mediaSrc = actx.createMediaElementSource(tap); mediaSrc.connect(tapGain); }
      catch (e) { vizLog("createMediaElementSource failed: " + e); }
    }
    syncTap(true);
    silenceSeconds = 0; warnedSilence = false;
    
    vizLog("audio -> file tap (" + (reason || "") + ")");
  }
  function stopBuf() {
    if (bufNode) {
      try { bufNode.stop(); } catch (e) {}
      try { bufNode.disconnect(); } catch (e) {}
      bufNode = null;
    }
  }
  function stopDecoded() { stopBuf(); decodedBuffer = null; decodedPath = ""; }
  function startBufSync(force) {
    if (!decodedBuffer || decodedPath !== state.path) return;
    if (!state.playing) { stopBuf(); return; }
    if (bufNode && !force) return;
    stopBuf();
    var node = actx.createBufferSource();
    node.buffer = decodedBuffer;
    node.playbackRate.value = state.speed || 1;
    node.connect(tapGain);
    var off = Math.max(0, state.position % decodedBuffer.duration);
    try { node.start(0, off); }
    catch (e) { vizLog("buf start failed: " + e); return; }
    bufNode = node; bufStartedCtx = actx.currentTime; bufStartedPos = state.position; bufSpeed = state.speed || 1;
  }
  function b64ToBytes(b64) {
    var bin = atob(b64), n = bin.length, out = new Uint8Array(n), i;
    for (i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function onAudioChunk(d) {
    if (!d || d.id !== feedExpectedId || !feedPending) return;
    feedChunks.push(b64ToBytes(d.data));
  }
  function onAudioEnd(d) {
    if (!d || d.id !== feedExpectedId || !feedPending) return;
    feedPending = false; clearTimeout(feedTimer);
    var total = 0, i, off = 0;
    for (i = 0; i < feedChunks.length; i++) total += feedChunks[i].length;
    var all = new Uint8Array(total);
    for (i = 0; i < feedChunks.length; i++) { all.set(feedChunks[i], off); off += feedChunks[i].length; }
    feedChunks = [];
    vizLog("decode: received " + total + " bytes, decoding\u2026");
    var promise = null;
    try { promise = actx.decodeAudioData(all.buffer.slice(0)); } catch (e) {}
    if (!promise || !promise.then) { vizLog("decode: decodeAudioData unavailable"); startTapMode("decode-unavailable"); return; }
    promise.then(function (buf) {
      if (state.path !== feedPath) { vizLog("decode: track changed while decoding \u2014 discarding"); return; }
      decodedBuffer = buf; decodedPath = state.path;
      vizLog("decode: ok " + buf.duration.toFixed(1) + "s, " + buf.numberOfChannels + "ch @ " + buf.sampleRate + "Hz");
      startBufSync(true);
      
    }).catch(function (e) {
      vizLog("decode: decodeAudioData failed: " + e);
      startTapMode("decode-failed");
    });
  }
  function onAudioUnavailable(d) {
    if (!d || d.id !== feedExpectedId || !feedPending) return;
    feedPending = false; clearTimeout(feedTimer);
    vizLog("decode: unavailable \u2014 " + (d.reason || "unknown"));
    startTapMode(d.reason || "unavailable");
  }
  function syncTap(force) {
    if (activeSource !== "file" || !state.hasMedia || !state.url || fileDecodeFailed) return;
    var src = state.url;
    var cur = tap.getAttribute("src") || "";
    if (cur !== src) {
      tap.src = src; tap.load();
      force = true;
    }
    var now = performance.now();
    if (!force && now - lastSyncAt < 4000) return;
    lastSyncAt = now;
    var drift = Math.abs(tap.currentTime - state.position);
    if (force || drift > 0.35 || tap.readyState < 2) {
      try { tap.currentTime = Math.max(0, state.position); } catch (e) {}
    }
    if (state.playing && tap.paused) { var p = tap.play(); if (p) p.catch(function () {}); }
    if (!state.playing && !tap.paused) tap.pause();
  }
  tap.addEventListener("error", function () {
    if (activeSource !== "file" || fileDecodeFailed) return;
    fileDecodeFailed = true;
    vizLog("file decode failed for " + state.path);
    showFallback("Couldn't read this file's audio",
      "The synced decoder can't open “" + (state.path.split("/").pop() || "this file") + "”. If it's DRM-protected (e.g. Apple Music downloads), use Mic mode while it plays, or the ambient beat.");
    setSource(settings.audioSource === "file" ? "mic" : "ambient", "auto");
  });

  // ------------------------------------------------------------ visuals
  function probeWebGL2() {
    try {
      var c = document.createElement("canvas");
      var gl = c.getContext("webgl2");
      if (!gl) return "no-context";
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      var renderer = "unknown";
      try { renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) {}
      return "ok (" + renderer + ")";
    } catch (e) { return "threw: " + e; }
  }
  var textureScale = 1;
  // TRUE native resolution — and a trap in Butterchurn's sizing model that
  // made every 2.x build soft: Butterchurn NEVER sizes the display canvas,
  // and its final pass draws with a viewport of exactly the width/height it
  // was given (renderer.width/height). So canvas buffer, renderer size and
  // viewport must all be the same size, in DEVICE pixels. The "standard"
  // recipe (CSS size + pixelRatio) leaves the canvas at its 300x150 default
  // or at CSS size, and the picture comes out as a low-res crop/upscale.
  // We therefore work in device pixels end to end: buffer = CSS x
  // devicePixelRatio, renderer told the same numbers with pixelRatio 1,
  // and the warp mesh scales with the backing size (Butterchurn's built-in
  // mesh default is a fixed 48x36 regardless of size).
  function nativeDpr() { return window.devicePixelRatio || 1; }
  function deviceSize() {
    var dpr = nativeDpr();
    return {
      w: Math.max(2, Math.round(window.innerWidth * dpr)),
      h: Math.max(2, Math.round(window.innerHeight * dpr)),
    };
  }
  function meshFor(dw, dh) { // dw/dh: device pixels (before textureScale)
    var tw = dw * textureScale, th = dh * textureScale;
    return {
      meshWidth: Math.max(48, Math.min(168, Math.round(tw / 24))),
      meshHeight: Math.max(36, Math.min(126, Math.round(th / 24))),
    };
  }
  function createVisualizer() {
    if (visualizer) return true;
    if (!BC || !BC.createVisualizer) {
      showFallback("MilkDrop engine failed to load",
        "The Butterchurn script didn't initialize. Reinstall the plugin package; if this persists, the Log Viewer lines under MilkDrop will show why.");
      return false;
    }
    if (!ensureCtx()) return false;
    var ds0 = deviceSize();
    var m0 = meshFor(ds0.w, ds0.h);
    try {
      visualizer = BC.createVisualizer(actx, canvas, {
        width: ds0.w, height: ds0.h,
        pixelRatio: 1,
        textureRatio: textureScale,
        meshWidth: m0.meshWidth, meshHeight: m0.meshHeight,
      });
      var EI = unwrap(window.butterchurnExtraImages);
      if (EI && EI.getImages && visualizer.loadExtraImages) {
        try {
          // Butterchurn's bundled extra images, plus the MilkDrop Texture
          // Pack (lib/textures.js). Pack entries only fill names the
          // bundled set doesn't already provide, so existing presets keep
          // rendering exactly as before.
          var imgs = EI.getImages() || {};
          var texPack = window.__MILKDROP_TEXTURES__ || {};
          for (var tk in texPack) if (!(tk in imgs)) imgs[tk] = texPack[tk];
          // Textures that shipped in Geiss's favorites zip but aren't in
          // the pack (sunset01_, sunset03_, inspiration_, mcode1,
          // nightingale one) fill any remaining gaps.
          var texGeiss = window.__MILKDROP_GEISS_TEXTURES__ || {};
          for (var gk in texGeiss) if (!(gk in imgs)) imgs[gk] = texGeiss[gk];
          // MilkDrop lets each shader pass reference the same texture
          // with a pass prefix (fc_ composite, fw_ warp); Butterchurn
          // looks samplers up by exact name, so register the prefixed
          // aliases the preset corpus uses (see lib/textures.js).
          var texAliases = window.__MILKDROP_TEXTURE_ALIASES__ || {};
          for (var ak in texAliases) {
            if (!(ak in imgs) && texPack[texAliases[ak]]) imgs[ak] = texPack[texAliases[ak]];
          }
          visualizer.loadExtraImages(imgs);
        } catch (e) {}
      }
      try { visualizer.connectAudio(tapGain); }
      catch (e) { visualizer.connectAudio(analyser); }
      sizeCanvas();
    } catch (e) {
      vizLog("createVisualizer threw: " + e + " | webgl2 probe: " + probeWebGL2());
      showFallback("Visualizer failed to start",
        "Butterchurn couldn't create its renderer (" + String(e).slice(0, 160) + "). WebGL2 probe: " + probeWebGL2() +
        ". If this persists, send me the MilkDrop lines from IINA's Log Viewer.");
      return false;
    }
    vizLog("engine created (window " + window.innerWidth + "x" + window.innerHeight +
      " CSS x dpr " + nativeDpr() + " = " + ds0.w + "x" + ds0.h + " device px" +
      ", mesh " + m0.meshWidth + "x" + m0.meshHeight + ", texScale " + textureScale + ") | webgl2 probe: " + probeWebGL2());
    hideFallback();
    return true;
  }
  function sizeCanvas() {
    var ds = deviceSize();
    // The stage owns the display buffer (see the note at deviceSize): keep
    // it exactly at device-pixel size. Assigning canvas.width resets the
    // buffer, so only touch it when the size actually changed.
    if (canvas.width !== ds.w) canvas.width = ds.w;
    if (canvas.height !== ds.h) canvas.height = ds.h;
    if (visualizer) {
      var m = meshFor(ds.w, ds.h);
      try {
        visualizer.setRendererSize(ds.w, ds.h, {
          pixelRatio: 1, textureRatio: textureScale,
          meshWidth: m.meshWidth, meshHeight: m.meshHeight,
        });
      } catch (e) {}
    }
  }
  // Native fullscreen animates over ~1s and intermediate resize events carry
  // partial sizes; re-assert the size after the animation settles so the
  // renderer always lands on the full screen resolution.
  var settleTimers = [];
  function sizeCanvasSettled() {
    sizeCanvas();
    settleTimers.forEach(clearTimeout);
    settleTimers = [setTimeout(sizeCanvas, 350), setTimeout(sizeCanvas, 900)];
  }
  window.addEventListener("resize", sizeCanvasSettled);
  document.addEventListener("fullscreenchange", sizeCanvasSettled);
  document.addEventListener("webkitfullscreenchange", sizeCanvasSettled);
  // Moving the window between a Retina and a non-Retina display changes
  // devicePixelRatio WITHOUT changing the CSS size — no resize event fires.
  // Watch the resolution media query for exactly that, and re-watch after
  // each change (the query is value-specific).
  function watchDpr() {
    try {
      var mq = window.matchMedia("(resolution: " + nativeDpr() + "dppx)");
      var onChange = function () { sizeCanvasSettled(); watchDpr(); };
      if (mq.addEventListener) mq.addEventListener("change", onChange, { once: true });
      else if (mq.addListener) mq.addListener(onChange);
    } catch (e) {}
  }
  watchDpr();
  // And a plain timer, because rAF (which carries the other drift check)
  // pauses while the window is occluded — exactly when a display move can
  // happen unnoticed.
  setInterval(function () {
    var ds = deviceSize();
    if (canvas.width !== ds.w || canvas.height !== ds.h) sizeCanvas();
  }, 1000);

  function flashPreset(name) {
    // The bottom preset bar (between Previous and Next) is the single
    // place that names the current preset — no center-screen overlay.
    var parts = splitName(name);
    $("cur-name").textContent = parts.author ? parts.title : name;
    $("cur-author").textContent = parts.author;
    updateFavButton();
  }
  function loadPreset(name, blend) {
    if (!name) return;
    if (!createVisualizer()) return;
    resolvePreset(name, function (err, obj) {
      if (err || !obj) { lastLoadError = name + ": " + (err && err.message); vizLog("preset not resolvable: " + name + " (" + (err && err.message) + ")"); if (++failStreak <= 8) { toast("Couldn't load that preset — skipping."); stepLocal(1); } else showFallback("Presets keep failing to load", "Last error: " + lastLoadError + ". The full log is in IINA's Log Viewer under MilkDrop — or press D for diagnostics."); return; }
      try {
        visualizer.loadPreset(obj, typeof blend === "number" ? blend : 2.7);
        currentPreset = name;
        lastLoadAt = Date.now(); loadsCount++; lastLoadError = ""; failStreak = 0;
        hideFallback();
        recentList = [name].concat(recentList.filter(function (n) { return n !== name; })).slice(0, 24);
        flashPreset(name);
        vizLog("preset loaded: " + name);
      } catch (e) {
        lastLoadError = name + ": " + e;
        vizLog("loadPreset threw for " + name + ": " + e);
        if (++failStreak <= 8) { toast("Preset crashed the renderer — moving on."); stepLocal(1); }
      }
    });
  }
  var rafStarted = false;
  function renderLoop() { if (rafStarted) return; rafStarted = true; requestAnimationFrame(renderFrame); }
  var frameCount = 0, lastFpsAt = performance.now(), lastSilenceCheck = 0;
  var renderErrStreak = 0, renderRebuilt = false;
  function renderFrame() {
    requestAnimationFrame(renderFrame);
    if (!visualizer) return;
    try { visualizer.render(); renderErrStreak = 0; }
    catch (e) {
      renderErrStreak++;
      if (renderErrStreak === 3) {
        vizLog("render() throwing repeatedly: " + e);
        if (!renderRebuilt) {
          renderRebuilt = true;
          textureScale = 0.6;
          toast("Renderer hiccup — rebuilding at lower resolution…");
          var keep = currentPreset;
          visualizer = null;
          if (createVisualizer() && keep) loadPreset(keep, 0);
        } else {
          showFallback("The renderer keeps failing",
            "Butterchurn's render loop throws even after a lower-resolution rebuild (" + String(e).slice(0, 160) +
            "). The exact error is in IINA's Log Viewer under MilkDrop — send me those lines and I'll fix the real cause.");
        }
      }
    }
    frameCount++;
    var now = performance.now();
    if (now - lastFpsAt >= 1000) {
      $("fps").textContent = frameCount + " fps";
      frameCount = 0; lastFpsAt = now;
      // Safety net for the watchers above: if the buffer ever drifts from
      // the device-pixel size (missed resize, display change), correct it.
      var dsz = deviceSize();
      if (canvas.width !== dsz.w || canvas.height !== dsz.h) sizeCanvas();
      var clickPill = $("pill-click");
      clickPill.classList.toggle("hidden", !(actx && actx.state === "suspended" && state.playing));
      if (analyser && actx.state === "running") {
        var data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        var ssq = 0, cnt = 0;
        for (var i = 0; i < data.length; i += 8) { var dv = (data[i] - 128) / 128; ssq += dv * dv; cnt++; }
        var rms = Math.sqrt(ssq / Math.max(1, cnt));
        lastRms = rms;
        if (state.playing && (renderFrame._lvT || 0) < now - 10000) {
          renderFrame._lvT = now;
          vizLog("level rms=" + rms.toFixed(3) + " source=" + activeSource + " actx=" + actx.state);
        }
        if (rms < 0.004 && state.playing && activeSource !== "ambient") {
          silenceSeconds++;
          if (silenceSeconds >= 6 && !warnedSilence) {
            warnedSilence = true;
            toast("No audio signal reaching the visualizer (source: " + activeSource + "). Try Audio → Mic in the picker.");
          }
        } else silenceSeconds = 0;
      }
      lastSilenceCheck = now;
    }
    if (activeSource === "file") syncTap(false);
  }

  // ------------------------------------------------------------ fallback card
  var fallbackTitleShown = "";
  function showFallback(title, text) {
    if (fallbackTitleShown === title && !$("fallback").classList.contains("hidden")) return;
    fallbackTitleShown = title;
    $("fallback-title").textContent = title;
    $("fallback-text").textContent = text;
    $("fallback").classList.remove("hidden");
  }
  function hideFallback() { fallbackTitleShown = ""; $("fallback").classList.add("hidden"); }
  function retryRender() {
    var name = currentPreset || (settings && settings.preset) || "";
    if (!name) { var pool = poolFor(settings); name = pool.length ? pool[Math.floor(Math.random() * pool.length)] : ""; }
    if (name) loadPreset(name, 0);
  }
  $("f-mic").addEventListener("click", function () { hideFallback(); setSource("mic", "card"); retryRender(); });
  $("f-ambient").addEventListener("click", function () { hideFallback(); setSource("ambient", "card"); retryRender(); });
  $("f-retry").addEventListener("click", function () { hideFallback(); fileDecodeFailed = false; setSource("file", "card"); retryRender(); });

  // ------------------------------------------------------------ chrome auto-hide
  var idleTimer = 0;
  function pokeChrome() {
    document.body.classList.remove("cursor-hidden");
    $("topbar").classList.remove("hidden");
    $("bottombar").classList.remove("hidden");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (pickerOpen || !state.playing) return;
      document.body.classList.add("cursor-hidden");
      $("topbar").classList.add("hidden");
      $("bottombar").classList.add("hidden");
    }, 2600);
  }
  document.addEventListener("mousemove", pokeChrome);
  document.addEventListener("pointerdown", pokeChrome);
  pokeChrome();

  // ------------------------------------------------------------ picker
  var pickerOpen = false, activeCollection = "all", filterText = "";
  var renderedNames = [], selectedIdx = -1, pickerIO = null;
  // The picker shows exactly these collections, in this order, each with
  // its preset count in parentheses.
  var PICKER_ORDER = ["originals", "geiss", "all", "favorites"];
  function buildChips() {
    var host = $("p-collections");
    host.innerHTML = "";
    PICKER_ORDER.forEach(function (id) {
      var c = collectionById(id);
      var b = document.createElement("button");
      b.textContent = c.label + " (" + c.list().length.toLocaleString("en-US") + ")";
      b.setAttribute("data-id", c.id);
      if (c.id === activeCollection) b.className = "on";
      b.addEventListener("click", function () { activeCollection = c.id; buildChips(); refreshPicker(); $("p-list").scrollTop = 0; });
      host.appendChild(b);
    });
  }
  function currentList() {
    var list;
    if (filterText) {
      // Search always covers the WHOLE catalog — including presets whose
      // rows have not been rendered yet in the scrollable list. The full
      // match list is computed up front; only the DOM rows are paged.
      var q = filterText.toLowerCase();
      list = uniqueAllNames.filter(function (n) { return n.toLowerCase().indexOf(q) >= 0; });
    } else {
      list = collectionById(activeCollection).list().slice();
    }
    if (filterText) {
      list.sort(function (a, b) { return a.localeCompare(b); });
    } else {
      // Browse order: by author group (canonical key; authorless names
      // last), then by name — so one author is always one contiguous
      // group under one header.
      list.sort(function (a, b) {
        var ka = authorKey(a), kb = authorKey(b);
        if (ka !== kb) {
          if (!ka) return 1;
          if (!kb) return -1;
          return ka < kb ? -1 : 1;
        }
        return a.localeCompare(b);
      });
    }
    return list;
  }
  function refreshPicker() {
    var host = $("p-list");
    host.innerHTML = "";
    renderedNames = currentList();
    $("p-count").textContent = filterText
      ? renderedNames.length.toLocaleString() + " matches in all " + uniqueAllNames.length.toLocaleString() + " presets"
      : renderedNames.length.toLocaleString() + " presets · " + uniqueAllNames.length.toLocaleString() + " total";
    selectedIdx = renderedNames.indexOf(currentPreset);
    var PAGE = 160, shown = 0, lastAuthor = null;
    var sentinel = document.createElement("div");
    sentinel.id = "p-sentinel";
    sentinel.style.cssText = "height:1px";
    function renderMore() {
      if (shown >= renderedNames.length) return;
      var frag = document.createDocumentFragment();
      var end = Math.min(renderedNames.length, shown + PAGE);
      for (var i = shown; i < end; i++) {
        var name = renderedNames[i], parts = splitName(name);
        var aKey = authorKey(name);
        var authorDisp = aKey ? (authorDisplay[aKey] || cleanAuthor(parts.author)) : "";
        if (aKey !== lastAuthor && !filterText) {
          var head = document.createElement("div");
          head.className = "author-head"; head.textContent = authorDisp || "Unknown author";
          frag.appendChild(head);
          lastAuthor = aKey;
        }
        var row = document.createElement("div");
        row.className = "preset-row" + (name === currentPreset ? " active" : "");
        row.setAttribute("data-idx", String(i));
        row.setAttribute("data-name", name);
        var star = settings.favorites.indexOf(name) >= 0;
        row.innerHTML = "";
        // One line per preset: Author - Title (author cleaned of any
        // leading "_" / "-" sorting prefix).
        var nm = document.createElement("div"); nm.className = "p-name";
        var ln = document.createElement("div"); ln.className = "p-line";
        if (authorDisp) {
          var au = document.createElement("span"); au.className = "p-author"; au.textContent = authorDisp;
          var sep = document.createElement("span"); sep.className = "p-sep"; sep.textContent = " - ";
          var ti = document.createElement("span"); ti.textContent = parts.title || name;
          ln.appendChild(au); ln.appendChild(sep); ln.appendChild(ti);
        } else {
          ln.textContent = cleanAuthor(name);
        }
        nm.appendChild(ln); row.appendChild(nm);
        var st = document.createElement("button");
        st.className = "star" + (star ? " fav" : ""); st.textContent = star ? "★" : "☆";
        st.setAttribute("data-star", name);
        row.appendChild(st);
        frag.appendChild(row);
      }
      shown = end;
      host.insertBefore(frag, sentinel);
      if (shown >= renderedNames.length) sentinel.remove();
    }
    host.appendChild(sentinel);
    renderMore();
    // Rows keep loading automatically as the list scrolls — there is
    // deliberately no "Show more" button. IntersectionObserver does it in
    // the real webview; the scroll handler is the fallback (and what the
    // jsdom test rig exercises).
    if (pickerIO) { pickerIO.disconnect(); pickerIO = null; }
    if (window.IntersectionObserver) {
      pickerIO = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) renderMore();
      }, { root: host, rootMargin: "600px" });
      pickerIO.observe(sentinel);
    }
    host.onscroll = function () {
      if (host.scrollTop + host.clientHeight >= host.scrollHeight - 600) renderMore();
    };
  }
  $("p-list").addEventListener("click", function (ev) {
    var starBtn = ev.target.closest("[data-star]");
    if (starBtn) {
      toggleFavoriteLocal(starBtn.getAttribute("data-star"));
      return;
    }
    var row = ev.target.closest(".preset-row");
    if (!row) return;
    var name = renderedNames[Number(row.getAttribute("data-idx"))];
    if (name) pickLocal(name);
    closePicker();
  });
  $("p-search").addEventListener("input", function (ev) { filterText = ev.target.value.trim(); refreshPicker(); });
  function openPicker() {
    $("p-search").placeholder = "Search " + INDEX.length.toLocaleString() + " presets or authors…";
    pickerOpen = true;
    $("picker").classList.remove("hidden");
    if (PICKER_ORDER.indexOf(activeCollection) < 0) activeCollection = "all";
    buildChips(); refreshPicker();
    setTimeout(function () { $("p-search").focus(); }, 60);
    pokeChrome();
  }
  function closePicker() {
    pickerOpen = false;
    $("picker").classList.add("hidden");
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    pokeChrome();
  }
  $("p-close").addEventListener("click", closePicker);
  $("b-picker").addEventListener("click", function () { pickerOpen ? closePicker() : openPicker(); });
  $("b-preset").addEventListener("click", openPicker);
  $("p-source").addEventListener("change", function (ev) {
    settings.audioSource = ev.target.value;
    setSource(ev.target.value, "picker");
    post("set-setting", { key: "audioSource", value: ev.target.value });
  });
  // The cycle interval lives in the ▾ menu attached to the cycle button
  // (see the controls section), not in this panel.
  var cycleMenuOpen = false;
  function closeCycleMenu() { cycleMenuOpen = false; $("cycle-menu").classList.add("hidden"); }
  function openCycleMenu() {
    var m = $("cycle-menu");
    Array.prototype.forEach.call(m.querySelectorAll("button"), function (b) {
      b.classList.toggle("on", Number(b.getAttribute("data-sec")) === Number(settings.cycleSeconds));
    });
    m.classList.remove("hidden");
    cycleMenuOpen = true;
    var r = $("b-cycle").getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.left + r.width - m.offsetWidth)) + "px";
    m.style.bottom = (window.innerHeight - r.top + 8) + "px";
  }
  $("b-cycle-menu").addEventListener("click", function (ev) {
    ev.stopPropagation();
    if (cycleMenuOpen) closeCycleMenu(); else openCycleMenu();
  });
  $("cycle-menu").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-sec]");
    if (!b) return;
    settings.cycleSeconds = Number(b.getAttribute("data-sec"));
    updateCycleButton();
    post("set-setting", { key: "cycleSeconds", value: settings.cycleSeconds });
    closeCycleMenu();
    toast("Cycle interval: " + settings.cycleSeconds + "s" + (settings.cycle ? "" : " (cycling is off — tap ⟳ to start)"));
  });
  document.addEventListener("pointerdown", function (ev) {
    if (cycleMenuOpen && !$("cycle-menu").contains(ev.target) && ev.target !== $("b-cycle-menu")) closeCycleMenu();
  });

  // ------------------------------------------------------------ diagnostics
  var diagOpen = false, diagTimer = 0, diagLastFrames = 0, diagFps = 0;
  function ago(t) { return t ? Math.max(0, (Date.now() - t) / 1000).toFixed(1) + "s ago" : "never"; }
  function renderDiag() {
    var L = [];
    L.push("BRIDGE (stage <-> IINA plugin)");
    L.push("  init received: " + (initReceived ? "YES \u2014 plugin v" + pluginVersionSeen : "NO \u2014 standalone mode (bridge silent)"));
    L.push("  messages out / in: " + msgOut + " / " + msgIn);
    L.push("  last received: " + (lastRecvName || "\u2014") + " (" + ago(lastRecvAt) + ")");
    L.push("AUDIO");
    L.push("  source mode: " + activeSource + (feedPending ? " (feed pending)" : ""));
    L.push("  context: " + (actx ? actx.state : "none") + "   level RMS: " + lastRms.toFixed(3) + (lastRms < 0.004 && state.playing ? "  \u26a0 FLAT" : ""));
    if (decodedBuffer) L.push("  decoded: " + decodedBuffer.duration.toFixed(1) + "s \u00b7 " + decodedPath.split("/").pop());
    else if (state.path) L.push("  track: " + state.path.split("/").pop() + " (not decoded)");
    L.push("RENDER");
    var meshNow = meshFor(canvas.width, canvas.height);
    L.push("  engine: " + window.innerWidth + "\u00d7" + window.innerHeight + " CSS \u00d7 dpr " + nativeDpr() +
      " \u2192 " + canvas.width + "\u00d7" + canvas.height + " px, mesh " + meshNow.meshWidth + "\u00d7" + meshNow.meshHeight + ", texScale " + textureScale);
    L.push("  fullscreen: " + (fsElement() ? "element" : fillScreen ? "fill-screen (plugin)" : "no"));
    L.push("  fps: ~" + diagFps + "   presets loaded: " + loadsCount);
    L.push("  current: " + (currentPreset || "\u2014"));
    L.push("  last load error: " + (lastLoadError || "\u2014"));
    L.push("PRESETS");
    L.push("  collection: " + activeCollection + " (" + poolFor({ collection: activeCollection }).length + ")   favorites: " + (settings.favorites || []).length);
    L.push("  localStorage: " + (storageOk ? "available" : "UNAVAILABLE"));
    L.push("  state: playing=" + state.playing + " pos=" + Math.round(state.position) + "s path=" + (state.path ? "\u2026" + state.path.slice(-38) : "\u2014"));
    $("diag-body").textContent = L.join("\n");
  }
  function toggleDiag(force) {
    diagOpen = typeof force === "boolean" ? force : !diagOpen;
    $("diag").classList.toggle("hidden", !diagOpen);
    // Active state: the button fills system blue while the panel is open.
    $("b-diag").classList.toggle("on", diagOpen);
    clearInterval(diagTimer);
    if (diagOpen) {
      renderDiag();
      diagLastFrames = frameCount;
      diagTimer = setInterval(function () {
        diagFps = (frameCount - diagLastFrames) * 2;
        diagLastFrames = frameCount;
        renderDiag();
      }, 500);
    }
    pokeChrome();
  }
  $("b-diag").addEventListener("click", function () { toggleDiag(); });
  $("d-close").addEventListener("click", function () { toggleDiag(false); });

  // ------------------------------------------------------------ controls
  function post(name, data) { msgOut++; if (window.iina) iina.postMessage(name, data || {}); }
  function onMsg(name, fn) {
    iina.onMessage(name, function (data) {
      msgIn++; lastRecvName = name; lastRecvAt = Date.now();
      fn(data || {});
    });
  }

  // ------------------------------------------------------------ local preset engine
  // Everything preset-related happens HERE first. The plugin is notified
  // (set-preset / toggle-favorite with local:true) so menus and persistence
  // stay in sync when the bridge is alive — but nothing waits on it.
  var localBag = [], localHistory = [], bagCollection = "";
  function refillLocalBag() {
    bagCollection = activeCollection;
    localBag = poolFor({ collection: activeCollection });
    for (var i = localBag.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = localBag[i]; localBag[i] = localBag[j]; localBag[j] = t;
    }
  }
  function pickLocal(name) {
    if (!name) return;
    if (currentPreset && name !== currentPreset) {
      localHistory.push(currentPreset);
      if (localHistory.length > 50) localHistory.shift();
    }
    loadPreset(name, settings ? settings.blendSeconds : 2.7);
    post("set-preset", { name: name, local: true });
  }
  function stepLocal(dir) {
    if (dir === -1) {
      while (localHistory.length) {
        var p = localHistory.pop();
        if (p !== currentPreset) {
          loadPreset(p, settings ? settings.blendSeconds : 2.7);
          post("set-preset", { name: p, local: true });
          return;
        }
      }
      toast("No earlier preset in this session.");
      return;
    }
    if (!settings.random) {
      // Sequential mode (Random toggle off): step through the collection
      // in alphabetical order, wrapping at the end.
      var seq = poolFor({ collection: activeCollection }).slice()
        .sort(function (a, b) { return a.localeCompare(b); });
      if (!seq.length) { toast("No presets in this collection."); return; }
      pickLocal(seq[(seq.indexOf(currentPreset) + 1) % seq.length]);
      return;
    }
    // The shuffle bag belongs to the collection it was built from —
    // switching collections in the picker rebuilds it, so Next never
    // draws leftovers from the previous list.
    if (!localBag.length || bagCollection !== activeCollection) refillLocalBag();
    if (!localBag.length) { toast("No presets in this collection."); return; }
    var n = localBag.pop();
    if (n === currentPreset && localBag.length) n = localBag.pop();
    pickLocal(n);
  }
  function randomLocal() {
    var pool = poolFor({ collection: activeCollection });
    if (pool.length) pickLocal(pool[Math.floor(Math.random() * pool.length)]);
  }
  function toggleFavoriteLocal(name) {
    if (!name) return;
    var favs = (settings.favorites || []).slice();
    var i = favs.indexOf(name);
    var nowFav = i < 0;
    if (i >= 0) favs.splice(i, 1); else favs.unshift(name);
    settings.favorites = favs;
    storedFavs = favs.slice();
    lsSet("MilkDrop.favorites", JSON.stringify(storedFavs));
    post("toggle-favorite", { name: name, local: true, state: nowFav });
    updateFavButton();
    if (activeCollection === "favorites") localBag = []; // pool content changed
    if (pickerOpen) { buildChips(); refreshPicker(); }
    toast(nowFav ? "\u2605 Added to favorites" : "Removed from favorites");
  }
  // Local cycle timer. When the bridge is alive the plugin cycles too, but
  // every load (either origin) resets both clocks, so they never double-step.
  setInterval(function () {
    if (!settings || !settings.cycle || pickerOpen) return;
    if (!state.playing && initReceived) return;
    if (lastLoadAt > 0 && Date.now() - lastLoadAt > (settings.cycleSeconds || 30) * 1000) stepLocal(1);
  }, 1000);
  $("b-prev").addEventListener("click", function () { stepLocal(-1); });
  $("b-next").addEventListener("click", function () { stepLocal(1); });
  // Random is a mode, not a one-shot: while it is on (blue), Next — the
  // button, N, →, and the cycle timer — picks from the shuffle bag; while
  // off, Next steps through the collection in order. R still jumps once.
  function updateRandomButton() { $("b-random").classList.toggle("on", !!(settings && settings.random)); }
  $("b-random").addEventListener("click", function () {
    settings.random = !settings.random;
    updateRandomButton();
    post("set-setting", { key: "random", value: settings.random });
    if (settings.random) { toast("Random order on — next presets are picked at random."); randomLocal(); }
    else toast("Random order off — Next steps through the list in order.");
  });
  function updateFavButton() {
    var fav = settings && settings.favorites.indexOf(currentPreset) >= 0;
    $("b-fav").textContent = fav ? "★" : "☆";
    // Active state (same blue fill as the Random/Cycle toggles): the
    // button fills system blue while the star itself stays white.
    $("b-fav").classList.toggle("on", fav);
  }
  $("b-fav").addEventListener("click", function () { toggleFavoriteLocal(currentPreset); });
  function updateCycleButton() {
    var b = $("b-cycle");
    b.classList.toggle("on", !!settings.cycle);
    b.textContent = settings.cycle ? "⟳ " + settings.cycleSeconds + "s" : "⟳ off";
  }
  $("b-cycle").addEventListener("click", function () {
    closeCycleMenu();
    settings.cycle = !settings.cycle;
    updateCycleButton();
    post("set-setting", { key: "cycle", value: settings.cycle });
  });
  // Fullscreen. Two dead ends shaped this: IINA does not enable the
  // WKWebView element-fullscreen API (requestFullscreen silently no-ops
  // there), and the plugin API has no window fullscreen toggle. So: try the
  // standard element fullscreen first (in case a future IINA enables it);
  // if it has not engaged within 700ms, ask the plugin to fill the screen
  // instead — a borderless window sized to the display via setFrame, which
  // the resize handling above renders at full screen resolution. The macOS
  // green button keeps working as native fullscreen either way.
  var fillScreen = false, fsWatchTimer = 0;
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function enterFillScreen() {
    fillScreen = true;
    post("toggle-fullscreen", {
      on: true,
      screen: {
        width: window.screen.width, height: window.screen.height,
        availWidth: window.screen.availWidth, availHeight: window.screen.availHeight,
      },
    });
    sizeCanvasSettled();
    toast("Fill-screen mode \u2014 click \u26f6 again to exit.");
  }
  function toggleFullscreen() {
    if (fsElement()) {
      var ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex) { try { ex.call(document); } catch (e) {} }
      return;
    }
    if (fillScreen) {
      fillScreen = false;
      post("toggle-fullscreen", { on: false });
      sizeCanvasSettled();
      return;
    }
    // Already in true (green-button) fullscreen? Geometry alone can't tell:
    // a maximized window also fills the screen. display-mode can — it only
    // matches real fullscreen.
    if (window.innerWidth >= window.screen.width && window.innerHeight >= window.screen.height &&
        window.matchMedia && window.matchMedia("(display-mode: fullscreen)").matches) {
      toast("Already full screen (green button) \u2014 exit with Esc or the green button.");
      return;
    }
    var el = document.documentElement;
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) { enterFillScreen(); return; }
    var entered = false;
    function onFsChange() {
      if (fsElement()) { entered = true; cleanup(); sizeCanvasSettled(); }
    }
    function cleanup() {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      clearTimeout(fsWatchTimer);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    fsWatchTimer = setTimeout(function () { cleanup(); if (!entered) enterFillScreen(); }, 700);
    try {
      var p = req.call(el);
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (e) {}
  }
  $("b-full").addEventListener("click", toggleFullscreen);
  canvas.addEventListener("dblclick", function () { $("b-full").click(); });

  document.addEventListener("keydown", function (ev) {
    if (diagOpen && ev.key === "Escape") { toggleDiag(false); return; }
    if (cycleMenuOpen && ev.key === "Escape") { closeCycleMenu(); return; }
    if (pickerOpen) {
      if (ev.key === "Escape") { closePicker(); return; }
      if (ev.key === "Enter" && document.activeElement !== $("p-search")) {
        if (selectedIdx >= 0 && renderedNames[selectedIdx]) { pickLocal(renderedNames[selectedIdx]); closePicker(); }
        return;
      }
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        selectedIdx = Math.max(0, Math.min(renderedNames.length - 1, selectedIdx + (ev.key === "ArrowDown" ? 1 : -1)));
        var rows = $("p-list").querySelectorAll(".preset-row");
        rows.forEach(function (r) { r.style.outline = ""; });
        if (rows[selectedIdx]) { rows[selectedIdx].style.outline = "2px solid var(--accent)"; rows[selectedIdx].scrollIntoView({ block: "nearest" }); }
      }
      return;
    }
    var tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT") return;
    if (ev.key === " ") { ev.preventDefault(); post("control", { action: "toggle-pause" }); }
    else if (ev.key === "n" || ev.key === "N") stepLocal(1);
    else if (ev.key === "b" || ev.key === "B") stepLocal(-1);
    else if (ev.key === "r" || ev.key === "R") randomLocal();
    else if (ev.key === "f" || ev.key === "F") toggleFavoriteLocal(currentPreset);
    else if (ev.key === "d" || ev.key === "D") toggleDiag();
    else if (ev.key === "p" || ev.key === "P" || ev.key === "m" || ev.key === "M") openPicker();
    else if (ev.key === "ArrowRight") stepLocal(1);
    else if (ev.key === "ArrowLeft") stepLocal(-1);
    else if (ev.key === "ArrowUp") { ev.preventDefault(); post("control", { action: "set-volume", value: Math.min(100, state.volume + 5) }); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); post("control", { action: "set-volume", value: Math.max(0, state.volume - 5) }); }
  });

  // ------------------------------------------------------------ plugin state in
  var lastPoolHash = "";
  function sendPool() {
    var pool = poolFor(settings);
    var hash = (settings.collection || "") + ":" + pool.length + ":" + (pool[0] || "");
    if (hash === lastPoolHash) return;
    lastPoolHash = hash;
    post("set-pool", { collection: settings.collection, names: pool });
  }
  function applySettings(next) {
    var prev = settings;
    settings = next;
    if (storedFavs.length) {
      var merged = (settings.favorites || []).slice();
      storedFavs.forEach(function (f) { if (merged.indexOf(f) < 0) merged.unshift(f); });
      settings.favorites = merged;
    }
    if (!activeSource || prev.audioSource !== settings.audioSource) setSource(settings.audioSource, "settings");
    if (settings.preset && settings.preset !== currentPreset) loadPreset(settings.preset, settings.blendSeconds);
    $("p-source").value = settings.audioSource;
    updateCycleButton();
    updateRandomButton();
    updateFavButton();
    sendPool();
    if (pickerOpen) { buildChips(); refreshPicker(); }
  }
  function applyState(next) {
    var wasPath = state.path, wasPlaying = state.playing;
    state = next;
    if (state.path !== wasPath) fileDecodeFailed = false;
    if (settings && settings.audioSource === "file" && state.hasMedia && state.path && !/^https?:\/\//i.test(state.path)) {
      if (activeSource === "none") enterFileMode("media-ready");
      else if (activeSource === "decode" && state.path !== feedPath && state.path !== decodedPath) enterFileMode("track-change");
    }
    if (activeSource === "decode" && !feedPending && decodedBuffer && decodedPath === state.path && actx) {
      if (state.playing && !wasPlaying) startBufSync(true);
      else if (!state.playing && wasPlaying) stopBuf();
      else if (state.playing && bufNode && (state.speed !== bufSpeed ||
          Math.abs(state.position - (bufStartedPos + (actx.currentTime - bufStartedCtx) * bufSpeed)) > 0.45)) startBufSync(true);
      else if (state.playing && !bufNode) startBufSync(true);
    }
    $("t-title").textContent = state.track || "MilkDrop Visualizer";
    var bits = [];
    if (state.artist) bits.push(state.artist);
    if (state.album) bits.push(state.album);
    if (state.hasMedia && state.duration > 0) {
      var f = function (s2) { s2 = Math.max(0, Math.floor(s2)); return Math.floor(s2 / 60) + ":" + ("0" + (s2 % 60)).slice(-2); };
      bits.push(f(state.position) + " / " + f(state.duration));
    }
    $("t-sub").textContent = state.hasMedia ? bits.join(" \u00b7 ") : "Play a song in IINA \u2014 this window opens itself for music files.";
    pokeChrome();
  }

  function bootstrapLocal() {
    if (initReceived || bootstrapped) return;
    bootstrapped = true;
    vizLog("no init after 1.2s — local ambient preview");
    $("pill-link").textContent = "Waiting for IINA plugin… ambient preview";
    setSource("ambient", "bootstrap");
    var pool = poolFor(settings);
    if (pool.length) loadPreset(pool[Math.floor(Math.random() * pool.length)], 0);
    renderLoop();
  }

  window.addEventListener("beforeunload", function () { post("bye", {}); });

  if (window.iina) {
    onMsg("init", function (data) {
      initReceived = true;
      pluginVersionSeen = data.version || "?";
      $("pill-link").classList.add("hidden");
      vizLog("init received (plugin v" + (data.version || "?") + ")");
      if (data.settings) applySettings(data.settings);
      if (data.state) applyState(data.state);
      if ((!data.settings || !data.settings.preset)) {
        var pool = poolFor(settings);
        if (pool.length) pickLocal(pool[Math.floor(Math.random() * pool.length)]);
      }
      renderLoop();
    });
    onMsg("settings", function (data) { initReceived = true; $("pill-link").classList.add("hidden"); applySettings(data); });
    onMsg("state", function (data) { initReceived = true; applyState(data); });
    onMsg("load-preset", function (data) {
      if (data.name === currentPreset && Date.now() - lastLoadAt < 3000) return; // echo of a local pick
      loadPreset(data.name, data.blend);
    });
    onMsg("open-picker", function () { openPicker(); });
    onMsg("toast", function (data) { toast(data.text); });
    onMsg("audio-chunk", onAudioChunk);
    onMsg("audio-end", onAudioEnd);
    onMsg("audio-unavailable", onAudioUnavailable);
    var tries = 0;
    var timer = setInterval(function () {
      if (initReceived || tries >= 30) { clearInterval(timer); return; }
      tries++;
      post("ready", {});
    }, 1500);
    post("ready", {});
    vizLog("boot: index=" + INDEX.length + " engine=" + !!BC + " webgl2=" + probeWebGL2() + " isSupportedFn=" + (typeof window.isSupported === "function" ? String(window.isSupported()) : "n/a"));
    setTimeout(bootstrapLocal, 1200);
  } else {
    showFallback("This window runs inside IINA",
      "Install MilkDrop-Visualizer-0.1.2.iinaplgz via IINA ▸ Settings ▸ Plugins ▸ Install Local Package, then play any .mp3 or .m4a — this window opens by itself.");
    setSource("ambient", "preview");
    var pool = poolFor(settings);
    if (pool.length) loadPreset(pool[0], 0);
    renderLoop();
  }
})();
