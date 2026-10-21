import { Car } from '../physics/Car';
import { NeuralNetwork } from '../ai/NeuralNetwork';
import { Vector2 } from '../math/Vector2';

/** Sidebar telemetry widgets drawn with Canvas 2D on their own small canvases. */
export class HudCharts {
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
}
