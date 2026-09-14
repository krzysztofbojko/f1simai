export interface NetworkLayer {
  weights: number[][]; // [outputNodes][inputNodes]
  biases: number[];
  activations: number[];
}

export class NeuralNetwork {
  public layerSizes: number[];
  public layers: NetworkLayer[] = [];

  constructor(layerSizes: number[]) {
    this.layerSizes = [...layerSizes];
    this.initLayers();
  }

  private initLayers(): void {
    this.layers = [];
    for (let i = 0; i < this.layerSizes.length - 1; i++) {
      const inputs = this.layerSizes[i];
      const outputs = this.layerSizes[i + 1];

      // Xavier/He weight initialization
      const scale = Math.sqrt(2.0 / inputs);
      const weights: number[][] = [];
      const biases: number[] = [];

      for (let o = 0; o < outputs; o++) {
        const row: number[] = [];
        for (let inp = 0; inp < inputs; inp++) {
          row.push((Math.random() * 2 - 1) * scale);
        }
        weights.push(row);
        biases.push((Math.random() * 2 - 1) * 0.1);
      }

      this.layers.push({
        weights,
        biases,
        activations: new Array(outputs).fill(0),
      });
    }
  }

  forward(inputs: number[]): number[] {
    let current = [...inputs];

    for (let l = 0; l < this.layers.length; l++) {
      const layer = this.layers[l];
      const nextActivations: number[] = [];

      for (let o = 0; o < layer.biases.length; o++) {
        let sum = layer.biases[o];
        const row = layer.weights[o];
        for (let i = 0; i < current.length; i++) {
          sum += current[i] * row[i];
        }

        // Tanh activation for bounded smooth outputs and stable gradients
        nextActivations.push(Math.tanh(sum));
      }

      layer.activations = nextActivations;
      current = nextActivations;
    }

    return current;
  }

  clone(): NeuralNetwork {
    const copy = new NeuralNetwork(this.layerSizes);
    for (let l = 0; l < this.layers.length; l++) {
      for (let o = 0; o < this.layers[l].biases.length; o++) {
        copy.layers[l].biases[o] = this.layers[l].biases[o];
        for (let i = 0; i < this.layers[l].weights[o].length; i++) {
          copy.layers[l].weights[o][i] = this.layers[l].weights[o][i];
        }
      }
    }
    return copy;
  }

  mutate(rate: number = 0.08, strength: number = 0.25): void {
    for (let l = 0; l < this.layers.length; l++) {
      const layer = this.layers[l];
      for (let o = 0; o < layer.biases.length; o++) {
        if (Math.random() < rate) {
          layer.biases[o] += (Math.random() * 2 - 1) * strength;
        }
        for (let i = 0; i < layer.weights[o].length; i++) {
          if (Math.random() < rate) {
            // Gaussian-like perturbation
            const delta = (Math.random() + Math.random() + Math.random() - 1.5) * strength;
            layer.weights[o][i] += delta;
            // Clamp weights to prevent explosion
            layer.weights[o][i] = Math.max(-3.0, Math.min(3.0, layer.weights[o][i]));
          }
        }
      }
    }
  }

  static crossover(parentA: NeuralNetwork, parentB: NeuralNetwork): NeuralNetwork {
    const child = parentA.clone();
    for (let l = 0; l < child.layers.length; l++) {
      const layer = child.layers[l];
      for (let o = 0; o < layer.biases.length; o++) {
        if (Math.random() < 0.5) {
          layer.biases[o] = parentB.layers[l].biases[o];
        }
        for (let i = 0; i < layer.weights[o].length; i++) {
          if (Math.random() < 0.5) {
            layer.weights[o][i] = parentB.layers[l].weights[o][i];
          }
        }
      }
    }
    return child;
  }

  train(inputs: number[], targets: number[], learningRate: number = 0.03): void {
    // 1. Forward pass storing layer activations
    const allActivations: number[][] = [inputs];
    let current = inputs;

    for (let l = 0; l < this.layers.length; l++) {
      const layer = this.layers[l];
      const nextActivations: number[] = [];
      for (let o = 0; o < layer.biases.length; o++) {
        let sum = layer.biases[o];
        const row = layer.weights[o];
        for (let i = 0; i < current.length; i++) {
          sum += current[i] * row[i];
        }
        nextActivations.push(Math.tanh(sum));
      }
      layer.activations = nextActivations;
      allActivations.push(nextActivations);
      current = nextActivations;
    }

    // 2. Backward pass (Backprop)
    const numLayers = this.layers.length;
    const deltas: number[][] = new Array(numLayers);

    // Output layer error
    const outputLayer = this.layers[numLayers - 1];
    const outAct = allActivations[numLayers];
    const outDeltas: number[] = [];
    for (let o = 0; o < outputLayer.biases.length; o++) {
      const err = outAct[o] - (targets[o] !== undefined ? targets[o] : outAct[o]);
      // Derivative of tanh(x) is 1 - tanh(x)^2
      const d = err * (1 - outAct[o] * outAct[o]);
      outDeltas.push(d);
    }
    deltas[numLayers - 1] = outDeltas;

    // Backpropagate to hidden layers
    for (let l = numLayers - 2; l >= 0; l--) {
      const nextLayer = this.layers[l + 1];
      const nextDelta = deltas[l + 1];
      const curAct = allActivations[l + 1];
      const curDeltas: number[] = [];

      for (let i = 0; i < curAct.length; i++) {
        let errSum = 0;
        for (let o = 0; o < nextLayer.biases.length; o++) {
          errSum += nextDelta[o] * nextLayer.weights[o][i];
        }
        curDeltas.push(errSum * (1 - curAct[i] * curAct[i]));
      }
      deltas[l] = curDeltas;
    }

    // 3. Update weights and biases
    for (let l = 0; l < numLayers; l++) {
      const layer = this.layers[l];
      const d = deltas[l];
      const prevAct = allActivations[l];

      for (let o = 0; o < layer.biases.length; o++) {
        layer.biases[o] -= learningRate * d[o];
        for (let i = 0; i < prevAct.length; i++) {
          const grad = d[o] * prevAct[i];
          layer.weights[o][i] -= learningRate * grad;
          // Clamp weights to prevent explosion
          if (layer.weights[o][i] > 3.0) layer.weights[o][i] = 3.0;
          else if (layer.weights[o][i] < -3.0) layer.weights[o][i] = -3.0;
        }
      }
    }
  }

  static createTrainedDriverNetwork(rayCount: number): NeuralNetwork {
    const inputCount = rayCount + 5;
    const net = new NeuralNetwork([inputCount, 18, 14, 3]);

    // Generate diverse synthetic racing scenarios to teach the baseline F1 racing model
    const dataset: { inputs: number[]; targets: number[] }[] = [];
    const midRay = Math.floor(rayCount / 2);

    for (let s = 0; s < 240; s++) {
      const cpAngleDiff = (Math.random() * 2 - 1); // [-1, 1]
      const speedNorm = Math.random(); // [0, 1]
      const angularVel = (Math.random() * 2 - 1) * 0.8;
      const curvature = Math.random(); // [0, 1]
      const overspeed = (Math.random() * 2 - 1); // [-1, 1]

      const rays: number[] = [];
      const leftDist = Math.max(0.05, Math.min(1.0, 0.5 + cpAngleDiff * 0.4 + (Math.random() * 0.3 - 0.15)));
      const rightDist = Math.max(0.05, Math.min(1.0, 0.5 - cpAngleDiff * 0.4 + (Math.random() * 0.3 - 0.15)));

      for (let r = 0; r < rayCount; r++) {
        const ratio = r / Math.max(1, rayCount - 1);
        const interpolated = leftDist * (1 - ratio) + rightDist * ratio;
        rays.push(Math.max(0.05, Math.min(1.0, interpolated + (Math.random() * 0.1 - 0.05))));
      }

      const leftRayAvg = rays.slice(0, midRay).reduce((a, b) => a + b, 0) / Math.max(1, midRay);
      const rightRayAvg = rays.slice(midRay + 1).reduce((a, b) => a + b, 0) / Math.max(1, midRay);
      const wallRepulsion = (rightRayAvg - leftRayAvg) * 0.8;

      // Expert racing target calculations
      const targetSteer = Math.max(-1, Math.min(1, cpAngleDiff * 1.35 + wallRepulsion * 0.65 - angularVel * 0.2));
      const targetThrottle = overspeed > 0.2 || curvature > 0.6 ? 0.0 : 0.75;
      const targetBrake = overspeed > 0.08 ? Math.min(0.85, (overspeed - 0.05) * 1.8) : -0.6;

      const inputs: number[] = [
        ...rays,
        speedNorm,
        angularVel,
        cpAngleDiff,
        curvature,
        overspeed,
      ];

      dataset.push({ inputs, targets: [targetSteer, targetThrottle, targetBrake] });
    }

    // Train network for 30 epochs
    for (let epoch = 0; epoch < 30; epoch++) {
      for (const sample of dataset) {
        net.train(sample.inputs, sample.targets, 0.035);
      }
    }

    return net;
  }

  toJSON(): string {
    return JSON.stringify({
      layerSizes: this.layerSizes,
      layers: this.layers.map(l => ({
        weights: l.weights,
        biases: l.biases
      }))
    });
  }

  fromJSON(jsonStr: string): void {
    const data = JSON.parse(jsonStr);
    this.layerSizes = data.layerSizes;
    this.layers = data.layers.map((l: any) => ({
      weights: l.weights,
      biases: l.biases,
      activations: new Array(l.biases.length).fill(0)
    }));
  }
}
