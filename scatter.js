import * as THREE from 'three';

// Many copies of a few models, each copy drawn at the detail its distance deserves.
// variants[v] = [{ mesh: Object3D (meshes inside), far: metres }, ...] ordered near -> far.
// Every few frames the visible copies are re-sorted into one InstancedMesh per (variant, lod, part).
export class LodScatter {
  constructor(scene, variants, items, { radius = 6, shadowNear = 45, castShadow = true } = {}) {
    this.items = items; // [{ x, y, z, ry, s, v }]
    this.radius = radius; this.shadowNear = shadowNear;
    this.matrices = items.map((it) => new THREE.Matrix4().compose(
      new THREE.Vector3(it.x, it.y, it.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, it.ry, 0)), new THREE.Vector3(it.s, it.s, it.s)));
    this.byVariant = variants.map((lods, v) => {
      const n = items.filter((it) => it.v === v).length;
      return lods.map(({ mesh, far, shadow = castShadow }) => {
        const parts = [];
        mesh.updateMatrixWorld(true);
        mesh.traverse((o) => {
          if (!o.isMesh) return;
          const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
          const im = new THREE.InstancedMesh(g, o.material, Math.max(1, n));
          im.count = 0; im.frustumCulled = false; im.castShadow = shadow; im.receiveShadow = true;
          scene.add(im); parts.push(im);
        });
        return { far, parts };
      });
    });
    this.frustum = new THREE.Frustum(); this.pm = new THREE.Matrix4(); this.sphere = new THREE.Sphere();
  }
  update(camera) {
    this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pm);
    for (const lods of this.byVariant) for (const l of lods) l.n = 0;
    const cp = camera.position;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i], lods = this.byVariant[it.v];
      const d = Math.hypot(it.x - cp.x, it.z - cp.z);
      if (d > lods[lods.length - 1].far) continue;
      if (d > this.shadowNear) { // close ones always drawn so their shadows stay
        this.sphere.center.set(it.x, it.y + it.s * this.radius * 0.5, it.z); this.sphere.radius = it.s * this.radius;
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
      }
      const l = lods.find((x) => d <= x.far);
      for (const p of l.parts) p.setMatrixAt(l.n, this.matrices[i]);
      l.n++;
    }
    for (const lods of this.byVariant) for (const l of lods) for (const p of l.parts) { p.count = l.n; p.instanceMatrix.needsUpdate = true; }
  }
}
