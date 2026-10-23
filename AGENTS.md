# AGENTS.md

F1 race simulator with AI drivers: TypeScript, Vite, Three.js. The simulation runs in a Web Worker; the page only renders snapshots. User-facing docs are in Polish (`README.md`, `PHYSICS.md`).

## Commands

- `npm ci` once, then `npm run dev` (Vite dev server).
- `npx tsc --noEmit`, `npm run lint` and `npm test` must pass before every commit. The full suite takes about 1.5 minutes; single suites are `npm run test:<name>` (see `package.json`).
- `npm run bench:step -- 60`: µs per physics step and a state hash per seed. A pure refactor keeps the hashes; anything that changes physics or `random()` consumption changes them.
- `npm run build`: type check plus the production build in `dist/`.

## Layout

- `src/physics/`: `Car.ts` (vehicle dynamics), `DrivePlanner.ts` (rule-based planner and guardian), `LapTiming.ts`, `PitStrategy.ts`, `Fitness.ts`, `Traffic.ts`, `Weather.ts`, `Tyres.ts`, `SimConfig.ts`.
- `src/ai/`: neural networks, the population and its evolution, racing lines, training islands, race tactics.
- `src/race/RaceSession.ts`: qualifying, start, race, chequered flag and classification. It has no worker dependencies, so tests drive it directly.
- `src/workers/`: `sim.worker.ts` (simulation loop and messages), `island.worker.ts`, `CarView.ts` (the snapshot schema of a car).
- `src/ui/`, `src/main.ts`: the page. `SnapshotSync` is the only code that writes worker state into the page's copy of the field.
- `src/rendering/three/`: the Three.js scene.
- `scripts/`: regression tests (each one builds its entry points with Vite into a temp dir and imports them), benchmarks and diagnostics.

## Rules

- Training, qualifying and the race share every physical condition and mechanic. Do not add switches that turn a mechanic off, and do not make physics depend on `isRaceMode`. Behaviour that differs by session (learning, stress laps, race tactics, yellow flags) belongs outside the vehicle physics.
- Physics uses a fixed step (1/60 s by default). New state must integrate the same way at 30, 60 and 120 Hz; existing tests check this.
- Simulation code draws from `random()` in `src/math/Random.ts`, never `Math.random()` directly, so seeded runs replay (rendering effects may use `Math.random()`).
- Code, identifiers and comments are in English. UI strings and the docs are in Polish.
- When physics changes lap times, add a dated note to `PHYSICS.md` and the compatibility paragraph in `README.md`.
