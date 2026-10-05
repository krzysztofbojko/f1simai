import { Track } from '../track/Track';
import { Car, TrajectoryPoint } from '../physics/Car';
import { Vector2 } from '../math/Vector2';
import { NeuralNetwork } from '../ai/NeuralNetwork';

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private viewZoom = 1;
  public showSensors: boolean = true;
  public showCheckpoints: boolean = false;
  public showRacingLine: boolean = true;
  public showCarSpeed: boolean = true;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  clear(width: number, height: number, zoom: number = 1): void {
    this.viewZoom = Math.max(.01, zoom);
    const ctx = this.ctx;

    // Dark motorsport asphalt / grass background
    ctx.fillStyle = '#141E15'; // Dark grass green
    ctx.fillRect(0, 0, width, height);

    // 50m Grid: 1 cell = 50px = 50 meters
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.lineWidth = 1;
    const gridSize = 50;
    for (let x = 0; x < width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Scale indicator badge: 1 grid = 50 meters
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText(`📏 50 px = ${(50 / zoom).toFixed(1)} METRÓW`, 16, height - 16);
    ctx.strokeStyle = 'rgba(0, 210, 190, 0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(16, height - 28);
    ctx.lineTo(66, height - 28);
    ctx.moveTo(16, height - 32);
    ctx.lineTo(16, height - 24);
    ctx.moveTo(66, height - 32);
    ctx.lineTo(66, height - 24);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Render the drawn track with tarmac, kerbs, borders and start/finish line
   */
  renderTrack(track: Track): void {
    const pts = track.points;
    if (pts.length < 3) return;

    const ctx = this.ctx;

    // Shared generated geometry: grass beside asphalt, gravel up to the fence.
    const strip = (a: Vector2, b: Vector2, c: Vector2, d: Vector2, color: string) => {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
    };
    for (let i = 0; i < pts.length; i++) {
      const next = (i + 1) % pts.length, a = pts[i], b = pts[next];
      const r = track.runoff[i], s = track.runoff[next];
      strip(a.left, b.left, s.leftBarrier, r.leftBarrier, '#796849');
      strip(a.right, b.right, s.rightBarrier, r.rightBarrier, '#796849');
      strip(a.left, b.left, s.leftGrass, r.leftGrass, '#456333');
      strip(a.right, b.right, s.rightGrass, r.rightGrass, '#456333');
      // Deterministic gravel flecks; drawing never consumes simulation randomness.
      ctx.fillStyle = '#b4a07a';
      for (const side of ['left', 'right'] as const) {
        const inner = side === 'left' ? r.leftGrass : r.rightGrass;
        const outer = side === 'left' ? r.leftBarrier : r.rightBarrier;
        for (let j = 1; j <= 4; j++) {
          const p = Vector2.lerp(inner, outer, j / 5);
          ctx.fillRect(p.x + (i % 3) * 0.3, p.y, 0.35, 0.35);
        }
      }
    }
    ctx.strokeStyle = '#aeb9c3'; ctx.lineWidth = 0.65;
    for (const segment of track.barrierSegments) {
      ctx.beginPath(); ctx.moveTo(segment.p1.x, segment.p1.y); ctx.lineTo(segment.p2.x, segment.p2.y); ctx.stroke();
    }

    // 2. Main Asphalt track ribbon
    ctx.beginPath();
    ctx.strokeStyle = '#25262B'; // Fresh Dark Asphalt
    ctx.lineWidth = track.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i <= pts.length; i++) {
      const p = pts[i % pts.length].center;
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // 3. Red & White Kerbs (tarki) on corners
    const kerbWidth = Math.min(1.2, Math.max(0.5, track.width * 0.06));
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const nextPt = pts[(i + 1) % pts.length];
      const isCorner = Math.abs(pt.curvature) > 0.003;

      if (isCorner) {
        const isRed = i % 2 === 0;
        ctx.strokeStyle = isRed ? '#E10600' : '#FFFFFF';
        ctx.lineWidth = kerbWidth;

        if (pt.curvature > 0) {
          ctx.beginPath();
          ctx.moveTo(pt.left.x, pt.left.y);
          ctx.lineTo(nextPt.left.x, nextPt.left.y);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(pt.right.x, pt.right.y);
          ctx.lineTo(nextPt.right.x, nextPt.right.y);
          ctx.stroke();
        }
      }
    }

    // 4. White track boundary lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 0.2;

    ctx.beginPath();
    for (let i = 0; i <= pts.length; i++) {
      const p = pts[i % pts.length].left;
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    ctx.beginPath();
    for (let i = 0; i <= pts.length; i++) {
      const p = pts[i % pts.length].right;
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // 5. Start/Finish Line (Checkered pattern)
    if (track.checkpoints.length > 0) {
      const sf = track.checkpoints[0];
      const p1 = sf.p1;
      const p2 = sf.p2;

      ctx.save();
      ctx.lineWidth = 7;
      ctx.strokeStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      ctx.lineWidth = 5;
      ctx.strokeStyle = '#111111';
      ctx.setLineDash([8, 8]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.restore();
    }

    // 5b. 4 Official Timing Gates / Sector Splits (F1 Timing Beams)
    if (track.timingGates && track.timingGates.length === 4) {
      ctx.save();
      const sectorColors = ['#00D2BE', '#FFD700', '#A855F7', '#E10600'];

      for (let g = 0; g < 4; g++) {
        const gate = track.timingGates[g];
        const isMeta = g === 3;
        const color = sectorColors[g];

        // Beams across tarmac for CP 1, CP 2, CP 3
        if (!isMeta) {
          // Ambient neon glow
          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.35;
          ctx.lineWidth = 5.5;
          ctx.setLineDash([]);
          ctx.moveTo(gate.left.x, gate.left.y);
          ctx.lineTo(gate.right.x, gate.right.y);
          ctx.stroke();

          // Laser split beam
          ctx.globalAlpha = 0.95;
          ctx.lineWidth = 2.0;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(gate.left.x, gate.left.y);
          ctx.lineTo(gate.right.x, gate.right.y);
          ctx.stroke();
        }

        // Sensor posts on both sides of track
        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;
        for (const pt of [gate.left, gate.right]) {
          ctx.beginPath();
          ctx.fillStyle = color;
          ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Sector Pill Badge near left track border
        const badgeOffset = 18;
        const badgeX = gate.left.x + gate.normal.x * badgeOffset;
        const badgeY = gate.left.y + gate.normal.y * badgeOffset;

        const labelText = gate.name;
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        const textMetrics = ctx.measureText(labelText);
        const padX = 6;
        const bw = textMetrics.width + padX * 2;
        const bh = 15;
        const bx = badgeX - bw / 2;
        const by = badgeY - bh / 2;

        ctx.fillStyle = 'rgba(9, 11, 14, 0.92)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;

        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(bx, by, bw, bh, 3);
        } else {
          ctx.rect(bx, by, bw, bh);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText, badgeX, badgeY + 0.5);
      }
      ctx.restore();
    }

    // 5c. Pit Lane & Pit Box on Start/Finish Straight
    if (pts.length >= 20) {
      ctx.save();
      const n = pts.length;
      const pitSpan = Math.min(10, Math.floor(n * 0.08));

      // Draw yellow dashed pit lane separator
      ctx.beginPath();
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([6, 5]);

      for (let i = -pitSpan; i <= pitSpan; i++) {
        const idx = (n + i) % n;
        const pt = pts[idx];
        const pitOffset = Math.min(16, track.width * 0.35);
        const px = pt.center.x + pt.normal.x * pitOffset;
        const py = pt.center.y + pt.normal.y * pitOffset;
        if (i === -pitSpan) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Pit Box marker at start/finish line (index 0)
      const p0 = pts[0];
      const boxOffset = Math.min(18, track.width * 0.40);
      const boxPos = {
        x: p0.center.x + p0.normal.x * boxOffset,
        y: p0.center.y + p0.normal.y * boxOffset
      };

      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255, 215, 0, 0.25)';
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(boxPos.x, boxPos.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#FFD700';
      ctx.font = 'bold 8px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('P', boxPos.x, boxPos.y);

      // "PIT ENTRY" small text along line
      const entryPt = pts[(n - pitSpan) % n];
      const entryPos = {
        x: entryPt.center.x + entryPt.normal.x * (boxOffset + 10),
        y: entryPt.center.y + entryPt.normal.y * (boxOffset + 10)
      };
      ctx.fillStyle = '#FFD700';
      ctx.font = '7px "JetBrains Mono", monospace';
      ctx.fillText('PIT ENTRY', entryPos.x, entryPos.y);

      ctx.restore();
    }

    // 6. Checkpoints (optional debug)
    if (this.showCheckpoints) {
      ctx.strokeStyle = 'rgba(0, 210, 190, 0.25)';
      ctx.lineWidth = 1;
      for (const cp of track.checkpoints) {
        ctx.beginPath();
        ctx.moveTo(cp.p1.x, cp.p1.y);
        ctx.lineTo(cp.p2.x, cp.p2.y);
        ctx.stroke();
      }
    }
  }

  /**
   * Render the optimal racing line (najbardziej optymalna nitka toru)
   */
  renderOptimalRacingLine(line: TrajectoryPoint[]): void {
    if (!this.showRacingLine || line.length < 4) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 1. Outer ambient glow
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0, 210, 190, 0.2)';
    ctx.lineWidth = 8;
    for (let i = 0; i < line.length; i++) {
      if (i === 0) ctx.moveTo(line[i].x, line[i].y);
      else ctx.lineTo(line[i].x, line[i].y);
    }
    if (Math.hypot(line[0].x - line[line.length - 1].x, line[0].y - line[line.length - 1].y) < 70) {
      ctx.lineTo(line[0].x, line[0].y);
    }
    ctx.stroke();

    // 2. High-contrast telemetry gradient line
    ctx.lineWidth = 3.5;
    for (let i = 0; i < line.length - 1; i++) {
      const p1 = line[i];
      const p2 = line[i + 1];

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);

      if (p1.brake > 0.15) {
        ctx.strokeStyle = '#FF3333'; // Braking zone
      } else if (p1.throttle > 0.5) {
        ctx.strokeStyle = '#00E676'; // Full throttle
      } else {
        ctx.strokeStyle = '#00D2BE'; // Apex / neutral cornering
      }
      ctx.stroke();
    }

    // 3. Small gold apex markers along the line
    ctx.fillStyle = '#FFD700';
    for (let i = 0; i < line.length; i += 8) {
      ctx.beginPath();
      ctx.arc(line[i].x, line[i].y, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Render car skidmarks
   */
  renderSkidMarks(cars: Car[]): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(10, 10, 10, 0.15)';
    for (const car of cars) {
      for (const mark of car.skidMarks) {
        ctx.beginPath();
        ctx.arc(mark.x, mark.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Render F1 Car with aerodynamics, wheels, fuel state and livery
   */
  renderCar(
    car: Car,
    isLeader: boolean = false,
    isPlayer: boolean = false,
    isSelected: boolean = false,
    hasSelectedCar: boolean = false
  ): void {
    if (car.wreckRemoved) return;
    if (!car.isAlive) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(car.pos.x, car.pos.y);
      ctx.rotate(car.heading);
      ctx.globalAlpha = 0.35;

      ctx.fillStyle = '#222222';
      ctx.fillRect(-car.length / 2, -car.width / 2, car.length, car.width);
      ctx.strokeStyle = car.color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-car.length / 2, -car.width / 2, car.length, car.width);

      ctx.rotate(-car.heading);
      ctx.fillStyle = '#FF5252';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('💥 DNF', 0, -car.width - 2);
      ctx.restore();
      return;
    }

    const ctx = this.ctx;

    // Selection reticle and brackets around car
    if (isSelected) {
      ctx.save();
      const ringRadius = Math.max(12 / this.viewZoom, car.length * .65);
      ctx.strokeStyle = car.color;
      ctx.lineWidth = 2.0;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(car.pos.x, car.pos.y, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // 4 tactical target brackets
      const bLen = 6 / this.viewZoom;
      const bOffset = ringRadius + 4 / this.viewZoom;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      // Top-left
      ctx.beginPath();
      ctx.moveTo(car.pos.x - bOffset, car.pos.y - bOffset + bLen);
      ctx.lineTo(car.pos.x - bOffset, car.pos.y - bOffset);
      ctx.lineTo(car.pos.x - bOffset + bLen, car.pos.y - bOffset);
      // Top-right
      ctx.moveTo(car.pos.x + bOffset - bLen, car.pos.y - bOffset);
      ctx.lineTo(car.pos.x + bOffset, car.pos.y - bOffset);
      ctx.lineTo(car.pos.x + bOffset, car.pos.y - bOffset + bLen);
      // Bottom-left
      ctx.moveTo(car.pos.x - bOffset, car.pos.y + bOffset - bLen);
      ctx.lineTo(car.pos.x - bOffset, car.pos.y + bOffset);
      ctx.lineTo(car.pos.x - bOffset + bLen, car.pos.y + bOffset);
      // Bottom-right
      ctx.moveTo(car.pos.x + bOffset - bLen, car.pos.y + bOffset);
      ctx.lineTo(car.pos.x + bOffset, car.pos.y + bOffset);
      ctx.lineTo(car.pos.x + bOffset, car.pos.y + bOffset - bLen);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(car.pos.x, car.pos.y);
    ctx.rotate(car.heading);

    const length = car.length;
    const width = car.width;
    const halfL = length / 2;
    const halfW = width / 2;

    // Leader halo glow
    if (isLeader) {
      ctx.shadowColor = '#00D2BE';
      ctx.shadowBlur = 10;
    } else if (isPlayer) {
      ctx.shadowColor = '#FF8000';
      ctx.shadowBlur = 10;
    }

    // Tire smoke effect when skidding
    if (car.isSkidding) {
      ctx.fillStyle = 'rgba(220, 220, 220, 0.4)';
      ctx.beginPath();
      ctx.arc(-halfL - 3, -halfW - 2, 3.5 + Math.random() * 2, 0, Math.PI * 2);
      ctx.arc(-halfL - 3, halfW + 2, 3.5 + Math.random() * 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // All solid car parts occupy exactly the same box used by collisions.
    // Smoke, labels and selection markers are overlays, not vehicle geometry.
    ctx.beginPath();
    ctx.rect(-halfL, -halfW, length, width);
    ctx.clip();

    // 1. Wheels (Pirelli Slicks)
    ctx.fillStyle = '#1A1A1A';
    const scale = width / 14;
    const wheelW = 3.8 * scale;
    const wheelL = 8.5 * scale;

    // Front wheels (steered with steer angle)
    ctx.save();
    ctx.translate(halfL * 0.7, -halfW - wheelW * 0.3);
    ctx.rotate(car.angularVelocity * 0.15);
    ctx.fillRect(-wheelL / 2, -wheelW / 2, wheelL, wheelW);
    ctx.restore();

    ctx.save();
    ctx.translate(halfL * 0.7, halfW + wheelW * 0.3);
    ctx.rotate(car.angularVelocity * 0.15);
    ctx.fillRect(-wheelL / 2, -wheelW / 2, wheelL, wheelW);
    ctx.restore();

    // Rear wheels (fixed)
    ctx.fillRect(-halfL * 0.75 - wheelL / 2, -halfW - wheelW * 0.6, wheelL, wheelW * 1.1);
    ctx.fillRect(-halfL * 0.75 - wheelL / 2, halfW + wheelW * 0.2, wheelL, wheelW * 1.1);

    // 2. Chassis body (Chassis & Sidepods)
    ctx.fillStyle = car.color;
    ctx.beginPath();
    ctx.moveTo(halfL + 2 * scale, 0); // Nose tip
    ctx.lineTo(halfL * 0.5, -halfW * 0.4); // Front nose taper
    ctx.lineTo(0, -halfW); // Left sidepod
    ctx.lineTo(-halfL * 0.8, -halfW * 0.85); // Rear left
    ctx.lineTo(-halfL * 0.8, halfW * 0.85); // Rear right
    ctx.lineTo(0, halfW); // Right sidepod
    ctx.lineTo(halfL * 0.5, halfW * 0.4); // Front right nose taper
    ctx.closePath();
    ctx.fill();

    // 3. Front Wing
    ctx.fillStyle = '#0F0F0F';
    ctx.fillRect(halfL * 0.85, -halfW - 2 * scale, Math.max(1, 3.5 * scale), width + 4 * scale);

    // 4. Rear Wing
    ctx.fillStyle = '#0F0F0F';
    ctx.fillRect(-halfL - 2 * scale, -halfW - 1.5 * scale, Math.max(1, 3.5 * scale), width + 3 * scale);

    // 5. Cockpit & Halo
    ctx.fillStyle = '#222222';
    ctx.beginPath();
    ctx.ellipse(halfL * 0.1, 0, Math.max(1.5, 4.5 * scale), Math.max(1, 3 * scale), 0, 0, Math.PI * 2);
    ctx.fill();

    // Driver helmet
    ctx.fillStyle = isPlayer ? '#00D2BE' : '#FFDD00';
    ctx.beginPath();
    ctx.arc(halfL * 0.05, 0, Math.max(0.8, 2 * scale), 0, Math.PI * 2);
    ctx.fill();

    // 6. Rear flashing Rain / Brake light
    if (car.speedKmh < 90 || car.isSkidding) {
      ctx.fillStyle = '#FF0033';
      ctx.beginPath();
      ctx.arc(-halfL - 1, 0, Math.max(0.8, 2 * scale), 0, Math.PI * 2);
      ctx.fill();
    }

    // 7. Out of fuel warning
    if (car.isOutOfFuel) {
      ctx.fillStyle = '#FFB800';
      ctx.font = 'bold 8px "JetBrains Mono", monospace';
      ctx.fillText('NO FUEL', -15, -halfW - 5);
    }

    ctx.restore();

    // 8. Floating Speed Display above the car (horizontal, always readable)
    if (this.showCarSpeed) {
      this.renderSpeedLabel(car, isLeader, isPlayer, isSelected);
    }

    // Render sensor rays for selected car (or leader if no specific car selected)
    const shouldRenderSensors = this.showSensors && (isSelected || (isLeader && !hasSelectedCar));
    if (shouldRenderSensors) {
      this.renderSensors(car);
    }
  }

  /**
   * Render floating speed badge above the car
   */
  private renderSpeedLabel(car: Car, isLeader: boolean, isPlayer: boolean, isSelected: boolean = false): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(car.pos.x, car.pos.y);
    ctx.scale(1 / this.viewZoom, 1 / this.viewZoom);

    const speedVal = Math.round(car.speedKmh);
    const surnameMatch = car.driverName.match(/^([^\s]+)\s+([^\s(]+)/);
    const driverShort = surnameMatch ? surnameMatch[2] : car.driverName.split(' ')[0];

    const isPitting = car.isPitting;
    const wantsPit = car.wantsToPit && !isPitting;

    const labelText = isPitting
      ? `⛽ ${driverShort}: PIT STOP (${car.pitTimer.toFixed(1)}s)`
      : car.yellowFlag
      ? `⚑ ŻÓŁTA: ${driverShort} ${speedVal} km/h`
      : car.isOutOfFuel
      ? `⚠️ ${driverShort}: LIMP MODE (NO FUEL)`
      : wantsPit
      ? `🔧 ${driverShort}: BOX THIS LAP`
      : isPlayer
      ? `🏎️ GRACZ: ${speedVal} km/h`
      : isSelected
      ? `🎯 ${driverShort}: ${speedVal} km/h`
      : isLeader
      ? `👑 ${driverShort}: ${speedVal} km/h`
      : `${driverShort}: ${speedVal} km/h`;

    ctx.font = isLeader || isPlayer || isSelected || isPitting
      ? 'bold 10px "JetBrains Mono", monospace'
      : '9px "JetBrains Mono", monospace';

    const textWidth = ctx.measureText(labelText).width;
    const padX = 6;
    const boxW = textWidth + padX * 2;
    const boxH = isLeader || isPlayer || isSelected || isPitting ? 16 : 14;
    const posX = -boxW / 2;
    const posY = -Math.max(24, car.width * this.viewZoom / 2 + 16);

    // Dark pill container with team color border
    ctx.fillStyle = isPitting
      ? 'rgba(38, 28, 6, 0.95)'
      : wantsPit
      ? 'rgba(35, 18, 6, 0.92)'
      : isSelected
      ? 'rgba(10, 24, 30, 0.95)'
      : isLeader
      ? 'rgba(10, 16, 22, 0.92)'
      : isPlayer
      ? 'rgba(24, 18, 10, 0.92)'
      : 'rgba(12, 16, 20, 0.82)';

    ctx.strokeStyle = car.yellowFlag ? '#FFD700' : isPitting
      ? '#FFD700'
      : wantsPit
      ? '#FF8000'
      : isSelected
      ? '#00E676'
      : isLeader
      ? '#00D2BE'
      : isPlayer
      ? '#FF8000'
      : car.color;

    ctx.lineWidth = isPitting || isSelected ? 2 : isLeader || isPlayer ? 1.5 : 1;

    // Rounded rectangle pill
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(posX, posY, boxW, boxH, 4);
    } else {
      ctx.rect(posX, posY, boxW, boxH);
    }
    ctx.fill();
    ctx.stroke();

    // Text label
    ctx.fillStyle = car.yellowFlag ? '#FFD700' : isPitting
      ? '#FFD700'
      : wantsPit
      ? '#FFB800'
      : isSelected
      ? '#00E676'
      : isLeader
      ? '#00D2BE'
      : isPlayer
      ? '#FF9E3B'
      : '#F0F3F6';

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, 0, posY + boxH / 2);

    ctx.restore();
  }

  /**
   * Render LIDAR rays for car
   */
  private renderSensors(car: Car): void {
    const ctx = this.ctx;
    for (let i = 0; i < car.rayHits.length; i++) {
      const hit = car.rayHits[i];
      const distRatio = car.rayDistances[i];

      ctx.beginPath();
      ctx.moveTo(car.pos.x, car.pos.y);
      ctx.lineTo(hit.point.x, hit.point.y);

      const r = Math.round((1 - distRatio) * 255);
      const g = Math.round(distRatio * 255);
      ctx.strokeStyle = `rgba(${r}, ${g}, 70, 0.45)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = `rgba(${r}, ${g}, 70, 0.8)`;
      ctx.beginPath();
      ctx.arc(hit.point.x, hit.point.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Render active drawing line when user is drawing track with mouse
   */
  renderDrawingPath(points: Vector2[], mousePos: Vector2 | null, straightAnchor: Vector2 | null = null): void {
    if (points.length < 1) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.strokeStyle = '#00D2BE';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }

    if (straightAnchor && mousePos) {
      // Connect to anchor then draw straight line to mouse
      ctx.lineTo(straightAnchor.x, straightAnchor.y);
      ctx.stroke();

      // Distinct straight line guide
      ctx.beginPath();
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 6;
      ctx.moveTo(straightAnchor.x, straightAnchor.y);
      ctx.lineTo(mousePos.x, mousePos.y);
      ctx.stroke();

      // Badge on straight line
      const midX = (straightAnchor.x + mousePos.x) / 2;
      const midY = (straightAnchor.y + mousePos.y) / 2;
      ctx.fillStyle = 'rgba(9, 11, 14, 0.9)';
      ctx.fillRect(midX - 44, midY - 10, 88, 20);
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 1;
      ctx.strokeRect(midX - 44, midY - 10, 88, 20);
      ctx.fillStyle = '#FFD700';
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('📏 PROSTA (SHIFT)', midX, midY);
    } else if (mousePos && points.length > 0) {
      ctx.lineTo(mousePos.x, mousePos.y);
      ctx.stroke();
    } else {
      ctx.stroke();
    }

    const start = points[0];
    ctx.fillStyle = '#E10600';
    ctx.beginPath();
    ctx.arc(start.x, start.y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Snap target indicator if near start point to close loop
    if (mousePos && points.length > 5 && mousePos.dist(start) < 40) {
      ctx.fillStyle = 'rgba(0, 210, 190, 0.4)';
      ctx.beginPath();
      ctx.arc(start.x, start.y, 25, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Render live neural network architecture in HUD mini canvas
   */
  renderBrain(net: NeuralNetwork, canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const layerSizes = net.layerSizes;
    if (!layerSizes || layerSizes.length < 2) return;

    const numLayers = layerSizes.length;
    const padX = 22;
    const padY = 12;
    const colStep = (w - padX * 2) / Math.max(1, numLayers - 1);
    const time = performance.now() * 0.003;

    // 1. Calculate node positions per layer
    const nodePos: Vector2[][] = [];
    for (let l = 0; l < numLayers; l++) {
      const count = layerSizes[l];
      const rowStep = (h - padY * 2) / Math.max(1, count - 1);
      const x = padX + l * colStep;

      const layerNodes: Vector2[] = [];
      for (let n = 0; n < count; n++) {
        const y = count === 1 ? h / 2 : padY + n * rowStep;
        layerNodes.push(new Vector2(x, y));
      }
      nodePos.push(layerNodes);
    }

    // 2. Render synapse connections with animated signal pulses
    for (let l = 0; l < numLayers - 1; l++) {
      const layer = net.layers[l];
      if (!layer) continue;
      const fromNodes = nodePos[l];
      const toNodes = nodePos[l + 1];
      const fromActs = l === 0 ? (net.lastInputs || []) : (net.layers[l - 1]?.activations || []);

      for (let o = 0; o < toNodes.length; o++) {
        const toX = toNodes[o].x;
        const toY = toNodes[o].y;
        const weightRow = layer.weights[o];
        if (!weightRow) continue;

        for (let i = 0; i < fromNodes.length; i++) {
          const weight = weightRow[i] ?? 0;
          const absW = Math.min(1.0, Math.abs(weight));
          const fromVal = fromActs[i] ?? 0;
          const signal = Math.min(1.0, Math.abs(fromVal * weight));

          const fromX = fromNodes[i].x;
          const fromY = fromNodes[i].y;

          // Base synapse line: color coded by weight sign and modulated by signal activity
          ctx.beginPath();
          ctx.moveTo(fromX, fromY);
          ctx.lineTo(toX, toY);

          const alpha = Math.max(0.04, Math.min(0.65, absW * 0.25 + signal * 0.40));
          if (weight > 0) {
            ctx.strokeStyle = `rgba(0, 220, 200, ${alpha})`;
          } else {
            ctx.strokeStyle = `rgba(235, 40, 50, ${alpha})`;
          }
          ctx.lineWidth = Math.max(0.4, Math.min(2.0, absW * 1.2 + signal * 0.8));
          ctx.stroke();

          // Animated light impulse traveling along synapse if active signal passes through
          if (signal > 0.08) {
            const pulseSpeed = 1.4 + absW * 0.8;
            const phase = (time * pulseSpeed + (i * 0.17 + o * 0.29)) % 1.0;
            const px = fromX + (toX - fromX) * phase;
            const py = fromY + (toY - fromY) * phase;
            const pulseAlpha = Math.min(1.0, signal * 1.3) * Math.sin(phase * Math.PI);
            const pulseRadius = Math.max(0.7, Math.min(2.2, signal * 1.8));

            ctx.fillStyle = weight > 0
              ? `rgba(160, 255, 245, ${pulseAlpha})`
              : `rgba(255, 180, 190, ${pulseAlpha})`;
            ctx.beginPath();
            ctx.arc(px, py, pulseRadius, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // 3. Render neurons
    const lastIn = net.lastInputs || [];
    const totalInputs = layerSizes[0];
    const rayCount = Math.max(0, totalInputs - 5);

    // Layer 0: Input neurons (LiDAR rays and live telemetry)
    const inputNodes = nodePos[0];
    for (let n = 0; n < inputNodes.length; n++) {
      const p = inputNodes[n];
      const val = lastIn[n] ?? 0;
      const pulse = Math.sin(time * 2.8 + n * 0.4) * 0.22 + 0.78;

      let r: number;
      let coreColor: string;
      let glowColor: string;
      let glowBlur: number;

      if (n < rayCount) {
        // LiDAR ray: val is normalized distance [0, 1] (0 = wall near, 1 = open road)
        if (val < 0.25) {
          // Warning: obstacle in close proximity! Hot amber to coral
          coreColor = '#FF8533';
          glowColor = '#FF3300';
          r = 2.8 + (1.0 - val) * 1.6;
          glowBlur = 6 * pulse;
        } else if (val < 0.60) {
          // Moderate clearance: electric gold/yellow
          coreColor = '#FFD700';
          glowColor = '#FFAA00';
          r = 2.4 + val * 0.8;
          glowBlur = 4 * pulse;
        } else {
          // Clear runway ahead: glowing turquoise/cyan
          coreColor = '#00F5D4';
          glowColor = '#00B4D8';
          r = 2.0 + val * 0.8;
          glowBlur = 4 * pulse;
        }
      } else {
        // Telemetry inputs: speed, angular vel, waypoint angle, curvature, braking cue
        const telIdx = n - rayCount;
        r = 3.2 + Math.min(1.5, Math.abs(val) * 1.5);
        if (telIdx === 0) {
          // Speed: brilliant gold
          coreColor = '#FFEA00';
          glowColor = '#FF9E00';
          glowBlur = 5 + Math.abs(val) * 6 * pulse;
        } else if (telIdx === 1) {
          // Angular velocity: electric purple/magenta
          coreColor = '#D946EF';
          glowColor = '#A855F7';
          glowBlur = 4 + Math.abs(val) * 5 * pulse;
        } else if (telIdx === 2) {
          // Waypoint angle diff: neon sky blue
          coreColor = '#38BDF8';
          glowColor = '#0284C7';
          glowBlur = 4 + Math.abs(val) * 5 * pulse;
        } else if (telIdx === 3) {
          // Curvature: bright spring emerald
          coreColor = '#10B981';
          glowColor = '#059669';
          glowBlur = 4 + Math.abs(val) * 5 * pulse;
        } else {
          // Overspeed / braking cue: hot fiery coral or cool cyan
          if (val > 0.05) {
            coreColor = '#FF3B30';
            glowColor = '#FF0055';
            glowBlur = 6 + val * 6 * pulse;
          } else {
            coreColor = '#2DD4BF';
            glowColor = '#0D9488';
            glowBlur = 3 * pulse;
          }
        }
      }

      ctx.save();
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = glowBlur;
      ctx.fillStyle = coreColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Hidden layers (Layers 1 .. numLayers - 2)
    for (let l = 1; l < numLayers - 1; l++) {
      const nodes = nodePos[l];
      const acts = net.layers[l - 1]?.activations || [];

      for (let n = 0; n < nodes.length; n++) {
        const p = nodes[n];
        const val = acts[n] ?? 0;
        const absVal = Math.min(1.0, Math.abs(val));
        const r = 2.8 + absVal * 1.8;

        // Color and glow dynamically based on activation sign & magnitude
        const coreColor = val >= 0
          ? `rgba(${Math.round(100 + absVal * 155)}, 255, 255, ${0.45 + absVal * 0.55})`
          : `rgba(255, ${Math.round(80 + (1 - absVal) * 100)}, ${Math.round(180 + absVal * 75)}, ${0.45 + absVal * 0.55})`;

        const glowColor = val >= 0 ? '#00F0FF' : '#FF2D8C';
        const glowBlur = 3 + absVal * 8;

        ctx.save();
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = glowBlur;
        ctx.fillStyle = coreColor;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // Output layer (numLayers - 1)
    const outNodes = nodePos[numLayers - 1];
    const outActs = net.layers[numLayers - 2]?.activations || [];
    const outputLabels = ['SKRĘT', 'GAZ', 'HAM'];

    for (let n = 0; n < outNodes.length; n++) {
      const p = outNodes[n];
      const val = outActs[n] ?? 0;
      const absVal = Math.min(1.0, Math.abs(val));

      let coreColor: string;
      let glowColor: string;
      let glowBlur: number;
      const r = 4.5 + absVal * 2.2;

      if (n === 0) {
        // Steer (tanh output, [-1, 1])
        if (val < -0.15) {
          // Left turn: bright cyan
          coreColor = '#00F5D4';
          glowColor = '#00B4D8';
        } else if (val > 0.15) {
          // Right turn: hot amber/orange
          coreColor = '#FF9100';
          glowColor = '#FF5400';
        } else {
          // Centered: pure white
          coreColor = '#FFFFFF';
          glowColor = '#B0E0E6';
        }
        glowBlur = 4 + absVal * 9;
      } else if (n === 1) {
        // Throttle (green / neon lime)
        const isAccelerating = val > 0.1;
        coreColor = isAccelerating ? '#00FF66' : '#1A6633';
        glowColor = isAccelerating ? '#00FF66' : '#0D331A';
        glowBlur = isAccelerating ? 6 + absVal * 9 : 2;
      } else {
        // Brake (crimson / carbon-ceramic red)
        const isBraking = val > 0.1;
        coreColor = isBraking ? '#FF1744' : '#660015';
        glowColor = isBraking ? '#FF1744' : '#33000A';
        glowBlur = isBraking ? 8 + absVal * 10 : 2;
      }

      ctx.save();
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = glowBlur;
      ctx.fillStyle = coreColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Output node label
      if (outputLabels[n]) {
        ctx.save();
        ctx.font = 'bold 8px monospace';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.textAlign = 'right';
        ctx.fillText(outputLabels[n], p.x - r - 4, p.y + 3);
        ctx.restore();
      }
    }
  }

  /**
   * Render circular F1 G-Force Meter / Kamm's friction circle
   */
  renderGMeter(car: Car, canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(cx, cy) - 5;

    ctx.clearRect(0, 0, w, h);

    // 1. Concentric G circles (2G, 4G, 5G)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;

    // 2G circle
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.4, 0, Math.PI * 2);
    ctx.stroke();

    // 4G circle
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.8, 0, Math.PI * 2);
    ctx.stroke();

    // Outer 5G limit circle
    ctx.strokeStyle = 'rgba(0, 210, 190, 0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // 2. Crosshair axes
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.beginPath();
    ctx.moveTo(cx, 4);
    ctx.lineTo(cx, h - 4);
    ctx.moveTo(4, cy);
    ctx.lineTo(w - 4, cy);
    ctx.stroke();

    // 3. G-Force Dot (Longitudinal G: up/down, Lateral centrifugal G: left/right)
    const maxG = 5.0;
    const latG = car.lateralG;
    const longG = car.longitudinalG;

    const dotX = cx + (latG / maxG) * radius;
    const dotY = cy - (longG / maxG) * radius;

    const distFromCenter = Math.hypot(dotX - cx, dotY - cy);
    const clampedDist = Math.min(radius, distFromCenter);
    const angle = Math.atan2(dotY - cy, dotX - cx);
    const finalX = cx + Math.cos(angle) * clampedDist;
    const finalY = cy + Math.sin(angle) * clampedDist;

    const totalG = Math.hypot(latG, longG);
    const isHighG = totalG > 3.2;

    ctx.save();
    ctx.fillStyle = isHighG ? '#FF0033' : '#00D2BE';
    ctx.shadowColor = isHighG ? '#FF0033' : '#00D2BE';
    ctx.shadowBlur = isHighG ? 8 : 4;
    ctx.beginPath();
    ctx.arc(finalX, finalY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Render the 5 F1 Red Start Lights gantry during the starting countdown
   */
  renderStartLights(lightsCount: number, state: 'GRID_START' | 'RACING' | 'FINISHED' | 'IDLE'): void {
    if (state !== 'GRID_START' && lightsCount === 0) return;
    const ctx = this.ctx;
    ctx.save();

    const dpr = window.devicePixelRatio || 1;
    const cx = (this.ctx.canvas.width / dpr) / 2;
    const cy = 60;
    const gantryW = 220;
    const gantryH = 50;

    // Dark carbon gantry housing
    ctx.fillStyle = '#0e1218';
    ctx.strokeStyle = '#273344';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(cx - gantryW / 2, cy - gantryH / 2, gantryW, gantryH, 8);
    } else {
      ctx.rect(cx - gantryW / 2, cy - gantryH / 2, gantryW, gantryH);
    }
    ctx.fill();
    ctx.stroke();

    // 5 light pods
    const podSpacing = 36;
    const startX = cx - (4 * podSpacing) / 2;

    for (let i = 0; i < 5; i++) {
      const px = startX + i * podSpacing;
      const py = cy;
      const isLit = lightsCount > 0 && (i + 1) <= lightsCount;
      const isLightsOut = lightsCount === -1;

      // Housing rim
      ctx.beginPath();
      ctx.fillStyle = '#06080b';
      ctx.arc(px, py, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#374151';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Light bulb
      ctx.beginPath();
      ctx.arc(px, py, 10, 0, Math.PI * 2);
      if (isLit) {
        ctx.fillStyle = '#FF1801';
        ctx.shadowColor = '#FF1801';
        ctx.shadowBlur = 12;
        ctx.fill();
      } else if (isLightsOut) {
        ctx.fillStyle = '#00E676';
        ctx.shadowColor = '#00E676';
        ctx.shadowBlur = 8;
        ctx.fill();
      } else {
        ctx.fillStyle = '#260808';
        ctx.shadowBlur = 0;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    // Banner underneath gantry
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (lightsCount === -1) {
      ctx.fillStyle = '#00E676';
      ctx.fillText('🟢 LIGHTS OUT AND AWAY WE GO!', cx, cy + gantryH / 2 + 16);
    } else if (lightsCount > 0) {
      ctx.fillStyle = '#FF5252';
      ctx.fillText(`🔴 START ZA CHWILĘ... (${lightsCount}/5)`, cx, cy + gantryH / 2 + 16);
    } else if (state === 'GRID_START') {
      ctx.fillStyle = '#FFD700';
      ctx.fillText('🏎️ USTAWIANIE NA POLACH STARTOWYCH...', cx, cy + gantryH / 2 + 16);
    }

    ctx.restore();
  }

  /**
   * Render Chequered Flag finish banner on winner celebration
   */
  renderChequeredFlagBanner(winnerName: string | null): void {
    const ctx = this.ctx;
    ctx.save();
    const dpr = window.devicePixelRatio || 1;
    const w = this.ctx.canvas.width / dpr;
    const cx = w / 2;
    const cy = 70;
    const bannerW = Math.min(460, w - 40);
    const bannerH = 64;

    ctx.fillStyle = 'rgba(10, 14, 20, 0.94)';
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(cx - bannerW / 2, cy - bannerH / 2, bannerW, bannerH, 8);
    } else {
      ctx.rect(cx - bannerW / 2, cy - bannerH / 2, bannerW, bannerH);
    }
    ctx.fill();
    ctx.stroke();

    ctx.font = 'bold 15px "Titillium Web", sans-serif';
    ctx.fillStyle = '#FFD700';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🏁 KONIEC WYŚCIGU (FLAGA W SZACHOWNICĘ) 🏁', cx, cy - 12);

    ctx.font = 'bold 13px "JetBrains Mono", monospace';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`🏆 ZWYCIĘZCA: ${winnerName || 'P1'}`, cx, cy + 14);

    ctx.restore();
  }
}
