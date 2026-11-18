// Forest soundscape built from real field recordings (BBC Natural History Unit archive, see assets/README.txt).
// Ambience beds loop seamlessly; animal calls and footsteps are short clips placed in 3D with HRTF.
const rr = (a, b) => a + (b - a) * Math.random();
const S = 'assets/sounds/';
const CLIPS = {
  bed_pines: 1, bed_birds: 1, lake_lap: 1, frogs: 1, step: 10, run: 8,
  elephant: 3, elephant_b: 2, croc: 4, croc_splash: 4, chimp: 5, bonobo: 2, stag: 3, hind: 3, gazelle: 2,
};
// one call type -> the clip groups it may pick from
const CALLS = { elephant: ['elephant', 'elephant_b'], croc: ['croc'], splash: ['croc_splash'], monkey: ['chimp', 'bonobo'], deer: ['stag', 'hind'], gazelle: ['gazelle', 'hind'] };
const files = Object.entries(CLIPS).flatMap(([n, k]) => (k === 1 ? [n] : Array.from({ length: k }, (_, i) => `${n}_${i}`)));

export class ForestAudio {
  constructor({ pond }) {
    this.pond = pond; this.ctx = null; this.buf = {};
    this.raw = Object.fromEntries(files.map((f) => [f, fetch(S + f + '.ogg').then((r) => r.arrayBuffer())])); // download early, decode on first click
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = this.ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 3; comp.connect(ctx.destination);
    this.master = ctx.createGain(); this.master.gain.value = 0; this.master.connect(comp);
    this.master.gain.setTargetAtTime(1, ctx.currentTime, 1.5); // fade in
    this.reverb = ctx.createConvolver(); this.reverb.buffer = this.impulse(2.6, 2.4); this.reverb.connect(this.master);
    this.send = ctx.createGain(); this.send.gain.value = 0.3; this.send.connect(this.reverb);
    this.listenerPos = { x: 0, y: 0, z: 0 };
    this.nextBird = 0; // kept for video.js
    this.ready = Promise.all(files.map(async (f) => {
      try { (this.buf[f.replace(/_\d+$/, '')] ||= []).push(await ctx.decodeAudioData(await this.raw[f])); } catch (e) { console.warn('sound', f, e); }
    })).then(() => this.startBeds());
  }

  impulse(secs, decay) { // forest reverb tail
    const n = this.ctx.sampleRate * secs, b = this.ctx.createBuffer(2, n, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay) * (i < 400 ? i / 400 : 1); }
    return b;
  }
  gain(v) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  panner(x, y, z, ref, roll = 1.1) {
    const p = this.ctx.createPanner();
    Object.assign(p, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: ref, rolloffFactor: roll, maxDistance: 800 });
    p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    return p;
  }
  loop(name, dest, vol, offset = 0) {
    const s = this.ctx.createBufferSource(); s.buffer = this.buf[name][0]; s.loop = true;
    const g = this.gain(vol); s.connect(g).connect(dest); s.start(0, offset % s.buffer.duration);
    return g;
  }

  startBeds() {
    // wind in the pines + woodland birdsong, both stereo, all around you
    this.windBed = this.loop('bed_pines', this.master, 0.55);
    this.birdBed = this.loop('bed_birds', this.master, 0.5, 40);
    // the lake: water lapping at a few points of the shore, frogs in the reeds
    const p = this.pond;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2, pan = this.panner(p.x + Math.cos(a) * 30, p.y, p.z + Math.sin(a) * 30, 7, 1.3);
      pan.connect(this.master); this.loop('lake_lap', pan, 0.9, i * 27);
    }
    const fp = this.panner(p.x - 10, p.y, p.z + 18, 9, 1.2); fp.connect(this.master); fp.connect(this.send);
    this.loop('frogs', fp, 0.7);
  }

  // a real recorded call, coming from a point in the world
  call(kind, x, y, z, { ref = 12, vol = 1, rate = 1 } = {}, when = 0) {
    if (this.log) { this.log.push({ t: this.logT, kind, x, y, z, ref, vol, rate }); return 1; } // filming: replay later, in sync
    if (!this.ctx || (this.ctx.state !== 'running' && !when)) return 0;
    const groups = (CALLS[kind] || [kind]).filter((g) => this.buf[g]);
    if (!groups.length) return 0;
    const list = this.buf[groups[Math.floor(Math.random() * groups.length)]];
    const s = this.ctx.createBufferSource(); s.buffer = list[Math.floor(Math.random() * list.length)];
    s.playbackRate.value = rate * rr(0.96, 1.04);
    const p = this.panner(x, y, z, ref), g = this.gain(vol);
    s.connect(g).connect(p); p.connect(this.master); p.connect(this.send);
    s.onended = () => { g.disconnect(); p.disconnect(); };
    s.start(when);
    return s.buffer.duration;
  }

  step(run) {
    if (!this.ctx || !this.buf.step) return;
    const list = this.buf[run ? 'run' : 'step'], s = this.ctx.createBufferSource();
    s.buffer = list[Math.floor(Math.random() * list.length)]; s.playbackRate.value = rr(0.9, 1.1);
    const g = this.gain(run ? 0.55 : 0.4), p = this.ctx.createStereoPanner(); p.pan.value = rr(-0.15, 0.15);
    s.connect(g).connect(p).connect(this.master); s.start();
  }

  update(dt, cam) {
    const c = cam.position, f = cam.getWorldDirection(this._f || (this._f = cam.position.clone()));
    if (this.log) { this.poses.push([this.logT, c.x, c.y, c.z, f.x, f.y, f.z]); this.logT += dt; return; }
    const ctx = this.ctx; if (!ctx || ctx.state !== 'running') return;
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.value = c.x; L.positionY.value = c.y; L.positionZ.value = c.z;
      L.forwardX.value = f.x; L.forwardY.value = f.y; L.forwardZ.value = f.z; L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else { L.setPosition(c.x, c.y, c.z); L.setOrientation(f.x, f.y, f.z, 0, 1, 0); }
    if (this.windBed) { // birdsong thins out near the open lake, wind stays
      const dPond = Math.hypot(c.x - this.pond.x, c.z - this.pond.z);
      this.birdBed.gain.setTargetAtTime(0.25 + 0.25 * Math.min(1, dPond / 90), ctx.currentTime, 1);
    }
  }

  // ---------- video soundtrack: log what the world says while frames are rendered, then mix it offline
  beginLog() { this.log = []; this.poses = []; this.logT = 0; }
  async renderLog(seconds, sr = 48000) {
    const keep = { ctx: this.ctx, master: this.master, send: this.send, reverb: this.reverb, windBed: this.windBed, birdBed: this.birdBed };
    const log = this.log, poses = this.poses; this.log = null;
    const ctx = this.ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 3; comp.connect(ctx.destination);
    this.master = this.gain(0); this.master.connect(comp);
    this.master.gain.setValueAtTime(0, 0); this.master.gain.linearRampToValueAtTime(1, 1.5);
    this.master.gain.setValueAtTime(1, seconds - 1.5); this.master.gain.linearRampToValueAtTime(0, seconds);
    this.reverb = ctx.createConvolver(); this.reverb.buffer = this.impulse(2.6, 2.4); this.reverb.connect(this.master);
    this.send = this.gain(0.3); this.send.connect(this.reverb);
    this.startBeds();
    const L = ctx.listener, P = ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ'];
    poses.forEach(([t, ...v], i) => {
      P.forEach((k, j) => L[k].setValueAtTime(v[j], t));
      if (i % 6 === 0) this.birdBed.gain.setValueAtTime(0.25 + 0.25 * Math.min(1, Math.hypot(v[0] - this.pond.x, v[2] - this.pond.z) / 90), t);
    });
    for (const e of log) this.call(e.kind, e.x, e.y, e.z, e, Math.max(e.t, 1e-3));
    const out = await ctx.startRendering();
    Object.assign(this, keep);
    return out;
  }
}
