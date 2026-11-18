import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { ForestAudio } from './audio.js';
import { LodScatter } from './scatter.js';
import { makeImpostors } from './impostor.js';
import { makeGrass } from './grass.js';
import { makeAnimals } from './animals.js';

// Real assets: Poly Haven photogrammetry scans (CC0), reduced for real time in Blender (see assets/README.txt)
const A = 'assets/';
const GH = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/';
const FOX_URL = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/Fox/glTF-Binary/Fox.glb';

let seed = 20261116;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const rr = (a, b) => a + (b - a) * rand();
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ---------- renderer / scene / camera
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // refreshed every few frames in the loop
document.body.prepend(renderer.domElement);
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 2000);
scene.fog = new THREE.FogExp2(0x9eaea6, 0.0085);

// ---------- sky, sun, real-world ambient light (HDRI shot in a pine forest)
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 26), THREE.MathUtils.degToRad(205));
{
  const s = new Sky(); s.scale.setScalar(1900);
  const u = s.material.uniforms;
  u.turbidity.value = 5.5; u.rayleigh.value = 1.4; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;
  u.sunPosition.value.copy(sunDir);
  scene.add(s);
}
const pmrem = new THREE.PMREMGenerator(renderer);
new RGBELoader().load(A + 'hdri/misty_pines_1k.hdr', (t) => { t.mapping = THREE.EquirectangularReflectionMapping; scene.environment = pmrem.fromEquirectangular(t).texture; t.dispose(); });
scene.environmentIntensity = 0.45;

const sun = new THREE.DirectionalLight(0xffe7c8, 3.4);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 400 });
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a2617, 0.25));

// ---------- terrain
const WORLD = 600, HALF = WORLD / 2, RES = 241, CELL = WORLD / (RES - 1);
const noise = new ImprovedNoise();
const POND = new THREE.Vector2(38, -58);
function baseHeight(x, z) {
  let h = 0, amp = 13, f = 1 / 170;
  for (let o = 0; o < 5; o++) { h += noise.noise(x * f, z * f, 7.3) * amp; amp *= 0.45; f *= 2.1; }
  return h;
}
const H0 = baseHeight(POND.x, POND.y);
const WATER_Y = H0 - 1.2;
function rawHeight(x, z) {
  let h = baseHeight(x, z);
  const d = Math.hypot(x - POND.x, z - POND.y);
  h = THREE.MathUtils.lerp(h, Math.max(h, H0 + 0.3), 1 - smooth(30, 52, d)); // rim keeps water in
  h = THREE.MathUtils.lerp(h, H0 - 4, 1 - smooth(11, 35, d));               // basin
  return h;
}
const heights = new Float32Array(RES * RES);
for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) heights[j * RES + i] = rawHeight(-HALF + i * CELL, -HALF + j * CELL);
function heightAt(x, z) {
  const gx = THREE.MathUtils.clamp((x + HALF) / CELL, 0, RES - 1.001), gz = THREE.MathUtils.clamp((z + HALF) / CELL, 0, RES - 1.001);
  const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j, k = j * RES + i;
  const a = heights[k], b = heights[k + 1], c = heights[k + RES], d = heights[k + RES + 1];
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

const tl = new THREE.TextureLoader();
const tex = (f, srgb, rep) => {
  const t = tl.load(A + 'textures/' + f);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso; t.repeat.set(rep, rep);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
};
{ // forest floor: two scanned ground textures (needles + leaves), mixed by noise so tiling doesn't show
  const g = new THREE.PlaneGeometry(WORLD, WORLD, RES - 1, RES - 1);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position, col = new Float32Array(p.count * 3), mix = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), y = rawHeight(x, z);
    p.setY(i, y);
    const shore = 1 - smooth(WATER_Y - 0.3, WATER_Y + 1.5, y);
    const tint = 0.55 + 0.15 * noise.noise(x * 0.02, z * 0.02, 2.2);
    col.set([tint * 0.42 * (1 - shore * 0.1), tint * 0.88 * (1 - shore * 0.45), tint * 0.22 * (1 + shore * 0.3)], i * 3);
    mix[i] = smooth(0.05, 0.4, noise.noise(x * 0.035, z * 0.035, 4.4)) * 0.6;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMix', new THREE.BufferAttribute(mix, 1));
  g.computeVertexNormals();
  const REP = WORLD / 3.5;
  const leaves = tex('forest_leaves_04_diff_2k.jpg', true, REP);
  const m = new THREE.MeshStandardMaterial({
    map: tex('grass_ground_diff_2k.jpg', true, REP), normalMap: tex('grass_ground_nor_gl_2k.jpg', false, REP),
    roughnessMap: tex('grass_ground_rough_2k.jpg', false, REP), vertexColors: true,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLeaves = { value: leaves };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aMix;\nvarying float vMix;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvMix = aMix;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D uLeaves;\nvarying float vMix;')
      .replace('#include <map_fragment>', `
        vec4 g1 = texture2D(map, vMapUv), g2 = texture2D(map, vMapUv * 0.37 + vec2(0.31, 0.71));
        vec4 lv = texture2D(uLeaves, vMapUv * 0.83 + vec2(0.5, 0.2));
        diffuseColor *= mix(mix(g1, g2, 0.4), lv, vMix * 0.7);`);
  };
  const ground = new THREE.Mesh(g, m);
  ground.receiveShadow = true;
  scene.add(ground);
}

// ---------- grass: dense blades near you, a sparser ring further out, both wrapped around the camera
const grass = [];
{
  const heightTex = new THREE.DataTexture(heights, RES, RES, THREE.RedFormat, THREE.FloatType);
  heightTex.needsUpdate = true;
  const M = 512, mask = new Uint8Array(M * M * 4);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const x = -HALF + (i + 0.5) / M * WORLD, z = -HALF + (j + 0.5) / M * WORLD, y = rawHeight(x, z);
    const wet = smooth(WATER_Y + 0.15, WATER_Y + 0.9, y);
    const meadow = smooth(-0.1, -0.3, noise.noise(x * 0.013, z * 0.013, 3.1));   // the clearings between trees
    const patch = smooth(-0.35, 0.1, noise.noise(x * 0.06, z * 0.06, 8.8));
    mask.set([255 * wet * (0.55 + 0.45 * patch), 255 * (0.35 + 0.5 * meadow + 0.15 * patch), 255 * smooth(0.1, 0.45, noise.noise(x * 0.025, z * 0.025, 6.1)), 255], (j * M + i) * 4);
  }
  const maskTex = new THREE.DataTexture(mask, M, M);
  maskTex.magFilter = maskTex.minFilter = THREE.LinearFilter; maskTex.needsUpdate = true;
  const base = { heightTex, maskTex, WORLD, RES, cam: camera.position };
  grass.push(makeGrass({ ...base, size: 52, count: 700000, fade: [17, 25], height: [0.25, 0.7], width: 0.022, segs: 5, seed: 7 }));
  grass.push(makeGrass({ ...base, size: 230, count: 550000, fade: [60, 108], inner: 16, height: [0.25, 0.6], width: 0.055, segs: 3, seed: 11 }));
  scene.add(...grass);
}

// ---------- water
const water = new Water(new THREE.CircleGeometry(46, 64), {
  textureWidth: 1024, textureHeight: 1024,
  waterNormals: tl.load(GH + 'textures/waternormals.jpg', (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; }),
  sunDirection: sunDir.clone(), sunColor: 0xfff0d8, waterColor: 0x0b2418, distortionScale: 1.6, fog: true,
});
water.rotation.x = -Math.PI / 2;
water.position.set(POND.x, WATER_Y, POND.y);
water.material.uniforms.size.value = 3;
scene.add(water);

{ // the lake reflection is the costliest pass: refresh it every other frame
  const reflect = water.onBeforeRender.bind(water);
  let flip = 0;
  water.onBeforeRender = (...a) => {
    if (flip++ % 2 && !window.F.hq) return;
    for (const g of grass) g.visible = false; // grass is invisible in the reflection anyway, skip drawing it twice
    reflect(...a);
    for (const g of grass) g.visible = true;
  };
}

// ---------- colliders for the player (trunks, big rocks)
const colliders = new Map();
const CG = 6, ckey = (x, z) => `${Math.floor(x / CG)},${Math.floor(z / CG)}`;
const addCollider = (x, z, r) => { const k = ckey(x, z); if (!colliders.has(k)) colliders.set(k, []); colliders.get(k).push({ x, z, r }); };
const pondDist = (x, z) => Math.hypot(x - POND.x, z - POND.y);

// ---------- real scanned models
const loader = new GLTFLoader();
const scatters = [];
function variants(gltf) { // each top-level node is one variant; recentre it on its own base
  return gltf.scene.children.slice().sort((a, b) => a.name.localeCompare(b.name)).map((n) => {
    n.position.set(0, 0, 0);
    n.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      m.transparent = false; m.depthWrite = true;
      const cutout = m.alphaTest > 0 || /fern|branches_medium/.test(m.name); // glTF MASK leaves keep their cutout
      m.alphaTest = cutout ? 0.5 : 0; m.alphaToCoverage = cutout;
      if (/twig|fern|needle/.test(m.name)) m.side = THREE.DoubleSide;
      if (/fern/.test(m.name)) m.color.setRGB(0.55, 0.6, 0.5);
    });
    return n;
  });
}
function place(count, ok, make) {
  const out = [];
  for (let t = 0; out.length < count && t < count * 20; t++) {
    const x = rr(-HALF + 4, HALF - 4), z = rr(-HALF + 4, HALF - 4);
    if (!ok(x, z)) continue;
    out.push(make(x, z, heightAt(x, z)));
  }
  return out;
}
async function buildForest() {
  const glb = (n) => loader.loadAsync(A + 'models/' + n + '.glb');
  const json = (n) => fetch(A + 'impostors/' + n + '.json').then((r) => r.json());
  const [firClose, sapClose, firNear, firMid, sapNear, sapMid, fern, rock1, rock2, stump1, stump2, log, roots] = await Promise.all(
    ['fir_close', 'sapling_close', 'fir_near', 'fir_mid', 'sapling_near', 'sapling_mid', 'fern_02', 'rock_moss_set_01', 'rock_moss_set_02', 'tree_stump_01', 'tree_stump_02', 'dead_tree_trunk', 'pine_roots'].map(glb));
  const impNames = ['fir_tree_01_a', 'fir_tree_01_b', 'fir_tree_01_c', 'fir_sapling_medium_a', 'fir_sapling_medium_b', 'fir_sapling_medium_c'];
  const metas = await Promise.all(impNames.map(json));

  // trees: 0-2 tall firs (19, 14, 14.5 m), 3-5 young firs (8.8, 7.8, 5.9 m)
  const close = [...variants(firClose), ...variants(sapClose)], near = [...variants(firNear), ...variants(sapNear)], mid = [...variants(firMid), ...variants(sapMid)];
  const trees = [];
  const grid = new Map(), gk = (x, z) => `${Math.floor(x / 5)},${Math.floor(z / 5)}`;
  for (let t = 0; trees.length < 6800 && t < 140000; t++) {
    const x = rr(-HALF + 4, HALF - 4), z = rr(-HALF + 4, HALF - 4);
    if (pondDist(x, z) < 38 || Math.hypot(x, z) < 7 || Math.hypot(x - 15, z - 28) < 12) continue;
    if (noise.noise(x * 0.013, z * 0.013, 3.1) < -0.22 && rand() < 0.93) continue; // clearings (grass meadows for the big animals)
    let close = false;
    for (let i = -1; i <= 1 && !close; i++) for (let j = -1; j <= 1 && !close; j++)
      close = (grid.get(`${Math.floor(x / 5) + i},${Math.floor(z / 5) + j}`) || []).some((o) => Math.hypot(o.x - x, o.z - z) < 3.5);
    if (close) continue;
    const young = rand() < 0.38, v = (young ? 3 : 0) + Math.floor(rand() * 3), s = young ? rr(0.75, 1.2) : rr(0.85, 1.25);
    const it = { x, y: heightAt(x, z) - 0.15, z, ry: rand() * Math.PI * 2, s, v };
    trees.push(it);
    if (!grid.has(gk(x, z))) grid.set(gk(x, z), []);
    grid.get(gk(x, z)).push(it);
    addCollider(x, z, (young ? 0.2 : 0.4) * s + 0.3);
  }
  scatters.push(new LodScatter(scene, near.map((n, i) => [{ mesh: close[i], far: 12 }, { mesh: n, far: 34 }, { mesh: mid[i], far: 75, shadow: false }]), trees, { radius: 10 }));
  const light = new THREE.Vector3(1.05, 1.05, 1.0);
  impNames.forEach((name, i) => {
    const atlas = tl.load(A + 'impostors/' + name + '.png');
    scene.add(makeImpostors(atlas, metas[i], trees.filter((t) => t.v === i), camera.position, 75, light));
  });

  // ground cover
  const fernV = variants(fern);
  scatters.push(new LodScatter(scene, fernV.map((n) => [{ mesh: n, far: 45 }]),
    place(9000, (x, z) => heightAt(x, z) > WATER_Y + 0.5 && noise.noise(x * 0.04, z * 0.04, 5.5) > -0.05,
      (x, z, y) => ({ x, y, z, ry: rand() * 6.28, s: rr(0.8, 1.6), v: Math.floor(rand() * fernV.length) })),
    { radius: 1, castShadow: false, shadowNear: 0 }));
  // bushes, nettles, weeds and dandelions (Poly Haven scans) all over the floor
  const plant = (n) => loader.loadAsync(A + 'models/' + n + '/' + n + '.gltf');
  const [sh2, sh3, sh4, nettle, weed, dand] = await Promise.all(['shrub_02', 'shrub_03', 'shrub_04', 'nettle_plant', 'weed_plant_02', 'dandelion_01'].map(plant));
  const ground = (count, list, far, sMin, sMax, ok = () => true) => scatters.push(new LodScatter(scene, list.map((n) => [{ mesh: n, far }]),
    place(count, (x, z) => heightAt(x, z) > WATER_Y + 0.4 && pondDist(x, z) > 20 && ok(x, z),
      (x, z, y) => ({ x, y: y - 0.03, z, ry: rand() * 6.28, s: rr(sMin, sMax), v: Math.floor(rand() * list.length) })),
    { radius: 1.5, castShadow: false, shadowNear: 0 }));
  const meadow = (x, z) => noise.noise(x * 0.013, z * 0.013, 3.1) < -0.15;
  ground(4000, [...variants(sh2), ...variants(sh3), ...variants(sh4)], 48, 0.9, 1.8);
  ground(9000, [...variants(nettle), ...variants(weed)], 38, 0.8, 1.6);
  ground(9000, variants(dand), 30, 0.9, 1.4, meadow);
  const rocks = [...variants(rock1), ...variants(rock2)];
  const rockItems = place(170, (x, z) => Math.hypot(x, z) > 6, (x, z, y) => {
      const s = rr(0.35, 1.4); if (s > 0.8) addCollider(x, z, s * 1.1);
      return { x, y: y - 0.25 * s, z, ry: rand() * 6.28, s, v: Math.floor(rand() * rocks.length) };
    });
  scatters.push(new LodScatter(scene, rocks.map((n) => [{ mesh: n, far: 230 }]), rockItems, { radius: 2 }));
  window.F.rocks = rockItems;
  const props = [...variants(stump1), ...variants(stump2), ...variants(log)];
  scatters.push(new LodScatter(scene, props.map((n) => [{ mesh: n, far: 160 }]),
    place(150, (x, z) => pondDist(x, z) > 34 && Math.hypot(x, z) > 5, (x, z, y) => ({ x, y: y - 0.05, z, ry: rand() * 6.28, s: rr(0.9, 1.6), v: Math.floor(rand() * props.length) })),
    { radius: 2 }));
  // roots at the foot of some tall firs
  const rootV = variants(roots);
  scatters.push(new LodScatter(scene, rootV.map((n) => [{ mesh: n, far: 60 }]),
    trees.filter((t) => t.v < 3 && rand() < 0.35).map((t) => ({ x: t.x, y: t.y + 0.1, z: t.z, ry: rand() * 6.28, s: t.s * 0.9, v: Math.floor(rand() * rootV.length) })),
    { radius: 1.5, castShadow: false }));
  window.F.trees = trees;
}

// ---------- animals
const foxes = [], birds = [], animals = [];
const isMeadow = (x, z) => noise.noise(x * 0.013, z * 0.013, 3.1) < -0.22;
class Fox {
  constructor(src, clips, scale, yOff, x, z) {
    this.obj = SkeletonUtils.clone(src);
    this.obj.scale.setScalar(scale); this.yOff = yOff;
    this.obj.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.mixer = new THREE.AnimationMixer(this.obj);
    const pick = (n) => this.mixer.clipAction(clips.find((c) => c.name.toLowerCase().includes(n)) || clips[0]);
    this.actions = { survey: pick('survey'), walk: pick('walk'), run: pick('run') };
    this.home = new THREE.Vector2(x, z); this.pos = new THREE.Vector2(x, z); this.target = new THREE.Vector2();
    this.heading = rand() * Math.PI * 2; this.state = 'idle'; this.timer = rr(0.5, 3);
    this.play('survey'); scene.add(this.obj);
  }
  play(n) {
    if (this.cur === n) return;
    this.actions[n].reset().fadeIn(0.35).play();
    if (this.cur) this.actions[this.cur].fadeOut(0.35);
    this.cur = n;
  }
  pickTarget(cx, cz, r) {
    for (let i = 0; i < 10; i++) {
      const a = rand() * 6.28, d = rr(r * 0.3, r);
      this.target.set(cx + Math.cos(a) * d, cz + Math.sin(a) * d);
      if (heightAt(this.target.x, this.target.y) > WATER_Y + 0.6) return true;
    }
    return false;
  }
  update(dt, px, pz) {
    this.timer -= dt;
    const dp = Math.hypot(this.pos.x - px, this.pos.y - pz);
    if (dp < 9 && this.state !== 'flee') {
      this.state = 'flee'; this.timer = rr(3, 5);
      const ax = (this.pos.x - px) / dp, az = (this.pos.y - pz) / dp;
      this.target.set(this.pos.x + ax * 30, this.pos.y + az * 30);
    }
    if (this.state === 'idle') {
      this.play('survey');
      if (this.timer < 0 && this.pickTarget(this.home.x, this.home.y, 24)) { this.state = 'walk'; this.timer = 20; }
    } else {
      const flee = this.state === 'flee';
      const dx = this.target.x - this.pos.x, dz = this.target.y - this.pos.y, dist = Math.hypot(dx, dz);
      if (dist < 0.6 || this.timer < 0) { this.state = 'idle'; this.timer = rr(2, 7); if (flee) this.home.copy(this.pos); }
      else {
        const want = Math.atan2(dx, dz);
        const diff = ((want - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        this.heading += diff * Math.min(1, dt * (flee ? 6 : 2.5));
        const sp = flee ? 6 : 1.1;
        const nx = this.pos.x + Math.sin(this.heading) * sp * dt, nz = this.pos.y + Math.cos(this.heading) * sp * dt;
        if (heightAt(nx, nz) < WATER_Y + 0.4) { this.state = 'idle'; this.timer = rr(1, 3); }
        else this.pos.set(nx, nz);
        this.play(flee ? 'run' : 'walk');
      }
    }
    this.obj.position.set(this.pos.x, heightAt(this.pos.x, this.pos.y) + this.yOff, this.pos.y);
    this.obj.rotation.y = this.heading;
    this.mixer.update(dt);
  }
}
class Bird {
  constructor(src, clip, scale, cx, cz, radius, alt, speed, tint) {
    this.obj = src.clone(true);
    this.obj.scale.setScalar(scale);
    if (tint) this.obj.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color.set(tint); } });
    this.mixer = new THREE.AnimationMixer(this.obj);
    this.mixer.clipAction(clip).setDuration(rr(0.9, 1.3)).startAt(-rand()).play();
    Object.assign(this, { cx, cz, radius, alt, speed, a: rand() * 6.28, dirn: rand() < 0.5 ? 1 : -1 });
    this.next = new THREE.Vector3();
    scene.add(this.obj);
  }
  at(a, out) {
    const x = this.cx + Math.cos(a) * this.radius, z = this.cz + Math.sin(a) * this.radius * 0.7;
    return out.set(x, Math.max(heightAt(x, z), WATER_Y) + this.alt + Math.sin(a * 3) * 2.5, z);
  }
  update(dt) {
    this.a += this.dirn * this.speed * dt / this.radius;
    this.at(this.a, this.obj.position);
    this.obj.lookAt(this.at(this.a + this.dirn * 0.05, this.next));
    this.mixer.update(dt);
  }
}
const loadAnimals = async () => {
  const [fox, stork] = await Promise.all([loader.loadAsync(FOX_URL), loader.loadAsync(GH + 'models/gltf/Stork.glb')]);
  const box = new THREE.Box3().setFromObject(fox.scene), size = box.getSize(new THREE.Vector3());
  const fs = 1.05 / Math.max(size.x, size.z);
  [[12, -22], [26, -34], [-8, -40], [55, -18], [-30, -15], [70, -95]].forEach(([x, z]) =>
    foxes.push(new Fox(fox.scene, fox.animations, fs, -box.min.y * fs, x, z)));
  const sb = new THREE.Box3().setFromObject(stork.scene).getSize(new THREE.Vector3());
  const ss = 1.9 / Math.max(sb.x, sb.z);
  for (let i = 0; i < 4; i++) birds.push(new Bird(stork.scene, stork.animations[0], ss, POND.x + rr(-20, 20), POND.y + rr(-20, 20), rr(45, 80), rr(34, 50), rr(7, 10)));
  for (let i = 0; i < 5; i++) birds.push(new Bird(stork.scene, stork.animations[0], ss * 0.45, rr(-60, 60), rr(-80, 20), rr(20, 45), rr(26, 34), rr(9, 12), 0x161616));
  animals.push(...await makeAnimals({ scene, loader, heightAt, WATER_Y, POND, rand, audio, isMeadow }));
};

// ---------- player
const controls = new PointerLockControls(camera, document.body);
const player = { x: 0, z: 0, y: heightAt(0, 0), vy: 0, vx: 0, vz: 0, phase: 0, ground: true };
camera.position.set(0, player.y + 1.7, 0);
camera.lookAt(POND.x * 0.5, player.y + 1.2, POND.y);
const keys = {};
addEventListener('keydown', (ev) => {
  keys[ev.code] = true;
  if (ev.code === 'Space' && player.ground && controls.isLocked) { player.vy = 5; player.ground = false; }
});
addEventListener('keyup', (ev) => { keys[ev.code] = false; });
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const audio = new ForestAudio({ pond: { x: POND.x, y: WATER_Y + 0.5, z: POND.y } });

function updatePlayer(dt) {
  const active = controls.isLocked;
  const run = keys.ShiftLeft || keys.ShiftRight;
  const f = active ? (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) : 0;
  const s = active ? (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) : 0;
  camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize(); right.crossVectors(fwd, UP);
  let wx = fwd.x * f + right.x * s, wz = fwd.z * f + right.z * s;
  const wl = Math.hypot(wx, wz) || 1, speed = run ? 6.5 : 2.8;
  wx = (wx / wl) * speed * (f || s ? 1 : 0); wz = (wz / wl) * speed * (f || s ? 1 : 0);
  const k = 1 - Math.exp(-dt * (player.ground ? 10 : 2));
  player.vx += (wx - player.vx) * k; player.vz += (wz - player.vz) * k;
  let nx = player.x + player.vx * dt, nz = player.z + player.vz * dt;
  for (let ix = -1; ix <= 1; ix++) for (let iz = -1; iz <= 1; iz++) {
    const list = colliders.get(`${Math.floor(nx / CG) + ix},${Math.floor(nz / CG) + iz}`);
    if (list) for (const t of list) {
      const dx = nx - t.x, dz = nz - t.z, d = Math.hypot(dx, dz);
      if (d < t.r && d > 1e-4) { nx = t.x + (dx / d) * t.r; nz = t.z + (dz / d) * t.r; }
    }
  }
  if (heightAt(nx, nz) < WATER_Y - 0.35) { nx = player.x; nz = player.z; player.vx *= 0.3; player.vz *= 0.3; } // no swimming
  player.x = THREE.MathUtils.clamp(nx, -HALF + 8, HALF - 8); player.z = THREE.MathUtils.clamp(nz, -HALF + 8, HALF - 8);
  const gy = heightAt(player.x, player.z);
  player.vy -= 14 * dt; player.y += player.vy * dt;
  if (player.y <= gy) { if (!player.ground && player.vy < -3) audio.step(true); player.y = gy; player.vy = 0; player.ground = true; }
  const moving = Math.hypot(player.vx, player.vz);
  let bob = 0;
  if (player.ground && moving > 0.4) {
    const prev = player.phase;
    player.phase += dt * moving * 2.1;
    bob = Math.abs(Math.sin(player.phase)) * 0.05 * Math.min(1, moving / 3);
    if (Math.floor(prev / Math.PI) !== Math.floor(player.phase / Math.PI)) audio.step(run);
  }
  camera.position.set(player.x, player.y + 1.7 + bob, player.z);
}

// ---------- UI
const overlay = document.getElementById('overlay'), status = document.getElementById('status'), go = document.getElementById('go');
let ready = false;
overlay.addEventListener('click', () => { if (!ready) return; audio.start(); controls.lock(); });
controls.addEventListener('lock', () => overlay.classList.add('hidden'));
controls.addEventListener('unlock', () => { overlay.classList.remove('hidden'); status.textContent = 'إيقاف مؤقت'; go.textContent = 'اضغط للرجوع للغابة'; });
THREE.DefaultLoadingManager.onProgress = (_, done, total) => { if (!ready) status.textContent = `جاري التحميل… ${Math.round((done / total) * 100)}%`; };
Promise.all([buildForest(), loadAnimals()]).then(() => {
  ready = true; status.textContent = 'الغابة جاهزة'; go.textContent = 'اضغط في أي حتة للدخول — السماعات أحسن'; go.classList.add('ready');
}, (err) => { console.error(err); status.textContent = 'النت فصل أثناء التحميل'; go.textContent = 'اعمل Refresh للصفحة (F5) وجرّب تاني'; });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------- loop
const clock = new THREE.Clock();
const MAX_PR = Math.min(devicePixelRatio, 1.5);
let frame = 0, fpsT = 0, fpsN = 0, pr = renderer.getPixelRatio();
// one step of the world. hq: offline video frames, so refresh shadows/LODs/reflection every frame
function tick(dt, hq = false) {
  if (window.F.cinema) window.F.cinema(dt); else updatePlayer(dt); // video.js drives the camera when filming
  const cp = camera.position;
  if (hq || frame % 4 === 0) for (const s of scatters) s.update(camera);
  if (hq || frame % 3 === 0) { renderer.shadowMap.needsUpdate = true; sun.position.copy(cp).addScaledVector(sunDir, 160); sun.target.position.copy(cp); }
  frame++;
  water.visible = Math.hypot(POND.x - cp.x, POND.y - cp.z) < 260;
  water.material.uniforms.time.value += dt * 0.35;
  for (const g of grass) g.update(dt);
  for (const f of foxes) f.update(dt, player.x, player.z);
  for (const b of birds) b.update(dt);
  for (const a of animals) a.update(dt, player.x, player.z);
  audio.update(dt, camera);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(() => {
  const raw = clock.getDelta(), dt = Math.min(raw, 0.05);
  fpsT += raw; fpsN++;
  if (fpsT > 2 && !window.F.cinema) { // dynamic resolution: keep it smooth on weaker GPUs, sharpen on strong ones
    const fps = fpsN / fpsT; fpsT = fpsN = 0;
    const next = fps < 38 ? Math.max(0.6, pr - 0.1) : fps > 50 ? Math.min(MAX_PR, pr + 0.1) : pr;
    if (next !== pr) { pr = next; renderer.setPixelRatio(pr); }
  }
  tick(dt);
});

window.F = { tick, camera, player, renderer, scene, foxes, birds, animals, heightAt, POND, WATER_Y, audio, scatters };
