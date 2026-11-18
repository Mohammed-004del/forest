import * as THREE from 'three';

// GPU grass. One instanced blade mesh per ring; blades live on a tile that wraps around the camera,
// so the field is endless with zero CPU work. Terrain height and grass density are read from textures.
export function makeGrass({ heightTex, maskTex, WORLD, RES, cam, size, count, fade, inner = 0, height, width, segs, seed = 1 }) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;

  // one blade: tapered strip, y = 0..1 along its length
  const pos = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, w = (1 - t * t * 0.9) * 0.5;
    if (i < segs) pos.push(-w, t, 0, w, t, 0); else pos.push(0, 1, 0);
  }
  for (let i = 0; i < segs - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const a = (segs - 1) * 2; idx.push(a, a + 1, a + 2);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const blade = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) blade.set([rnd(), rnd(), rnd() * Math.PI * 2, rnd()], i * 4);
  g.setAttribute('aBlade', new THREE.InstancedBufferAttribute(blade, 4));
  g.instanceCount = count;

  const uniforms = {
    uCam: { value: cam }, uSize: { value: size }, uTime: { value: 0 }, uFade: { value: new THREE.Vector2(...fade) }, uInner: { value: inner },
    uHeight: { value: heightTex }, uMask: { value: maskTex }, uWorld: { value: WORLD }, uRes: { value: RES },
    uDims: { value: new THREE.Vector2(...height) }, uWidth: { value: width },
  };
  const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.75, metalness: 0, envMapIntensity: 0.6 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
      attribute vec4 aBlade;
      uniform vec3 uCam; uniform float uSize, uTime, uInner, uWorld, uRes, uWidth; uniform vec2 uFade, uDims;
      uniform sampler2D uHeight, uMask;
      varying float vT, vShade; varying vec3 vTint;
      float terrain(vec2 p) { // bilinear, same as the CPU heightAt
        vec2 g = clamp((p + uWorld * 0.5) / uWorld * (uRes - 1.0), vec2(0.0), vec2(uRes - 1.001));
        ivec2 i = ivec2(floor(g)); vec2 f = fract(g);
        float a = texelFetch(uHeight, i, 0).r, b = texelFetch(uHeight, i + ivec2(1, 0), 0).r;
        float c = texelFetch(uHeight, i + ivec2(0, 1), 0).r, d = texelFetch(uHeight, i + ivec2(1, 1), 0).r;
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      vec3 gPos; vec3 gNrm;`)
      .replace('#include <beginnormal_vertex>', `
      vec2 p = uCam.xz + mod(aBlade.xy * uSize - uCam.xz + uSize * 0.5, uSize) - uSize * 0.5;
      float dist = length(p - uCam.xz);
      vec4 mk = texture2D(uMask, (p + uWorld * 0.5) / uWorld);         // r: density, g: height, b: dryness
      float keep = step(aBlade.w, mk.r);
      float k = keep * (1.0 - smoothstep(uFade.x, uFade.y, dist)) * smoothstep(uInner, uInner + 5.0, dist);
      float r2 = fract(aBlade.w * 7.31 + aBlade.z);
      float H = mix(uDims.x, uDims.y, r2) * (0.45 + mk.g) * k;
      float t = position.y;
      // wind: slow rolling gusts + fast flutter, travelling across the field
      float gust = sin(uTime * 0.9 + p.x * 0.11 + p.y * 0.07) * 0.5 + 0.5;
      float wind = (gust * 0.55 + 0.12) * (0.75 + 0.25 * sin(uTime * 4.3 + aBlade.z * 9.0));
      float lean = 0.18 + 0.4 * fract(aBlade.w * 13.7);
      float c = cos(aBlade.z), s = sin(aBlade.z);
      vec2 side = vec2(c, -s), face = vec2(s, c);
      float bend = t * t;
      vec2 off = face * lean * bend * H + vec2(0.82, 0.57) * wind * bend * H * 0.55;
      float drop = (lean + wind * 0.5) * bend * H * 0.35;               // bending shortens the blade
      gPos = vec3(p.x + side.x * position.x * uWidth * k + off.x, terrain(p) + t * H - drop, p.y + side.y * position.x * uWidth * k + off.y);
      gNrm = normalize(vec3(face.x, 0.0, face.y) * 0.35 + vec3(0.0, 1.0, 0.0));
      vT = t; vShade = 0.75 + 0.25 * mk.g;
      vTint = mix(vec3(0.9, 1.0, 0.75), vec3(1.12, 1.02, 0.6), mk.b) * (0.75 + 0.35 * r2);
      vec3 objectNormal = gNrm;`)
      .replace('#include <begin_vertex>', 'vec3 transformed = gPos;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vT, vShade; varying vec3 vTint;')
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/gl_FrontFacing \? 1\.0 : - ?1\.0/, '1.0')) // back of a blade lit like its front
      .replace('#include <color_fragment>', `
      vec3 base = vec3(0.06, 0.09, 0.025), tip = vec3(0.15, 0.235, 0.055);
      diffuseColor.rgb = mix(base, tip * vTint, smoothstep(0.0, 0.8, vT)) * mix(0.7, 1.0, vShade);`);
  };
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false; mesh.receiveShadow = true;
  mesh.update = (dt) => { uniforms.uTime.value += dt; };
  return mesh;
}
