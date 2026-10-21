/**
 * Race overlays in HTML over the 3D view: the five start lights with their caption, the
 * chequered-flag banner and the map scale.
 */
export class RaceHud {
  private readonly lights: HTMLElement;
  private readonly pods: HTMLElement[] = [];
  private readonly caption: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly winner: HTMLElement;
  private readonly scale: HTMLElement;
  private key = '';

  constructor(root: HTMLElement) {
    this.lights = document.createElement('div');
    this.lights.className = 'start-lights';
    const gantry = document.createElement('div');
    gantry.className = 'start-gantry';
    for (let i = 0; i < 5; i++) {
      const pod = document.createElement('span');
      pod.className = 'start-pod';
      gantry.appendChild(pod);
      this.pods.push(pod);
    }
    this.caption = document.createElement('div');
    this.caption.className = 'start-caption';
    this.lights.append(gantry, this.caption);

    this.banner = document.createElement('div');
    this.banner.className = 'finish-banner';
    const title = document.createElement('strong');
    title.textContent = '🏁 KONIEC WYŚCIGU (FLAGA W SZACHOWNICĘ) 🏁';
    this.winner = document.createElement('span');
    this.banner.append(title, this.winner);

    this.scale = document.createElement('div');
    this.scale.className = 'map-scale';
    root.append(this.lights, this.banner, this.scale);
    this.update('IDLE', 0, null, false, null);
  }

  update(state: string, lights: number, winner: string | null, drawMode: boolean, pixelsPerMetre: number | null): void {
    const scale = pixelsPerMetre ? (50 / pixelsPerMetre).toFixed(1) : '';
    const key = `${state}|${lights}|${winner}|${drawMode}|${scale}`;
    if (key === this.key) return;
    this.key = key;

    const showLights = !drawMode && (state === 'GRID_START' || lights !== 0);
    this.lights.hidden = !showLights;
    if (showLights) {
      this.pods.forEach((pod, i) => {
        pod.classList.toggle('lit', lights > 0 && i + 1 <= lights);
        pod.classList.toggle('go', lights === -1);
      });
      this.caption.className = `start-caption ${lights === -1 ? 'go' : lights > 0 ? 'lit' : 'grid'}`;
      this.caption.textContent = lights === -1 ? '🟢 LIGHTS OUT AND AWAY WE GO!'
        : lights > 0 ? `🔴 START ZA CHWILĘ... (${lights}/5)` : '🏎️ USTAWIANIE NA POLACH STARTOWYCH...';
    }

    this.banner.hidden = drawMode || state !== 'FINISHED';
    this.winner.textContent = `🏆 ZWYCIĘZCA: ${winner || 'P1'}`;

    this.scale.hidden = !pixelsPerMetre;
    this.scale.textContent = `📏 50 px = ${scale} METRÓW`;
  }
}
