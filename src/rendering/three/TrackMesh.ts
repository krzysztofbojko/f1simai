import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Track } from '../../track/Track';
import { Textures } from './Textures';
import { Point2, stripGeometry, offsetPolyline } from './Geometry';
import { PIT_LANE_WIDTH } from '../../track/PitLane';
import { Population } from '../../ai/Population';

/** Surface heights (m): each layer sits a few millimetres above the one it overlaps. */
const H = { ground: -0.25, gravel: 0, grass: 0.004, asphalt: 0.01, paint: 0.018, kerb: 0.022 };
const SECTOR_COLORS = ['#00D2BE', '#FFD700', '#A855F7', '#E10600'];
/**
 * Billboards: image aspect (width / height, from public/textures), size in metres, and the flat
 * layer behind each for the top camera (`depth` metres deep at `topHeight`).
 */
const TREES = { aspect: 2048 / 459, height: 16, gap: 25, depth: 12, topHeight: 12, topAspect: 2048 / 415 };
const CITY = { aspect: 2048 / 372, height: 45, gap: 15, depth: 40, topHeight: H.ground + 0.05, topAspect: 4 };
const GRANDSTAND = { aspect: 2048 / 386, length: 120, gap: 8, depth: 18 };
/** Every third 36 m stretch of barrier carries the sponsor banners. */
const AD_STRETCH = 36;

export interface StaticLabel { text: string; x: number; y: number; color: string; className: string }

/** Pulls decals towards the camera in the depth test, so coplanar layers never flicker. */
function decal<M extends THREE.Material>(m: M, layer: number): M {
  // Strips are wound by edge order, which flips between the two sides of the track.
  m.side = THREE.DoubleSide;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -layer;
  m.polygonOffsetUnits = -layer * 4;
  return m;
}

/**
 * The circuit as static meshes, generated from the same points the physics uses: asphalt,
 * grass and gravel strips up to the barriers, kerbs on corners, painted lines, the chequered
 * start line, timing beams, the pit lane, and tree line and grandstand billboards beyond the
 * barriers. Rebuilt whenever the track changes.
 */
export class TrackMesh {
  readonly group = new THREE.Group();
  readonly checkpoints = new THREE.Group();
  staticLabels: StaticLabel[] = [];
  bounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 };

  private readonly asphalt: THREE.MeshStandardMaterial;
  private readonly grass: THREE.MeshStandardMaterial;
  private readonly ground: THREE.MeshStandardMaterial;
  private readonly gravel: THREE.MeshStandardMaterial;
  private readonly kerb: THREE.MeshStandardMaterial;
  private readonly paint: THREE.MeshStandardMaterial;
  private readonly barrier: THREE.MeshStandardMaterial;
  private readonly barrierAds: THREE.MeshStandardMaterial;
  private readonly trees: THREE.MeshStandardMaterial;
  private readonly grandstand: THREE.MeshStandardMaterial;
  private readonly canopy: THREE.MeshStandardMaterial;
  private readonly city: THREE.MeshStandardMaterial;
  private readonly cityDay = Textures.billboard('city_day.webp');
  private readonly cityNight = Textures.billboard('city_night.webp');
  private readonly rooftops: THREE.MeshStandardMaterial;
  private readonly standRoof: THREE.MeshStandardMaterial;
  /** Street circuit: a skyline in place of the tree line. */
  private street = false;
  private readonly checker: THREE.MeshStandardMaterial;
  private readonly pitLine: THREE.MeshBasicMaterial;
  private readonly dashTexture = Textures.dashes();
  private wetness = -1;
  private builtFor: Track | null = null;
  private builtKey = '';

  /** Water darkens the asphalt and turns it glossy, so the sky shows in it. */
  setWetness(wetness: number): void {
    const w = Math.round(Math.max(0, Math.min(1, wetness)) * 50) / 50;
    if (w === this.wetness) return;
    this.wetness = w;
    this.asphalt.color.setScalar(1 - 0.45 * w);
    this.asphalt.roughness = 1 - 0.65 * w;
    this.asphalt.envMapIntensity = 1 + 1.5 * w;
  }

  constructor() {
    const asphalt = Textures.asphalt();
    // Repeats are metres per tile, sized for the generated images in public/textures.
    asphalt.map.repeat.set(1 / 8, 1 / 8);
    asphalt.roughnessMap.repeat.copy(asphalt.map.repeat);
    this.asphalt = decal(new THREE.MeshStandardMaterial({ map: asphalt.map, roughnessMap: asphalt.roughnessMap, roughness: 1, metalness: 0 }), 2);

    const grass = Textures.grass();
    grass.repeat.set(1 / 6, 1 / 3); // the image is 2:1
    this.grass = decal(new THREE.MeshStandardMaterial({ map: grass, roughness: 0.95 }), 1);
    const ground = Textures.ground();
    ground.repeat.set(1 / 24, 1 / 24);
    this.ground = new THREE.MeshStandardMaterial({ map: ground, roughness: 1, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 });

    const gravel = Textures.gravel();
    gravel.repeat.set(1 / 4, 1 / 4);
    this.gravel = new THREE.MeshStandardMaterial({ map: gravel, roughness: 1, side: THREE.DoubleSide });

    const kerb = Textures.kerb();
    kerb.repeat.set(1 / 4, 1); // two red/white pairs of 1 m blocks
    this.kerb = decal(new THREE.MeshStandardMaterial({ map: kerb, roughness: 0.55 }), 4);
    this.paint = decal(new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }), 3);

    const barrier = Textures.barrier();
    barrier.repeat.set(1 / 3, 1);
    this.barrier = new THREE.MeshStandardMaterial({ map: barrier, roughness: 0.7, side: THREE.DoubleSide });
    const ads = Textures.barrier('barrier_ads.webp');
    ads.repeat.copy(barrier.repeat);
    this.barrierAds = new THREE.MeshStandardMaterial({ map: ads, roughness: 0.6, side: THREE.DoubleSide });

    const trees = Textures.billboard('trees.webp');
    trees.repeat.set(1 / (TREES.height * TREES.aspect), 1);
    this.trees = new THREE.MeshStandardMaterial({ map: trees, alphaTest: 0.5, roughness: 0.9, side: THREE.DoubleSide });
    this.grandstand = new THREE.MeshStandardMaterial({ map: Textures.billboard('grandstand.webp'), alphaTest: 0.5, roughness: 0.8, side: THREE.DoubleSide });
    const canopy = Textures.billboard('canopy.webp');
    canopy.repeat.set(1 / (TREES.depth * TREES.topAspect), 1);
    this.canopy = new THREE.MeshStandardMaterial({ map: canopy, alphaTest: 0.5, roughness: 0.9, side: THREE.DoubleSide });
    for (const t of [this.cityDay, this.cityNight]) t.repeat.set(1 / (CITY.height * CITY.aspect), 1);
    this.city = new THREE.MeshStandardMaterial({ map: this.cityDay, alphaTest: 0.5, roughness: 0.6, side: THREE.DoubleSide });
    const rooftops = Textures.billboard('rooftops.webp');
    rooftops.repeat.set(1 / (CITY.depth * CITY.topAspect), 1);
    this.rooftops = decal(new THREE.MeshStandardMaterial({ map: rooftops, roughness: 0.9 }), 1);
    const roof = Textures.billboard('stand_roof.webp');
    roof.repeat.set(1 / (GRANDSTAND.depth * 4), 1);
    this.standRoof = new THREE.MeshStandardMaterial({ map: roof, roughness: 0.5, side: THREE.DoubleSide });

    const checker = Textures.checker();
    this.checker = decal(new THREE.MeshStandardMaterial({ map: checker, roughness: 0.6 }), 4);

    const dash = this.dashTexture.clone();
    dash.repeat.set(1 / 2.5, 1);
    this.pitLine = decal(new THREE.MeshBasicMaterial({ color: 0xffd700, alphaMap: dash, transparent: true, depthWrite: false }), 4);
  }

  /** Street circuits get a skyline instead of trees, with lit windows at night; rebuilds when that changes. */
  setScenery(street: boolean, night: boolean): void {
    this.city.map = night ? this.cityNight : this.cityDay;
    this.city.emissiveMap = night ? this.cityNight : null;
    this.city.emissive.set(night ? 0xffffff : 0x000000);
    this.city.needsUpdate = true;
    // Rooftops catch the city glow, so the top camera still shows the blocks at night.
    this.rooftops.emissiveMap = night ? this.rooftops.map : null;
    this.rooftops.emissive.set(night ? 0x3a3a3a : 0x000000);
    this.rooftops.needsUpdate = true;
    if (street === this.street) return;
    this.street = street;
    this.builtKey = '';
  }

  /** Rebuilds only when the track object or its geometry changed. */
  update(track: Track): boolean {
    const key = `${track.points.length}|${track.totalLength}|${track.width}|${track.barrierSegments.length}`;
    if (track === this.builtFor && key === this.builtKey) return false;
    this.builtFor = track;
    this.builtKey = key;
    this.build(track);
    return true;
  }

  private add(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], shadows = { cast: false, receive: true }, parent: THREE.Object3D = this.group): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = shadows.cast;
    mesh.receiveShadow = shadows.receive;
    parent.add(mesh);
    return mesh;
  }

  private clear(): void {
    for (const g of [this.group, this.checkpoints]) {
      g.traverse(o => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          // Per-build materials (sector colours, checkpoint lines) are owned by the mesh.
          if (o.userData.ownsMaterial) {
            const m = o.material as THREE.MeshBasicMaterial;
            m.alphaMap?.dispose(); // beam dash clones are per build too
            m.dispose();
          }
        }
      });
      g.clear();
    }
  }

  private build(track: Track): void {
    this.clear();
    const pts = track.points, run = track.runoff, n = pts.length;
    this.staticLabels = [];
    if (n < 3 || run.length !== n) return;

    const lefts = pts.map(p => p.left), rights = pts.map(p => p.right);
    this.add(stripGeometry(lefts, rights, H.asphalt, true), this.asphalt);
    const grass = mergeGeometries([
      stripGeometry(lefts, run.map(r => r.leftGrass), H.grass, true),
      stripGeometry(rights, run.map(r => r.rightGrass), H.grass, true),
    ]);
    this.add(grass, this.grass);
    const gravel = mergeGeometries([
      stripGeometry(run.map(r => r.leftGrass), run.map(r => r.leftBarrier), H.gravel, true),
      stripGeometry(run.map(r => r.rightGrass), run.map(r => r.rightBarrier), H.gravel, true),
    ]);
    this.add(gravel, this.gravel);

    // White track-limit lines just inside each edge.
    const line = 0.25;
    this.add(mergeGeometries([
      stripGeometry(lefts, pts.map(p => p.left.sub(p.normal.mul(line))), H.paint, true, false),
      stripGeometry(rights, pts.map(p => p.right.add(p.normal.mul(line))), H.paint, true, false),
    ]), this.paint);

    this.buildKerbs(track);
    this.buildBarriers(track);
    this.buildStartLine(track);
    this.buildTimingGates(track);
    this.buildPitLane(track);
    this.buildScenery(track);
    this.buildCheckpoints(track);

    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const r of run) {
      for (const p of [r.leftBarrier, r.rightBarrier]) {
        b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
        b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y);
      }
    }
    this.bounds = b;

    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    // Subdivided: huge single triangles lose depth precision against the strips in perspective.
    const ground = new THREE.PlaneGeometry(12000, 12000, 48, 48).rotateX(-Math.PI / 2).translate(cx, H.ground, cy);
    // World-space UVs, so the ground texture lines up with the grass strips.
    const uv = ground.getAttribute('uv') as THREE.BufferAttribute, pos = ground.getAttribute('position');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
    this.add(ground, this.ground);
  }

  /** Red/white kerbs on the inside edge of every corner, as continuous runs (same rule as the 2D view). */
  private buildKerbs(track: Track): void {
    const pts = track.points, n = pts.length;
    const half = Math.min(1.2, Math.max(0.5, track.width * 0.06)) / 2;
    const parts: THREE.BufferGeometry[] = [];
    for (const side of [1, -1]) {
      const bend = track.localCurvature;
      const isKerb = (i: number) => Math.abs(bend[i]) > 0.003 && Math.sign(bend[i]) === side;
      // Scan from a straight point, so no run wraps across the scan start.
      const start = pts.findIndex((_, i) => !isKerb(i));
      if (start < 0) { parts.push(this.kerbStrip(track, pts.map((_, i) => i), side, half, true)); continue; }
      for (let k = 0; k < n;) {
        if (!isKerb((start + k) % n)) { k++; continue; }
        const ids: number[] = [];
        while (k < n && isKerb((start + k) % n)) ids.push((start + k++) % n);
        ids.push((start + k) % n); // closes the segment from the last kerb point to the next
        parts.push(this.kerbStrip(track, ids, side, half, false));
      }
    }
    if (parts.length) this.add(mergeGeometries(parts), this.kerb);
  }

  private kerbStrip(track: Track, ids: number[], side: number, half: number, closed: boolean): THREE.BufferGeometry {
    const edge = ids.map(i => side > 0 ? track.points[i].left : track.points[i].right);
    const nrm = ids.map(i => track.points[i].normal.mul(side));
    return stripGeometry(edge.map((p, k) => p.sub(nrm[k].mul(half))), edge.map((p, k) => p.add(nrm[k].mul(half))), H.kerb, closed, false);
  }

  /** Barrier walls along the physics barrier segments: 1 m high, 0.5 m thick. */
  private buildBarriers(track: Track): void {
    const segs = track.barrierSegments;
    if (!segs.length) return;
    const height = 1, t = 0.25;
    const pos = new Float32Array(segs.length * 12 * 3), nrm = new Float32Array(segs.length * 12 * 3), uv = new Float32Array(segs.length * 12 * 2);
    const plain: number[] = [], ads: number[] = [];
    let u = 0, v = 0, index = plain;
    const quad = (corners: number[][], normal: number[], u0: number, u1: number, v0: number, v1: number) => {
      const base = v;
      const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      for (let k = 0; k < 4; k++) {
        pos.set(corners[k], v * 3); nrm.set(normal, v * 3); uv.set(uvs[k], v * 2); v++;
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    // The pit entry and exit roads pass through the wall: no wall drawn across them.
    const roads: Point2[] = [];
    const lane = track.pitLane;
    if (lane) {
      const edge = lane.side * (track.width / 2 - 2.5);
      for (let d = lane.entry; d <= lane.limiterStart; d += 2) roads.push(lane.point(d, lane.offset(d, edge)));
      for (let d = lane.limiterEnd; d <= lane.exit; d += 2) roads.push(lane.point(d, lane.offset(d, edge)));
    }
    const reach = (PIT_LANE_WIDTH / 2 + 1) ** 2;
    for (const s of segs) {
      const mx = (s.p1.x + s.p2.x) / 2, my = (s.p1.y + s.p2.y) / 2;
      if (roads.some(p => (p.x - mx) ** 2 + (p.y - my) ** 2 < reach)) continue;
      const dx = s.p2.x - s.p1.x, dy = s.p2.y - s.p1.y, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * t, ny = dx / len * t;
      const a = [s.p1.x + nx, s.p1.y + ny], b = [s.p2.x + nx, s.p2.y + ny];
      const c = [s.p1.x - nx, s.p1.y - ny], d = [s.p2.x - nx, s.p2.y - ny];
      const u1 = u + len;
      index = Math.floor(u / AD_STRETCH) % 3 === 0 ? ads : plain;
      quad([[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], height, b[1]], [a[0], height, a[1]]], [nx / t, 0, ny / t], u, u1, 0, 1);
      quad([[c[0], 0, c[1]], [d[0], 0, d[1]], [d[0], height, d[1]], [c[0], height, c[1]]], [-nx / t, 0, -ny / t], u, u1, 0, 1);
      quad([[a[0], height, a[1]], [b[0], height, b[1]], [d[0], height, d[1]], [c[0], height, c[1]]], [0, 1, 0], u, u1, 0.9, 1);
      u = u1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex([...plain, ...ads]);
    g.addGroup(0, plain.length, 0);
    g.addGroup(plain.length, ads.length, 1);
    this.add(g, [this.barrier, this.barrierAds], { cast: true, receive: true });
  }

  private buildStartLine(track: Track): void {
    const sf = track.checkpoints[0];
    if (!sf) return;
    const t = sf.tangent.mul(0.6), len = sf.p1.dist(sf.p2);
    const corners = [sf.p1.sub(t), sf.p2.sub(t), sf.p2.add(t), sf.p1.add(t)];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap(p => [p.x, H.kerb, p.y]), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, len / 2.4, 0, len / 2.4, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.add(g, this.checker);
  }

  /** Sector beams across the asphalt and lit posts on both sides, colour-coded like the timing screens. */
  private buildTimingGates(track: Track): void {
    if (track.timingGates.length !== 4) return;
    const post = new THREE.CylinderGeometry(0.14, 0.18, 2.6, 10).translate(0, 1.3, 0);
    for (let g = 0; g < 4; g++) {
      const gate = track.timingGates[g], color = new THREE.Color(SECTOR_COLORS[g]);
      if (g < 3) {
        const alpha = this.dashTexture.clone();
        alpha.repeat.set(1 / 1.4, 1);
        const beam = new THREE.MeshBasicMaterial({ color, alphaMap: alpha, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
        const t = gate.tangent.mul(0.3);
        const mesh = this.add(stripGeometry([gate.left.sub(t), gate.right.sub(t)], [gate.left.add(t), gate.right.add(t)], H.kerb, false, false), decal(beam, 5));
        mesh.userData.ownsMaterial = true;
      }
      const lamp = new THREE.MeshStandardMaterial({ color: 0x20252c, emissive: color, emissiveIntensity: 1.6, roughness: 0.4 });
      for (const p of [gate.left, gate.right]) {
        const mesh = this.add(post, lamp, { cast: true, receive: false });
        mesh.position.set(p.x, 0, p.y);
        mesh.userData.ownsMaterial = p === gate.right;
      }
      const badge = gate.left.add(gate.normal.mul(9));
      this.staticLabels.push({ text: gate.name, x: badge.x, y: badge.y, color: SECTOR_COLORS[g], className: 'sector' });
    }
  }

  /**
   * The pit lane (track/PitLane.ts): its asphalt with the entry and exit roads, a dashed yellow line
   * along the roads' track side, the entry and exit lines, the 80 km/h limiter lines, and a box in
   * each team's colour where its cars stop.
   */
  private buildPitLane(track: Track): void {
    const lane = track.pitLane;
    if (!lane) return;
    const edge = lane.side * (track.width / 2 - 2.5), step = 2;
    const centre: Point2[] = [];
    for (let d = lane.entry; d <= lane.exit; d += step) centre.push(lane.point(d, lane.offset(d, edge)));
    const [l, r] = offsetPolyline(centre, PIT_LANE_WIDTH / 2, false);
    this.add(stripGeometry(l, r, H.asphalt, false), this.asphalt);
    // Garages: a strip of concrete along the far side of the lane, between the limiter lines.
    const garage: Point2[] = [], garageOuter: Point2[] = [];
    for (let d = lane.limiterStart; d <= lane.limiterEnd; d += step) {
      garage.push(lane.point(d, lane.side * (lane.laneOffset + PIT_LANE_WIDTH / 2)));
      garageOuter.push(lane.point(d, lane.side * (lane.laneOffset + PIT_LANE_WIDTH / 2 + 4)));
    }
    this.add(stripGeometry(garage, garageOuter, H.asphalt, false), this.gravel);

    // Yellow dashes along the track side of the entry and exit roads.
    const inner = (from: number, to: number) => {
      const pts: Point2[] = [];
      for (let d = from; d <= to; d += step) pts.push(lane.point(d, lane.offset(d, edge) - lane.side * PIT_LANE_WIDTH / 2));
      const [a, b] = offsetPolyline(pts, 0.15, false);
      this.add(stripGeometry(a, b, H.kerb, false, false), this.pitLine);
    };
    inner(lane.entry, lane.limiterStart);
    inner(lane.limiterEnd, lane.exit);

    // Lines across the lane: entry and exit (solid white), limiter (white, with the limit).
    const across = (d: number, width: number, label: string, color: string) => {
      const c = lane.point(d, lane.offset(d, edge)), ahead = lane.point(d + 1, lane.offset(d + 1, edge));
      const tx = ahead.x - c.x, ty = ahead.y - c.y, len = Math.hypot(tx, ty) || 1;
      const nx = -ty / len, ny = tx / len, half = PIT_LANE_WIDTH / 2;
      const a = [{ x: c.x + nx * half, y: c.y + ny * half }, { x: c.x - nx * half, y: c.y - ny * half }];
      const b = a.map(p => ({ x: p.x + tx / len * width, y: p.y + ty / len * width }));
      this.add(stripGeometry(a, b, H.kerb, false, false), this.paint);
      const tag = lane.point(d, lane.offset(d, edge) + lane.side * (PIT_LANE_WIDTH / 2 + 5));
      this.staticLabels.push({ text: label, x: tag.x, y: tag.y, color, className: 'pit' });
    };
    across(lane.entry, 0.6, 'PIT IN', '#FFD700');
    across(lane.exit, 0.6, 'PIT OUT', '#FFD700');
    across(lane.limiterStart, 0.3, '80 km/h', '#FFFFFF');
    across(lane.limiterEnd, 0.3, '80 km/h', '#FFFFFF');

    // Team boxes: an outline in the team colour around each stopping point, the team on the garage.
    const teams = Population.F1_TEAMS.slice(0, lane.boxes.length);
    lane.boxes.forEach((d, k) => {
      const color = teams[k]?.color ?? '#FFD700';
      const lineAt = (along: number, side: number) => lane.point(d + along, lane.side * lane.laneOffset + side);
      const half = PIT_LANE_WIDTH / 2 - 0.4, len = 3;
      const ring = [lineAt(-len, -half), lineAt(len, -half), lineAt(len, half), lineAt(-len, half)];
      const geometries: THREE.BufferGeometry[] = [];
      for (let e = 0; e < 4; e++) {
        const [a, b] = offsetPolyline([ring[e], ring[(e + 1) % 4]], 0.12, false);
        geometries.push(stripGeometry(a, b, H.kerb, false, false));
      }
      const mesh = this.add(mergeGeometries(geometries), decal(new THREE.MeshBasicMaterial({ color }), 4));
      mesh.userData.ownsMaterial = true;
      const tag = lane.point(d, lane.side * (lane.laneOffset + PIT_LANE_WIDTH / 2 + 2));
      this.staticLabels.push({ text: teams[k]?.teamName.split(' ')[0].toUpperCase() ?? `BOX ${k + 1}`, x: tag.x, y: tag.y, color, className: 'pit' });
    });
  }

  /**
   * A tree line (a skyline of buildings on street circuits) a fixed gap beyond the barriers on
   * both sides, and a grandstand opposite the pit lane along the start/finish straight. Each has
   * a flat layer behind it for the top camera: tree crowns, rooftops, the grandstand roof.
   * Points that would land near another part of the circuit (offsets folding through tight
   * corners or across a nearby straight) are dropped.
   */
  private buildScenery(track: Track): void {
    const pts = track.points, run = track.runoff, n = pts.length;
    const clear = (q: Point2, need: number) => pts.every(p => (p.center.x - q.x) ** 2 + (p.center.y - q.y) ** 2 >= need * need);
    const place = (i: number, side: number, gap: number) => {
      const barrier = side > 0 ? run[i].leftBarrier : run[i].rightBarrier;
      const out = pts[i].normal.mul(side);
      const q = barrier.add(out.mul(gap));
      return { q, out, ok: clear(q, barrier.dist(pts[i].center) + gap - 2) };
    };
    type Spot = ReturnType<typeof place>;
    const noShadow = { cast: false, receive: false };
    // Flat strip `depth` metres deep behind a billboard line, at `height`.
    const top = (line: Spot[], depth: number, height: number) =>
      stripGeometry(line.map(s => s.q), line.map(s => s.q.add(s.out.mul(depth))), height, false, false);

    const look = this.street ? CITY : TREES;
    const fronts: THREE.BufferGeometry[] = [], tops: THREE.BufferGeometry[] = [];
    for (const side of [1, -1]) {
      const spots = pts.map((_, i) => place(i, side, look.gap));
      const start = spots.findIndex(s => !s.ok);
      const lines: Spot[][] = [];
      if (start < 0) lines.push([...spots, spots[0]]);
      else {
        for (let k = 0; k < n;) {
          const line: Spot[] = [];
          while (k < n && spots[(start + k) % n].ok) line.push(spots[(start + k++) % n]);
          k++;
          if (line.length > 3) lines.push(line);
        }
      }
      for (const line of lines) {
        fronts.push(billboardStrip(line.map(s => s.q), look.height));
        tops.push(top(line, look.depth, look.topHeight));
      }
    }
    if (fronts.length) {
      this.add(mergeGeometries(fronts), this.street ? this.city : this.trees, noShadow);
      this.add(mergeGeometries(tops), this.street ? this.rooftops : this.canopy, noShadow);
    }

    // Points within half the grandstand's length either side of the start line, on the non-pit side.
    const along: number[] = [];
    for (let d = 0, i = 0; d < GRANDSTAND.length / 2 && along.length < n; i++) {
      along.push(i);
      d += pts[i % n].center.dist(pts[(i + 1) % n].center);
    }
    const back: number[] = [];
    for (let d = 0, i = n - 1; d < GRANDSTAND.length / 2 && back.length + along.length < n; i--) {
      d += pts[i].center.dist(pts[(i + 1) % n].center);
      back.unshift(i);
    }
    const stand = [...back, ...along].map(i => place(i, -1, GRANDSTAND.gap));
    if (stand.length > 3 && stand.every(s => s.ok)) {
      const base = stand.map(s => s.q);
      const length = base.reduce((sum, p, k) => k ? sum + p.dist(base[k - 1]) : 0, 0);
      const height = length / GRANDSTAND.aspect;
      this.add(billboardStrip(base, height, length), this.grandstand, noShadow);
      this.add(top(stand, GRANDSTAND.depth, height), this.standRoof, noShadow);
    }
  }

  private buildCheckpoints(track: Track): void {
    const pos: number[] = [];
    for (const cp of track.checkpoints) pos.push(cp.p1.x, H.kerb + 0.02, cp.p1.y, cp.p2.x, H.kerb + 0.02, cp.p2.y);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x00d2be, transparent: true, opacity: 0.45 }));
    lines.userData.ownsMaterial = true;
    this.checkpoints.add(lines);
  }
}

/**
 * Upright strip standing on the ground along `base`, `height` metres tall. u runs in metres
 * (the material's repeat sets the tile), or 0..1 over the whole strip when `span` is given.
 */
function billboardStrip(base: Point2[], height: number, span?: number): THREE.BufferGeometry {
  const rows = base.length;
  const pos = new Float32Array(rows * 2 * 3), uv = new Float32Array(rows * 2 * 2), nrm = new Float32Array(rows * 2 * 3);
  const index: number[] = [];
  let u = 0;
  for (let r = 0; r < rows; r++) {
    const p = base[r];
    if (r) u += Math.hypot(p.x - base[r - 1].x, p.y - base[r - 1].y);
    const a = base[Math.max(0, r - 1)], b = base[Math.min(rows - 1, r + 1)];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    pos.set([p.x, H.ground, p.y, p.x, H.ground + height, p.y], r * 6);
    nrm.set([-dy / len, 0, dx / len, -dy / len, 0, dx / len], r * 6);
    const s = span ? u / span : u;
    uv.set([s, 0, s, 1], r * 4);
    if (r) index.push(r * 2 - 2, r * 2, r * 2 + 1, r * 2 - 2, r * 2 + 1, r * 2 - 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}
