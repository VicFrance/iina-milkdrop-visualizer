/*
 * MilkDrop Visualizer for IINA — deliberately simple.
 *
 * One surface: a standalone, full-resolution MilkDrop window ("the stage").
 * It opens automatically when IINA plays an audio/music file, and offers a
 * quick in-window preset picker plus Plugin-menu shortcuts.
 *
 * This script owns settings, playback state, auto-launch and preset cycling.
 * The stage webview (ui/stage.html) owns rendering (Butterchurn/WebGL2) and
 * audio analysis. They talk over iina.postMessage/onMessage with a
 * self-healing ready/init handshake — load order does not matter.
 */
(function () {
  "use strict";

  var VERSION = "0.1.2";
  var AUDIO_EXTS = ["mp3", "m4a", "m4b", "flac", "aac", "wav", "aif", "aiff", "alac", "ogg", "oga", "opus", "caf", "mp4"];

  // ---------------------------------------------------------------- settings
  var DEFAULTS = {
    autoLaunch: true,
    audioSource: "file", // file | mic | ambient
    cycle: true,
    cycleSeconds: 30,
    random: true,
    blendSeconds: 2.7,
    preset: "",
    collection: "all",
    favorites: [],
  };
  var S = {};
  function log(m) { try { iina.console.log("[MilkDrop] " + m); } catch (e) {} }
  function loadSettings() {
    for (var k in DEFAULTS) {
      var v;
      try { v = iina.preferences.get(k); } catch (e) { v = undefined; }
      S[k] = (v === undefined || v === null) ? DEFAULTS[k] : v;
    }
    if (!Array.isArray(S.favorites)) S.favorites = [];
  }
  function persist(keys) {
    keys.forEach(function (k) { try { iina.preferences.set(k, S[k]); } catch (e) {} });
    try { iina.preferences.sync(); } catch (e) {}
  }
  function settingsPayload() { var o = {}; for (var k in DEFAULTS) o[k] = S[k]; return o; }

  // ---------------------------------------------------------------- mpv state
  function gs(n) { try { var v = iina.mpv.getString(n); return v == null ? "" : v; } catch (e) { return ""; } }
  function gn(n, f) { try { var v = iina.mpv.getNumber(n); return (typeof v === "number" && isFinite(v)) ? v : f; } catch (e) { return f; } }
  function gf(n, f) { try { var v = iina.mpv.getFlag(n); return typeof v === "boolean" ? v : f; } catch (e) { return f; } }

  function fileUrl(p) {
    if (!p) return "";
    if (/^https?:\/\//i.test(p)) return p;
    var path = p.replace(/^file:\/\//i, "");
    return "file://" + path.split("/").map(function (seg) {
      return encodeURIComponent(seg).replace(/'/g, "%27");
    }).join("/");
  }

  var musicModeFlag = false;
  // Audio-only? mpv gives cover-art files a "video" track, so check the track
  // list first (selected, non-album-art video = real video), then Music Mode,
  // then the file extension, then dimensions.
  function computeAudioOnly(path, hasMedia, w, h) {
    if (!hasMedia) return false;
    try {
      var tl = iina.mpv.getNative("track-list");
      if (tl && typeof tl.length === "number") {
        var hasAudio = false, realVideo = false;
        for (var i = 0; i < tl.length; i++) {
          var t = tl[i] || {};
          if (t.type === "audio") hasAudio = true;
          if (t.type === "video" && t.selected && !t.albumart) realVideo = true;
        }
        if (hasAudio) return !realVideo;
      }
    } catch (e) {}
    if (musicModeFlag) return true;
    var ext = (path.split(".").pop() || "").toLowerCase().split("?")[0];
    if (AUDIO_EXTS.indexOf(ext) >= 0) return true;
    return w === 0 && h === 0;
  }

  function snapshot() {
    var path = gs("path");
    var duration = gn("duration", 0);
    var eof = gf("eof-reached", false);
    var hasMedia = !!path && !eof;
    var w = gn("width", 0), h = gn("height", 0);
    return {
      hasMedia: hasMedia,
      path: path,
      url: fileUrl(path),
      paused: gf("pause", true),
      playing: hasMedia && !gf("pause", true),
      position: gn("time-pos", 0),
      duration: duration,
      volume: gn("volume", 100),
      speed: gn("speed", 1),
      title: gs("media-title") || gs("filename"),
      track: gs("metadata/title") || gs("media-title") || gs("filename"),
      artist: gs("metadata/artist"),
      album: gs("metadata/album"),
      audioOnly: computeAudioOnly(path, hasMedia, w, h),
      ts: Date.now(),
    };
  }

  // ---------------------------------------------------------------- stage window
  var stage = null, stageLoaded = false, stageOpen = false, acked = false;
  var closedForPath = null, lastPath = null;

  function loadStage() {
    if (stageLoaded) return;
    stageLoaded = true;
    try {
      stage = iina.standaloneWindow;
      stage.loadFile("ui/stage.html");
      // IINA's loadFile() calls messageHub.clearListeners() — every onMessage
      // handler registered before this point is silently erased. (Re)register
      // AFTER loading, always.
      handlersRegistered = false;
      registerHandlers();
      stage.setProperty({ title: "MilkDrop Visualizer", resizable: true, fullSizeContentView: true, hideTitleBar: false });
      stage.setFrame(1440, 900);
    } catch (e) { log("loadStage failed: " + e); stage = null; }
  }
  function openStage(fromUser) {
    loadStage();
    if (!stage) return;
    try { stage.open(); } catch (e) { log("open stage: " + e); }
    stageOpen = true;
    if (fromUser) closedForPath = null;
    pushInit();
  }
  function post(name, data) { if (!stage) return; try { stage.postMessage(name, data); } catch (e) {} }
  function pushInit() {
    post("init", { version: VERSION, settings: settingsPayload(), state: snapshot() });
  }

  // ---------------------------------------------------------------- presets / cycling
  var pool = [], bag = [], history = [];
  function refillBag() {
    bag = pool.slice();
    for (var i = bag.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = bag[i]; bag[i] = bag[j]; bag[j] = t;
    }
  }
  function setPreset(name, reason) {
    if (!name || name === S.preset) { if (name) post("load-preset", { name: name, blend: 0 }); return; }
    if (S.preset) { history.push(S.preset); if (history.length > 50) history.shift(); }
    S.preset = name;
    persist(["preset"]);
    post("load-preset", { name: name, blend: S.blendSeconds });
    post("settings", settingsPayload());
    try { iina.core.osd("MilkDrop: " + name); } catch (e) {}
    cycleElapsed = 0;
    log("preset -> " + name + " (" + (reason || "") + ")");
  }
  function stepNext(reason) {
    if (!pool.length) {
      // Only nag when the *user* asked; automatic steps stay silent (the pool
      // simply hasn't arrived from the stage yet).
      if (reason === "menu" || reason === "stage" || reason === "key") {
        post("toast", { text: "Preset list not ready yet — open the picker (P)." });
      }
      return;
    }
    if (!S.random) {
      // Sequential mode (Random toggle off): next in alphabetical order.
      var seq = pool.slice().sort(function (a, b) { return a.localeCompare(b); });
      setPreset(seq[(seq.indexOf(S.preset) + 1) % seq.length], (reason || "next") + "-seq");
      return;
    }
    if (!bag.length) refillBag();
    var n = bag.pop();
    if (n === S.preset && bag.length) n = bag.pop();
    setPreset(n, reason || "next");
  }
  function stepPrev() {
    while (history.length) {
      var n = history.pop();
      if (n !== S.preset) { setPreset(n, "prev"); return; }
    }
    post("toast", { text: "No earlier preset in this session." });
  }

  // ---------------------------------------------------------------- plugin-fed audio decode
  // The stage cannot reliably read the playing file itself (WebKit taints
  // file:// media fed through a MediaElementSource — it outputs silence).
  // The plugin *can* read the file (FileHandle, binary), so it streams the
  // bytes to the stage in base64 chunks; the stage decodeAudioData()s them
  // and plays the buffer in sync with mpv. True FFT of the actual song.
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function bytesToB64(bytes) {
    var out = "", i, n = bytes.length;
    for (i = 0; i < n; i += 3) {
      var a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0;
      out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] +
        (i + 1 < n ? B64[((b & 15) << 2) | (c >> 6)] : "=") +
        (i + 2 < n ? B64[c & 63] : "=");
    }
    return out;
  }
  var feed = null; // { id, path }
  var MAX_FEED_BYTES = 96 * 1024 * 1024;
  function feedAudio(id, path) {
    stopFeed();
    if (!path || /^https?:\/\//i.test(path)) { post("audio-unavailable", { id: id, reason: "stream" }); return; }
    var handle;
    try { handle = iina.file.handle(path, "read"); }
    catch (e) { log("file.handle failed: " + e); post("audio-unavailable", { id: id, reason: "open-failed: " + e }); return; }
    var size = 0;
    try { handle.seekToEnd(); size = handle.offset(); handle.seekTo(0); } catch (e) {}
    if (size > MAX_FEED_BYTES) {
      try { handle.close(); } catch (e) {}
      log("audio feed skipped: " + size + " bytes > cap");
      post("audio-unavailable", { id: id, reason: "too-large (" + Math.round(size / 1048576) + " MB)" });
      return;
    }
    feed = { id: id, path: path };
    var seq = 0, sent = 0, CHUNK = 256 * 1024;
    log("audio feed start: " + path + " (" + size + " bytes)");
    (function next() {
      if (!feed || feed.id !== id) { try { handle.close(); } catch (e) {} return; }
      var bytes;
      try { bytes = handle.read(CHUNK); } catch (e) { log("feed read: " + e); bytes = null; }
      if (!bytes || bytes.length === 0) {
        try { handle.close(); } catch (e) {}
        log("audio feed done: " + sent + " bytes in " + seq + " chunks");
        post("audio-end", { id: id, total: sent });
        if (feed && feed.id === id) feed = null;
        return;
      }
      sent += bytes.length;
      post("audio-chunk", { id: id, seq: seq++, data: bytesToB64(bytes) });
      setTimeout(next, 0);
    })();
  }
  function stopFeed() { feed = null; }

  // ---------------------------------------------------------------- fill-screen
  // The stage's fullscreen button: IINA enables neither the webview's
  // element-fullscreen API nor a plugin window-fullscreen call, so the
  // plugin emulates it — borderless window sized to the display. Exit
  // restores the standard 1440x900 frame, centered (the API offers no way
  // to read the frame the user had dragged the window to).
  var fillScreenOn = false, fillScreenDims = null;
  function exitFillScreen() {
    if (!fillScreenOn) return;
    fillScreenOn = false;
    if (!stage) return;
    try {
      stage.setProperty({ hideTitleBar: false });
      var sw = fillScreenDims ? fillScreenDims.w : 1920, sh = fillScreenDims ? fillScreenDims.h : 1080;
      var w = Math.min(1440, sw), h = Math.min(900, sh);
      stage.setFrame(w, h, Math.max(0, Math.round((sw - w) / 2)), Math.max(0, Math.round((sh - h) / 2)));
      log("fill-screen off -> " + w + "x" + h + " centered");
    } catch (e) { log("exitFillScreen: " + e); }
  }

  // ---------------------------------------------------------------- messages from the stage
  var cycleElapsed = 0;
  var HANDLERS = {
    ready: function () { acked = true; pushInit(); log("stage ready"); },
    "set-preset": function (d) {
      if (d && d.local) {
        if (d.name && d.name !== S.preset) {
          S.preset = d.name;
          persist(["preset"]);
          post("settings", settingsPayload());
          cycleElapsed = 0;
          log("preset -> " + d.name + " (stage-local)");
        }
        return;
      }
      setPreset(d.name, "picker");
    },
    "cycle-step": function (d) { if (d && d.dir === -1) stepPrev(); else stepNext("stage"); },
    "random-preset": function () {
      if (pool.length) setPreset(pool[Math.floor(Math.random() * pool.length)], "stage-random");
    },
    "set-pool": function (d) {
      if (Array.isArray(d.names)) { pool = d.names.slice(); refillBag(); log("pool: " + pool.length + " (" + (d.collection || "") + ")"); }
    },
    "set-setting": function (d) {
      if (!d || !(d.key in DEFAULTS)) return;
      if (d.key === "cycleSeconds") d.value = Math.max(5, Math.min(600, Number(d.value) || 30));
      if (d.key === "blendSeconds") d.value = Math.max(0, Math.min(10, Number(d.value) || 0));
      S[d.key] = d.value;
      persist([d.key]);
      post("settings", settingsPayload());
      log("setting " + d.key + " = " + JSON.stringify(d.value));
    },
    "toggle-favorite": function (d) {
      var name = d.name || S.preset; if (!name) return;
      var i = S.favorites.indexOf(name);
      if (d && d.local && typeof d.state === "boolean") {
        if (d.state && i < 0) S.favorites.unshift(name);
        else if (!d.state && i >= 0) S.favorites.splice(i, 1);
        persist(["favorites"]);
        post("settings", settingsPayload());
        return;
      }
      if (i >= 0) S.favorites.splice(i, 1); else S.favorites.unshift(name);
      persist(["favorites"]);
      post("settings", settingsPayload());
      post("toast", { text: i >= 0 ? "Removed from favorites" : "★ Added to favorites" });
    },
    control: function (d) {
      try {
        if (d.action === "toggle-pause") { if (gf("pause", true)) iina.core.resume(); else iina.core.pause(); }
        else if (d.action === "next-track") iina.mpv.command("playlist-next", []);
        else if (d.action === "prev-track") iina.mpv.command("playlist-prev", []);
        else if (d.action === "seek" && typeof d.seconds === "number") iina.core.seek(d.seconds, false);
        else if (d.action === "set-volume" && typeof d.value === "number") iina.mpv.set("volume", Math.max(0, Math.min(100, d.value)));
      } catch (e) { log("control: " + e); }
    },
    key: function (d) {
      if (d.key === "space") HANDLERS.control({ action: "toggle-pause" });
      else if (d.key === "n") stepNext("key");
      else if (d.key === "b") stepPrev();
      else if (d.key === "f") HANDLERS["toggle-favorite"]({});
    },
    "viz-log": function (d) { log("[stage] " + (d.text || "")); },
    "request-audio": function (d) {
      var st = snapshot();
      if (!d || !d.path || d.path !== st.path) { log("request-audio for stale path ignored"); return; }
      feedAudio(d.id, d.path);
    },
    "toggle-fullscreen": function (d) {
      if (!stage) return;
      if (d && d.on) {
        var sw = (d.screen && d.screen.width) || 1920, sh = (d.screen && d.screen.height) || 1080;
        fillScreenDims = { w: sw, h: sh };
        try {
          stage.setProperty({ hideTitleBar: true, fullSizeContentView: true });
          stage.setFrame(sw, sh, 0, 0);
          fillScreenOn = true;
          log("fill-screen on: " + sw + "x" + sh);
        } catch (e) { log("toggle-fullscreen: " + e); }
      } else {
        exitFillScreen();
      }
    },
    bye: function () {
      exitFillScreen();
      stageOpen = false;
      var st = snapshot();
      closedForPath = st.path || null;
      log("stage closed by user for: " + closedForPath);
    },
  };
  var handlersRegistered = false;
  function registerHandlers() {
    if (!stage) { try { stage = iina.standaloneWindow; } catch (e) {} }
    if (handlersRegistered || !stage) return;
    handlersRegistered = true;
    Object.keys(HANDLERS).forEach(function (name) {
      try {
        stage.onMessage(name, function (data) {
          try { HANDLERS[name](data || {}); } catch (e) { log("handler " + name + ": " + e); }
        });
      } catch (e) { log("onMessage " + name + ": " + e); }
    });
  }

  // ---------------------------------------------------------------- menu
  function item(title, action) {
    try { iina.menu.addItem(iina.menu.item(title, action, {})); } catch (e) { log("menu: " + e); }
  }
  function sep() { try { iina.menu.addItem(iina.menu.separator()); } catch (e) {} }
  function initMenu() {
    item("Open MilkDrop Visualizer Window", function () { openStage(true); });
    item("Preset Picker…", function () { openStage(true); post("open-picker", {}); });
    sep();
    item("Next Preset", function () { stepNext("menu"); });
    item("Previous Preset", function () { stepPrev(); });
    item("Random Preset", function () {
      if (pool.length) setPreset(pool[Math.floor(Math.random() * pool.length)], "menu-random");
    });
    item("★ Favorite Current Preset", function () { HANDLERS["toggle-favorite"]({}); });
    sep();
    item("Auto-Launch on Music: Toggle", function () {
      S.autoLaunch = !S.autoLaunch; persist(["autoLaunch"]);
      try { iina.core.osd("MilkDrop auto-launch: " + (S.autoLaunch ? "on" : "off")); } catch (e) {}
    });
    item("Cycle Presets: Toggle", function () {
      S.cycle = !S.cycle; persist(["cycle"]);
      post("settings", settingsPayload());
      try { iina.core.osd("MilkDrop cycling: " + (S.cycle ? "on" : "off")); } catch (e) {}
    });
    item("Random Preset Order: Toggle", function () {
      S.random = !S.random; persist(["random"]);
      post("settings", settingsPayload());
      try { iina.core.osd("MilkDrop random order: " + (S.random ? "on" : "off")); } catch (e) {}
    });
    sep();
    [["file", "Audio Source: Playing File (synced)"], ["mic", "Audio Source: Microphone / System"], ["ambient", "Audio Source: Ambient Beat"]]
      .forEach(function (s) {
        item(s[1], function () {
          S.audioSource = s[0]; persist(["audioSource"]);
          post("settings", settingsPayload());
          try { iina.core.osd("MilkDrop audio: " + s[0]); } catch (e) {}
        });
      });
    sep();
    item("Diagnostics (Log Viewer)", function () {
      var st = snapshot();
      log("DIAG v" + VERSION + " stageLoaded=" + stageLoaded + " stageOpen=" + stageOpen +
        " acked=" + acked + " pool=" + pool.length + " preset=" + (S.preset || "(none)") +
        " audioOnly=" + st.audioOnly + " hasMedia=" + st.hasMedia + " path=" + (st.path || "(none)"));
      try { iina.core.osd("MilkDrop diag in Log Viewer — pool " + pool.length + ", audioOnly " + st.audioOnly); } catch (e) {}
    });
  }

  // ---------------------------------------------------------------- loop + init
  var lastStatePush = 0, lastInitPush = 0;
  function tick() {
    try {
      var st = snapshot();
      var now = Date.now();
      if (st.path !== lastPath) {
        lastPath = st.path;
        if (feed && feed.path !== st.path) stopFeed();
        cycleElapsed = 0;
        if (S.cycle) setTimeout(function () { stepNext("track"); }, 1000);
      }
      // Auto-launch: music started → stage appears (once per track, and never
      // again for a track the user explicitly closed the window on).
      if (S.autoLaunch && st.hasMedia && st.audioOnly && !stageOpen && closedForPath !== st.path) {
        log("auto-launching stage for: " + st.path);
        openStage(false);
      }
      if (stageOpen && S.cycle && st.playing) {
        cycleElapsed += 0.5;
        if (cycleElapsed >= S.cycleSeconds) { cycleElapsed = 0; stepNext("cycle"); }
      }
      if (stageLoaded && !acked && now - lastInitPush > 2000) { lastInitPush = now; pushInit(); }
      if (stageOpen && now - lastStatePush > 500) { lastStatePush = now; post("state", st); }
    } catch (e) { log("tick: " + e); }
  }

  function init() {
    loadSettings();
    initMenu();
    var boot = function () {
      loadStage();
      registerHandlers();
      setTimeout(pushInit, 600);
    };
    try { iina.event.on("iina.window-loaded", boot); } catch (e) { log("window-loaded: " + e); }
    setTimeout(function () { if (!stageLoaded) { log("window-loaded fallback"); boot(); } }, 2500);
    try {
      iina.event.on("iina.music-mode.changed", function (s) { musicModeFlag = !!s; });
    } catch (e) {}
    setInterval(tick, 500);
    log("initialized v" + VERSION);
  }

  try { init(); } catch (e) { log("FATAL: " + e); }
})();
