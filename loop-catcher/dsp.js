// Loop Catcher – offline DSP: beat detection (runs in a Web Worker) and WAV reading/writing.
'use strict';

/* ---------------------------------------------------------------------------------------------
   Beat detection
   1. Onset strength: log-magnitude spectral flux (whole spectrum and a low "kick" band).
   2. Tempo: autocorrelation of the onset envelope with a prior around 120 BPM, then a fine search
      that maximises how well an evenly spaced beat comb lines up with the onsets over the whole track.
   3. Phase: the comb offset with the most onset energy; downbeat: the beat of the bar with the
      strongest low-frequency onsets.
   Like lcWorkletModule, this function is turned into a Blob and run as a Worker.
--------------------------------------------------------------------------------------------- */
function lcBeatWorker() {
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  function detect(mono, sr, opts) {
    // decimate to ~22-24 kHz
    let d = 1; while (sr / (d * 2) >= 20000) d *= 2;
    const n2 = Math.floor(mono.length / d), x = new Float32Array(n2);
    for (let i = 0; i < n2; i++) { let s = 0; for (let k = 0; k < d; k++) s += mono[i * d + k]; x[i] = s / d; }
    const sr2 = sr / d, N = 1024, H = 256, fr = sr2 / H;
    const frames = Math.max(0, Math.floor((n2 - N) / H) + 1);
    if (frames < fr * 4) return { error: 'The track is too short for beat detection (at least ~5 seconds needed).' };
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const bins = N / 2, lowBin = Math.max(2, Math.round(160 / (sr2 / N)));
    const re = new Float32Array(N), im = new Float32Array(N);
    let prev = new Float32Array(bins), cur = new Float32Array(bins);
    const flux = new Float32Array(frames), low = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      const o = f * H;
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let s = 0, sl = 0;
      for (let b = 1; b < bins; b++) {
        const m = Math.log1p(100 * Math.sqrt(re[b] * re[b] + im[b] * im[b]));
        cur[b] = m;
        const dlt = m - prev[b];
        if (dlt > 0) { s += dlt; if (b <= lowBin) sl += dlt; }
      }
      flux[f] = f === 0 ? 0 : s; low[f] = f === 0 ? 0 : sl;
      const t = prev; prev = cur; cur = t;
      if ((f & 1023) === 0) postMessage({ type: 'progress', value: 0.6 * f / frames });
    }
    // remove the local mean, half-wave rectify, normalise
    const env = hp(flux, Math.round(fr * 0.4)), envL = hp(low, Math.round(fr * 0.4));
    // a frame's flux peaks once the onset reaches the middle of its window (measured on test signals)
    const t0 = (N * 0.7) / sr2;

    // --- coarse tempo by autocorrelation
    const minBpm = opts.minBpm || 55, maxBpm = opts.maxBpm || 210;
    const lagMin = Math.floor(fr * 60 / maxBpm), lagMax = Math.ceil(fr * 60 / minBpm);
    const ac = new Float32Array(lagMax * 2 + 2);
    for (let l = lagMin; l <= Math.min(lagMax * 2, frames - 1); l++) {
      let s = 0; for (let i = 0; i + l < frames; i++) s += env[i] * env[i + l];
      ac[l] = s / (frames - l);
    }
    postMessage({ type: 'progress', value: 0.75 });
    let bestL = lagMin, bestS = -1;
    const score = new Float32Array(lagMax + 1);
    for (let l = lagMin; l <= lagMax; l++) {
      const bpm = 60 * fr / l;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      const s = (ac[l] + 0.5 * (ac[2 * l] || 0)) * prior;
      score[l] = s;
      if (s > bestS) { bestS = s; bestL = l; }
    }
    let lag = bestL;
    if (bestL > lagMin && bestL < lagMax) {
      const a = score[bestL - 1], b = score[bestL], c = score[bestL + 1], den = a - 2 * b + c;
      if (den !== 0) lag = bestL + 0.5 * (a - c) / den;
    }
    let bpm = 60 * fr / lag;

    // --- fine tempo: best comb alignment over the whole track
    const comb = (period) => {
      const P = period, steps = Math.max(8, Math.ceil(P * 2));
      let best = -1, bestPh = 0;
      for (let s = 0; s < steps; s++) {
        const ph = s * P / steps; let sum = 0, cnt = 0;
        for (let p = ph; p < frames - 1; p += P) { const i = p | 0, f = p - i; sum += env[i] * (1 - f) + env[i + 1] * f; cnt++; }
        sum /= cnt;
        if (sum > best) { best = sum; bestPh = ph; }
      }
      return { score: best, phase: bestPh };
    };
    let bestComb = null;
    for (let k = -60; k <= 60; k++) {
      const cand = bpm * (1 + k * 0.0005);
      const r = comb(60 * fr / cand);
      if (!bestComb || r.score > bestComb.score) bestComb = { ...r, bpm: cand };
    }
    postMessage({ type: 'progress', value: 0.9 });
    bpm = bestComb.bpm;
    if (opts.round && Math.abs(bpm - Math.round(bpm)) < 0.25) {
      bpm = Math.round(bpm);
      bestComb = { ...comb(60 * fr / bpm), bpm };
    }
    const P = 60 * fr / bpm;
    const phase = bestComb.phase;
    // --- downbeat: which beat of the bar carries the most low-end onset energy
    const beats = Math.max(1, opts.beatsPerBar || 4);
    const sums = new Float64Array(beats), alls = new Float64Array(beats);
    let idx = 0;
    const peakNear = (arr, p) => { const i = Math.round(p); let m = 0; for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < frames && arr[k] > m) m = arr[k]; return m; };
    for (let p = phase; p < frames - 1; p += P, idx++) { sums[idx % beats] += peakNear(envL, p); alls[idx % beats] += peakNear(env, p); }
    let down = 0, dv = -1;
    const lt = sums.reduce((a, b) => a + b, 0) || 1, at = alls.reduce((a, b) => a + b, 0) || 1;
    for (let b = 0; b < beats; b++) { const v = sums[b] / lt + 0.35 * alls[b] / at; if (v > dv) { dv = v; down = b; } }
    const beatSec = 60 / bpm;
    let offset = phase / fr + t0 + down * beatSec;
    const barSec = beatSec * beats;
    offset = ((offset % barSec) + barSec) % barSec;
    // confidence: comb score relative to the average envelope level
    let mean = 0; for (let i = 0; i < frames; i++) mean += env[i]; mean /= frames;
    const confidence = Math.max(0, Math.min(1, (bestComb.score / (mean || 1) - 1) / 3));
    // individual beat times (for display)
    const beatTimes = [];
    for (let t = offset - Math.floor(offset / beatSec) * beatSec; t < mono.length / sr; t += beatSec) beatTimes.push(t);
    return { bpm, offset, confidence, beatTimes };
  }

  function hp(a, w) {
    const n = a.length, out = new Float32Array(n);
    let s = 0; const q = [];
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
    let mx = 0;
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - w), hi = Math.min(n, i + w + 1);
      const m = (pre[hi] - pre[lo]) / (hi - lo);
      const v = a[i] - m; out[i] = v > 0 ? v : 0;
      if (out[i] > mx) mx = out[i];
    }
    if (mx > 0) for (let i = 0; i < n; i++) out[i] /= mx;
    return out;
  }

  self.onmessage = (e) => {
    try { postMessage({ type: 'result', result: detect(e.data.mono, e.data.sr, e.data.opts || {}) }); }
    catch (err) { postMessage({ type: 'result', result: { error: String(err && err.message || err) } }); }
  };
}

function lcDetectBeats(channels, sr, opts, onProgress) {
  return new Promise((resolve) => {
    const n = channels[0].length, mono = new Float32Array(n);
    for (const c of channels) for (let i = 0; i < n; i++) mono[i] += c[i] / channels.length;
    const url = URL.createObjectURL(new Blob([`(${lcBeatWorker.toString()})()`], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = (e) => {
      if (e.data.type === 'progress') { if (onProgress) onProgress(e.data.value); return; }
      w.terminate(); URL.revokeObjectURL(url); resolve(e.data.result);
    };
    w.onerror = (e) => { w.terminate(); URL.revokeObjectURL(url); resolve({ error: e.message || 'Beat detection failed' }); };
    w.postMessage({ mono, sr, opts }, [mono.buffer]);
  });
}

/* ---------------------------------------------------------------------------------------------
   WAV writing: PCM 16/24-bit or 32-bit float, with markers as cue points (+ labels), sections
   as regions (labelled text with a length) – readable by most DAWs and editors – and the full
   Loop Catcher state (grid, markers, sections, colours) as JSON in the INFO comment.
--------------------------------------------------------------------------------------------- */
function lcEncodeWav(channels, sr, bits, meta, cueShift = 0) {
  const nch = channels.length, len = channels[0].length;
  const float = bits === 32, bps = bits / 8;
  const dataBytes = len * nch * bps;
  const parts = [];
  const enc = new TextEncoder();
  const str4 = (s) => enc.encode(s);
  const chunk = (id, body) => {
    const pad = body.byteLength & 1;
    const b = new Uint8Array(8 + body.byteLength + pad);
    b.set(str4(id), 0); new DataView(b.buffer).setUint32(4, body.byteLength, true);
    b.set(new Uint8Array(body.buffer || body, body.byteOffset || 0, body.byteLength), 8);
    return b;
  };
  // fmt
  const fmt = new DataView(new ArrayBuffer(16));
  fmt.setUint16(0, float ? 3 : 1, true); fmt.setUint16(2, nch, true); fmt.setUint32(4, sr, true);
  fmt.setUint32(8, sr * nch * bps, true); fmt.setUint16(12, nch * bps, true); fmt.setUint16(14, bits, true);
  parts.push(chunk('fmt ', new Uint8Array(fmt.buffer)));
  if (float) { const f = new DataView(new ArrayBuffer(4)); f.setUint32(0, len, true); parts.push(chunk('fact', new Uint8Array(f.buffer))); }
  // data
  const data = new Uint8Array(dataBytes), dv = new DataView(data.buffer);
  let o = 0;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      let v = channels[c][i];
      if (float) { dv.setFloat32(o, v, true); o += 4; continue; }
      v = v > 1 ? 1 : v < -1 ? -1 : v;
      if (bits === 16) { dv.setInt16(o, Math.round(v < 0 ? v * 32768 : v * 32767), true); o += 2; }
      else { const s = Math.round(v < 0 ? v * 8388608 : v * 8388607); dv.setUint8(o, s & 255); dv.setUint8(o + 1, (s >> 8) & 255); dv.setUint8(o + 2, (s >> 16) & 255); o += 3; }
    }
  }
  parts.push(chunk('data', data));
  // cue points and labels
  const markers = (meta && meta.markers) || [], sections = (meta && meta.sections) || [];
  const cues = [];
  // cueShift converts the meta's time base to positions in this file (sessions keep timeline times in the JSON)
  markers.forEach((m) => cues.push({ pos: Math.round((m.time + cueShift) * sr), name: m.name || 'Marker' }));
  sections.forEach((s) => cues.push({ pos: Math.round((s.start + cueShift) * sr), name: s.name || 'Section', length: Math.round((s.end - s.start) * sr) }));
  for (let i = cues.length - 1; i >= 0; i--) if (cues[i].pos < 0 || cues[i].pos > len) cues.splice(i, 1);
  if (cues.length) {
    const cue = new DataView(new ArrayBuffer(4 + 24 * cues.length));
    cue.setUint32(0, cues.length, true);
    cues.forEach((c, i) => {
      const b = 4 + 24 * i;
      cue.setUint32(b, i + 1, true); cue.setUint32(b + 4, c.pos, true);
      new Uint8Array(cue.buffer).set(str4('data'), b + 8);
      cue.setUint32(b + 12, 0, true); cue.setUint32(b + 16, 0, true); cue.setUint32(b + 20, c.pos, true);
    });
    parts.push(chunk('cue ', new Uint8Array(cue.buffer)));
    const sub = [str4('adtl')];
    cues.forEach((c, i) => {
      const txt = enc.encode(c.name + '\0');
      const l = new Uint8Array(4 + txt.length); new DataView(l.buffer).setUint32(0, i + 1, true); l.set(txt, 4);
      sub.push(chunk('labl', l));
      if (c.length != null) {
        const t = new DataView(new ArrayBuffer(20));
        t.setUint32(0, i + 1, true); t.setUint32(4, c.length, true);
        new Uint8Array(t.buffer).set(str4('rgn '), 8);
        sub.push(chunk('ltxt', new Uint8Array(t.buffer)));
      }
    });
    parts.push(chunk('LIST', concat(sub)));
  }
  // INFO with software name and full state
  const info = [str4('INFO'), chunk('ISFT', enc.encode('Loop Catcher\0'))];
  if (meta) info.push(chunk('ICMT', enc.encode('LoopCatcher:' + JSON.stringify({ v: 1, ...meta }) + '\0')));
  parts.push(chunk('LIST', concat(info)));
  const body = concat([str4('WAVE'), ...parts]);
  const out = new Uint8Array(8 + body.length);
  out.set(str4('RIFF'), 0); new DataView(out.buffer).setUint32(4, body.length, true); out.set(body, 8);
  return out;
}

function concat(arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// Read markers/sections back from a WAV file (our JSON if present, else standard cue/label chunks).
function lcReadWavMeta(arrayBuffer) {
  try {
    const dv = new DataView(arrayBuffer), dec = new TextDecoder();
    const id = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (dv.byteLength < 12 || id(0) !== 'RIFF' || id(8) !== 'WAVE') return null;
    let sr = 44100, json = null; const cues = new Map(), labels = new Map(), lengths = new Map();
    const walk = (start, end, inList) => {
      let o = start;
      while (o + 8 <= end) {
        const cid = id(o), size = dv.getUint32(o + 4, true), b = o + 8;
        if (b + size > dv.byteLength + 1) break;
        if (cid === 'fmt ') sr = dv.getUint32(b + 4, true);
        else if (cid === 'cue ') {
          const n = dv.getUint32(b, true);
          for (let i = 0; i < n; i++) cues.set(dv.getUint32(b + 4 + 24 * i, true), dv.getUint32(b + 4 + 24 * i + 20, true));
        } else if (cid === 'LIST') walk(b + 4, b + size, id(b));
        else if (cid === 'labl' && inList === 'adtl') labels.set(dv.getUint32(b, true), dec.decode(new Uint8Array(arrayBuffer, b + 4, size - 4)).replace(/\0.*$/s, ''));
        else if (cid === 'ltxt' && inList === 'adtl') lengths.set(dv.getUint32(b, true), dv.getUint32(b + 4, true));
        else if (cid === 'ICMT' && inList === 'INFO') {
          const t = dec.decode(new Uint8Array(arrayBuffer, b, size)).replace(/\0.*$/s, '');
          if (t.startsWith('LoopCatcher:')) { try { json = JSON.parse(t.slice(12)); } catch (e) { /* ignore */ } }
        }
        o = b + size + (size & 1);
      }
    };
    walk(12, dv.byteLength, null);
    if (json) return json;
    if (!cues.size) return null;
    const markers = [], sections = [];
    for (const [cid, pos] of cues) {
      const name = labels.get(cid) || '';
      if (lengths.has(cid) && lengths.get(cid) > 0) sections.push({ start: pos / sr, end: (pos + lengths.get(cid)) / sr, name: name || 'Section' });
      else markers.push({ time: pos / sr, name: name || 'Marker' });
    }
    return { markers, sections };
  } catch (e) { return null; }
}
