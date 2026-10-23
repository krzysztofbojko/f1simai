import { random } from '../math/Random';
import { distillDriverNetwork } from './Distill';
import type { Track } from '../track/Track';

export interface NetworkLayer {
  weights: number[][]; // [outputNodes][inputNodes]
  biases: number[];
  activations: number[];
}

export type NetworkTopologyPreset = 'Small' | 'Standard' | 'Deep' | 'Large';

export interface TopologyPresetDef {
  name: NetworkTopologyPreset;
  label: string;
  description: string;
  hiddenLayers: number[];
}

export const TOPOLOGY_PRESETS: Record<NetworkTopologyPreset, TopologyPresetDef> = {
  Small: {
    name: 'Small',
    label: 'Mała (Szybka ewolucja)',
    description: '2 warstwy ukryte [12, 8]. Zredukowana przestrzeń parametrów, wysoka zbieżność algorytmu genetycznego.',
    hiddenLayers: [12, 8],
  },
  Standard: {
    name: 'Standard',
    label: 'Standardowa (Domyślny F1)',
    description: '2 warstwy ukryte [18, 14]. Zbalansowana topologia referencyjna bolidów.',
    hiddenLayers: [18, 14],
  },
  Deep: {
    name: 'Deep',
    label: 'Głęboka (Hierarchiczna)',
    description: '3 warstwy ukryte [24, 18, 12]. Wielopoziomowa ekstrakcja cech trajektorii i sekwencji zakrętów.',
    hiddenLayers: [24, 18, 12],
  },
  Large: {
    name: 'Large',
    label: 'Duża (Wysoka pojemność)',
    description: '3 warstwy ukryte [32, 24, 16]. Zwiększona ekspresyjność i pojemność modelowania dla złożonych torów.',
    hiddenLayers: [32, 24, 16],
  },
};

export type TopologySpecifier =
  | NetworkTopologyPreset
  | number[]
  | TopologyPresetDef
  | { hiddenLayers: number[] }
  | { layerSizes: number[] };

export class NeuralNetwork {
  public layerSizes: number[];
  public layers: NetworkLayer[] = [];
  public lastInputs: number[] = [];

  constructor(layerSizes: number[] = [30, 18, 14, 3]) {
    const validated = NeuralNetwork.validateLayerSizes(layerSizes);
    this.layerSizes = [...validated.normalized];
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
          row.push((random() * 2 - 1) * scale);
        }
        weights.push(row);
        biases.push((random() * 2 - 1) * 0.1);
      }

      this.layers.push({
        weights,
        biases,
        activations: new Array(outputs).fill(0),
      });
    }
  }

  /**
   * Network outputs for `inputs`. Inputs and every layer's activations are written into buffers
   * the network keeps, so a step allocates nothing: the returned array is the output layer's
   * activations and is overwritten by the next call (read it, or copy it to keep it).
   */
  forward(inputs: number[]): number[] {
    const last = this.lastInputs;
    if (last !== inputs) {
      last.length = inputs.length;
      for (let i = 0; i < inputs.length; i++) last[i] = inputs[i];
    }
    let current = last;

    for (let l = 0; l < this.layers.length; l++) {
      const layer = this.layers[l];
      const outputs = layer.biases.length;
      let next = layer.activations;
      if (next === current || next.length !== outputs) next = layer.activations = new Array(outputs).fill(0);

      for (let o = 0; o < outputs; o++) {
        let sum = layer.biases[o];
        const row = layer.weights[o];
        for (let i = 0; i < current.length; i++) {
          sum += current[i] * row[i];
        }

        // Tanh activation for bounded smooth outputs and stable gradients
        next[o] = Math.tanh(sum);
      }

      current = next;
    }

    return current;
  }

  /** An independent copy. Built without the constructor, so no weights are drawn only to be overwritten. */
  clone(): NeuralNetwork {
    const copy: NeuralNetwork = Object.create(NeuralNetwork.prototype);
    copy.layerSizes = [...this.layerSizes];
    copy.lastInputs = [...this.lastInputs];
    copy.layers = this.layers.map(layer => ({
      weights: layer.weights.map(row => row.slice()),
      biases: layer.biases.slice(),
      activations: layer.activations.slice(),
    }));
    return copy;
  }

  mutate(rate: number = 0.08, strength: number = 0.25): void {
    for (let l = 0; l < this.layers.length; l++) {
      const layer = this.layers[l];
      for (let o = 0; o < layer.biases.length; o++) {
        if (random() < rate) {
          layer.biases[o] += (random() * 2 - 1) * strength;
        }
        for (let i = 0; i < layer.weights[o].length; i++) {
          if (random() < rate) {
            // Gaussian-like perturbation
            const delta = (random() + random() + random() - 1.5) * strength;
            layer.weights[o][i] += delta;
            // Clamp weights to prevent explosion
            layer.weights[o][i] = Math.max(-3.0, Math.min(3.0, layer.weights[o][i]));
          }
        }
      }
    }
  }

  hasSameTopology(other: NeuralNetwork): boolean {
    if (!other || !Array.isArray(other.layerSizes)) return false;
    if (this.layerSizes.length !== other.layerSizes.length) return false;
    for (let i = 0; i < this.layerSizes.length; i++) {
      if (this.layerSizes[i] !== other.layerSizes[i]) return false;
    }
    return true;
  }

  get topologyName(): NetworkTopologyPreset | 'Custom' {
    const hidden = this.layerSizes.slice(1, -1);
    for (const preset of Object.values(TOPOLOGY_PRESETS)) {
      if (
        preset.hiddenLayers.length === hidden.length &&
        preset.hiddenLayers.every((val, idx) => val === hidden[idx])
      ) {
        return preset.name;
      }
    }
    return 'Custom';
  }

  get parameterCount(): number {
    let count = 0;
    for (const layer of this.layers) {
      count += layer.biases.length;
      for (const row of layer.weights) {
        count += row.length;
      }
    }
    return count;
  }

  static getAvailablePresets(): TopologyPresetDef[] {
    return Object.values(TOPOLOGY_PRESETS);
  }

  static getPreset(presetName: NetworkTopologyPreset): TopologyPresetDef {
    return TOPOLOGY_PRESETS[presetName] || TOPOLOGY_PRESETS.Standard;
  }

  static getPresetNames(): NetworkTopologyPreset[] {
    return Object.keys(TOPOLOGY_PRESETS) as NetworkTopologyPreset[];
  }

  static validateLayerSizes(
    layerSizes: number[],
    expectedInputCount?: number,
    expectedOutputCount: number = 3
  ): { valid: boolean; error?: string; normalized: number[] } {
    if (!Array.isArray(layerSizes) || layerSizes.length < 2) {
      const fallback = [expectedInputCount || 30, 18, 14, expectedOutputCount];
      return { valid: false, error: 'layerSizes must have at least 2 layers', normalized: fallback };
    }

    const normalized = layerSizes.map((s, idx) => {
      const val = Math.round(Number(s));
      if (!Number.isFinite(val) || val <= 0) {
        return idx === 0 ? (expectedInputCount || 30) : (idx === layerSizes.length - 1 ? expectedOutputCount : 16);
      }
      return Math.min(256, Math.max(1, val));
    });

    if (expectedInputCount !== undefined && normalized[0] !== expectedInputCount) {
      normalized[0] = expectedInputCount;
    }

    if (expectedOutputCount !== undefined && normalized[normalized.length - 1] !== expectedOutputCount) {
      normalized[normalized.length - 1] = expectedOutputCount;
    }

    return { valid: true, normalized };
  }

  static resolveLayerSizes(
    inputCount: number,
    topology?: TopologySpecifier,
    outputCount: number = 3
  ): number[] {
    const defaultHidden = TOPOLOGY_PRESETS.Standard.hiddenLayers;

    if (!topology) {
      return [inputCount, ...defaultHidden, outputCount];
    }

    if (typeof topology === 'string') {
      const preset = TOPOLOGY_PRESETS[topology as NetworkTopologyPreset];
      const hidden = preset ? preset.hiddenLayers : defaultHidden;
      return [inputCount, ...hidden, outputCount];
    }

    if (Array.isArray(topology)) {
      if (
        topology.length >= 3 &&
        topology[0] === inputCount &&
        topology[topology.length - 1] === outputCount
      ) {
        return NeuralNetwork.validateLayerSizes(topology, inputCount, outputCount).normalized;
      }
      // Treat as hidden layers array
      const hidden = topology.map(h => Math.max(2, Math.min(128, Math.round(Number(h) || 14))));
      const validHidden = hidden.length > 0 ? hidden.slice(0, 6) : defaultHidden;
      return [inputCount, ...validHidden, outputCount];
    }

    if (typeof topology === 'object' && topology !== null) {
      if ('layerSizes' in topology && Array.isArray((topology as any).layerSizes)) {
        return NeuralNetwork.resolveLayerSizes(inputCount, (topology as any).layerSizes, outputCount);
      }
      if ('hiddenLayers' in topology && Array.isArray((topology as any).hiddenLayers)) {
        return NeuralNetwork.resolveLayerSizes(inputCount, (topology as any).hiddenLayers, outputCount);
      }
      if ('name' in topology && typeof (topology as any).name === 'string') {
        return NeuralNetwork.resolveLayerSizes(inputCount, (topology as any).name, outputCount);
      }
    }

    return [inputCount, ...defaultHidden, outputCount];
  }

  static crossover(parentA: NeuralNetwork, parentB: NeuralNetwork): NeuralNetwork {
    const child = parentA.clone();
    // Safety check: ensure identical layer architecture before crossing over weights
    if (!parentA.hasSameTopology(parentB)) {
      return child;
    }

    for (let l = 0; l < child.layers.length; l++) {
      const layer = child.layers[l];
      const parentBLayer = parentB.layers[l];
      for (let o = 0; o < layer.biases.length; o++) {
        if (random() < 0.5) {
          layer.biases[o] = parentBLayer.biases[o];
        }
        for (let i = 0; i < layer.weights[o].length; i++) {
          if (random() < 0.5) {
            layer.weights[o][i] = parentBLayer.weights[o][i];
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

  /** Driver network distilled from the rule-based expert on a real circuit. */
  static createTrainedDriverNetwork(
    rayCount: number,
    topology: TopologySpecifier = 'Standard',
    track?: Track
  ): NeuralNetwork {
    return distillDriverNetwork(rayCount, topology, track);
  }

  toJSON(): string {
    return JSON.stringify({
      layerSizes: this.layerSizes,
      topologyPreset: this.topologyName,
      parameterCount: this.parameterCount,
      lastInputs: this.lastInputs,
      layers: this.layers.map(l => ({
        weights: l.weights,
        biases: l.biases,
        activations: l.activations || []
      }))
    });
  }

  fromJSON(jsonOrData: string | { layerSizes: number[]; layers: any[]; topologyPreset?: string; lastInputs?: number[] }): void {
    const data: any = typeof jsonOrData === 'string' ? JSON.parse(jsonOrData) : jsonOrData;
    if (!data || !Array.isArray(data.layerSizes) || !Array.isArray(data.layers)) {
      throw new Error('Invalid NeuralNetwork JSON structure');
    }
    const validated = NeuralNetwork.validateLayerSizes(data.layerSizes);
    this.layerSizes = [...validated.normalized];
    this.lastInputs = Array.isArray(data.lastInputs) ? data.lastInputs : [];
    this.layers = data.layers.map((l: any) => ({
      weights: l.weights.map((row: any[]) => row.map(Number)),
      biases: l.biases.map(Number),
      activations: Array.isArray(l.activations) ? l.activations : new Array(l.biases.length).fill(0)
    }));
  }

  static fromJSON(jsonOrData: string | object): NeuralNetwork {
    const data: any = typeof jsonOrData === 'string' ? JSON.parse(jsonOrData) : jsonOrData;
    if (!data || !Array.isArray(data.layerSizes)) {
      throw new Error('Invalid NeuralNetwork JSON structure');
    }
    const validated = NeuralNetwork.validateLayerSizes(data.layerSizes);
    const net = new NeuralNetwork(validated.normalized);
    net.fromJSON(data);
    return net;
  }
}
