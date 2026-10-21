import * as THREE from 'three';
import { Textures } from './Textures';

const vertexShader = /* glsl */`
  attribute float aSize;
  attribute vec4 aColor;
  uniform float uScale;
  uniform float uPerspective;
  varying vec4 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // aSize is in metres; uScale turns it into device pixels for the active camera.
    float size = uPerspective > 0.5 ? aSize * uScale / -mv.z : aSize * uScale;
    gl_PointSize = max(size, 1.5);
    vColor = aColor;
  }
`;

const fragmentShader = /* glsl */`
  uniform sampler2D uMap;
  varying vec4 vColor;
  void main() {
    float a = vColor.a * texture2D(uMap, gl_PointCoord).a;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor.rgb, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface EmitOptions {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  size0: number; size1: number;
  color: THREE.Color; alpha: number;
  /** Upward acceleration (m/s²): negative for sparks that fall, positive for rising smoke. */
  lift: number;
  drag: number;
}

/**
 * A fixed-size pool of point sprites simulated on the CPU. Dead particles are swapped out, so
 * the live ones always occupy the front of the buffers and one draw call renders them.
 */
export class ParticleSystem {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private count = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly sizeRange: Float32Array;
  private readonly color: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly lift: Float32Array;
  private readonly drag: Float32Array;
  private readonly material: THREE.ShaderMaterial;

  constructor(capacity: number, blending: THREE.Blending) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.sizeRange = new Float32Array(capacity * 2);
    this.color = new Float32Array(capacity * 4);
    this.alpha0 = new Float32Array(capacity);
    this.lift = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: Textures.softDot() }, uScale: { value: 1 }, uPerspective: { value: 0 } },
      vertexShader, fragmentShader,
      transparent: true, depthWrite: false, blending,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  emit(o: EmitOptions): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.pos[i * 3] = o.x; this.pos[i * 3 + 1] = o.y; this.pos[i * 3 + 2] = o.z;
    this.vel[i * 3] = o.vx; this.vel[i * 3 + 1] = o.vy; this.vel[i * 3 + 2] = o.vz;
    this.age[i] = 0; this.life[i] = o.life;
    this.sizeRange[i * 2] = o.size0; this.sizeRange[i * 2 + 1] = o.size1;
    this.color[i * 4] = o.color.r; this.color[i * 4 + 1] = o.color.g; this.color[i * 4 + 2] = o.color.b;
    this.alpha0[i] = o.alpha;
    this.lift[i] = o.lift; this.drag[i] = o.drag;
  }

  /** Scale for the active camera: pixels per metre (orthographic) or the focal length in pixels. */
  setProjection(scale: number, perspective: boolean): void {
    this.material.uniforms.uScale.value = scale;
    this.material.uniforms.uPerspective.value = perspective ? 1 : 0;
  }

  clear(): void { this.count = 0; this.points.geometry.setDrawRange(0, 0); }

  update(dt: number): void {
    for (let i = 0; i < this.count;) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.move(--this.count, i); continue; }
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k; this.vel[i * 3 + 2] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k + this.lift[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.02, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = this.age[i] / this.life[i];
      this.size[i] = this.sizeRange[i * 2] + (this.sizeRange[i * 2 + 1] - this.sizeRange[i * 2]) * t;
      this.color[i * 4 + 3] = this.alpha0[i] * (1 - t) * (1 - t);
      i++;
    }
    const g = this.points.geometry;
    for (const name of ['position', 'aSize', 'aColor']) g.getAttribute(name).needsUpdate = true;
    g.setDrawRange(0, this.count);
  }

  /** Copies particle `from` into slot `to` (used to fill the hole a dead particle leaves). */
  private move(from: number, to: number): void {
    if (from === to) return;
    for (let k = 0; k < 3; k++) { this.pos[to * 3 + k] = this.pos[from * 3 + k]; this.vel[to * 3 + k] = this.vel[from * 3 + k]; }
    for (let k = 0; k < 4; k++) this.color[to * 4 + k] = this.color[from * 4 + k];
    this.sizeRange[to * 2] = this.sizeRange[from * 2]; this.sizeRange[to * 2 + 1] = this.sizeRange[from * 2 + 1];
    this.age[to] = this.age[from]; this.life[to] = this.life[from]; this.size[to] = this.size[from];
    this.alpha0[to] = this.alpha0[from]; this.lift[to] = this.lift[from]; this.drag[to] = this.drag[from];
  }
}
