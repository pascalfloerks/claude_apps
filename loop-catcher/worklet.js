// Loop Catcher – audio worklet processors.
// This function is never called on the main thread: its source text is turned into a Blob
// and loaded with audioWorklet.addModule(), so the app also works when opened from file://.
//
//  "lc-player"   plays the track with a pitch-preserving time stretch (WSOLA), loops, scrubs
//                and renders the metronome click on a second output.
//  "lc-recorder" collects input samples and hands them to the main thread in blocks.
function lcWorkletModule() {
  const FRAME = 2048;            // WSOLA frame length (samples)
  const HOP = FRAME / 2;         // synthesis hop: 50 % overlap of a periodic Hann window sums to 1
  const SEEK = 384;              // search range (± samples) for the best-matching analysis frame
  const XFADE = 256;             // crossfade at the loop seam (samples)

  class Player extends AudioWorkletProcessor {
    constructor() {
      super();
      this.ch = [new Float32Array(0)];
      this.len = 0;
      this.win = new Float32Array(FRAME);
      for (let i = 0; i < FRAME; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME);
      this.seg = [new Float32Array(FRAME + 2 * SEEK + HOP), new Float32Array(FRAME + 2 * SEEK + HOP)];
      this.nat = [new Float32Array(FRAME), new Float32Array(FRAME)];
      this.acc = [new Float32Array(FRAME), new Float32Array(FRAME)];
      this.out = [new Float32Array(HOP), new Float32Array(HOP)];
      this.outPos = HOP; this.outFill = HOP;
      this.outSrc = new Float64Array(HOP); // timeline position of each output sample
      this.playing = false;
      this.speed = 1;
      this.loop = false; this.loopStart = 0; this.loopEnd = 0;
      this.ana = 0; this.prevSel = 0; this.fresh = true;
      this.pos = 0; this.lastReport = 0; this.ending = -1;
      // scrub
      this.scrub = false; this.scrubPos = 0; this.scrubTarget = 0; this.scrubGain = 0; this.scrubVel = 0;
      // metronome
      this.met = { on: false, bpm: 120, offset: 0, beats: 4, vol: 0.6, accent: true };
      this.freeClock = false; this.freePos = 0;
      this.clickPhase = 0; this.clickLeft = 0; this.clickFreq = 1000; this.clickAmp = 0; this.lastBeat = null;
      this.port.onmessage = (e) => this.onMsg(e.data);
    }

    onMsg(m) {
      switch (m.type) {
        case 'buffer':
          this.ch = m.channels; this.len = m.channels[0].length;
          this.reset(Math.min(this.pos, this.len));
          break;
        case 'play': this.playing = true; this.ending = -1; this.reset(m.pos); this.lastBeat = null; break;
        case 'stop': this.playing = false; this.scrub = false; break;
        case 'seek': this.reset(m.pos); this.lastBeat = null; break;
        case 'speed': this.speed = Math.max(0.1, Math.min(4, m.speed)); break;
        case 'loop':
          this.loop = !!m.on; this.loopStart = Math.max(0, m.start | 0); this.loopEnd = Math.min(this.len, m.end | 0);
          if (this.loopEnd - this.loopStart < FRAME) this.loop = false;
          break;
        case 'scrubStart': this.scrub = true; this.scrubPos = this.scrubTarget = m.pos; this.scrubGain = 0; this.scrubVel = 0; break;
        case 'scrubMove': this.scrubTarget = m.pos; break;
        case 'scrubEnd': this.scrub = false; break;
        case 'metro': Object.assign(this.met, m.cfg); break;
        case 'freeClock': this.freeClock = !!m.on; this.freePos = 0; this.lastBeat = null; break;
      }
    }

    reset(pos) {
      pos = Math.max(0, Math.min(this.len, Math.round(pos || 0)));
      this.ana = pos; this.prevSel = pos; this.fresh = true; this.pos = pos;
      for (let c = 0; c < 2; c++) this.acc[c].fill(0);
      this.outPos = HOP; this.outFill = HOP;
    }

    // Read src[i] for channel c, honouring the loop (positions past loopEnd continue at loopStart,
    // with a short crossfade from the audio just before loopStart into the seam).
    fill(dst, c, start, n) {
      const s = this.ch[c] || this.ch[0];
      const len = this.len;
      const lp = this.loop, ls = this.loopStart, le = this.loopEnd, ll = le - ls;
      const xf = Math.min(XFADE, ls, ll >> 2);
      for (let k = 0; k < n; k++) {
        let i = start + k;
        if (lp && i >= le) i = ls + ((i - le) % ll);
        let v = 0;
        if (i >= 0 && i < len) v = s[i];
        if (lp && xf > 0 && i >= le - xf && i < le) {
          const t = (i - (le - xf)) / xf;
          const j = ls - xf + (i - (le - xf));
          v = v * (1 - t) + s[j] * t;
        }
        dst[k] = v;
      }
    }

    wrap(p) {
      if (this.loop && p >= this.loopEnd) p = this.loopStart + ((p - this.loopEnd) % (this.loopEnd - this.loopStart));
      return p;
    }

    // Produce the next HOP output samples with WSOLA.
    frame() {
      const nch = Math.min(2, this.ch.length);
      const ha = HOP * this.speed;
      const target = Math.round(this.ana);
      let sel = target;
      if (!this.fresh) {
        // natural continuation of the previous frame
        const natStart = this.prevSel + HOP;
        for (let c = 0; c < nch; c++) this.fill(this.nat[c], c, natStart, HOP);
        for (let c = 0; c < nch; c++) this.fill(this.seg[c], c, target - SEEK, HOP + 2 * SEEK);
        // coarse search on a mono mix, then refine
        const segM = this.seg[0], segS = nch > 1 ? this.seg[1] : null;
        const natM = this.nat[0], natS = nch > 1 ? this.nat[1] : null;
        const corr = (off) => {
          let sum = 0, e = 1e-9;
          for (let j = 0; j < HOP; j += 4) {
            const a = segS ? segM[off + j] + segS[off + j] : segM[off + j];
            const b = natS ? natM[j] + natS[j] : natM[j];
            sum += a * b; e += a * a;
          }
          return sum / Math.sqrt(e);
        };
        let best = SEEK, bestV = -Infinity;
        for (let off = 0; off <= 2 * SEEK; off += 8) { const v = corr(off); if (v > bestV) { bestV = v; best = off; } }
        const lo = Math.max(0, best - 7), hi = Math.min(2 * SEEK, best + 7);
        for (let off = lo; off <= hi; off++) { const v = corr(off); if (v > bestV) { bestV = v; best = off; } }
        // at normal speed with nothing to correct, stay sample-exact
        if (this.speed === 1 && corr(SEEK) >= bestV - 1e-6) best = SEEK;
        sel = target - SEEK + best;
      }
      this.fresh = false;
      for (let c = 0; c < nch; c++) {
        const acc = this.acc[c], w = this.win, buf = this.seg[c];
        this.fill(buf, c, sel, FRAME);
        for (let j = 0; j < FRAME; j++) acc[j] += w[j] * buf[j];
        this.out[c].set(acc.subarray(0, HOP));
        acc.copyWithin(0, HOP); acc.fill(0, FRAME - HOP);
      }
      if (nch === 1) this.out[1].set(this.out[0]);
      // timeline position of the samples just produced
      for (let j = 0; j < HOP; j++) this.outSrc[j] = this.wrap(target + j * this.speed);
      this.prevSel = sel;
      this.ana = this.wrap(this.ana + ha);
      if (this.loop && this.prevSel >= this.loopEnd) this.prevSel -= (this.loopEnd - this.loopStart);
      this.outPos = 0; this.outFill = HOP;
    }

    click(beatIndex) {
      const m = this.met;
      const isBar = m.accent && (((beatIndex % m.beats) + m.beats) % m.beats === 0);
      this.clickFreq = isBar ? 1760 : 1175;
      this.clickAmp = (isBar ? 1 : 0.7) * m.vol;
      this.clickLeft = Math.round(sampleRate * 0.035);
      this.clickPhase = 0;
    }

    metroAt(posSamples) {
      const m = this.met;
      if (!m.on) { this.lastBeat = null; return; }
      const t = posSamples / sampleRate;
      const beatLen = 60 / m.bpm;
      const b = Math.floor((t - m.offset) / beatLen + 1e-9);
      if (this.lastBeat === null) { this.lastBeat = b; if (Math.abs((t - m.offset) / beatLen - b) < 0.002) this.click(b); return; }
      if (b !== this.lastBeat) { if (b > this.lastBeat || b < this.lastBeat - 1) this.click(b); this.lastBeat = b; }
    }

    process(inputs, outputs) {
      const out = outputs[0], clk = outputs[1];
      const L = out[0], R = out[1] || out[0];
      const n = L.length;
      const cL = clk && clk[0], cR = clk && (clk[1] || clk[0]);
      if (this.scrub && this.len > 0) {
        const s0 = this.ch[0], s1 = this.ch[1] || s0;
        const alpha = 1 / (0.035 * sampleRate);
        for (let i = 0; i < n; i++) {
          let v = (this.scrubTarget - this.scrubPos) * alpha;
          if (v > 4) v = 4; else if (v < -4) v = -4;
          this.scrubVel += (v - this.scrubVel) * 0.01;
          this.scrubPos += this.scrubVel;
          const g = Math.min(1, Math.abs(this.scrubVel) * 3);
          this.scrubGain += (g - this.scrubGain) * 0.005;
          const p = this.scrubPos, i0 = Math.floor(p), f = p - i0;
          let a = 0, b = 0;
          if (i0 >= 0 && i0 + 1 < this.len) { a = s0[i0] + (s0[i0 + 1] - s0[i0]) * f; b = s1[i0] + (s1[i0 + 1] - s1[i0]) * f; }
          L[i] = a * this.scrubGain; R[i] = b * this.scrubGain;
        }
        this.pos = this.scrubPos;
      } else if (this.playing && this.len > 0) {
        for (let i = 0; i < n; i++) {
          if (this.outPos >= this.outFill) this.frame();
          const p = this.outSrc[this.outPos];
          L[i] = this.out[0][this.outPos]; R[i] = this.out[1][this.outPos];
          this.outPos++;
          this.pos = p;
          this.metroAt(p);
          if (cL) cL[i] = this.renderClick();
          if (!this.loop && p >= this.len - 1) { this.playing = false; this.ending = 1; for (let k = i + 1; k < n; k++) { L[k] = 0; R[k] = 0; } break; }
        }
        if (cR && cL !== cR) cR.set(cL);
      } else if (this.freeClock) {
        for (let i = 0; i < n; i++) {
          this.freePos++;
          this.metroAt(this.freePos);
          if (cL) cL[i] = this.renderClick();
        }
        if (cR && cL !== cR) cR.set(cL);
      }
      if (!this.playing && !this.freeClock && cL && this.clickLeft > 0) {
        for (let i = 0; i < n; i++) cL[i] = this.renderClick();
        if (cR && cL !== cR) cR.set(cL);
      }
      this.lastReport += n;
      if (this.lastReport >= 1024 || this.ending === 1) {
        this.lastReport = 0;
        this.port.postMessage({ type: 'pos', pos: this.pos, playing: this.playing, scrub: this.scrub, ended: this.ending === 1, t: currentTime });
        if (this.ending === 1) this.ending = 0;
      }
      return true;
    }

    renderClick() {
      if (this.clickLeft <= 0) return 0;
      const total = Math.round(sampleRate * 0.035);
      const k = total - this.clickLeft;
      this.clickLeft--;
      const env = Math.exp(-k / (sampleRate * 0.006)) * Math.min(1, k / 24);
      this.clickPhase += 2 * Math.PI * this.clickFreq / sampleRate;
      return Math.sin(this.clickPhase) * env * this.clickAmp;
    }
  }
  registerProcessor('lc-player', Player);

  class Recorder extends AudioWorkletProcessor {
    constructor() {
      super();
      this.on = false;
      this.block = 4096;
      this.buf = [new Float32Array(this.block), new Float32Array(this.block)];
      this.n = 0;
      this.peak = [0, 0]; this.meterCount = 0;
      this.port.onmessage = (e) => {
        if (e.data.type === 'start') { this.on = true; this.n = 0; }
        if (e.data.type === 'stop') { this.flush(); this.on = false; this.port.postMessage({ type: 'stopped' }); }
      };
    }
    flush() {
      if (this.n === 0) return;
      const l = this.buf[0].slice(0, this.n), r = this.buf[1].slice(0, this.n);
      this.port.postMessage({ type: 'data', l, r }, [l.buffer, r.buffer]);
      this.n = 0;
    }
    process(inputs, outputs) {
      const inp = inputs[0];
      if (!inp || inp.length === 0) return true;
      const l = inp[0], r = inp[1] || inp[0];
      const n = l.length;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(l[i]), b = Math.abs(r[i]);
        if (a > this.peak[0]) this.peak[0] = a;
        if (b > this.peak[1]) this.peak[1] = b;
      }
      if (this.on) {
        for (let i = 0; i < n; i++) {
          this.buf[0][this.n] = l[i]; this.buf[1][this.n] = r[i]; this.n++;
          if (this.n === this.block) this.flush();
        }
      }
      // pass through (for optional monitoring)
      const o = outputs[0];
      if (o && o[0]) { o[0].set(l); if (o[1]) o[1].set(r); }
      if (++this.meterCount >= 8) {
        this.meterCount = 0;
        this.port.postMessage({ type: 'meter', l: this.peak[0], r: this.peak[1] });
        this.peak[0] = 0; this.peak[1] = 0;
      }
      return true;
    }
  }
  registerProcessor('lc-recorder', Recorder);
}
