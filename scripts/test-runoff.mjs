import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-runoff-'));
try {
  const entries = { car: 'physics/Car', track: 'track/Track', presets: 'track/Presets', vector: 'math/Vector2', spline: 'math/Spline', population: 'ai/Population', mistakes: 'ai/DriverMistakes', network: 'ai/NeuralNetwork', battle: 'ai/BattlePush' };
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: Object.fromEntries(Object.entries(entries).map(([key, path]) => [key, resolve('src/' + path + '.ts')])), formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const modules = Object.fromEntries(await Promise.all(Object.keys(entries).map(async key => [key, await import(pathToFileURL(join(output, key + '.mjs')))])));
  const { Car } = modules.car, { Track } = modules.track, { Presets } = modules.presets, { Vector2, segmentsIntersect } = modules.vector;
  const { Spline } = modules.spline, { Population } = modules.population, { DriverMistakes } = modules.mistakes, { NeuralNetwork } = modules.network;
  const seeded = seed => () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const { BattlePush } = modules.battle;
  const push = new BattlePush(() => 0);
  push.step(1 / 60, 'Rywal', false);
  assert.equal(push.remaining, 0, 'training/manual/recovery must not trigger attacks');
  push.step(1 / 60, null, true);
  assert.equal(push.remaining, 0, 'no rival means no attack');
  push.step(1 / 60, 'Rywal', true);
  assert.equal(push.remaining, 3);
  assert.equal(push.opponent, 'Rywal');
  push.step(.1, null, true);
  assert.equal(push.remaining, 0, 'losing the rival cancels the attack');
  push.step(.1, 'Rywal', true);
  assert.equal(push.remaining, 0, 'cooldown prevents immediate repeat');
  push.reset();
  push.step(.1, 'Rywal', true);
  push.step(.1, 'Rywal', false);
  assert.equal(push.remaining, 0, 'loss of control cancels the attack');
  const rates = [30, 60, 120].map(hz => {
    const controller = new BattlePush(seeded(71));
    for (let t = 0; t < 6000 * hz; t++) controller.step(1 / hz, 'Rywal', true);
    return controller.count;
  });
  assert.ok(Math.max(...rates) - Math.min(...rates) < 25, 'attack timing must use simulation seconds');
  console.log('Battle push: eligibility, cancellation, cooldown and step independence:', rates);
  Math.random = seeded(54321);
  const gp = Presets.createGrandPrixTrack(14);
  const raw = [[0,0],[100,0],[200,0],[300,0],[400,0],[500,0],[500,200],[400,200],[300,200],[200,200],[100,200],[0,200]].map(p => new Vector2(...p));
  const points = raw.map((center, i) => {
    const tangent = raw[(i + 1) % raw.length].sub(raw[(i + raw.length - 1) % raw.length]).normalize(), normal = tangent.normal();
    return { center, tangent, normal, left: center.add(normal.mul(7)), right: center.sub(normal.mul(7)), curvature: [0,5,6,11].includes(i) ? 0.01 : 0 };
  });
  const track = new Track(points, 14);
  // Exact 3.5 m runoff on a long straight, outside corners enlarged.
  const straight = gp.runoff.filter((r, i) => Math.abs(gp.points[i].curvature) < 0.0001 && Math.max(r.leftWidth, r.rightWidth) < 4);
  assert.ok(straight.length > 0);
  assert.ok(straight.every(r => Math.abs(r.leftWidth - 3.5) < 1e-8 && Math.abs(r.rightWidth - 3.5) < 1e-8));
  assert.ok(gp.runoff.some((r, i) => gp.points[i].curvature > 0.004 && r.rightWidth >= 14 && r.rightWidth > r.leftWidth));
  for (const r of gp.runoff) assert.ok(r.leftWidth > 0 && r.rightWidth > 0 && Math.max(r.leftWidth, r.rightWidth) <= 56);
  for (const segment of gp.barrierSegments) for (const road of [...gp.leftSegments, ...gp.rightSegments]) {
    assert.equal(segmentsIntersect(segment.p1, segment.p2, road.p1, road.p2), false, 'fence crosses asphalt');
  }
  assert.throws(()=>Spline.generateClosedTrack([new Vector2(Infinity,0),new Vector2(200,0),new Vector2(200,200),new Vector2(0,200)],14),/współrzędne/);
  assert.throws(() => new Track(Spline.generateClosedTrack([[0,0],[200,200],[0,200],[200,0]].map(p => new Vector2(...p)),14,18),14), /przecina/);
  const closeRaw = [[0,0],[400,0],[400,80],[80,80],[80,160],[400,160],[400,300],[0,300]].map(p => new Vector2(...p));
  const closeTrack = new Track(Spline.generateClosedTrack(closeRaw,14,18),14);
  for (const fence of closeTrack.barrierSegments) for (const road of [...closeTrack.leftSegments,...closeTrack.rightSegments]) {
    assert.equal(segmentsIntersect(fence.p1,fence.p2,road.p1,road.p2),false,'tight-layout fence crosses asphalt');
  }
  assert.ok(closeTrack.runoff.some(r=>r.leftWidth<r.requestedLeftWidth || r.rightWidth<r.requestedRightWidth),'nearby road must limit corner runoff');
  const maxJump=Math.max(...gp.runoff.map((r,i)=>Math.max(Math.abs(r.leftWidth-gp.runoff[(i+1)%gp.runoff.length].leftWidth),Math.abs(r.rightWidth-gp.runoff[(i+1)%gp.runoff.length].rightWidth))));
  assert.ok(maxJump<14,'runoff width must change smoothly');
  assert.equal(track.sampleSurface(new Vector2(150,0)).surface, 'asphalt');
  // Pick a straight without nearby corners influencing runoff.
  const p = new Vector2(250,0), r = track.runoff[2];
  assert.equal(track.sampleSurface(new Vector2(250,7.4)).surface, 'grass');
  assert.equal(track.sampleSurface(new Vector2(250,9.3)).surface, 'gravel');
  const idle = { throttle:0, brake:0, steer:0 };
  const make = (y=0, vx=0, vy=0) => {
    const c = new Car(new Vector2(p.x,y),0);
    c.vel.set(vx,vy); c.speed=c.vel.mag(); c.speedKmh=c.speed*3.6;
    c.lapGripFactor=c.lapPowerFactor=c.lapDragFactor=1; c.currentCheckpointIdx=3; c.mistakesEnabled=false;
    return c;
  };
  const partial=make(6.8,20); partial.updatePhysics(idle,1/60,track);
  assert.equal(partial.isAlive,true); assert.equal(partial.surfaceFractions.asphalt,0.5); assert.equal(partial.surfaceFractions.grass,0.5);
  const asphalt=make(0,30), gravel=make(9.3,30);
  asphalt.updatePhysics(idle,1/60,track); gravel.updatePhysics(idle,1/60,track);
  assert.equal(gravel.surfaceFractions.gravel,1);
  assert.ok(asphalt.speed-gravel.speed > 0.3*Car.GRAVITY/60);
  assert.equal(gravel.isAlive,true); assert.equal(gravel.lapCompromised,true);
  // Stop on soil without reversing or creating kinetic energy.
  const creeping=make(9.3,0.01);
  for(let i=0;i<120;i++) { const before=creeping.speed; creeping.updatePhysics({...idle,brake:1},1/60,track); assert.ok(creeping.vel.x>=-1e-9); assert.ok(creeping.speed<=before+1e-9); }
  const slide=make(9.3,0,-1); slide.updatePhysics(idle,1/60,track); assert.ok(slide.speed<1); assert.ok(slide.vel.y<=0);
  // First body contact with fence, not a road-edge contact.
  const fence=track.runoff[2].leftBarrier.y;
  const gentle=make(fence-0.95,35,5); gentle.updatePhysics(idle,1/60,track);
  assert.equal(gentle.isAlive,true); assert.ok(gentle.barrierImpactSpeed>0 && gentle.barrierImpactSpeed<12); assert.ok(gentle.vel.y<=0.001);
  const severe=make(fence-0.95,35,30); severe.updatePhysics(idle,1/60,track);
  assert.equal(severe.isAlive,false); assert.equal(severe.eliminationReason,'barrier'); assert.ok(severe.barrierImpactSpeed>=12);
  const tunnel=make(0,0,150); tunnel.updatePhysics(idle,0.2,track);
  assert.equal(tunnel.isAlive,false); assert.equal(tunnel.eliminationReason,'barrier'); assert.ok(tunnel.pos.y<fence);
  const swept=track.sweepBarrier(new Vector2(250,0),new Vector2(250,100),0,0);
  assert.ok(swept && swept.fraction<0.2);
  // Recover on asphalt with the normal geometric driver, no artificial position changes.
  const recovery=make(9.3,5); recovery.brain=NeuralNetwork.createTrainedDriverNetwork(25); recovery.recoveryTimer=2;
  let returned=false;
  for(let i=0;i<600 && recovery.isAlive;i++) {
    recovery.updateSensors(track); const control=recovery.getAIControl(track,[],true);
    recovery.updatePhysics(control,1/60,track);
    if(recovery.surfaceFractions.asphalt===1) { returned=true; break; }
  }
  assert.ok(returned,'AI did not recover onto asphalt'); assert.equal(recovery.replayBuffer.length,0);
  const duel = new Population(2, gp);
  duel.isRaceMode = true;
  const [attacker, rival] = duel.cars;
  const gate = gp.checkpoints[10];
  for (const car of duel.cars) {
    car.reset(gate.center, gate.tangent.heading(), true, 10);
    car.vel = gate.tangent.mul(25);
    car.speed = 25;
    car.mistakesEnabled = false;
    car.battlePush = new BattlePush(() => 0);
  }
  rival.pos = attacker.pos.add(gate.tangent.mul(10));
  duel.update(1/60, gp);
  assert.equal(attacker.battleOpponent, rival.driverName, 'nearby opponent must trigger a race attack');
  assert.equal(attacker.lapCompromised, true, 'tactical lap must not replace baseline PB');
  assert.equal(attacker.replayBuffer.length, 0, 'attack controls must not train the network');
  let laterBraking = false;
  for (let idx = 0; idx < gp.checkpoints.length && !laterBraking; idx += 3) {
    const cp = gp.checkpoints[idx];
    attacker.reset(cp.center, cp.tangent.heading(), true, idx);
    attacker.updateSensors(gp);
    for (let speed = 15; speed < 70 && !laterBraking; speed += .5) {
      attacker.speed = speed;
      attacker.battlePush.remaining = 0;
      const baseline = attacker.getAIControl(gp);
      attacker.battlePush.remaining = 3;
      const attack = attacker.getAIControl(gp);
      laterBraking = baseline.brake > .6 && attack.brake === 0 && attack.throttle > 0;
    }
  }
  assert.ok(laterBraking, 'attack must produce genuinely later braking, not just a telemetry label');
  duel.isRaceMode = false;
  duel.update(1/60, gp);
  assert.equal(attacker.battleOpponent, '', 'training must never attack');
  const population=new Population(1,gp); const champion=population.cars[0];
  const event={lapTime:60,trajectory:[],maxSpeed:300,avgSpeed:180,fuelRemaining:100};
  population.recordLap(event,champion,false,gp);
  const saved=JSON.stringify(population.teamRecords[0].bestBrain.layers.map(l=>l.weights));
  champion.brain.layers[0].weights[0][0]+=10;
  population.recordLap({...event,compromised:true,lapTime:40},champion,false,gp);
  assert.equal(population.teamRecords[0].bestLapTime,60); assert.equal(population.globalBestLap,60);
  assert.equal(JSON.stringify(population.teamRecords[0].bestBrain.layers.map(l=>l.weights)),saved);
  const active=champion.brain;
  population.recordLap({...event,compromised:true,lapTime:90},champion,false,gp);
  assert.equal(champion.brain,active,'a random incident triggered model rollback');
  // Every expected checkpoint is required: jumping behind a later gate cannot clear it.
  const shortcut=make(0,30); shortcut.currentCheckpointIdx=2;
  shortcut.pos.set(350,0); shortcut.prevPos.set(250,0);
  shortcut.updatePhysics(idle,1/60,track); assert.equal(shortcut.currentCheckpointIdx,2);
  const dtA=1/60, dtB=1/30;
  assert.ok(Math.abs((1-DriverMistakes.probability(1,dtA))**2-(1-DriverMistakes.probability(1,dtB)))<1e-12);
  assert.equal(DriverMistakes.probability(0,1),0);
  const counts=[];
  for(const dt of [1/30,1/60,1/120]) {
    let count=0;
    for(let seed=1;seed<=16;seed++) {
      const mistakes=new DriverMistakes(seeded(seed));
      for(let time=0;time<12000;time+=dt) mistakes.step({steer:0.1,throttle:0.5,brake:0.2},dt,1,true);
      count+=mistakes.count;
    }
    counts.push(count);
    assert.ok(count>240 && count<370,`unexpected simulated-time rate: ${count}`);
  }
  const finish=gp.checkpoints[0];
  const dirtyCar=new Car(finish.center.sub(finish.tangent.mul(0.1)),finish.tangent.heading(),NeuralNetwork.createTrainedDriverNetwork(25));
  dirtyCar.mistakesEnabled=false; dirtyCar.vel=finish.tangent.mul(10); dirtyCar.speed=10;
  dirtyCar.currentCheckpointIdx=0; dirtyCar.checkpointsCleared=gp.checkpoints.length-1;
  dirtyCar.lapCompromised=true; dirtyCar.lapTime=60; dirtyCar.bestLapTime=65;
  const dirtyFinish=dirtyCar.updatePhysics(idle,1/60,gp);
  assert.ok(dirtyFinish?.compromised); assert.equal(dirtyCar.bestLapTime,65); assert.equal(dirtyCar.raceLapsCompleted,1);
  const forced=make(0,30); forced.brain=NeuralNetwork.createTrainedDriverNetwork(25); forced.mistakesEnabled=true; forced.tireUtilization=1; forced.mistakes=new DriverMistakes(()=>0);
  const weights=JSON.stringify(forced.brain.layers.map(l=>l.weights));
  forced.updatePhysics({...idle,brake:0.5},1/60,track);
  assert.equal(forced.incidentActive,true); assert.equal(forced.lapCompromised,true); assert.equal(JSON.stringify(forced.brain.layers.map(l=>l.weights)),weights);
  const manual=make(0,30); manual.brain=NeuralNetwork.createTrainedDriverNetwork(25); manual.isManual=true; manual.mistakesEnabled=true; manual.tireUtilization=1; manual.mistakes=new DriverMistakes(()=>0);
  manual.updatePhysics(idle,1/60,track); assert.equal(manual.mistakes.count,0);
  const disabled=new DriverMistakes(()=>0);
  for(let i=0;i<100;i++) disabled.step(idle,1/60,1,false);
  assert.equal(disabled.count,0);
  const trigger=new DriverMistakes(()=>0); const result=trigger.step({...idle,brake:0.5},1/60,1,true);
  assert.equal(result.affected,true); assert.ok(trigger.remaining>=0.18 && trigger.remaining<=0.6); assert.equal(trigger.cooldown,30);
  // Actual driver/physics/population loop, with different stochastic runs.
  const integrations=[];
  for(const seed of [145,456,789]) {
    Math.random=seeded(seed);
    const pop=new Population(10,gp);
    let errors=0, offRoadFrames=0, previousCounts=pop.cars.map(c=>c.mistakes.count);
    for(let step=0;step<600*60;step++) {
      pop.update(1/60,gp);
      pop.cars.forEach((c,i)=> {
        errors+=Math.max(0,c.mistakes.count-previousCounts[i]); previousCounts[i]=c.mistakes.count;
        if(c.surface!=='asphalt') offRoadFrames++;
        assert.ok(Number.isFinite(c.pos.x+c.pos.y+c.speed),'non-finite vehicle state');
      });
    }
    const laps=pop.teamRecords.reduce((sum,r)=>sum+r.lapsCount,0);
    assert.ok(laps>=50,'normal learning/racing no longer completes laps');
    integrations.push({seed,laps,errors,offRoadFrames});
  }
  console.log('600-second real training runs:',JSON.stringify(integrations));
  console.log('Runoff regressions passed (geometry, surfaces, soil forces, swept fences, recovery, PB protection, checkpoints).');
  console.log('Mistake counts over 16 × 12000 simulated seconds at 30/60/120 Hz:',counts.join('/'));
} finally { await rm(output,{recursive:true,force:true}); }
