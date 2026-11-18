import * as THREE from 'three';

// Far trees: a camera-facing card showing a Blender render of the real tree from the nearest of
// N angles (blended with the next one), so a distant tree is a photo of the real model.
// meta = { views, width, height, bottom } from bake; items = [{ x, y, z, ry, s }]
export function makeImpostors(atlas, meta, items, cam, nearDist, light) {
  const g = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  g.index = quad.index; g.setAttribute('position', quad.attributes.position); g.setAttribute('uv', quad.attributes.uv);
  const a = new Float32Array(items.length * 4), s = new Float32Array(items.length);
  items.forEach((it, i) => { a.set([it.x, it.y, it.z, it.ry], i * 4); s[i] = it.s; });
  g.setAttribute('aItem', new THREE.InstancedBufferAttribute(a, 4));
  g.setAttribute('aS', new THREE.InstancedBufferAttribute(s, 1));
  g.instanceCount = items.length;
  atlas.colorSpace = THREE.SRGBColorSpace; atlas.anisotropy = 8;
  const m = new THREE.ShaderMaterial({
    fog: true, alphaToCoverage: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uAtlas: { value: null }, uCam: { value: cam }, uNear: { value: nearDist }, uViews: { value: meta.views },
      uSize: { value: new THREE.Vector3(meta.width, meta.height, meta.bottom) }, uLight: { value: light },
    }]),
    vertexShader: /* glsl */`
      attribute vec4 aItem; attribute float aS;
      uniform vec3 uCam, uSize; uniform float uNear, uViews;
      varying vec2 vUv0; varying vec2 vUv1; varying float vMix; varying float vH;
      #include <fog_pars_vertex>
      void main() {
        vec3 base = aItem.xyz;
        vec2 to = uCam.xz - base.xz; float d = length(to); vec2 dir = to / max(d, 1e-3);
        float c = cos(aItem.w), sn = sin(aItem.w);
        vec2 l = vec2(dir.x * c - dir.y * sn, dir.x * sn + dir.y * c);   // into the tree's own frame
        float th = atan(-l.y, l.x); if (th < 0.0) th += 6.2831853;
        float fv = th / (6.2831853 / uViews), f0 = floor(fv);
        vMix = fv - f0;
        float f1 = mod(f0 + 1.0, uViews);
        vUv0 = vec2((f0 + uv.x) / uViews, uv.y); vUv1 = vec2((f1 + uv.x) / uViews, uv.y);
        vH = uv.y;
        vec3 right = vec3(dir.y, 0.0, -dir.x);
        vec3 p = base + right * (position.x * uSize.x * aS) + vec3(0.0, (uSize.z + position.y * uSize.y) * aS, 0.0);
        if (d < uNear) p = vec3(0.0, -1e4, 0.0);      // close trees are real geometry
        vec4 mvPosition = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uAtlas; uniform vec3 uLight;
      varying vec2 vUv0; varying vec2 vUv1; varying float vMix; varying float vH;
      #include <fog_pars_fragment>
      void main() {
        vec4 c = mix(texture2D(uAtlas, vUv0), texture2D(uAtlas, vUv1), vMix);
        if (c.a < 0.45) discard;
        gl_FragColor = vec4(c.rgb * uLight * (0.75 + 0.35 * vH), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  m.uniforms.uAtlas.value = atlas;
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  return mesh;
}
