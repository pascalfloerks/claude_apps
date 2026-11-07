// Loop Catcher – main application.
'use strict';

const $ = (id) => document.getElementById(id);
const TAURI = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__ : null;
const invoke = TAURI ? TAURI.core.invoke : null;

/* =============================================================================================
   State
============================================================================================= */
const LS_KEY = 'loopcatcher.settings.v1';
const defaults = {
  srcType: TAURI ? 'loopback' : 'input', inDev: '', loopDev: '', outDev: '', recChannels: 2, sampleRate: 0, latency: 'interactive',
  monitor: false, metroRec: false, detect: true, round: true, returnOnStop: true, stereoView: true,
  vol: 85, pan: 0, panBothEars: false, metroVol: 60, pattern: '{name}_{date}_{time}', bits: 24, saveMeta: true, saveDir: '', autoSave: false, counter: 1,
  division: '0.5', snap: true, showGrid: true, follow: true,
  speedPresets: [], trainer: { start: 70, target: 100, step: 5, every: 2, unit: 'loops', atTarget: 'hold' },
};
const settings = Object.assign({}, defaults, loadSettings());
function loadSettings() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { /* storage unavailable */ } }

const S = {
  sr: 48000, channels: null, len: 0, trackStart: 0,
  name: 'Recording', fileName: 'Untitled', dirty: false,
  cursor: 0, playing: false, playStart: 0, playPos: 0, lastMsg: null,
  recording: false,
  inPt: null, outPt: null, loop: false,
  markers: [], sections: [],
  grid: { bpm: 120, beats: 4, offset: 0 },
  metro: false, speed: 1,
  view: { start: 0, spp: 0.01 },
  selected: null, // { kind: 'marker'|'section', id }
  beatTimes: null,
};
let uid = 1;
const SECTION_COLORS = ['#E07A5F', '#5EC3CA', '#81B29A', '#F2CC8F', '#9C89B8', '#F28482', '#6D9DC5', '#C8B560'];

const audioDur = () => (S.len ? S.len / S.sr : 0);
const dur = () => (S.len ? S.trackStart + audioDur() : 0); // timeline end of the track block
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* =============================================================================================
   Audio engine
============================================================================================= */
let ctx = null, player = null, musicGain, bal, clickGain, analyser, outLevelBuf;
let playData = null; // channels resampled to the context rate (or S.channels when rates match)
let audioReady = null;

async function ensureAudio() {
  if (ctx) { if (ctx.state === 'suspended') await ctx.resume(); return; }
  if (audioReady) return audioReady;
  audioReady = (async () => {
    const opts = { latencyHint: settings.latency };
    if (+settings.sampleRate) opts.sampleRate = +settings.sampleRate;
    try { ctx = new AudioContext(opts); } catch (e) { ctx = new AudioContext(); }
    const code = `(${lcWorkletModule.toString()})()`;
    try { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))); }
    catch (e) { await ctx.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(code)); } // file:// pages
    player = new AudioWorkletNode(ctx, 'lc-player', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 2] });
    musicGain = ctx.createGain(); clickGain = ctx.createGain();
    // Balance: a 2x2 matrix from the track's L/R channels to the L/R outputs (see applyMix)
    bal = { split: ctx.createChannelSplitter(2), merge: ctx.createChannelMerger(2), LL: ctx.createGain(), LR: ctx.createGain(), RL: ctx.createGain(), RR: ctx.createGain() };
    bal.split.connect(bal.LL, 0); bal.split.connect(bal.LR, 0); bal.split.connect(bal.RL, 1); bal.split.connect(bal.RR, 1);
    bal.LL.connect(bal.merge, 0, 0); bal.RL.connect(bal.merge, 0, 0); bal.LR.connect(bal.merge, 0, 1); bal.RR.connect(bal.merge, 0, 1);
    analyser = ctx.createAnalyser(); analyser.fftSize = 2048; outLevelBuf = new Float32Array(analyser.fftSize);
    player.connect(musicGain, 0); musicGain.connect(bal.split); bal.merge.connect(analyser); analyser.connect(ctx.destination);
    player.connect(clickGain, 1); clickGain.connect(ctx.destination);
    player.port.onmessage = (e) => onPlayerMsg(e.data);
    applyMix();
    await applyOutputDevice();
    if (ctx.state === 'suspended') await ctx.resume();
    sendMetro();
    await updatePlayerData();
    $('stRate').textContent = `${(ctx.sampleRate / 1000).toFixed(1)} kHz`;
  })();
  try { await audioReady; } finally { audioReady = null; }
}

async function restartAudio() {
  const wasPlaying = S.playing;
  if (S.playing) stop();
  if (ctx) { try { await ctx.close(); } catch (e) { /* ignore */ } }
  ctx = null; player = null;
  await ensureAudio();
  if (wasPlaying) play();
}

function applyMix() {
  if (!ctx) return;
  const t = ctx.currentTime;
  musicGain.gain.setTargetAtTime(Math.pow(settings.vol / 100, 2) * 1.0, t, 0.02);
  // p < 0 fades out the right channel, p > 0 the left one.
  //  default:    the remaining channel stays on its own side (true balance)
  //  both ears:  the remaining channel moves into both outputs
  const p = settings.pan / 100, k = Math.abs(p);
  let LL = 1, LR = 0, RL = 0, RR = 1;
  if (!settings.panBothEars) { if (p < 0) RR = 1 - k; else LL = 1 - k; }
  else if (p < 0) { RR = 1 - k; LR = k; }
  else { LL = 1 - k; RL = k; }
  for (const [g, v] of [[bal.LL, LL], [bal.LR, LR], [bal.RL, RL], [bal.RR, RR]]) g.gain.setTargetAtTime(v, t, 0.02);
  clickGain.gain.setTargetAtTime(1, t, 0.02);
}

async function applyOutputDevice() {
  if (!ctx || typeof ctx.setSinkId !== 'function') return;
  try { await ctx.setSinkId(settings.outDev || ''); } catch (e) { setMsg('Could not use that output device: ' + e.message, true); }
}

async function resample(channels, fromSr, toSr) {
  if (fromSr === toSr) return channels;
  const len = Math.max(1, Math.round(channels[0].length * toSr / fromSr));
  const off = new OfflineAudioContext(channels.length, len, toSr);
  const buf = off.createBuffer(channels.length, channels[0].length, fromSr);
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  return Array.from({ length: channels.length }, (_, i) => out.getChannelData(i).slice());
}

async function updatePlayerData() {
  if (!player) return;
  if (!S.channels) { playData = null; player.port.postMessage({ type: 'buffer', channels: [new Float32Array(1)] }); return; }
  playData = await resample(S.channels, S.sr, ctx.sampleRate);
  sendOrigin();
  player.port.postMessage({ type: 'buffer', channels: playData });
  sendLoop();
}

const toCtx = (sec) => Math.round(sec * (ctx ? ctx.sampleRate : S.sr));

function sendOrigin() { if (player) player.port.postMessage({ type: 'origin', origin: toCtx(S.trackStart) }); }

function loopRange() {
  const d = dur();
  let a = S.inPt != null ? S.inPt : S.trackStart, b = S.outPt != null ? S.outPt : d;
  if (b < a) [a, b] = [b, a];
  return [clamp(a, 0, d), clamp(b, 0, d)];
}

function sendLoop() {
  if (!player) return;
  const [a, b] = loopRange();
  player.port.postMessage({ type: 'loop', on: S.loop && b - a > 0.05, start: toCtx(a), end: toCtx(b) });
}
function sendMetro() {
  if (!player) return;
  player.port.postMessage({ type: 'metro', cfg: { on: S.metro, bpm: S.grid.bpm, offset: S.grid.offset, beats: S.grid.beats, vol: Math.pow(settings.metroVol / 100, 1.5), accent: true } });
}
function sendSpeed() { if (player) player.port.postMessage({ type: 'speed', speed: S.speed }); }

function onPlayerMsg(m) {
  if (m.type === 'wrap') { trainerOnWrap(); return; }
  if (m.type !== 'pos') return;
  S.lastMsg = { pos: m.pos / ctx.sampleRate, t: m.t };
  if (m.playing) trainerOnPos(S.lastMsg.pos);
  if (m.ended && S.playing) {
    S.playing = false; S.cursor = settings.returnOnStop ? S.playStart : dur();
    updateTransportUI(); requestDraw();
  }
}

function currentPos() {
  if (S.playing && S.lastMsg && ctx) {
    const lat = (ctx.outputLatency || ctx.baseLatency || 0);
    let p = S.lastMsg.pos + (ctx.currentTime - S.lastMsg.t - lat) * S.speed;
    if (S.loop) { const [a, b] = loopRange(); if (S.lastMsg.pos < b && p >= b && b > a) p = a + (p - b) % (b - a); }
    return clamp(p, 0, dur());
  }
  return S.cursor;
}

async function play() {
  if (!S.channels || S.recording) return;
  await ensureAudio();
  if (!playData) await updatePlayerData();
  let start = S.cursor;
  const [a, b] = loopRange();
  if (S.loop && (start < a || start >= b - 0.01)) start = a;
  if (start >= dur() - 0.01) start = S.loop ? a : S.trackStart;
  S.playStart = start; S.cursor = start;
  sendLoop(); sendSpeed(); sendMetro();
  player.port.postMessage({ type: 'play', pos: toCtx(start) });
  S.lastMsg = { pos: start, t: ctx.currentTime };
  S.playing = true;
  updateTransportUI();
}

function stop() {
  if (!S.playing) return;
  const p = currentPos();
  player.port.postMessage({ type: 'stop' });
  S.playing = false;
  S.cursor = settings.returnOnStop ? S.playStart : p;
  updateTransportUI(); requestDraw();
}

function togglePlay() { if (S.recording) { stopRecording(); return; } S.playing ? stop() : play(); }

function seek(t) {
  t = clamp(t, 0, dur());
  S.cursor = t;
  if (S.playing && player) {
    player.port.postMessage({ type: 'seek', pos: toCtx(t) });
    S.lastMsg = { pos: t, t: ctx.currentTime }; S.playStart = t;
  }
  requestDraw();
}

/* =============================================================================================
   Recording
============================================================================================= */
const REC = { stream: null, srcNode: null, node: null, monitor: null, chunks: [[], []], total: 0, sr: 48000, peaks: null, native: false, testing: false, nativeChannels: 2 };
const REC_BIN = 256;

function newRecPeaks() {
  const cap = 1 << 14;
  return { n: 0, min: [new Float32Array(cap), new Float32Array(cap)], max: [new Float32Array(cap), new Float32Array(cap)], accN: 0, accMin: [1, 1], accMax: [-1, -1] };
}
function pushRecPeaks(l, r) {
  const P = REC.peaks;
  for (let i = 0; i < l.length; i++) {
    const a = l[i], b = r[i];
    if (a < P.accMin[0]) P.accMin[0] = a; if (a > P.accMax[0]) P.accMax[0] = a;
    if (b < P.accMin[1]) P.accMin[1] = b; if (b > P.accMax[1]) P.accMax[1] = b;
    if (++P.accN === REC_BIN) {
      if (P.n === P.min[0].length) for (let c = 0; c < 2; c++) {
        const nm = new Float32Array(P.n * 2); nm.set(P.min[c]); P.min[c] = nm;
        const nx = new Float32Array(P.n * 2); nx.set(P.max[c]); P.max[c] = nx;
      }
      for (let c = 0; c < 2; c++) { P.min[0 + c][P.n] = P.accMin[c]; P.max[c][P.n] = P.accMax[c]; P.accMin[c] = 1; P.accMax[c] = -1; }
      P.n++; P.accN = 0;
    }
  }
}

let meterLevel = [0, 0];
function onRecData(l, r) {
  if (S.recording) {
    REC.chunks[0].push(l); REC.chunks[1].push(r); REC.total += l.length;
    pushRecPeaks(l, r);
  }
}

async function openInput() {
  await ensureAudio();
  const type = settings.srcType;
  if (type === 'loopback' && TAURI) {
    REC.native = true;
    const chan = new TAURI.core.Channel();
    chan.onmessage = (msg) => onNativeData(msg);
    const info = await invoke('loopback_start', { device: settings.loopDev || null, onData: chan });
    REC.sr = info.sample_rate; REC.nativeChannels = info.channels;
    $('stSource').textContent = 'Loopback: ' + info.device;
    return;
  }
  REC.native = false;
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: +settings.recChannels } };
  if (type === 'display') {
    if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Tab / screen audio capture is not supported here.');
    REC.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio, systemAudio: 'include', selfBrowserSurface: 'exclude' });
    REC.stream.getVideoTracks().forEach((t) => t.stop());
    if (!REC.stream.getAudioTracks().length) throw new Error('No audio was shared. Tick "Share audio" (or "Share system audio") in the picker.');
    $('stSource').textContent = 'Shared audio';
  } else {
    if (settings.inDev) audio.deviceId = { exact: settings.inDev };
    REC.stream = await navigator.mediaDevices.getUserMedia({ audio });
    const tr = REC.stream.getAudioTracks()[0];
    $('stSource').textContent = (tr && tr.label) || 'Input';
  }
  REC.sr = ctx.sampleRate;
  REC.srcNode = ctx.createMediaStreamSource(REC.stream);
  REC.node = new AudioWorkletNode(ctx, 'lc-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  REC.node.port.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'data') onRecData(d.l, d.r);
    else if (d.type === 'meter') { meterLevel[0] = Math.max(meterLevel[0], d.l); meterLevel[1] = Math.max(meterLevel[1], d.r); }
    else if (d.type === 'stopped' && REC.onStopped) { REC.onStopped(); REC.onStopped = null; }
  };
  REC.monitor = ctx.createGain();
  REC.monitor.gain.value = 0;
  REC.srcNode.connect(REC.node); REC.node.connect(REC.monitor); REC.monitor.connect(ctx.destination);
  REC.stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => { if (S.recording) { setMsg('The audio source ended.'); stopRecording(); } }));
}

function onNativeData(msg) {
  let buf = msg;
  if (Array.isArray(msg)) buf = new Uint8Array(msg).buffer;
  else if (msg && msg.buffer && !(msg instanceof ArrayBuffer)) buf = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength);
  if (!(buf instanceof ArrayBuffer)) return;
  const f = new Float32Array(buf), nc = REC.nativeChannels || 2, n = Math.floor(f.length / nc);
  const l = new Float32Array(n), r = new Float32Array(n);
  let pl = 0, pr = 0;
  for (let i = 0; i < n; i++) {
    l[i] = f[i * nc]; r[i] = nc > 1 ? f[i * nc + 1] : l[i];
    const a = Math.abs(l[i]), b = Math.abs(r[i]); if (a > pl) pl = a; if (b > pr) pr = b;
  }
  meterLevel[0] = Math.max(meterLevel[0], pl); meterLevel[1] = Math.max(meterLevel[1], pr);
  onRecData(l, r);
}

async function closeInput() {
  if (REC.native) {
    try { await invoke('loopback_stop'); } catch (e) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 150)); // let the last block arrive
    REC.native = false;
  }
  if (REC.node) { try { REC.srcNode.disconnect(); REC.node.disconnect(); REC.monitor.disconnect(); } catch (e) { /* ignore */ } }
  if (REC.stream) REC.stream.getTracks().forEach((t) => t.stop());
  REC.stream = REC.srcNode = REC.node = REC.monitor = null;
}

async function startRecording() {
  if (S.recording) return;
  if (S.dirty && S.channels && !confirm('The current track has unsaved changes. Record a new take and discard it?')) return;
  if (S.playing) stop();
  if (REC.testing) await stopTest();
  try {
    await openInput();
  } catch (e) {
    await closeInput();
    setMsg(recordErrorText(e), true);
    return;
  }
  REC.chunks = [[], []]; REC.total = 0; REC.peaks = newRecPeaks();
  // clear the timeline for the new take (restored if nothing gets recorded)
  REC.backup = S.channels ? { snap: snapshot(), name: S.name, fileName: S.fileName, dirty: S.dirty, beatTimes: S.beatTimes } : null;
  S.channels = null; S.len = 0; S.markers = []; S.sections = []; S.inPt = S.outPt = null; S.cursor = 0; S.beatTimes = null;
  S.view.start = 0; S.view.spp = 10 / Math.max(1, W);
  if (REC.monitor) REC.monitor.gain.value = settings.monitor ? 1 : 0;
  if (REC.node) REC.node.port.postMessage({ type: 'start' });
  S.recording = true; S.recStartT = performance.now();
  S.selected = null;
  if (settings.metroRec && S.metro) player.port.postMessage({ type: 'freeClock', on: true });
  $('emptyHint').hidden = true;
  updateTransportUI(); setMsg('Recording…'); requestDraw();
}

function recordErrorText(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError') return 'Access to the audio source was refused or cancelled.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'The selected input device was not found. Choose another one in Audio setup.';
  return 'Could not start recording: ' + ((e && e.message) || e);
}

async function stopRecording() {
  if (!S.recording) return;
  if (REC.node) await new Promise((res) => { REC.onStopped = res; REC.node.port.postMessage({ type: 'stop' }); setTimeout(res, 500); });
  S.recording = false;
  if (player) player.port.postMessage({ type: 'freeClock', on: false });
  await closeInput();
  updateTransportUI();
  const n = REC.total;
  if (n < 64) {
    setMsg('Nothing was recorded. Check the source in Audio setup.', true); REC.peaks = null;
    const b = REC.backup; REC.backup = null;
    if (b) { restore(b.snap); S.name = b.name; S.fileName = b.fileName; S.dirty = b.dirty; S.beatTimes = b.beatTimes; zoomFit(); }
    requestDraw(); refreshEmpty(); return;
  }
  REC.backup = null;
  const mono = +settings.recChannels === 1;
  const outCh = mono ? [new Float32Array(n)] : [new Float32Array(n), new Float32Array(n)];
  let o = 0;
  for (let k = 0; k < REC.chunks[0].length; k++) {
    const l = REC.chunks[0][k], r = REC.chunks[1][k];
    if (mono) { for (let i = 0; i < l.length; i++) outCh[0][o + i] = 0.5 * (l[i] + r[i]); }
    else { outCh[0].set(l, o); outCh[1].set(r, o); }
    o += l.length;
  }
  REC.chunks = [[], []]; REC.peaks = null;
  const keepGrid = { ...S.grid };
  undoStack.length = 0; redoStack.length = 0;
  loadTrack(outCh, REC.sr, { name: 'Recording', fileName: 'Untitled', dirty: true, grid: keepGrid });
  setMsg(`Recorded ${fmtTime(dur())}.`);
  if (settings.detect && dur() > 6) await detectBeats(true);
  if (TAURI && settings.autoSave && settings.saveDir) await saveWav({ auto: true });
}

async function toggleRecord() { S.recording ? stopRecording() : startRecording(); }

// "Test" in Audio setup: open the input and show its level without recording.
async function startTest() {
  if (S.recording || REC.testing) return;
  try { await openInput(); REC.testing = true; $('btnTest').classList.add('on'); $('btnTest').textContent = 'Stop'; }
  catch (e) { await closeInput(); setSrcNote(recordErrorText(e), true); }
}
async function stopTest() {
  if (!REC.testing) return;
  REC.testing = false; await closeInput();
  $('btnTest').classList.remove('on'); $('btnTest').textContent = 'Test';
}

/* =============================================================================================
   Track loading, peaks
============================================================================================= */
const peakCache = new WeakMap();
function buildPeaks(channels) {
  if (peakCache.has(channels)) return peakCache.get(channels);
  const levels = [];
  let spb = 256;
  const n = channels[0].length;
  // level 0 from samples
  const l0 = { spb, min: [], max: [] };
  for (const c of channels) {
    const bins = Math.ceil(n / spb), mn = new Float32Array(bins), mx = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      let lo = 1, hi = -1; const e = Math.min(n, (b + 1) * spb);
      for (let i = b * spb; i < e; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      mn[b] = lo; mx[b] = hi;
    }
    l0.min.push(mn); l0.max.push(mx);
  }
  levels.push(l0);
  while (levels[levels.length - 1].min[0].length > 64) {
    const p = levels[levels.length - 1], q = { spb: p.spb * 4, min: [], max: [] };
    for (let c = 0; c < p.min.length; c++) {
      const bins = Math.ceil(p.min[c].length / 4), mn = new Float32Array(bins), mx = new Float32Array(bins);
      for (let b = 0; b < bins; b++) {
        let lo = 1, hi = -1;
        for (let k = b * 4; k < Math.min(p.min[c].length, b * 4 + 4); k++) { if (p.min[c][k] < lo) lo = p.min[c][k]; if (p.max[c][k] > hi) hi = p.max[c][k]; }
        mn[b] = lo; mx[b] = hi;
      }
      q.min.push(mn); q.max.push(mx);
    }
    levels.push(q);
  }
  peakCache.set(channels, levels);
  return levels;
}

function loadTrack(channels, sr, o = {}) {
  if (S.playing) stop();
  S.channels = channels; S.sr = sr; S.len = channels[0].length;
  S.name = o.name || S.name; S.fileName = o.fileName || S.fileName; S.dirty = !!o.dirty;
  S.inPt = S.outPt = null; S.cursor = 0; S.selected = null; S.beatTimes = null;
  S.trackStart = Math.max(0, o.trackStart || 0);
  S.markers = (o.markers || []).map((m) => ({ id: uid++, time: m.time, name: m.name }));
  S.sections = (o.sections || []).map((s, i) => ({ id: uid++, start: s.start, end: s.end, name: s.name, color: s.color || SECTION_COLORS[i % SECTION_COLORS.length] }));
  if (o.grid) Object.assign(S.grid, o.grid);
  if (o.loop != null) S.loop = o.loop;
  if (o.inPt != null) S.inPt = o.inPt;
  if (o.outPt != null) S.outPt = o.outPt;
  if (o.cursor != null) S.cursor = o.cursor;
  if (o.speed) setSpeed(o.speed);
  buildPeaks(channels);
  zoomFit();
  syncGridUI(); updateTransportUI(); updateStatus(); refreshEmpty();
  sendMetro();
  if (ctx) updatePlayerData();
  requestDraw();
}

// "New": back to an empty canvas
function newSession() {
  if (S.recording) return;
  if (S.dirty && S.channels && !confirm('Discard the current track, its markers and sections?')) return;
  if (S.playing) stop();
  trainerStop(true);
  S.channels = null; S.len = 0; S.trackStart = 0; S.markers = []; S.sections = []; S.inPt = S.outPt = null;
  S.cursor = 0; S.selected = null; S.beatTimes = null; S.loop = false;
  S.name = 'Recording'; S.fileName = 'Untitled'; S.dirty = false;
  S.grid = { bpm: 120, beats: 4, offset: 0 };
  undoStack.length = 0; redoStack.length = 0;
  setSpeed(1);
  if (ctx) updatePlayerData();
  S.view = { start: 0, spp: 0.01 }; clampView();
  syncGridUI(); sendMetro(); updateTransportUI(); updateStatus(); refreshEmpty(); requestDraw();
  setMsg('New empty session.');
}

function refreshEmpty() { $('emptyHint').hidden = !!(S.channels || S.recording); }

async function openFile(file) {
  if (!file) return;
  if (S.recording) return;
  if (S.dirty && S.channels && !confirm('Discard the current unsaved track and open this file?')) return;
  setMsg('Opening ' + file.name + '…');
  try {
    await ensureAudio();
    const ab = await file.arrayBuffer();
    const meta = lcReadWavMeta(ab);
    const buf = await ctx.decodeAudioData(ab.slice(0));
    const chans = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i).slice());
    const base = file.name.replace(/\.[^.]+$/, '');
    undoStack.length = 0; redoStack.length = 0;
    const isSession = !!(meta && meta.kind === 'session');
    loadTrack(chans, buf.sampleRate, {
      name: isSession && meta.name ? meta.name : base, fileName: file.name, dirty: false,
      markers: meta && meta.markers, sections: meta && meta.sections, grid: meta && meta.grid,
      ...(isSession ? { trackStart: meta.trackStart, inPt: meta.inPt, outPt: meta.outPt, loop: meta.loop, cursor: meta.cursor, speed: meta.speed } : {}),
    });
    if (isSession && meta.metro != null) { S.metro = !!meta.metro; sendMetro(); updateTransportUI(); }
    setMsg(isSession ? `Opened session ${file.name}` : `Opened ${file.name}` + (meta && (meta.markers || meta.sections) ? ' (with markers)' : ''));
  } catch (e) {
    setMsg('Could not open that file: ' + (e.message || e), true);
  }
}

/* =============================================================================================
   Undo / redo
============================================================================================= */
const undoStack = [], redoStack = [];
function snapshot() {
  return {
    channels: S.channels, sr: S.sr, trackStart: S.trackStart, inPt: S.inPt, outPt: S.outPt, grid: { ...S.grid }, beatTimes: S.beatTimes,
    markers: S.markers.map((m) => ({ ...m })), sections: S.sections.map((s) => ({ ...s })),
  };
}
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; S.dirty = true; updateUndoUI(); }
function restore(s) {
  const audioChanged = s.channels !== S.channels;
  S.channels = s.channels; S.sr = s.sr; S.len = s.channels ? s.channels[0].length : 0;
  const moved = s.trackStart !== S.trackStart;
  S.trackStart = s.trackStart || 0; S.beatTimes = s.beatTimes || null;
  S.inPt = s.inPt; S.outPt = s.outPt; S.grid = { ...s.grid };
  S.markers = s.markers.map((m) => ({ ...m })); S.sections = s.sections.map((x) => ({ ...x }));
  S.selected = null; S.cursor = clamp(S.cursor, 0, dur());
  if (audioChanged) { if (S.playing) stop(); if (ctx) updatePlayerData(); zoomFit(); }
  else if (moved) sendOrigin();
  S.dirty = true;
  syncGridUI(); sendMetro(); sendLoop(); updateStatus(); requestDraw();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); updateUndoUI(); setMsg('Undo'); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); updateUndoUI(); setMsg('Redo'); }
function updateUndoUI() { $('btnUndo').disabled = !undoStack.length; $('btnRedo').disabled = !redoStack.length; }

/* =============================================================================================
   Grid helpers
============================================================================================= */
const beatLen = () => 60 / S.grid.bpm;
const barLen = () => beatLen() * S.grid.beats;
function divLen() { return settings.division === 'bar' ? barLen() : beatLen() * parseFloat(settings.division); }
function snap(t, ev) {
  if (!settings.snap || (ev && ev.altKey) || !S.channels) return t;
  const d = divLen(), o = S.grid.offset;
  return o + Math.round((t - o) / d) * d;
}
function barBeat(t) {
  const b = beatLen(), rel = (t - S.grid.offset) / b;
  const beatIdx = Math.floor(rel + 1e-9), tick = Math.floor((rel - beatIdx) * 960);
  const bar = Math.floor(beatIdx / S.grid.beats), beat = beatIdx - bar * S.grid.beats;
  return `${bar + 1}.${beat + 1}.${String(tick).padStart(3, '0')}`;
}
function fmtTime(t, ms = true) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return ms ? `${m}:${s.toFixed(3).padStart(6, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

/* =============================================================================================
   Edit actions
============================================================================================= */
function setIn(t) {
  if (!S.channels) return;
  pushUndo();
  S.inPt = clamp(t, 0, dur());
  if (S.outPt != null && S.outPt < S.inPt) [S.inPt, S.outPt] = [S.outPt, S.inPt];
  afterSelChange();
}
function setOut(t) {
  if (!S.channels) return;
  pushUndo();
  S.outPt = clamp(t, 0, dur());
  if (S.inPt != null && S.outPt < S.inPt) [S.inPt, S.outPt] = [S.outPt, S.inPt];
  afterSelChange();
}
function clearIO() { if (S.inPt == null && S.outPt == null) return; pushUndo(); S.inPt = S.outPt = null; afterSelChange(); }
function afterSelChange() { sendLoop(); updateStatus(); requestDraw(); }
function selectRange(a, b, loop) {
  if (!S.channels) return;
  pushUndo();
  S.inPt = Math.min(a, b); S.outPt = Math.max(a, b);
  if (loop) { S.loop = true; updateTransportUI(); }
  afterSelChange();
}

function cropToSelection() {
  if (!S.channels) return;
  if (S.inPt == null && S.outPt == null) { setMsg('Set an In and/or Out point first (I / O).', true); return; }
  const [a, b] = loopRange();
  if (b - a < 0.05) { setMsg('The In→Out range is too short to crop.', true); return; }
  if (S.playing) stop();
  pushUndo();
  const s0 = clamp(Math.round((a - S.trackStart) * S.sr), 0, S.len), s1 = clamp(Math.round((b - S.trackStart) * S.sr), 0, S.len);
  if (s1 - s0 < S.sr * 0.05) { undoStack.pop(); setMsg('The In→Out range does not cover the track.', true); return; }
  S.channels = S.channels.map((c) => c.slice(s0, s1)); S.len = s1 - s0;
  S.trackStart += s0 / S.sr;
  const ta = S.trackStart, tb = dur();
  S.markers = S.markers.filter((m) => m.time >= ta && m.time <= tb);
  S.sections = S.sections.filter((s) => s.end > ta && s.start < tb).map((s) => ({ ...s, start: Math.max(ta, s.start), end: Math.min(tb, s.end) }));
  if (S.beatTimes) S.beatTimes = S.beatTimes.filter((t) => t >= ta && t <= tb);
  const d = tb - ta;
  S.inPt = S.outPt = null; S.cursor = ta;
  buildPeaks(S.channels);
  if (ctx) updatePlayerData();
  zoomFit(); syncGridUI(); sendMetro(); updateStatus(); requestDraw();
  setMsg(`Cropped to ${fmtTime(d)}.`);
}

function addMarker(t) {
  if (!S.channels) return;
  pushUndo();
  const m = { id: uid++, time: clamp(t, 0, dur()), name: `Marker ${S.markers.length + 1}` };
  S.markers.push(m); S.markers.sort((x, y) => x.time - y.time);
  S.selected = { kind: 'marker', id: m.id };
  requestDraw();
}
function addSection(a, b, push = true) {
  if (!S.channels) return null;
  if (push) pushUndo();
  const s = { id: uid++, start: Math.min(a, b), end: Math.max(a, b), name: `Section ${S.sections.length + 1}`, color: SECTION_COLORS[S.sections.length % SECTION_COLORS.length] };
  S.sections.push(s); S.sections.sort((x, y) => x.start - y.start);
  S.selected = { kind: 'section', id: s.id };
  requestDraw();
  return s;
}
function addSectionFromSelection() {
  if (!S.channels) return;
  if (S.inPt != null && S.outPt != null && S.outPt - S.inPt > 0.01) addSection(S.inPt, S.outPt);
  else {
    const bl = barLen(), o = S.grid.offset, t = currentPos();
    const a = o + Math.floor((t - o) / bl) * bl;
    addSection(clamp(a, 0, dur()), clamp(a + bl * 4, 0, dur()));
  }
}
function getSel() {
  if (!S.selected) return null;
  const list = S.selected.kind === 'marker' ? S.markers : S.sections;
  return list.find((x) => x.id === S.selected.id) || null;
}
function deleteSelected() {
  const it = getSel(); if (!it) return;
  pushUndo();
  if (S.selected.kind === 'marker') S.markers = S.markers.filter((m) => m !== it);
  else S.sections = S.sections.filter((s) => s !== it);
  S.selected = null; requestDraw();
}
async function renameSelected() {
  const it = getSel(); if (!it) return;
  const name = await promptText(S.selected.kind === 'marker' ? 'Rename marker' : 'Rename section', it.name);
  if (name == null || name === it.name) return;
  pushUndo(); it.name = name; requestDraw();
}
function selectSectionAndLoop(s) {
  S.selected = { kind: 'section', id: s.id };
  selectRange(s.start, s.end, true);
  if (S.playing) { if (S.cursor < s.start || currentPos() < s.start || currentPos() > s.end) seek(s.start); }
  else S.cursor = s.start;
  requestDraw();
}
function selectAll() { if (!S.channels) return; selectRange(S.trackStart, dur(), false); S.selected = null; }

// Move the track block (markers, sections and In/Out travel with the audio)
function moveTrackTo(start) {
  start = Math.max(0, start);
  const d = start - S.trackStart;
  if (Math.abs(d) < 1e-9) return;
  S.trackStart = start;
  for (const m of S.markers) m.time += d;
  for (const x of S.sections) { x.start += d; x.end += d; }
  if (S.inPt != null) S.inPt += d;
  if (S.outPt != null) S.outPt += d;
  if (S.beatTimes) S.beatTimes = S.beatTimes.map((t) => t + d);
  if (!S.playing) S.cursor = Math.max(0, S.cursor + d);
  sendOrigin(); sendLoop(); updateStatus(); requestDraw();
}

function jumpMarker(dir) {
  const t = currentPos();
  const pts = [0, S.trackStart, dur(), ...S.markers.map((m) => m.time), ...S.sections.map((s) => s.start)].sort((a, b) => a - b);
  let target = null;
  if (dir > 0) target = pts.find((p) => p > t + 0.01);
  else for (const p of pts) if (p < t - 0.05) target = p;
  if (target != null) { seek(target); ensureVisible(target); }
}

// Grid
function setBpm(v, push = true) {
  v = clamp(+v || 120, 20, 400);
  if (push) pushUndo();
  S.grid.bpm = Math.round(v * 100) / 100;
  syncGridUI(); sendMetro(); requestDraw();
}
function setOffset(v, push = true) {
  if (push) pushUndo();
  const bl = barLen();
  S.grid.offset = Math.round((((v % bl) + bl) % bl) * 10000) / 10000;
  syncGridUI(); sendMetro(); requestDraw();
}
const taps = [];
function tapTempo() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now); if (taps.length > 8) taps.shift();
  if (taps.length >= 2) {
    const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    setBpm(60000 / iv, taps.length === 2);
  }
  setMsg(`Tap tempo: ${taps.length < 2 ? 'keep tapping' : S.grid.bpm.toFixed(1) + ' BPM'}`);
}

let detecting = false;
async function detectBeats(auto = false) {
  if (!S.channels || detecting) return;
  detecting = true;
  $('btnDetect').disabled = true;
  setMsg('Detecting beats… <span class="progress"><i id="prog"></i></span>', false, true);
  const res = await lcDetectBeats(S.channels, S.sr, { beatsPerBar: S.grid.beats, round: settings.round }, (p) => { const el = $('prog'); if (el) el.style.width = Math.round(p * 100) + '%'; });
  detecting = false; $('btnDetect').disabled = false;
  if (res.error) { setMsg(res.error, true); return; }
  pushUndo();
  S.grid.bpm = Math.round(res.bpm * 100) / 100;
  const bl = 60 / S.grid.bpm * S.grid.beats, off = res.offset + S.trackStart;
  S.grid.offset = Math.round((((off % bl) + bl) % bl) * 10000) / 10000;
  S.beatTimes = res.beatTimes.map((t) => t + S.trackStart);
  syncGridUI(); sendMetro(); requestDraw();
  const conf = res.confidence > 0.6 ? 'high' : res.confidence > 0.3 ? 'medium' : 'low';
  setMsg(`${auto ? 'Beats detected' : 'Detected'}: ${S.grid.bpm} BPM, bar 1 at ${S.grid.offset.toFixed(3)} s (confidence ${conf}). Use ÷2 / ×2 or "Bar 1 here" to correct.`);
}

/* =============================================================================================
   Saving
============================================================================================= */
function sanitize(s) { return s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/\s+$/,'').replace(/^\.+/, '') || 'Recording'; }
function buildFileName(pattern, name, range) {
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const [a, b] = range === 'sel' ? loopRange() : [S.trackStart, dur()];
  const len = Math.max(0, Math.min(b, dur()) - Math.max(a, S.trackStart));
  const out = pattern
    .replace(/\{name\}/g, name || 'Recording')
    .replace(/\{date\}/g, `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`)
    .replace(/\{time\}/g, `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`)
    .replace(/\{bpm\}/g, String(Math.round(S.grid.bpm * 100) / 100))
    .replace(/\{n\}/g, String(settings.counter).padStart(3, '0'))
    .replace(/\{len\}/g, `${Math.floor(len / 60)}m${p2(Math.round(len % 60))}s`)
    .replace(/\{range\}/g, range === 'sel' ? 'sel' : 'full');
  return sanitize(out) + '.wav';
}

function openSaveDialog() {
  if (!S.channels) { setMsg('Nothing to save yet – record or open something first.', true); return; }
  if (S.playing) stop();
  $('saveName').value = S.name;
  $('savePattern').value = settings.pattern;
  $('saveBits').value = String(settings.bits);
  $('saveMeta').checked = settings.saveMeta;
  const hasSel = S.inPt != null || S.outPt != null;
  $('saveRange').querySelector('[value=sel]').disabled = !hasSel;
  $('saveRange').value = 'all';
  $('saveNative').hidden = !TAURI;
  $('saveDir').textContent = settings.saveDir || 'Ask every time';
  $('optAutoSave').checked = settings.autoSave;
  $('optAutoSave').disabled = !settings.saveDir;
  updateSavePreview();
  $('dlgSave').showModal();
  $('saveName').select();
}
function updateSavePreview() { $('savePreview').textContent = buildFileName($('savePattern').value || '{name}', $('saveName').value.trim(), $('saveRange').value); }

async function saveWav(o = {}) {
  const auto = !!o.auto;
  const name = auto ? S.name : ($('saveName').value.trim() || 'Recording');
  const pattern = auto ? settings.pattern : ($('savePattern').value || '{name}');
  const range = auto ? 'all' : $('saveRange').value;
  if (!auto) {
    settings.pattern = pattern; settings.bits = +$('saveBits').value; settings.saveMeta = $('saveMeta').checked; saveSettings();
  }
  const fileName = buildFileName(pattern, name, range);
  let [a, b] = range === 'sel' ? loopRange() : [S.trackStart, dur()];
  a = clamp(a, S.trackStart, dur()); b = clamp(b, S.trackStart, dur());
  if (b - a < 0.01) { setMsg('The In→Out range does not cover the track.', true); return false; }
  const s0 = Math.round((a - S.trackStart) * S.sr), s1 = Math.round((b - S.trackStart) * S.sr);
  const chans = S.channels.map((c) => c.subarray(s0, s1));
  let meta = null;
  if (settings.saveMeta) {
    const d = b - a;
    meta = {
      grid: { ...S.grid, offset: (((S.grid.offset - a) % barLen()) + barLen()) % barLen() },
      markers: S.markers.filter((m) => m.time >= a && m.time <= b).map((m) => ({ time: m.time - a, name: m.name })),
      sections: S.sections.filter((s) => s.end > a && s.start < b).map((s) => ({ start: Math.max(0, s.start - a), end: Math.min(d, s.end - a), name: s.name, color: s.color })),
    };
  }
  const bytes = lcEncodeWav(chans, S.sr, settings.bits, meta);
  try {
    let savedAs = fileName;
    if (TAURI) {
      const dir = settings.saveDir || '';
      const path = await invoke('save_audio_file', bytes, { headers: { 'x-file-name': encodeURIComponent(fileName), 'x-dir': encodeURIComponent(auto ? dir : dir) } });
      if (!path) { setMsg('Save cancelled.'); return false; }
      savedAs = path;
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const aEl = document.createElement('a'); aEl.href = url; aEl.download = fileName; document.body.appendChild(aEl); aEl.click(); aEl.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    settings.counter++; saveSettings();
    S.name = name;
    if (range === 'all') { S.dirty = false; S.fileName = savedAs.split(/[\\/]/).pop(); }
    updateStatus();
    setMsg(`Saved ${savedAs}`);
    return true;
  } catch (e) {
    setMsg('Saving failed: ' + (e.message || e), true);
    return false;
  }
}

// A session is a WAV file (32-bit float, lossless) that also carries the complete state:
// track position, grid, markers, sections, In/Out, loop, speed and metronome.
async function saveSession() {
  if (!S.channels) { setMsg('Nothing to save yet – record or open something first.', true); return false; }
  if (S.recording) return false;
  const state = {
    kind: 'session', name: S.name, trackStart: S.trackStart, grid: { ...S.grid },
    markers: S.markers.map((m) => ({ time: m.time, name: m.name })),
    sections: S.sections.map((x) => ({ start: x.start, end: x.end, name: x.name, color: x.color })),
    inPt: S.inPt, outPt: S.outPt, loop: S.loop, cursor: S.cursor, speed: S.speed, metro: S.metro,
  };
  // the cue points written for other programs are relative to the audio, so pass shifted copies for those
  const bytes = lcEncodeWav(S.channels, S.sr, 32, state, -S.trackStart);
  const fileName = sanitize(S.name) + '.lcsession';
  try {
    let savedAs = fileName;
    if (TAURI) {
      const path = await invoke('save_audio_file', bytes, { headers: { 'x-file-name': encodeURIComponent(fileName), 'x-dir': '', 'x-kind': 'session' } });
      if (!path) { setMsg('Save cancelled.'); return false; }
      savedAs = path;
    } else downloadBytes(bytes, fileName, 'application/octet-stream');
    S.dirty = false; S.fileName = savedAs.split(/[\\/]/).pop(); updateStatus();
    setMsg(`Session saved: ${savedAs}`);
    return true;
  } catch (e) { setMsg('Saving the session failed: ' + (e.message || e), true); return false; }
}
function downloadBytes(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const aEl = document.createElement('a'); aEl.href = url; aEl.download = name; document.body.appendChild(aEl); aEl.click(); aEl.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* =============================================================================================
   Speed presets & trainer
============================================================================================= */
const BUILTIN_PRESETS = [50, 60, 70, 75, 80, 85, 90, 95, 100, 105, 110, 125];
function fmtBpm(pct) { return `${Math.round(S.grid.bpm * pct) / 100} BPM`; }
function renderPresets() {
  const cur = Math.round(S.speed * 100);
  const mk = (pct, mine) => {
    const b = document.createElement('button'); b.className = 'btn' + (pct === cur ? ' on' : '');
    b.innerHTML = `<b>${pct}%</b><small>${fmtBpm(pct)}</small>`;
    b.onclick = (e) => { if (e.target.classList.contains('x')) return; setSpeed(pct / 100); renderPresets(); };
    if (mine) {
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove preset';
      x.onclick = () => { settings.speedPresets = settings.speedPresets.filter((p) => p !== pct); saveSettings(); renderPresets(); };
      b.append(x);
    }
    return b;
  };
  $('presetGrid').replaceChildren(...BUILTIN_PRESETS.map((p) => mk(p, false)));
  const mine = settings.speedPresets.slice().sort((a, b) => a - b);
  $('myPresetGrid').replaceChildren(...mine.map((p) => mk(p, true)));
  $('myPresetsHead').hidden = $('myPresetGrid').hidden = !mine.length;
  $('customPct').value = cur;
  $('targetBpm').value = Math.round(S.grid.bpm * S.speed * 10) / 10;
}
function toggleSpeedPop() {
  const pop = $('speedPop');
  if (!pop.hidden) { pop.hidden = true; return; }
  renderPresets();
  pop.hidden = false;
  const r = $('speedOut').getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left - 120, innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = (r.bottom + 6) + 'px';
}

const TR = { running: false, count: 0, acc: 0, lastPos: null, done: false };
function trainerCfg() { return settings.trainer; }
function trainerLabel() {
  const c = trainerCfg();
  return `${c.start}% → ${c.target}%, ${c.target >= c.start ? '+' : '−'}${c.step}% every ${c.every} ${c.unit === 'bars' ? (c.every === 1 ? 'bar' : 'bars') : (c.every === 1 ? 'loop' : 'loops')}`;
}
function openTrainer() {
  const c = trainerCfg();
  $('trStart').value = c.start; $('trTarget').value = c.target; $('trStep').value = c.step; $('trEvery').value = c.every;
  $('trUnit').value = c.unit; $('trAt').value = c.atTarget;
  $('trStop').hidden = !TR.running;
  updateTrainerSummary();
  $('dlgTrainer').showModal();
}
function readTrainerForm() {
  settings.trainer = {
    start: clamp(Math.round(+$('trStart').value || 70), 25, 150), target: clamp(Math.round(+$('trTarget').value || 100), 25, 150),
    step: clamp(Math.round(+$('trStep').value || 5), 1, 50), every: clamp(Math.round(+$('trEvery').value || 1), 1, 64),
    unit: $('trUnit').value, atTarget: $('trAt').value,
  };
  saveSettings();
}
function updateTrainerSummary() {
  readTrainerForm();
  const c = trainerCfg(), steps = Math.ceil(Math.abs(c.target - c.start) / c.step);
  let extra = '';
  if (c.unit === 'loops') { const [a, b] = loopRange(); if (S.channels && b > a) { let t = 0, sp = c.start; for (let i = 0; i <= steps; i++) { t += c.every * (b - a) / (sp / 100); sp = Math.min(c.target, sp + c.step); } extra = ` – about ${fmtTime(t, false)} until the target`; } }
  $('trSummary').textContent = `${trainerLabel()}: ${steps} step${steps === 1 ? '' : 's'}${extra}.`;
}
async function trainerStart() {
  if (!S.channels) { setMsg('Record or open a track first.', true); return; }
  const c = trainerCfg();
  TR.running = true; TR.count = 0; TR.acc = 0; TR.lastPos = null; TR.done = false;
  setSpeed(c.start / 100);
  if (c.unit === 'loops' && !S.loop) { S.loop = true; sendLoop(); }
  if (S.playing) stop();
  S.cursor = loopRange()[0];
  await play();
  updateTransportUI();
  setMsg(`Trainer: ${trainerLabel()}.`);
}
function trainerStop(silent) {
  if (!TR.running) return;
  TR.running = false; updateTransportUI();
  if (!silent) setMsg('Trainer stopped.');
}
function toggleTrainer() { TR.running ? trainerStop() : trainerStart(); }
function trainerStep() {
  const c = trainerCfg(), cur = Math.round(S.speed * 100), dir = c.target >= c.start ? 1 : -1;
  if (TR.done || (dir > 0 ? cur >= c.target : cur <= c.target)) {
    if (c.atTarget === 'restart') { setSpeed(c.start / 100); TR.done = false; setMsg(`Trainer: back to ${c.start}%.`); }
    else if (c.atTarget === 'stop') { stop(); trainerStop(true); setMsg(`Trainer finished at ${cur}%.`); }
    else TR.done = true;
    return;
  }
  const next = dir > 0 ? Math.min(c.target, cur + c.step) : Math.max(c.target, cur - c.step);
  setSpeed(next / 100);
  updateTransportUI();
  setMsg(`Trainer: ${next}% (${fmtBpm(next)})${next === c.target ? ' – target reached' : ''}.`);
}
function trainerOnWrap() {
  if (!TR.running || trainerCfg().unit !== 'loops') return;
  if (++TR.count >= trainerCfg().every) { TR.count = 0; trainerStep(); }
}
function trainerOnPos(pos) {
  if (!TR.running || trainerCfg().unit !== 'bars') { TR.lastPos = pos; return; }
  if (TR.lastPos != null) {
    let d = pos - TR.lastPos;
    if (d < 0 && S.loop) { const [a, b] = loopRange(); d = (b - TR.lastPos) + (pos - a); }
    if (d > 0 && d < 2) TR.acc += d;
    const need = trainerCfg().every * barLen();
    if (TR.acc >= need) { TR.acc -= need; trainerStep(); }
  }
  TR.lastPos = pos;
}

/* =============================================================================================
   Devices
============================================================================================= */
async function refreshDevices() {
  const inSel = $('inDev'), outSel = $('outDev');
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) { /* ignore */ }
  const ins = devs.filter((d) => d.kind === 'audioinput'), outs = devs.filter((d) => d.kind === 'audiooutput');
  inSel.innerHTML = '';
  inSel.append(new Option('System default input', ''));
  ins.filter((d) => d.deviceId && d.deviceId !== 'default').forEach((d, i) => inSel.append(new Option(d.label || `Input ${i + 1}`, d.deviceId)));
  inSel.value = [...inSel.options].some((o) => o.value === settings.inDev) ? settings.inDev : '';
  $('btnPerm').hidden = ins.some((d) => d.label);
  outSel.innerHTML = '';
  outSel.append(new Option('System default output', ''));
  outs.filter((d) => d.deviceId && d.deviceId !== 'default').forEach((d, i) => outSel.append(new Option(d.label || `Output ${i + 1}`, d.deviceId)));
  outSel.value = [...outSel.options].some((o) => o.value === settings.outDev) ? settings.outDev : '';
  const canSink = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  outSel.disabled = !canSink;
  if (!canSink) outSel.options[0].text = 'System default (choosing is not supported here)';
  if (TAURI) {
    const lsel = $('loopDev');
    try {
      const list = await invoke('loopback_devices');
      lsel.innerHTML = '';
      lsel.append(new Option('Default playback device', ''));
      list.forEach((d) => lsel.append(new Option(`${d.name}${d.is_default ? ' (default)' : ''} – ${d.sample_rate / 1000} kHz`, d.name)));
      lsel.value = [...lsel.options].some((o) => o.value === settings.loopDev) ? settings.loopDev : '';
    } catch (e) { lsel.innerHTML = ''; lsel.append(new Option('Loopback not available: ' + e, '')); }
  }
}

function updateSrcUI() {
  const t = settings.srcType;
  $('rowLoopDev').hidden = t !== 'loopback';
  $('rowInDev').hidden = t !== 'input';
  let note = '';
  if (t === 'loopback') note = 'Records everything you hear on the chosen playback device (YouTube, Spotify, a DAW, games …). Nothing else to set up.';
  else if (t === 'input') note = TAURI
    ? 'Microphone, line-in or audio interface. You can also pick a loopback input such as "Stereo Mix" or a virtual cable here.'
    : 'Microphone, line-in or audio interface. To record what your computer plays, pick a loopback input such as "Stereo Mix" (Windows), a virtual cable (VB-Cable), BlackHole (macOS) or a "Monitor of …" source (Linux) – or use "Browser tab / screen audio".';
  else note = 'When you press Record, a picker opens: choose a browser tab (and keep "Share tab audio" ticked) or, on Windows, "Entire screen" with "Share system audio" to record everything that plays.';
  setSrcNote(note);
}
function setSrcNote(t, err) { const n = $('srcNote'); n.textContent = t; n.style.color = err ? 'var(--rec)' : ''; }

/* =============================================================================================
   Drawing
============================================================================================= */
const tl = $('timeline'), cvB = $('cvBack'), cvF = $('cvFront'), cvO = $('cvOverview');
const gB = cvB.getContext('2d'), gF = cvF.getContext('2d'), gO = cvO.getContext('2d');
const RULER = 26, SECT = 24, MARK = 20, WAVE_TOP = RULER + SECT + MARK, HDR = 18;
let trackHover = false;
let W = 0, H = 0, DPR = 1, dirty = true, colors = {};

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['bg', 'panel', 'panel-2', 'panel-3', 'line', 'ink', 'muted', 'faint', 'accent', 'wave', 'wave-2', 'wave-bg', 'rec', 'play', 'cursor', 'sel', 'sel-edge', 'grid-bar', 'grid-beat', 'grid-sub', 'marker']) colors[k] = cs.getPropertyValue('--' + k).trim();
}
function resize() {
  DPR = window.devicePixelRatio || 1;
  const r = tl.getBoundingClientRect();
  W = Math.max(50, Math.floor(r.width)); H = Math.max(50, Math.floor(r.height));
  for (const c of [cvB, cvF]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
  const o = cvO.getBoundingClientRect();
  cvO.width = Math.round(o.width * DPR); cvO.height = Math.round(o.height * DPR);
  clampView(); requestDraw();
}
const xOf = (t) => (t - S.view.start) / S.view.spp;
const tOf = (x) => S.view.start + x * S.view.spp;
// Redraw only what changed: the waveform layer and overview when `dirty`, the cursor/hover
// layer when `fdirty`. The playhead is a DOM line moved with a CSS transform, so playback
// does not repaint any canvas.
let fdirty = true;
function requestDraw() { dirty = true; fdirty = true; }

function clampView() {
  const d = Math.max(dur(), S.recording ? REC.total / REC.sr : 0, 1);
  S.view.spp = clamp(S.view.spp, 1 / (S.sr * 4) * 4 / 4 || 1e-5, (d * 1.5) / Math.max(1, W));
  S.view.spp = Math.max(S.view.spp, 2e-5);
  const span = W * S.view.spp;
  S.view.start = clamp(S.view.start, -span * 0.05, Math.max(0, d - span * 0.9));
}
function zoomFit() { const d = Math.max(dur(), 1); S.view.spp = d / Math.max(1, W - 20); S.view.start = 0; clampView(); requestDraw(); }
function zoomBy(f, anchorX) {
  const ax = anchorX != null ? anchorX : (S.playing || S.cursor ? clamp(xOf(currentPos()), 0, W) : W / 2);
  const t = tOf(ax);
  S.view.spp *= f; clampView();
  S.view.start = t - ax * S.view.spp; clampView(); requestDraw();
}
function ensureVisible(t) {
  const x = xOf(t);
  if (x < 0 || x > W) { S.view.start = t - W * S.view.spp * 0.2; clampView(); requestDraw(); }
}

function niceStep(minSec) {
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s >= minSec) || 1200;
}

// min/max of channel c over samples [s0, s1)
function colMinMax(chIdx, s0, s1, levels, raw) {
  let lo = 1, hi = -1;
  const span = s1 - s0;
  if (span <= 0) return null;
  if (span < 256 && raw) {
    const c = raw[chIdx]; const a = Math.max(0, Math.floor(s0)), b = Math.min(c.length, Math.ceil(s1));
    if (a >= b) { const i = Math.floor(s0); if (i >= 0 && i < c.length) return [c[i], c[i]]; return null; }
    for (let i = a; i < b; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo, hi];
  }
  let L = levels[0];
  for (const l of levels) if (l.spb <= span) L = l;
  const mn = L.min[chIdx], mx = L.max[chIdx];
  const a = Math.max(0, Math.floor(s0 / L.spb)), b = Math.min(mn.length, Math.ceil(s1 / L.spb));
  for (let i = a; i < b; i++) { if (mn[i] < lo) lo = mn[i]; if (mx[i] > hi) hi = mx[i]; }
  return a < b ? [lo, hi] : null;
}

function drawBack() {
  const g = gB;
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.fillStyle = colors['wave-bg']; g.fillRect(0, 0, W, H);
  // lanes background
  g.fillStyle = colors.panel; g.fillRect(0, 0, W, WAVE_TOP);
  g.fillStyle = colors['panel-2']; g.fillRect(0, RULER, W, SECT);
  g.strokeStyle = colors.line; g.lineWidth = 1;
  g.beginPath(); for (const y of [RULER, RULER + SECT, WAVE_TOP]) { g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); } g.stroke();
  g.font = '10px "IBM Plex Mono", monospace'; g.textBaseline = 'middle';
  g.fillStyle = colors.faint;
  g.fillText('SECTIONS', 6, RULER + SECT / 2); g.fillText('MARKERS', 6, RULER + SECT + MARK / 2);

  const d = S.recording ? REC.total / REC.sr : dur();
  const t0 = tOf(0), t1 = tOf(W);
  const waveH = H - WAVE_TOP;

  // track block
  if (d > 0) {
    const ts = S.recording ? 0 : S.trackStart;
    const xa = xOf(ts), xb = xOf(d);
    g.fillStyle = colors['panel-2']; g.globalAlpha = 0.55; roundRect(g, xa, WAVE_TOP + 2, xb - xa, waveH - 4, 6); g.fill(); g.globalAlpha = 1;
    // header bar: drag it to move the track
    const hover = trackHover && !S.recording;
    g.fillStyle = S.recording ? colors.rec : colors.wave; g.globalAlpha = hover ? 0.55 : 0.32;
    roundRect(g, xa, WAVE_TOP + 2, xb - xa, HDR, 6); g.fill(); g.globalAlpha = 1;
    g.save(); g.beginPath(); g.rect(Math.max(xa, 0), WAVE_TOP, Math.max(0, Math.min(xb, W) - Math.max(xa, 0) - 4), HDR + 2); g.clip();
    g.fillStyle = colors.ink; g.font = '600 11px "IBM Plex Sans", sans-serif'; g.textBaseline = 'middle';
    const label = S.recording ? '● Recording' : `${S.name}  ·  ${fmtTime(audioDur())}${S.trackStart > 0 ? '  ·  starts ' + fmtTime(S.trackStart) : ''}`;
    g.fillText(label, Math.max(xa, 0) + 8, WAVE_TOP + 2 + HDR / 2); g.restore();
  }

  // section tints in the waveform
  for (const s of S.sections) {
    const xa = xOf(s.start), xb = xOf(s.end);
    if (xb < 0 || xa > W) continue;
    g.fillStyle = s.color; g.globalAlpha = 0.07; g.fillRect(xa, WAVE_TOP, xb - xa, waveH); g.globalAlpha = 1;
  }

  // In/Out selection
  if (!S.recording && (S.inPt != null || S.outPt != null)) {
    const [a, b] = loopRange();
    const xa = xOf(a), xb = xOf(b);
    g.fillStyle = colors.sel; g.fillRect(xa, RULER, xb - xa, H - RULER);
    g.fillStyle = colors.accent; g.globalAlpha = S.loop ? 0.9 : 0.45; g.fillRect(xa, 0, xb - xa, 4); g.globalAlpha = 1;
  }

  // grid
  if (settings.showGrid && (S.channels || S.recording)) drawGrid(g, t0, t1);
  else drawTimeRuler(g, t0, t1);

  // waveform
  if (S.recording && REC.peaks) drawRecWave(g);
  else if (S.channels) drawWave(g);

  // in/out edges
  if (!S.recording) {
    g.lineWidth = 1.5; g.strokeStyle = colors['sel-edge'];
    for (const [t, lab] of [[S.inPt, 'IN'], [S.outPt, 'OUT']]) {
      if (t == null) continue;
      const x = Math.round(xOf(t)) + 0.5;
      if (x < -20 || x > W + 20) continue;
      g.beginPath(); g.moveTo(x, RULER - 13); g.lineTo(x, H); g.stroke();
      g.fillStyle = colors['sel-edge']; g.font = '600 9px "IBM Plex Mono", monospace';
      const tw = g.measureText(lab).width + 6;
      const lx = lab === 'IN' ? x : x - tw;
      g.fillRect(lx, RULER - 13, tw, 13); g.fillStyle = '#1C1204';
      g.fillText(lab, lx + 3, RULER - 6);
    }
  }

  // sections in lane
  g.font = '600 11px "IBM Plex Sans", sans-serif';
  for (const s of S.sections) {
    const xa = xOf(s.start), xb = xOf(s.end);
    if (xb < 0 || xa > W) continue;
    const sel = S.selected && S.selected.kind === 'section' && S.selected.id === s.id;
    g.fillStyle = s.color; g.globalAlpha = 1;
    roundRect(g, xa, RULER + 3, Math.max(2, xb - xa), SECT - 6, 4); g.fill(); g.globalAlpha = 1;
    if (sel) { g.strokeStyle = colors.ink; g.lineWidth = 1.5; roundRect(g, xa + 0.5, RULER + 3.5, Math.max(2, xb - xa) - 1, SECT - 7, 4); g.stroke(); }
    g.save(); g.beginPath(); g.rect(Math.max(xa, 0), RULER, Math.max(0, xb - Math.max(xa, 0) - 4), SECT); g.clip();
    g.fillStyle = '#111'; g.fillText(s.name, Math.max(xa, 0) + 6, RULER + SECT / 2 + 0.5); g.restore();
  }

  // markers
  for (const m of S.markers) {
    const x = Math.round(xOf(m.time)) + 0.5;
    if (x < -150 || x > W + 5) continue;
    const sel = S.selected && S.selected.kind === 'marker' && S.selected.id === m.id;
    g.strokeStyle = colors.marker; g.globalAlpha = sel ? 1 : 0.7; g.lineWidth = 1;
    g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, WAVE_TOP); g.lineTo(x, H); g.stroke(); g.setLineDash([]);
    g.globalAlpha = 1;
    const y = RULER + SECT;
    g.fillStyle = colors.marker;
    g.beginPath(); g.moveTo(x, y + 2); g.lineTo(x + 9, y + 2); g.lineTo(x + 9, y + MARK - 6); g.lineTo(x, y + MARK - 2); g.closePath(); g.fill();
    g.font = (sel ? '600 ' : '') + '11px "IBM Plex Sans", sans-serif';
    g.fillStyle = sel ? colors.ink : colors.muted;
    g.fillText(m.name, x + 12, y + MARK / 2);
  }

  // detected beat ticks (subtle)
  if (S.beatTimes && settings.showGrid && W / ((t1 - t0) / beatLen()) > 6) {
    g.fillStyle = colors.accent; g.globalAlpha = 0.5;
    for (const bt of S.beatTimes) { if (bt < t0 || bt > t1) continue; g.fillRect(Math.round(xOf(bt)) - 1, H - 5, 2, 5); }
    g.globalAlpha = 1;
  }
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function drawTimeRuler(g, t0, t1) {
  const step = niceStep(S.view.spp * 80);
  g.fillStyle = colors.muted; g.font = '10px "IBM Plex Mono", monospace'; g.textBaseline = 'middle';
  g.strokeStyle = colors['grid-beat']; g.lineWidth = 1;
  g.beginPath();
  for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
    if (t < 0) continue;
    const x = Math.round(xOf(t)) + 0.5;
    g.moveTo(x, RULER - 8); g.lineTo(x, RULER); g.moveTo(x, WAVE_TOP); g.lineTo(x, H);
    g.fillText(step < 1 ? fmtTime(t).replace(/0+$/, '').replace(/\.$/, '') : fmtTime(t, false), x + 3, RULER / 2);
  }
  g.stroke();
}

function drawGrid(g, t0, t1) {
  const b = beatLen(), bars = barLen(), o = S.grid.offset;
  const pxBeat = b / S.view.spp, pxBar = bars / S.view.spp;
  const div = divLen(), pxDiv = div / S.view.spp;
  // subdivisions
  if (settings.division !== 'bar' && parseFloat(settings.division) < 1 && pxDiv > 7) {
    g.strokeStyle = colors['grid-sub']; g.lineWidth = 1; g.beginPath();
    for (let k = Math.floor((t0 - o) / div); o + k * div <= t1; k++) { const x = Math.round(xOf(o + k * div)) + 0.5; g.moveTo(x, WAVE_TOP); g.lineTo(x, H); }
    g.stroke();
  }
  // beats
  if (pxBeat > 6) {
    g.strokeStyle = colors['grid-beat']; g.lineWidth = 1; g.beginPath();
    for (let k = Math.floor((t0 - o) / b); o + k * b <= t1; k++) {
      const x = Math.round(xOf(o + k * b)) + 0.5;
      g.moveTo(x, WAVE_TOP); g.lineTo(x, H); g.moveTo(x, RULER - 6); g.lineTo(x, RULER);
    }
    g.stroke();
  }
  // bars
  let every = 1; while (pxBar * every < 34) every *= 2;
  g.strokeStyle = colors['grid-bar']; g.lineWidth = 1; g.beginPath();
  g.fillStyle = colors.ink; g.font = '600 10px "IBM Plex Mono", monospace'; g.textBaseline = 'middle';
  const k0 = Math.floor((t0 - o) / bars);
  for (let k = k0; o + k * bars <= t1; k++) {
    const x = Math.round(xOf(o + k * bars)) + 0.5;
    if (pxBar > 3 || k % every === 0) { g.moveTo(x, WAVE_TOP); g.lineTo(x, H); }
    if (k % every === 0) { g.moveTo(x, 4); g.lineTo(x, RULER); g.fillText(String(k + 1), x + 3, 11); }
  }
  g.stroke();
  // beat labels when zoomed in far enough
  if (pxBeat > 60) {
    g.fillStyle = colors.muted; g.font = '10px "IBM Plex Mono", monospace';
    for (let k = Math.floor((t0 - o) / b); o + k * b <= t1; k++) {
      const bi = ((k % S.grid.beats) + S.grid.beats) % S.grid.beats;
      if (bi === 0) continue;
      g.fillText(`${Math.floor(k / S.grid.beats) + 1}.${bi + 1}`, Math.round(xOf(o + k * b)) + 3, 11);
    }
  }
  // fine time ticks when even beats are far apart
  if (pxBeat > 400) {
    const step = niceStep(S.view.spp * 90);
    g.fillStyle = colors.faint; g.strokeStyle = colors['grid-beat']; g.font = '9px "IBM Plex Mono", monospace'; g.beginPath();
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      if (t < 0) continue;
      const x = Math.round(xOf(t)) + 0.5; g.moveTo(x, RULER - 4); g.lineTo(x, RULER);
      g.fillText(fmtTime(t), x + 3, 21);
    }
    g.stroke();
  }
  // small time labels under bar numbers when there is room
  else if (pxBar * every > 70) {
    g.fillStyle = colors.faint; g.font = '9px "IBM Plex Mono", monospace';
    for (let k = k0; o + k * bars <= t1; k++) { if (k % every) continue; const t = o + k * bars; if (t >= 0) g.fillText(fmtTime(t, false), Math.round(xOf(t)) + 3, 21); }
  }
}

function waveLanes() {
  const nch = S.recording ? (+settings.recChannels === 1 ? 1 : 2) : (S.channels ? S.channels.length : 1);
  const split = nch > 1 && settings.stereoView;
  const top = WAVE_TOP + HDR + 8, h = H - WAVE_TOP - HDR - 14;
  if (!split) return [{ ch: nch > 1 ? 'mix' : 0, y: top, h }];
  const gap = 6, lh = (h - gap) / 2;
  return [{ ch: 0, y: top, h: lh }, { ch: 1, y: top + lh + gap, h: lh }];
}

function drawWave(g) {
  const levels = buildPeaks(S.channels), raw = S.channels, sr = S.sr, ts = S.trackStart;
  const lanes = waveLanes();
  const xa = Math.max(0, Math.floor(xOf(ts))), xb = Math.min(W, Math.ceil(xOf(dur())));
  for (const lane of lanes) {
    const mid = lane.y + lane.h / 2, amp = lane.h / 2;
    g.strokeStyle = colors.line; g.lineWidth = 1; g.beginPath(); g.moveTo(xa, Math.round(mid) + 0.5); g.lineTo(xb, Math.round(mid) + 0.5); g.stroke();
    g.fillStyle = colors.wave;
    const spp = S.view.spp * sr;
    if (spp < 1.5) {
      // sample-level: draw a line
      g.strokeStyle = colors.wave; g.lineWidth = 1.25; g.beginPath();
      const s0 = Math.max(0, Math.floor((tOf(0) - ts) * sr)), s1 = Math.min(S.len - 1, Math.ceil((tOf(W) - ts) * sr));
      for (let i = s0; i <= s1; i++) {
        const v = lane.ch === 'mix' ? (raw[0][i] + raw[1][i]) / 2 : raw[lane.ch][i];
        const x = xOf(ts + i / sr), y = mid - v * amp;
        if (i === s0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      continue;
    }
    g.beginPath();
    for (let x = xa; x < xb; x++) {
      const s0 = (tOf(x) - ts) * sr, s1 = (tOf(x + 1) - ts) * sr;
      let mm;
      if (lane.ch === 'mix') {
        const a = colMinMax(0, s0, s1, levels, raw), b = colMinMax(1, s0, s1, levels, raw);
        if (!a || !b) continue; mm = [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
      } else { mm = colMinMax(lane.ch, s0, s1, levels, raw); if (!mm) continue; }
      const y0 = mid - clamp(mm[1], -1, 1) * amp, y1 = mid - clamp(mm[0], -1, 1) * amp;
      g.rect(x, y0, 1, Math.max(1, y1 - y0));
    }
    g.fill();
    if (lanes.length > 1) { g.fillStyle = colors.faint; g.font = '9px "IBM Plex Mono", monospace'; g.fillText(lane.ch === 0 ? 'L' : 'R', 4, lane.y + 8); }
  }
}

function drawRecWave(g) {
  const P = REC.peaks, sr = REC.sr;
  const lanes = waveLanes();
  for (const lane of lanes) {
    const mid = lane.y + lane.h / 2, amp = lane.h / 2;
    g.fillStyle = colors.rec; g.globalAlpha = 0.85;
    g.beginPath();
    const xa = Math.max(0, Math.floor(xOf(0))), xb = Math.min(W, Math.ceil(xOf(P.n * REC_BIN / sr)));
    for (let x = xa; x < xb; x++) {
      const b0 = Math.floor(tOf(x) * sr / REC_BIN), b1 = Math.max(b0 + 1, Math.floor(tOf(x + 1) * sr / REC_BIN));
      let lo = 1, hi = -1;
      for (let b = Math.max(0, b0); b < Math.min(P.n, b1); b++) {
        if (lane.ch === 'mix' || lane.ch === 0) { lo = Math.min(lo, P.min[0][b]); hi = Math.max(hi, P.max[0][b]); }
        if (lane.ch === 'mix' || lane.ch === 1) { lo = Math.min(lo, P.min[1][b]); hi = Math.max(hi, P.max[1][b]); }
      }
      if (hi < lo) continue;
      const y0 = mid - clamp(hi, -1, 1) * amp, y1 = mid - clamp(lo, -1, 1) * amp;
      g.rect(x, y0, 1, Math.max(1, y1 - y0));
    }
    g.fill(); g.globalAlpha = 1;
  }
}

function drawFront() {
  const g = gF;
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.clearRect(0, 0, W, H);
  if (S.recording || !S.channels) return;
  // edit cursor
  const cx = Math.round(xOf(S.cursor)) + 0.5;
  g.strokeStyle = colors.cursor; g.lineWidth = 1; g.globalAlpha = S.playing ? 0.5 : 1;
  g.beginPath(); g.moveTo(cx, RULER); g.lineTo(cx, H); g.stroke(); g.globalAlpha = 1;
  g.fillStyle = colors.cursor; g.beginPath(); g.moveTo(cx - 6, 0); g.lineTo(cx + 6, 0); g.lineTo(cx, 8); g.closePath(); g.fill();
  // hover line
  if (hoverX != null && !drag) {
    g.strokeStyle = colors.muted; g.globalAlpha = 0.35; g.lineWidth = 1; g.beginPath(); g.moveTo(hoverX + 0.5, RULER); g.lineTo(hoverX + 0.5, H); g.stroke(); g.globalAlpha = 1;
  }
  // drag preview for a new section
  if (drag && drag.type === 'newSection' && drag.moved) {
    const xa = xOf(Math.min(drag.a, drag.b)), xb = xOf(Math.max(drag.a, drag.b));
    g.fillStyle = colors.accent; g.globalAlpha = 0.4; g.fillRect(xa, RULER + 3, xb - xa, SECT - 6); g.globalAlpha = 1;
  }
}

function drawOverview() {
  const g = gO, w = cvO.width / DPR, h = cvO.height / DPR;
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.fillStyle = colors.panel; g.fillRect(0, 0, w, h);
  const d = S.recording ? REC.total / REC.sr : dur();
  if (d <= 0) return;
  const total = Math.max(d, W * S.view.spp);
  const mid = h / 2, amp = h / 2 - 3;
  g.fillStyle = S.recording ? colors.rec : colors['wave-2'];
  g.beginPath();
  if (S.recording && REC.peaks) {
    const P = REC.peaks;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x / w) * total * REC.sr / REC_BIN), b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * total * REC.sr / REC_BIN));
      let hi = 0; for (let b = b0; b < Math.min(P.n, b1); b++) hi = Math.max(hi, P.max[0][b], -P.min[0][b], P.max[1][b], -P.min[1][b]);
      if (hi > 0) g.rect(x, mid - hi * amp, 1, Math.max(1, 2 * hi * amp));
    }
  } else if (S.channels) {
    const levels = buildPeaks(S.channels);
    for (let x = 0; x < w; x++) {
      const s0 = ((x / w) * total - S.trackStart) * S.sr, s1 = (((x + 1) / w) * total - S.trackStart) * S.sr;
      let hi = 0;
      for (let c = 0; c < S.channels.length; c++) { const mm = colMinMax(c, s0, s1, levels, null); if (mm) hi = Math.max(hi, mm[1], -mm[0]); }
      if (hi > 0) g.rect(x, mid - hi * amp, 1, Math.max(1, 2 * hi * amp));
    }
  }
  g.fill();
  // markers & sections ticks
  for (const s of S.sections) { g.fillStyle = s.color; g.fillRect(s.start / total * w, 0, (s.end - s.start) / total * w, 3); }
  g.fillStyle = colors.marker; for (const m of S.markers) g.fillRect(m.time / total * w, 0, 1, h);
  if (S.inPt != null || S.outPt != null) { const [a, b] = loopRange(); g.fillStyle = colors.sel; g.fillRect(a / total * w, 0, (b - a) / total * w, h); }
  // viewport
  const va = S.view.start / total * w, vw = (W * S.view.spp) / total * w;
  g.strokeStyle = colors.accent; g.lineWidth = 1.5; g.strokeRect(va + 0.75, 0.75, Math.max(4, vw) - 1.5, h - 1.5);
}

function drawMeter(canvas, lv) {
  const g = canvas.getContext('2d');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const bw = Math.round(w * DPR), bh0 = Math.round(h * DPR);
  if (canvas.width !== bw || canvas.height !== bh0) { canvas.width = bw; canvas.height = bh0; }
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.clearRect(0, 0, w, h);
  const bh = (h - 6) / 2;
  for (let c = 0; c < 2; c++) {
    const db = 20 * Math.log10(Math.max(1e-5, lv[c]));
    const f = clamp((db + 60) / 60, 0, 1);
    const y = 2 + c * (bh + 2);
    g.fillStyle = colors['panel-3']; g.fillRect(3, y, w - 6, bh);
    g.fillStyle = db > -1 ? colors.rec : db > -9 ? colors.accent : colors.wave;
    g.fillRect(3, y, (w - 6) * f, bh);
  }
}

let meterSmooth = [0, 0], meterDrawn = [-1, -1], lastFrame = 0, lastRecDraw = 0;
const textCache = {};
function setText(id, t) { if (textCache[id] !== t) { textCache[id] = t; $(id).textContent = t; } }
const elHead = $('playhead'), elOvHead = $('ovHead');
function placeLine(el, x, show, color) {
  if (!show) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.style.transform = `translateX(${Math.round(x * 2) / 2}px)`;
  if (color && el.dataset.c !== color) { el.dataset.c = color; el.style.background = color; }
}
function frame(now) {
  requestAnimationFrame(frame);
  // at most ~60 fps, also on 120/144/240 Hz screens
  if (now - lastFrame < 15) return;
  lastFrame = now;
  // follow playhead
  if (S.playing && settings.follow && !drag) {
    const x = xOf(currentPos());
    if (x > W * 0.92 || x < 0) { S.view.start = currentPos() - W * S.view.spp * 0.08; clampView(); requestDraw(); }
  }
  let headT = null, headColor = colors.play;
  if (S.recording) {
    // keep the whole take visible while it grows (redrawn ~15 times per second)
    const d = REC.total / REC.sr;
    if (now - lastRecDraw > 66) { S.view.spp = Math.max(d * 1.15, 10) / Math.max(1, W); S.view.start = 0; dirty = true; lastRecDraw = now; }
    setText('clockTime', fmtTime(d));
    setText('clockBars', `REC · ${barBeat(d)}`);
    setText('stLen', fmtTime(d));
    headT = d; headColor = colors.rec;
  } else {
    const p = currentPos();
    setText('clockTime', fmtTime(p));
    setText('clockBars', `${barBeat(p)} · ${Math.round(S.grid.bpm * S.speed * 10) / 10} BPM`);
    if (S.playing || scrubbing) headT = p;
  }
  if (dirty) { drawBack(); drawOverview(); dirty = false; }
  if (fdirty) { drawFront(); fdirty = false; }
  // playhead lines (DOM, no canvas repaint)
  placeLine(elHead, headT == null ? 0 : xOf(headT), headT != null && xOf(headT) >= -2 && xOf(headT) <= W + 2, headColor);
  const ovW = cvO.width / DPR, total = Math.max(S.recording ? REC.total / REC.sr : dur(), W * S.view.spp);
  placeLine(elOvHead, headT == null || !total ? 0 : headT / total * ovW, headT != null && total > 0, headColor);
  // meters: only repaint when the level changes
  let lv = [0, 0];
  if (S.recording || REC.testing) { lv = meterLevel.slice(); meterLevel = [0, 0]; }
  else if (analyser && S.playing) {
    analyser.getFloatTimeDomainData(outLevelBuf);
    let m = 0; for (let i = 0; i < outLevelBuf.length; i++) { const v = Math.abs(outLevelBuf[i]); if (v > m) m = v; }
    lv = [m, m];
  }
  for (let c = 0; c < 2; c++) { meterSmooth[c] = lv[c] > meterSmooth[c] ? lv[c] : meterSmooth[c] * 0.9; if (meterSmooth[c] < 1e-4) meterSmooth[c] = 0; }
  const audioOpen = $('dlgAudio').open;
  if (audioOpen || Math.abs(meterSmooth[0] - meterDrawn[0]) > 0.003 || Math.abs(meterSmooth[1] - meterDrawn[1]) > 0.003) {
    drawMeter($('meter'), meterSmooth); meterDrawn = meterSmooth.slice();
    if (audioOpen) drawMeter($('testMeter'), meterSmooth);
  }
}

/* =============================================================================================
   Mouse interaction on the timeline
============================================================================================= */
let drag = null, hoverX = null, scrubbing = false, scrubWasPlaying = false;

function zoneAt(y) { return y < RULER ? 'ruler' : y < RULER + SECT ? 'sections' : y < WAVE_TOP ? 'markers' : 'wave'; }
function hitSection(x) {
  for (let i = S.sections.length - 1; i >= 0; i--) {
    const s = S.sections[i], xa = xOf(s.start), xb = xOf(s.end);
    if (x >= xa - 4 && x <= xb + 4) {
      const edge = Math.abs(x - xa) <= 5 ? 'start' : Math.abs(x - xb) <= 5 ? 'end' : null;
      if (edge || (x >= xa && x <= xb)) return { s, edge };
    }
  }
  return null;
}
function hitMarker(x) {
  let best = null, bd = 8;
  for (const m of S.markers) { const dx = x - xOf(m.time); if (dx >= -4 && dx <= 10 && Math.abs(dx) < bd) { bd = Math.abs(dx); best = m; } }
  return best;
}
function sectionAtTime(t) {
  let found = null;
  for (const s of S.sections) if (t >= s.start && t <= s.end && (!found || s.end - s.start < found.end - found.start)) found = s;
  return found;
}

function localXY(e) { const r = cvF.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

function hitIOTab(x, y) {
  if (y < RULER - 14 || y > RULER) return null;
  for (const [which, pt, lab] of [['in', S.inPt, 'IN'], ['out', S.outPt, 'OUT']]) {
    if (pt == null) continue;
    const px = xOf(pt), w = lab === 'IN' ? 18 : 24;
    if (lab === 'IN' ? x >= px - 3 && x <= px + w : x >= px - w && x <= px + 3) return which;
  }
  return null;
}
const inTrackHeader = (x, y) => S.channels && y >= WAVE_TOP && y <= WAVE_TOP + HDR + 3 && x >= xOf(S.trackStart) && x <= xOf(dur());

// Scrubbing: the cursor follows the mouse and the audio under it plays.
async function scrubBegin(t) {
  await ensureAudio();
  scrubWasPlaying = S.playing;
  if (S.playing) { S.cursor = currentPos(); player.port.postMessage({ type: 'stop' }); S.playing = false; updateTransportUI(); }
  scrubbing = true;
  S.cursor = clamp(t, 0, dur());
  player.port.postMessage({ type: 'scrubStart', pos: toCtx(S.cursor) });
}
function scrubEnd() {
  if (!scrubbing) return;
  player.port.postMessage({ type: 'scrubEnd' });
  scrubbing = false;
  if (scrubWasPlaying) play();
  requestDraw();
}

cvF.addEventListener('pointerdown', (e) => {
  hideCtx();
  if (!S.channels || S.recording) return;
  if (e.button === 2) return;
  if (e.button === 1) { drag = { type: 'pan', x0: e.clientX, start0: S.view.start }; cvF.setPointerCapture(e.pointerId); return; }
  const [x, y] = localXY(e);
  const t = tOf(x), zone = zoneAt(y);
  cvF.setPointerCapture(e.pointerId);
  if (zone === 'ruler') {
    const io = hitIOTab(x, y);
    if (io) { drag = { type: 'ioEdge', which: io, undo: false }; return; }
    if (e.altKey) { drag = { type: 'grid', x0: x, off0: S.grid.offset, undo: false }; return; }
    drag = { type: 'scrub', x0: x, started: false };
    return;
  }
  if (zone === 'sections') {
    const h = hitSection(x);
    if (h) {
      S.selected = { kind: 'section', id: h.s.id };
      drag = { type: h.edge ? 'sectionEdge' : 'sectionMove', s: h.s, edge: h.edge, t0: t, a0: h.s.start, b0: h.s.end, undo: false, moved: false };
    } else {
      drag = { type: 'newSection', a: snap(t, e), b: snap(t, e), moved: false };
    }
    requestDraw(); return;
  }
  if (zone === 'markers') {
    const m = hitMarker(x);
    if (m) { S.selected = { kind: 'marker', id: m.id }; drag = { type: 'marker', m, t0: t, time0: m.time, undo: false, moved: false }; }
    else { S.selected = null; drag = { type: 'none' }; }
    requestDraw(); return;
  }
  // waveform: the header bar moves the track, everything else scrubs
  if (inTrackHeader(x, y)) { drag = { type: 'moveTrack', t0: t, start0: S.trackStart, undo: false, moved: false }; cvF.style.cursor = 'grabbing'; return; }
  drag = { type: 'scrub', x0: x, started: false };
});

cvF.addEventListener('pointermove', (e) => {
  const [x, y] = localXY(e);
  const hx = y >= WAVE_TOP ? x : null;
  if (hx !== hoverX) { hoverX = hx; fdirty = true; }
  if (!drag) {
    const th = inTrackHeader(x, y);
    if (th !== trackHover) { trackHover = th; requestDraw(); }
    updateCursorStyle(x, y); return;
  }
  const t = tOf(x);
  switch (drag.type) {
    case 'pan': S.view.start = drag.start0 - (e.clientX - drag.x0) * S.view.spp; clampView(); requestDraw(); break;
    case 'scrub':
      if (!drag.started) {
        if (Math.abs(x - drag.x0) < 3) break;
        drag.started = true; S.selected = null;
        scrubBegin(t);
      }
      S.cursor = clamp(t, 0, dur());
      if (scrubbing) player.port.postMessage({ type: 'scrubMove', pos: toCtx(S.cursor) });
      // keep the cursor in view when dragging past the edges
      if (x > W - 10) { S.view.start += S.view.spp * 12; clampView(); requestDraw(); }
      else if (x < 10) { S.view.start -= S.view.spp * 12; clampView(); requestDraw(); }
      break;
    case 'moveTrack': {
      if (!drag.moved && Math.abs(t - drag.t0) / S.view.spp < 3) break;
      if (!drag.undo) { pushUndo(); drag.undo = true; }
      drag.moved = true;
      moveTrackTo(snap(Math.max(0, drag.start0 + (t - drag.t0)), e));
      break;
    }
    case 'grid': {
      if (!drag.undo) { pushUndo(); drag.undo = true; }
      setOffset(drag.off0 + (x - drag.x0) * S.view.spp, false); break;
    }
    case 'newSection': drag.b = snap(clamp(t, 0, dur()), e); drag.moved = Math.abs(xOf(drag.b) - xOf(drag.a)) > 3; break;
    case 'sectionMove': {
      if (Math.abs(t - drag.t0) / S.view.spp < 3 && !drag.moved) break;
      if (!drag.undo) { pushUndo(); drag.undo = true; drag.s = S.sections.find((s) => s.id === drag.s.id); }
      drag.moved = true;
      const len = drag.b0 - drag.a0;
      let a = snap(drag.a0 + (t - drag.t0), e); a = clamp(a, 0, Math.max(0, dur() - len));
      drag.s.start = a; drag.s.end = a + len; requestDraw(); break;
    }
    case 'sectionEdge': {
      if (!drag.undo) { pushUndo(); drag.undo = true; drag.s = S.sections.find((s) => s.id === drag.s.id); }
      drag.moved = true;
      const v = clamp(snap(t, e), 0, dur());
      if (drag.edge === 'start') drag.s.start = Math.min(v, drag.s.end - 0.01); else drag.s.end = Math.max(v, drag.s.start + 0.01);
      requestDraw(); break;
    }
    case 'marker': {
      if (Math.abs(t - drag.t0) / S.view.spp < 3 && !drag.moved) break;
      if (!drag.undo) { pushUndo(); drag.undo = true; drag.m = S.markers.find((m) => m.id === drag.m.id); }
      drag.moved = true;
      drag.m.time = clamp(snap(drag.time0 + (t - drag.t0), e), 0, dur()); requestDraw(); break;
    }
    case 'ioEdge': {
      if (!drag.undo) { pushUndo(); drag.undo = true; }
      const v = clamp(snap(t, e), 0, dur());
      if (drag.which === 'in') S.inPt = v; else S.outPt = v;
      afterSelChange(); break;
    }
  }
  requestDraw();
});

function endDrag(e) {
  if (!drag) return;
  const [x] = localXY(e);
  const t = tOf(x);
  const d = drag; drag = null;
  switch (d.type) {
    case 'scrub':
      if (d.started) scrubEnd();
      else { S.selected = null; seek(snap(clamp(t, 0, dur()), e)); }
      break;
    case 'moveTrack':
      if (d.moved) setMsg(`Track starts at ${fmtTime(S.trackStart)} (${barBeat(S.trackStart)}).`);
      updateCursorStyle(...localXY(e));
      break;
    case 'newSection':
      if (d.moved) addSection(clamp(Math.min(d.a, d.b), 0, dur()), clamp(Math.max(d.a, d.b), 0, dur()));
      else { S.selected = null; }
      break;
    case 'marker':
      if (!d.moved) seek(d.m.time);
      else S.markers.sort((a, b) => a.time - b.time);
      break;
    case 'sectionMove':
      S.sections.sort((a, b) => a.start - b.start);
      break;
    case 'ioEdge':
      if (S.inPt != null && S.outPt != null && S.outPt < S.inPt) [S.inPt, S.outPt] = [S.outPt, S.inPt];
      afterSelChange(); break;
  }
  requestDraw();
}
cvF.addEventListener('pointerup', endDrag);
cvF.addEventListener('pointercancel', endDrag);
cvF.addEventListener('pointerleave', () => { hoverX = null; fdirty = true; if (trackHover) { trackHover = false; requestDraw(); } });

cvF.addEventListener('dblclick', (e) => {
  if (!S.channels || S.recording) return;
  const [x, y] = localXY(e);
  const t = tOf(x), zone = zoneAt(y);
  if (zone === 'sections') { const h = hitSection(x); if (h) selectSectionAndLoop(h.s); return; }
  if (zone === 'markers') {
    const m = hitMarker(x);
    if (m) { S.selected = { kind: 'marker', id: m.id }; renameSelected(); }
    else addMarker(snap(clamp(t, 0, dur()), e));
    return;
  }
  if (zone === 'wave') {
    const s = sectionAtTime(t);
    if (s) selectSectionAndLoop(s);
    else { selectAll(); setMsg('Whole track selected.'); }
  }
});

cvF.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!S.channels || S.recording) return;
  const [x, y] = localXY(e);
  const zone = zoneAt(y), t = tOf(x);
  if (zone === 'sections') { const h = hitSection(x); if (h) { S.selected = { kind: 'section', id: h.s.id }; requestDraw(); showCtx(e, sectionMenu(h.s)); } return; }
  if (zone === 'markers') { const m = hitMarker(x); if (m) { S.selected = { kind: 'marker', id: m.id }; requestDraw(); showCtx(e, markerMenu(m)); } else showCtx(e, [['Add marker here', () => addMarker(snap(t, e))]]); return; }
  const s = sectionAtTime(t);
  const items = [
    ['Set In here', () => setIn(snap(t, e))], ['Set Out here', () => setOut(snap(t, e))],
    ['Add marker here', () => addMarker(snap(t, e))],
    ['Section from In→Out', addSectionFromSelection],
  ];
  if (S.inPt != null || S.outPt != null) items.push(['Crop to In→Out', cropToSelection], ['Clear In/Out', clearIO]);
  if (s) items.push(null, [`Select & loop "${s.name}"`, () => selectSectionAndLoop(s)]);
  items.push(null, ['Select whole track', selectAll]);
  showCtx(e, items);
});

function sectionMenu(s) {
  return [
    ['Select & loop', () => selectSectionAndLoop(s)],
    ['Rename…', renameSelected],
    { swatches: (c) => { pushUndo(); s.color = c; requestDraw(); } },
    null,
    ['Delete section', deleteSelected],
  ];
}
function markerMenu(m) {
  return [
    ['Go to marker', () => seek(m.time)],
    ['Rename…', renameSelected],
    ['Set In here', () => setIn(m.time)], ['Set Out here', () => setOut(m.time)],
    null,
    ['Delete marker', deleteSelected],
  ];
}
function showCtx(e, items) {
  const el = $('ctxMenu'); el.innerHTML = '';
  for (const it of items) {
    if (it === null) { el.append(document.createElement('hr')); continue; }
    if (it.swatches) {
      const row = document.createElement('div'); row.className = 'swatches';
      SECTION_COLORS.forEach((c) => { const sp = document.createElement('span'); sp.style.background = c; sp.title = c; sp.onclick = () => { hideCtx(); it.swatches(c); }; row.append(sp); });
      el.append(row); continue;
    }
    const b = document.createElement('button'); b.textContent = it[0]; b.onclick = () => { hideCtx(); it[1](); }; el.append(b);
  }
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
}
function hideCtx() { $('ctxMenu').hidden = true; }
document.addEventListener('pointerdown', (e) => { if (!$('ctxMenu').contains(e.target)) hideCtx(); });

function updateCursorStyle(x, y) {
  if (!S.channels) { cvF.style.cursor = 'default'; return; }
  const z = zoneAt(y);
  let c = 'text';
  if (z === 'ruler') c = hitIOTab(x, y) ? 'col-resize' : 'ew-resize';
  else if (z === 'sections') { const h = hitSection(x); c = h ? (h.edge ? 'col-resize' : 'grab') : 'copy'; }
  else if (z === 'markers') c = hitMarker(x) ? 'grab' : 'default';
  else if (inTrackHeader(x, y)) c = 'grab';
  else c = 'ew-resize';
  cvF.style.cursor = c;
}

tl.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!S.channels && !S.recording) return;
  const [x] = localXY(e);
  if (e.ctrlKey || e.metaKey) { zoomBy(Math.exp(e.deltaY * 0.0025), x); return; }
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  S.view.start += delta * S.view.spp * (e.deltaMode === 1 ? 30 : 1); clampView(); requestDraw();
}, { passive: false });

// Overview: click / drag to move the view
let ovDrag = false;
function ovMove(e) {
  const r = cvO.getBoundingClientRect();
  const total = Math.max(dur(), W * S.view.spp);
  const t = (e.clientX - r.left) / r.width * total;
  S.view.start = t - W * S.view.spp / 2; clampView(); requestDraw();
}
cvO.addEventListener('pointerdown', (e) => { if (!S.channels) return; ovDrag = true; cvO.setPointerCapture(e.pointerId); ovMove(e); });
cvO.addEventListener('pointermove', (e) => { if (ovDrag) ovMove(e); });
cvO.addEventListener('pointerup', () => { ovDrag = false; });
cvO.addEventListener('dblclick', zoomFit);

// Drag & drop files
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('dropHint').hidden = false; e.preventDefault(); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('dropHint').hidden = true; const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) openFile(f); });

/* =============================================================================================
   Keyboard
============================================================================================= */
function isTyping(e) {
  const el = e.target;
  if (!el || !el.tagName) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') return !['range', 'checkbox', 'button'].includes(el.type);
  return false;
}
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) {
    if (e.key === 'Enter' && $('dlgPrompt').open) { e.preventDefault(); $('promptOk').click(); }
    if (e.key === 'Enter' && $('dlgSave').open && e.target.tagName === 'INPUT' && e.target.type === 'text') { e.preventDefault(); $('btnSaveGo').click(); }
    return;
  }
  if (e.key === 'Escape' && !$('speedPop').hidden) { $('speedPop').hidden = true; e.preventDefault(); return; }
  if (isTyping(e)) { if (e.key === 'Escape' || e.key === 'Enter') e.target.blur(); return; }
  const k = e.key, ctrl = e.ctrlKey || e.metaKey, lower = k.length === 1 ? k.toLowerCase() : k;
  const pos = currentPos();
  let handled = true;
  if (ctrl) {
    if (lower === 'z' && !e.shiftKey) undo();
    else if ((lower === 'z' && e.shiftKey) || lower === 'y') redo();
    else if (lower === 's' && e.shiftKey) saveSession();
    else if (lower === 's') openSaveDialog();
    else if (lower === 'o') $('fileInput').click();
    else if (lower === 'k') cropToSelection();
    else if (lower === 'a') selectAll();
    else handled = false;
  } else if (k === ' ') togglePlay();
  else if (lower === 'r') toggleRecord();
  else if (lower === 'i') { if (e.shiftKey) { if (S.inPt != null) { seek(S.inPt); ensureVisible(S.inPt); } } else setIn(snapIfStopped(pos, e)); }
  else if (lower === 'o') { if (e.shiftKey) { if (S.outPt != null) { seek(S.outPt); ensureVisible(S.outPt); } } else setOut(snapIfStopped(pos, e)); }
  else if (lower === 'l') toggleLoop();
  else if (lower === 'x' || k === 'Escape') { if (k === 'Escape' && S.selected) { S.selected = null; requestDraw(); } else clearIO(); }
  else if (k === 'Home' || k === 'Enter') { const t = S.inPt != null ? S.inPt : 0; seek(pos > t + 0.05 || S.inPt == null ? t : 0); ensureVisible(S.cursor); }
  else if (k === 'End') { const t = S.outPt != null ? S.outPt : dur(); seek(t); ensureVisible(t); }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    if (!S.channels) return;
    const step = e.shiftKey ? barLen() : divLen(), o = S.grid.offset, dir = k === 'ArrowLeft' ? -1 : 1;
    let n = o + Math.round((pos - o) / step) * step;
    if (Math.abs(n - pos) < 1e-4 || Math.sign(n - pos) !== dir) n += dir * step;
    seek(n); ensureVisible(S.cursor);
  }
  else if (k === ',' ) jumpMarker(-1);
  else if (k === '.') jumpMarker(1);
  else if (lower === 'm') addMarker(snapIfStopped(pos, e));
  else if (lower === 's') addSectionFromSelection();
  else if (k === 'Delete' || k === 'Backspace') deleteSelected();
  else if (k === 'F2') renameSelected();
  else if (lower === 'c') toggleMetro();
  else if (lower === 'n') toggleSnap();
  else if (lower === 'g') toggleGrid();
  else if (lower === 'b') detectBeats();
  else if (lower === 'd') { if (S.channels) { setOffset(pos); setMsg(`Bar 1 now starts at ${fmtTime(S.grid.offset)}.`); } }
  else if (lower === 't') tapTempo();
  else if (lower === 'p') toggleTrainer();
  else if (lower === 'z') zoomFit();
  else if (lower === 'f') toggleFollow();
  else if (k === '+' || k === '=') zoomBy(0.66);
  else if (k === '-' || k === '_') zoomBy(1.5);
  else if (k === '[') setSpeed(S.speed - 0.05);
  else if (k === ']') setSpeed(S.speed + 0.05);
  else if (k === '\\' || k === '#') setSpeed(1);
  else if (k === '?') $('dlgHelp').showModal();
  else handled = false;
  if (handled) e.preventDefault();
});
const snapIfStopped = (t, e) => (S.playing ? t : snap(t, e));

/* =============================================================================================
   Controls
============================================================================================= */
function toggleLoop() { S.loop = !S.loop; sendLoop(); updateTransportUI(); requestDraw(); }
function toggleMetro() { S.metro = !S.metro; sendMetro(); updateTransportUI(); if (S.recording && settings.metroRec && player) player.port.postMessage({ type: 'freeClock', on: S.metro }); }
function toggleSnap() { settings.snap = !settings.snap; saveSettings(); updateTransportUI(); }
function toggleGrid() { settings.showGrid = !settings.showGrid; saveSettings(); updateTransportUI(); requestDraw(); }
function toggleFollow() { settings.follow = !settings.follow; saveSettings(); updateTransportUI(); }
function setSpeed(v) {
  S.speed = Math.round(clamp(v, 0.25, 1.5) * 100) / 100;
  $('speed').value = Math.round(S.speed * 100);
  $('speedOut').textContent = Math.round(S.speed * 100) + '%';
  sendSpeed();
  if (!$('speedPop').hidden) renderPresets();
}

function updateTransportUI() {
  fdirty = true;
  $('btnPlay').classList.toggle('on', S.playing);
  $('icoPlay').innerHTML = S.playing ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>' : '<path d="M7 4v16l13-8z"/>';
  $('btnRec').classList.toggle('on', S.recording);
  $('btnLoop').classList.toggle('on', S.loop);
  $('btnMetro').classList.toggle('on', S.metro);
  $('btnSnap').classList.toggle('on', settings.snap);
  $('btnGrid').classList.toggle('on', settings.showGrid);
  $('btnFollow').classList.toggle('on', settings.follow);
  const has = !!S.channels && !S.recording;
  for (const id of ['btnPlay', 'btnIn', 'btnOut', 'btnClearIO', 'btnCrop', 'btnMarker', 'btnSection', 'btnDetect', 'btnBarHere', 'btnSave', 'btnTrainer']) $(id).disabled = !has && !(id === 'btnPlay' && S.recording);
  $('btnOpen').disabled = S.recording; $('btnNew').disabled = S.recording;
  $('btnSaveSession').disabled = !has;
  $('btnTrainer').classList.toggle('on', TR.running);
  $('btnTrainer').textContent = TR.running ? `Trainer ${Math.round(S.speed * 100)}%` : 'Trainer';
  updateUndoUI();
}

function syncGridUI() {
  $('bpm').value = S.grid.bpm;
  $('sig').value = String(S.grid.beats);
  $('gridOffset').value = S.grid.offset.toFixed(3);
}

function updateStatus() {
  $('stLen').textContent = fmtTime(audioDur());
  if (S.inPt != null || S.outPt != null) { const [a, b] = loopRange(); $('stSel').textContent = `${fmtTime(a)} → ${fmtTime(b)} (${fmtTime(b - a)})`; }
  else $('stSel').textContent = '–';
  $('stFile').textContent = S.fileName + (S.dirty ? ' •' : '');
  if (S.channels) $('stRate').textContent = `${(S.sr / 1000).toFixed(1)} kHz · ${S.channels.length === 1 ? 'mono' : 'stereo'}`;
}
setInterval(updateStatus, 500);

let msgTimer = null;
function setMsg(t, err = false, html = false) {
  const el = $('stMsg');
  if (html) el.innerHTML = t; else el.textContent = t;
  el.classList.toggle('err', !!err);
  clearTimeout(msgTimer);
  if (!html) msgTimer = setTimeout(() => { el.textContent = ''; }, err ? 9000 : 6000);
}

function promptText(title, value) {
  return new Promise((resolve) => {
    const d = $('dlgPrompt');
    $('promptTitle').textContent = title; $('promptInput').value = value || '';
    const done = (v) => { d.close(); $('promptOk').onclick = $('promptCancel').onclick = null; resolve(v); };
    $('promptOk').onclick = () => done($('promptInput').value.trim() || value);
    $('promptCancel').onclick = () => done(null);
    d.onclose = () => resolve(null);
    d.showModal(); $('promptInput').select();
  });
}

function wire() {
  // signatures
  for (let i = 1; i <= 12; i++) $('sig').append(new Option(`${i}/4`, String(i)));
  $('sig').value = '4';
  $('btnPlay').onclick = togglePlay;
  $('btnRec').onclick = toggleRecord;
  $('btnLoop').onclick = toggleLoop;
  $('btnHome').onclick = () => { const t = S.inPt != null && S.cursor > S.inPt + 0.05 ? S.inPt : 0; seek(t); ensureVisible(t); };
  $('speed').oninput = (e) => setSpeed(e.target.value / 100);
  $('speed').ondblclick = () => setSpeed(1);
  $('vol').value = settings.vol; $('volOut').textContent = settings.vol;
  $('vol').oninput = (e) => { settings.vol = +e.target.value; $('volOut').textContent = settings.vol; applyMix(); saveSettings(); };
  const panText = (v) => (v === 0 ? 'C' : v < 0 ? `L${-v}` : `R${v}`);
  $('pan').value = settings.pan; $('panOut').textContent = panText(settings.pan);
  $('pan').oninput = (e) => { settings.pan = +e.target.value; $('panOut').textContent = panText(settings.pan); applyMix(); saveSettings(); };
  $('btnBothEars').classList.toggle('on', settings.panBothEars);
  $('btnBothEars').onclick = (e) => { settings.panBothEars = !settings.panBothEars; e.currentTarget.classList.toggle('on', settings.panBothEars); applyMix(); saveSettings(); e.currentTarget.blur(); };
  $('pan').ondblclick = () => { settings.pan = 0; $('pan').value = 0; $('panOut').textContent = 'C'; applyMix(); saveSettings(); };
  $('metroVol').value = settings.metroVol;
  $('metroVol').oninput = (e) => { settings.metroVol = +e.target.value; sendMetro(); saveSettings(); };
  for (const id of ['speed', 'vol', 'pan', 'metroVol']) $(id).addEventListener('change', (e) => e.target.blur());

  $('bpm').onchange = (e) => setBpm(e.target.value);
  $('btnHalf').onclick = () => setBpm(S.grid.bpm / 2);
  $('btnDouble').onclick = () => setBpm(S.grid.bpm * 2);
  $('btnTap').onclick = tapTempo;
  $('sig').onchange = (e) => { pushUndo(); S.grid.beats = +e.target.value; sendMetro(); requestDraw(); e.target.blur(); };
  $('gridOffset').onchange = (e) => setOffset(parseFloat(e.target.value) || 0);
  $('btnNudgeL').onclick = () => setOffset(S.grid.offset - 0.005);
  $('btnNudgeR').onclick = () => setOffset(S.grid.offset + 0.005);
  $('btnBarHere').onclick = () => setOffset(currentPos());
  $('division').value = settings.division;
  $('division').onchange = (e) => { settings.division = e.target.value; saveSettings(); requestDraw(); e.target.blur(); };
  $('btnSnap').onclick = toggleSnap;
  $('btnGrid').onclick = toggleGrid;
  $('btnDetect').onclick = () => detectBeats();
  $('btnMetro').onclick = async () => { await ensureAudio(); toggleMetro(); };
  $('btnIn').onclick = () => setIn(snapIfStopped(currentPos()));
  $('btnOut').onclick = () => setOut(snapIfStopped(currentPos()));
  $('btnClearIO').onclick = clearIO;
  $('btnCrop').onclick = cropToSelection;
  $('btnMarker').onclick = () => addMarker(snapIfStopped(currentPos()));
  $('btnSection').onclick = addSectionFromSelection;
  $('btnUndo').onclick = undo; $('btnRedo').onclick = redo;
  $('btnZoomIn').onclick = () => zoomBy(0.66); $('btnZoomOut').onclick = () => zoomBy(1.5); $('btnFit').onclick = zoomFit;
  $('btnFollow').onclick = toggleFollow;

  $('btnOpen').onclick = () => $('fileInput').click();
  $('btnNew').onclick = newSession;
  $('btnSaveSession').onclick = saveSession;
  $('speedOut').onclick = (e) => { e.stopPropagation(); toggleSpeedPop(); };
  document.addEventListener('pointerdown', (e) => { if (!$('speedPop').hidden && !$('speedPop').contains(e.target) && e.target !== $('speedOut')) $('speedPop').hidden = true; });
  $('btnCustomSet').onclick = () => setSpeed(clamp(+$('customPct').value || 100, 25, 150) / 100);
  $('btnCustomAdd').onclick = () => {
    const v = Math.round(clamp(+$('customPct').value || 100, 25, 150));
    if (!settings.speedPresets.includes(v) && !BUILTIN_PRESETS.includes(v)) { settings.speedPresets.push(v); saveSettings(); }
    setSpeed(v / 100); renderPresets();
  };
  $('btnBpmSet').onclick = () => { const b = +$('targetBpm').value; if (b > 0) setSpeed(b / S.grid.bpm); };
  for (const id of ['customPct', 'targetBpm']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $(id === 'customPct' ? 'btnCustomSet' : 'btnBpmSet').click(); } });
  $('btnTrainer').onclick = openTrainer;
  for (const id of ['trStart', 'trTarget', 'trStep', 'trEvery', 'trUnit', 'trAt']) $(id).addEventListener('input', updateTrainerSummary);
  $('trCancel').onclick = () => $('dlgTrainer').close();
  $('trStop').onclick = () => { trainerStop(); $('dlgTrainer').close(); };
  $('trGo').onclick = () => { readTrainerForm(); $('dlgTrainer').close(); trainerStart(); };
  $('fileInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; openFile(f); };
  $('btnSave').onclick = openSaveDialog;
  $('btnHelp').onclick = () => $('dlgHelp').showModal();
  $('btnHelpClose').onclick = () => $('dlgHelp').close();

  // save dialog
  for (const id of ['saveName', 'savePattern']) $(id).oninput = updateSavePreview;
  $('saveRange').onchange = updateSavePreview;
  $('btnSaveCancel').onclick = () => $('dlgSave').close();
  $('btnSaveGo').onclick = async () => { const ok = await saveWav(); if (ok !== false) $('dlgSave').close(); };
  $('btnPickDir').onclick = async () => {
    try { const d = await invoke('pick_folder'); if (d) { settings.saveDir = d; saveSettings(); $('saveDir').textContent = d; $('optAutoSave').disabled = false; } } catch (e) { setMsg(String(e), true); }
  };
  $('btnClearDir').onclick = () => { settings.saveDir = ''; settings.autoSave = false; saveSettings(); $('saveDir').textContent = 'Ask every time'; $('optAutoSave').checked = false; $('optAutoSave').disabled = true; };
  $('optAutoSave').onchange = (e) => { settings.autoSave = e.target.checked; saveSettings(); };

  // audio dialog
  if (!TAURI) $('srcType').querySelector('[data-native]').remove();
  $('btnAudio').onclick = async () => {
    $('srcType').value = settings.srcType; $('recChannels').value = String(settings.recChannels);
    $('sampleRate').value = String(settings.sampleRate); $('latency').value = settings.latency;
    $('optMonitor').checked = settings.monitor; $('optMetroRec').checked = settings.metroRec; $('optDetect').checked = settings.detect;
    $('optRound').checked = settings.round; $('optReturn').checked = settings.returnOnStop; $('optStereoView').checked = settings.stereoView;
    updateSrcUI();
    $('dlgAudio').showModal();
    await refreshDevices();
  };
  $('btnAudioClose').onclick = () => $('dlgAudio').close();
  $('dlgAudio').addEventListener('close', () => { stopTest(); });
  $('srcType').onchange = async (e) => { settings.srcType = e.target.value; saveSettings(); updateSrcUI(); if (REC.testing) { await stopTest(); } };
  $('inDev').onchange = async (e) => { settings.inDev = e.target.value; saveSettings(); if (REC.testing) { await stopTest(); startTest(); } };
  $('loopDev').onchange = async (e) => { settings.loopDev = e.target.value; saveSettings(); if (REC.testing) { await stopTest(); startTest(); } };
  $('recChannels').onchange = (e) => { settings.recChannels = +e.target.value; saveSettings(); };
  $('outDev').onchange = async (e) => { settings.outDev = e.target.value; saveSettings(); await applyOutputDevice(); };
  $('sampleRate').onchange = async (e) => { settings.sampleRate = +e.target.value; saveSettings(); if (ctx) await restartAudio(); };
  $('latency').onchange = async (e) => { settings.latency = e.target.value; saveSettings(); if (ctx) await restartAudio(); };
  $('btnPerm').onclick = async () => {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch (e) { setSrcNote(recordErrorText(e), true); }
    refreshDevices();
  };
  $('btnTest').onclick = () => (REC.testing ? stopTest() : startTest());
  const opt = (id, key, fn) => { $(id).onchange = (e) => { settings[key] = e.target.checked; saveSettings(); if (fn) fn(); }; };
  opt('optMonitor', 'monitor', () => { if (REC.monitor) REC.monitor.gain.value = settings.monitor && S.recording ? 1 : 0; });
  opt('optMetroRec', 'metroRec'); opt('optDetect', 'detect'); opt('optRound', 'round'); opt('optReturn', 'returnOnStop');
  opt('optStereoView', 'stereoView', requestDraw);
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', () => { if ($('dlgAudio').open) refreshDevices(); });

  window.addEventListener('resize', resize);
  const watchDpr = () => {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener('change', () => { resize(); meterDrawn = [-1, -1]; watchDpr(); }, { once: true });
  };
  watchDpr();
  new ResizeObserver(resize).observe(tl);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); requestDraw(); });
  window.addEventListener('beforeunload', (e) => { if (S.dirty && S.channels) { e.preventDefault(); e.returnValue = ''; } });
  // the first gesture unlocks audio
  const unlock = () => { ensureAudio().catch(() => {}); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
}

readColors();
wire();
resize();
syncGridUI();
updateTransportUI();
updateStatus();
$('stSource').textContent = { loopback: 'System audio', input: 'Input device', display: 'Tab / screen' }[settings.srcType] || '–';
requestAnimationFrame(frame);
