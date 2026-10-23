import * as THREE from 'three';

const CAPACITY = 6000;
/** Fall speed of a raindrop (m/s). */
const FALL_SPEED = 9;

/**
 * Rain as streaks in a box that follows the camera's focus: the number of drops follows the
 * rain intensity, they fall at terminal speed and the wind carries them. A drop that lands or
 * leaves the box comes back at the top on the other side, so the pool is never reallocated.
 */
export class Rain {
  readonly mesh: THREE.LineSegments;
  private readonly drops = new Float32Array(CAPACITY * 3);
  private readonly positions = new Float32Array(CAPACITY * 6);
  private readonly material = new THREE.LineBasicMaterial({ color: 0xc6d2de, transparent: true, opacity: 0.45, depthWrite: false });
  private seeded = false;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    this.mesh = new THREE.LineSegments(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /**
   * `half` is half the width of the box (metres, from the camera's view size); `dt` is 0 while
   * the simulation stands still, so the drops hang in the air.
   */
  update(rain: number, centre: THREE.Vector3, half: number, windX: number, windY: number, dt: number): void {
    const count = Math.round(CAPACITY * Math.max(0, Math.min(1, rain)));
    this.mesh.visible = count > 0;
    if (!count) return;
    const height = Math.min(60, half);
    const d = this.drops;
    if (!this.seeded) {
      for (let i = 0; i < CAPACITY; i++) this.spawn(i, centre, half, height * Math.random());
      this.seeded = true;
    }
    // Streak along the drop's velocity, long enough to read from far away.
    const length = THREE.MathUtils.clamp(half * 0.012, 0.5, 12);
    const speed = Math.hypot(windX, FALL_SPEED, windY);
    const ux = windX / speed, uy = -FALL_SPEED / speed, uz = windY / speed;
    const p = this.positions;
    for (let i = 0; i < count; i++) {
      const k = i * 3;
      d[k] += windX * dt; d[k + 1] -= FALL_SPEED * dt; d[k + 2] += windY * dt;
      // Wrap into the box around the focus; landed drops start again from the top.
      d[k] = centre.x + wrap(d[k] - centre.x, half);
      d[k + 2] = centre.z + wrap(d[k + 2] - centre.z, half);
      if (d[k + 1] < 0) this.spawn(i, centre, half, height);
      const j = i * 6;
      p[j] = d[k]; p[j + 1] = d[k + 1]; p[j + 2] = d[k + 2];
      p[j + 3] = d[k] - ux * length; p[j + 4] = d[k + 1] - uy * length; p[j + 5] = d[k + 2] - uz * length;
    }
    this.material.opacity = 0.25 + 0.3 * rain;
    const g = this.mesh.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.setDrawRange(0, count * 2);
  }

  private spawn(i: number, centre: THREE.Vector3, half: number, y: number): void {
    const k = i * 3;
    this.drops[k] = centre.x + (Math.random() * 2 - 1) * half;
    this.drops[k + 1] = y;
    this.drops[k + 2] = centre.z + (Math.random() * 2 - 1) * half;
  }
}

function wrap(v: number, half: number): number {
  const size = half * 2;
  return ((v + half) % size + size) % size - half;
}
