import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// Wild animals: herds that wander the meadows, shy ones that bolt when you come close,
// crocodiles cruising the lake. Each one calls with its own real recorded voice (audio.call).
// Models live in assets/animals/<file>.glb; a species whose file is missing is simply skipped.
const SPECIES = [
  // len: body length in metres. flee: run when the player is closer than this. herd: [groups, members]
  { name: 'elephant', file: 'elephant', len: 6.2, herd: [2, 3], walk: 1.1, run: 3, flee: 0, call: 'elephant', every: [30, 70], ref: 30, where: 'meadow', clips: { call: 'Roar' } },
  { name: 'deer', file: 'deer', len: 2.4, herd: [3, 3], walk: 1.1, run: 9, flee: 16, call: 'deer', every: [30, 70], ref: 14, where: 'forest', clips: { idle: 'Stand_Breathing_01', walk: 'Walk', run: 'Run' } },
  { name: 'gazelle', file: 'gazelle', len: 1.4, herd: [3, 5], walk: 1.0, run: 11, flee: 18, call: 'gazelle', every: [40, 90], ref: 8, where: 'meadow' },
  { name: 'monkey', file: 'monkey', len: 1.5, herd: [2, 3], walk: 0.9, run: 5, flee: 9, call: 'monkey', every: [18, 45], ref: 16, where: 'forest', walkRate: 0.55, clips: { call: 'gorillastomp' } },
  { name: 'croc', file: 'croc', len: 4.2, herd: [1, 3], walk: 0.7, run: 1.4, flee: 0, call: 'croc', every: [25, 60], ref: 14, where: 'water', sink: 0.35 },
  { name: 'gator', file: 'alligator', len: 3.8, herd: [1, 3], walk: 0.5, run: 1.5, flee: 0, call: 'croc', every: [40, 90], ref: 14, where: 'shore' },
];
// each motion: clip-name patterns in order of preference
const CLIP = { idle: [/idle/i, /stand|breath/i, /eat|graz|look|survey/i], walk: [/walk/i], run: [/^run$|loco_run/i, /run|gallop|trot|sprint/i], swim: [/swim/i] };

export async function makeAnimals({ scene, loader, heightAt, WATER_Y, POND, rand, audio, isMeadow }) {
  const rr = (a, b) => a + (b - a) * rand();
  const land = (x, z) => heightAt(x, z) > WATER_Y + 0.6;
  const inLake = (x, z) => heightAt(x, z) < WATER_Y - 0.9 && Math.hypot(x - POND.x, z - POND.y) < 34;
  const shore = (x, z) => { const h = heightAt(x, z) - WATER_Y; return h > 0.2 && h < 1.6 && Math.hypot(x - POND.x, z - POND.y) < 50; };
  const fits = (sp, x, z) => (sp.where === 'water' ? inLake(x, z) : sp.where === 'shore' ? shore(x, z) : land(x, z) && (sp.where !== 'meadow' || isMeadow(x, z)));
  // meadow and forest spots spread around the start, nearest first, so you meet animals early
  const spots = (sp) => {
    const out = [];
    for (let r = 25; r < 230 && out.length < 40; r += 8) for (let a = 0; a < 6.28; a += 8 / r) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (fits(sp, x, z) && out.every((o) => Math.hypot(o[0] - x, o[1] - z) > 45)) out.push([x, z]);
    }
    return out;
  };

  class Animal {
    constructor(sp, src, clips, scale, yOff, x, z) {
      Object.assign(this, { sp, yOff });
      this.obj = SkeletonUtils.clone(src); this.obj.scale.setScalar(scale);
      this.obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } }); this.shadow = true;
      this.mixer = new THREE.AnimationMixer(this.obj);
      const pick = (k) => { for (const re of CLIP[k]) { const c = clips.find((c) => re.test(c.name)); if (c) return c; } };
      const walk = pick('walk') || pick('run') || clips[0], run = pick('run') || walk;
      this.actions = { idle: pick('idle') || clips[0], walk, run };
      if (sp.where === 'water' && pick('swim')) this.actions.walk = this.actions.run = pick('swim');
      for (const [k, n] of Object.entries(sp.clips || {})) this.actions[k] = clips.find((c) => c.name === n) || this.actions[k];
      for (const k in this.actions) this.actions[k] = this.mixer.clipAction(this.actions[k]);
      if (this.actions.call) { this.actions.call.setLoop(THREE.LoopOnce); this.actions.call.clampWhenFinished = true; }
      this.home = new THREE.Vector2(x, z); this.pos = new THREE.Vector2(x, z); this.target = new THREE.Vector2();
      this.heading = rand() * 6.28; this.state = 'idle'; this.timer = rr(0.5, 4); this.nextCall = rr(...sp.every) * rand();
      this.obj.position.set(x, this.y(), z);
      this.play('idle'); this.mixer.update(rand() * 5); scene.add(this.obj);
    }
    play(n) {
      if (this.cur === n) return;
      this.actions[n].reset().fadeIn(0.4).play();
      this.actions[n].timeScale = (n === 'walk' && this.sp.walkRate) || 1; // e.g. a run cycle slowed down to a walk
      if (this.cur && this.actions[this.cur] !== this.actions[n]) this.actions[this.cur].fadeOut(0.4);
      this.cur = n;
    }
    pickTarget(r) {
      for (let i = 0; i < 12; i++) {
        const a = rand() * 6.28, d = rr(r * 0.3, r);
        this.target.set(this.home.x + Math.cos(a) * d, this.home.y + Math.sin(a) * d);
        if (fits(this.sp, this.target.x, this.target.y)) return true;
      }
      return false;
    }
    y() { // crocodiles float with only eyes and back above the surface
      return this.sp.where === 'water' ? WATER_Y + this.yOff - this.sp.sink : heightAt(this.pos.x, this.pos.y) + this.yOff;
    }
    update(dt, px, pz) {
      const sp = this.sp, dp = Math.hypot(this.pos.x - px, this.pos.y - pz);
      this.obj.visible = dp < 170;                       // fog has swallowed it by then
      if (!this.obj.visible) return;
      const near = dp < 45;
      if (near !== this.shadow) { this.shadow = near; this.obj.traverse((o) => { if (o.isMesh) o.castShadow = near; }); }
      this.timer -= dt; this.nextCall -= dt;
      if (this.nextCall < 0) { // its own voice, from where it stands
        audio.call(sp.call, this.pos.x, this.obj.position.y + sp.len * 0.3, this.pos.y, { ref: sp.ref });
        if (this.actions.call && this.state === 'idle') { this.state = 'call'; this.timer = this.actions.call.getClip().duration; this.play('call'); } // trunk up, chest beat
        if (sp.where === 'water' && rand() < 0.5) audio.call('splash', this.pos.x, WATER_Y, this.pos.y, { ref: 8 });
        this.nextCall = rr(...sp.every) * (dp < 60 ? 0.6 : 1);
      }
      if (sp.flee && dp < sp.flee && this.state !== 'flee') {
        this.state = 'flee'; this.timer = rr(3, 5);
        this.target.set(this.pos.x + (this.pos.x - px) / dp * 40, this.pos.y + (this.pos.y - pz) / dp * 40);
        if (rand() < 0.5) audio.call(sp.call, this.pos.x, this.obj.position.y + 1, this.pos.y, { ref: sp.ref });
      }
      if (this.state === 'call') {
        if (this.timer < 0) { this.state = 'idle'; this.timer = rr(2, 6); }
      } else if (this.state === 'idle') {
        this.play('idle');
        if (this.timer < 0 && this.pickTarget(sp.where === 'water' ? 22 : 30)) { this.state = 'walk'; this.timer = 30; }
      } else {
        const flee = this.state === 'flee', dx = this.target.x - this.pos.x, dz = this.target.y - this.pos.y, dist = Math.hypot(dx, dz);
        if (dist < 0.8 || this.timer < 0) { this.state = 'idle'; this.timer = rr(3, 12); if (flee) this.home.copy(this.pos); }
        else {
          const diff = ((Math.atan2(dx, dz) - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          this.heading += diff * Math.min(1, dt * (flee ? 5 : 1.5));
          const v = flee ? sp.run : sp.walk;
          const nx = this.pos.x + Math.sin(this.heading) * v * dt, nz = this.pos.y + Math.cos(this.heading) * v * dt;
          if (sp.where === 'water' ? !inLake(nx, nz) : !land(nx, nz)) { this.state = 'idle'; this.timer = rr(1, 3); }
          else this.pos.set(nx, nz);
          this.play(flee ? 'run' : 'walk');
        }
      }
      this.obj.position.set(this.pos.x, this.y(), this.pos.y);
      this.obj.rotation.y = this.heading + (sp.yaw || 0);
      this.mixer.update(dt);
    }
  }

  const loaded = await Promise.all(SPECIES.map(async (sp) => {
    let gltf;
    try { gltf = await loader.loadAsync(`assets/animals/${sp.file}.glb`); } catch { return null; } // not downloaded: skip
    const src = gltf.scene;
    // older spec-gloss materials (three dropped them): feed their diffuse texture back in, or the animal renders white
    const sg = Object.fromEntries((gltf.parser.json.materials || []).map((m) => [m.name, m.extensions?.KHR_materials_pbrSpecularGlossiness]).filter((e) => e[1]));
    const fixes = [];
    src.traverse((o) => {
      const e = o.isMesh && sg[o.material.name];
      if (!e) return;
      const m = o.material; m.metalness = 0; m.roughness = 1 - 0.5 * (e.glossinessFactor ?? 1);
      if (e.diffuseFactor) m.color.fromArray(e.diffuseFactor);
      if (e.diffuseTexture) fixes.push(gltf.parser.getDependency('texture', e.diffuseTexture.index).then((t) => { t.colorSpace = THREE.SRGBColorSpace; m.map = t; m.needsUpdate = true; }));
    });
    await Promise.all(fixes);
    // measure the skin in its first animated pose: some rigs collapse to a point when unposed
    const mx = new THREE.AnimationMixer(src); if (gltf.animations[0]) { mx.clipAction(gltf.animations[0]).play(); mx.update(0); }
    src.updateMatrixWorld(true);
    src.traverse((o) => { if (o.isSkinnedMesh) { o.skeleton.update(); o.computeBoundingBox(); } });
    const box = new THREE.Box3().setFromObject(src), size = box.getSize(new THREE.Vector3());
    sp.yaw = size.x > size.z ? Math.PI / 2 : 0; // models modelled along x get turned to face +z
    // centre the model on its feet: some files sit metres away from their own origin
    const c = box.getCenter(new THREE.Vector3());
    src.position.set(-c.x, -box.min.y, -c.z);
    const holder = new THREE.Group().add(src);
    const scale = sp.len / Math.max(size.x, size.z), yOff = 0;
    return { sp, holder, clips: gltf.animations, scale, yOff };
  }));

  // every herd gets its own patch of land, at least 60 m from the others
  const all = [], taken = [], home = {};
  for (const L of loaded.filter(Boolean)) {
    const { sp } = L;
    const homes = sp.where === 'water' ? [[POND.x, POND.y]] : sp.with ? home[sp.with] || [] : [];
    if (!homes.length) for (const p of spots(sp)) {
      if (homes.length >= sp.herd[0]) break;
      if (sp.where === 'shore' || taken.every((t) => Math.hypot(t[0] - p[0], t[1] - p[1]) > 60)) { homes.push(p); taken.push(p); }
    }
    home[sp.name] = homes;
    for (const [hx, hz] of homes) for (let k = 0; k < sp.herd[1]; k++) {
      let x = hx, z = hz;
      for (let t = 0; t < 20; t++) { x = hx + rr(-12, 12); z = hz + rr(-12, 12); if (fits(sp, x, z)) break; }
      all.push(new Animal(sp, L.holder, L.clips, L.scale, L.yOff, x, z));
    }
  }
  return all;
}
