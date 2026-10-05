import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-traffic-'));
try {
 await build({configFile:false,logLevel:'silent',build:{outDir:dir,lib:{entry:{traffic:resolve('src/physics/Traffic.ts'),car:resolve('src/physics/Car.ts'),vector:resolve('src/math/Vector2.ts'),race:resolve('src/ai/RaceTraffic.ts'),presets:resolve('src/track/Presets.ts'),track:resolve('src/track/Track.ts'),network:resolve('src/ai/NeuralNetwork.ts'),population:resolve('src/ai/Population.ts')},formats:['es'],fileName:(_,name)=>name+'.mjs'}}});
 const {Car} = await import(pathToFileURL(join(dir,'car.mjs')));
 const {Vector2} = await import(pathToFileURL(join(dir,'vector.mjs')));
 const {captureMotion,resolveTraffic,avoidTraffic} = await import(pathToFileURL(join(dir,'traffic.mjs')));
 const {planRaceLine,updateRaceSafety} = await import(pathToFileURL(join(dir,'race.mjs')));
 const {Population} = await import(pathToFileURL(join(dir,'population.mjs')));
 const {Track} = await import(pathToFileURL(join(dir,'track.mjs')));
 const {NeuralNetwork} = await import(pathToFileURL(join(dir,'network.mjs')));
 const car=(x,y,v=0)=>{const c=new Car(new Vector2(x,y),0);c.vel=new Vector2(v,0);c.speed=v;c.isRaceMode=true;return c;};
 // A rear-end collision at 100 m/s cannot tunnel through the other body.
 let a=car(0,0,100),b=car(20,0,0),m=captureMotion([a,b]);a.pos=new Vector2(40,0);
 resolveTraffic([a,b],m);assert.equal(a.eliminationReason,'car');assert.equal(b.eliminationReason,'car');assert.ok(b.pos.x-a.pos.x>=5.5);
 // Gentle contact preserves momentum, dissipates kinetic energy, and does not cause DNF.
 a=car(0,0,12);b=car(6,0,10);m=captureMotion([a,b]);a.pos.x=2;b.pos.x=7;
 const energy=a.totalMass*12**2+b.totalMass*10**2;
 resolveTraffic([a,b],m);assert.ok(a.isAlive&&b.isAlive);assert.ok(a.totalMass*a.speed**2+b.totalMass*b.speed**2<=energy);assert.ok(Math.abs(a.speed-b.speed)<1e-8);assert.ok(b.pos.x-a.pos.x>=5.5);
 // Parallel cars may pass without a collision; initial overlaps are separated.
 a=car(0,0,20);b=car(0,3,20);m=captureMotion([a,b]);a.pos.x=10;b.pos.x=10;resolveTraffic([a,b],m);assert.equal(a.recoveryTimer,0);
 a=car(0,0);b=car(0,0);m=captureMotion([a,b]);resolveTraffic([a,b],m);assert.ok(a.pos.dist(b.pos)>=1.8);
 // Crossing trajectories collide even when neither endpoint overlaps.
 a=car(-10,0,30);b=car(0,-10);b.heading=Math.PI/2;b.vel=new Vector2(0,30);m=captureMotion([a,b]);a.pos=new Vector2(10,0);b.pos=new Vector2(0,10);resolveTraffic([a,b],m);assert.equal(a.eliminationReason,'car');
 // Lapped and stopped traffic are obstacles; manual input remains under user control.
 a=car(0,0,30);b=car(12,0,10);b.raceLapsCompleted=3;a.raceLapsCompleted=1;
 let ctrl=avoidTraffic(a,[a,b],{throttle:1,brake:0,steer:0});assert.equal(ctrl.throttle,0);assert.ok(ctrl.brake>0);
 b.pos.y=4;ctrl=avoidTraffic(a,[a,b],{throttle:1,brake:0,steer:0});assert.equal(ctrl.throttle,1);
 b.pos.y=0;b.isAlive=false;b.vel.set(0,0);assert.ok(avoidTraffic(a,[a,b],{throttle:1,brake:0,steer:0}).brake>0);
 a.isManual=true;assert.equal(avoidTraffic(a,[a,b],{throttle:1,brake:0,steer:0}).throttle,1);
 // Long straight fixture permits an actual pass under the production steering/physics.
 const raw = [[0,0],[100,0],[200,0],[300,0],[400,0],[500,0],[600,0],[600,200],[500,200],[400,200],[300,200],[200,200],[100,200],[0,200]].map(p=>new Vector2(...p));
 const points=raw.map((center,i)=>{const tangent=raw[(i+1)%raw.length].sub(raw[(i+raw.length-1)%raw.length]).normalize(),normal=tangent.normal();return {center,tangent,normal,left:center.add(normal.mul(7)),right:center.sub(normal.mul(7)),curvature:[0,6,7,13].includes(i)?.01:0};});
 const circuit=new Track(points,14);
 a=car(150,0,28);b=car(173,0,18);
 a.brain=NeuralNetwork.createTrainedDriverNetwork(25);a.currentCheckpointIdx=2;b.currentCheckpointIdx=2;
 a.mistakesEnabled=false;b.mistakesEnabled=false;
 let passed=false,maxOffset=0;
 for(let step=0;step<1200;step++) {
   updateRaceSafety([a,b],circuit);planRaceLine(a,[a,b],circuit,1/60);
   a.updateSensors(circuit);
   const motion=captureMotion([a,b]);
   a.updatePhysics(avoidTraffic(a,[a,b],a.getAIControl(circuit),circuit),1/60,circuit);
   // Pace car follows the straight at 18 m/s; the attacking car uses actual physics.
   b.prevPos=b.pos.clone();b.pos.x+=18/60;
   resolveTraffic([a,b],motion);
   maxOffset=Math.max(maxOffset,Math.abs(a.pos.y));
   assert.ok(a.isAlive&&b.isAlive,'overtaking caused a collision');
   assert.equal(a.surface,'asphalt','overtaking left the asphalt');
   if(a.pos.x>b.pos.x+12 && Math.abs(a.raceLineOffset)<.05) {passed=true;break;}
 }
 assert.ok(passed,'driver failed to complete an actual pass and return to the racing line');
 assert.ok(maxOffset>2.8,'driver did not use another line');
 // The default training mode must also have physical contact, not ghost cars.
 const training=new Population(2,circuit);
 const [trainingRear,trainingFront]=training.cars;
 for(const c of training.cars) {c.reset(new Vector2(150,0),0,true,2);c.isManual=true;c.manualControl={throttle:0,brake:0,steer:0};}
 trainingFront.pos=new Vector2(156.2,0);trainingRear.vel=new Vector2(60,0);trainingRear.speed=60;
 training.update(1/60,circuit);
 assert.equal(trainingRear.eliminationReason,'car');assert.equal(trainingFront.eliminationReason,'car');
 assert.equal(trainingRear.length,5.5);assert.equal(trainingRear.width,1.8);
 assert.deepEqual(Car.getDimensionsForTrackWidth(14),{length:5.5,width:1.8,effectiveTrackWidth:14});
 // Respawn must wait for an occupied start slot instead of placing a car on another.
 const slot=circuit.getGridSlot(0);
 trainingFront.isAlive=true;trainingFront.pos=slot.pos.clone();trainingFront.vel.set(0,0);trainingFront.speed=0;
 trainingRear.respawnTimer=0;
 training.update(1/60,circuit);
 assert.equal(trainingRear.isAlive,false,'respawn placed a car in an occupied slot');
 // Wrecks produce a local yellow and disappear only after one or two leader laps.
 a=car(150,0,35);b=car(190,0,0);b.isAlive=false;b.eliminationReason='car';
 updateRaceSafety([a,b],circuit);assert.equal(a.yellowFlag,true);assert.ok([1,2].includes(b.wreckClearLap));
 planRaceLine(a,[a,b],circuit,1/60);assert.notEqual(a.raceLineOffset,0,'yellow flag must allow bypassing a wreck');assert.equal(a.overtakingTargetName,'');
 ctrl=avoidTraffic(a,[a,b],{throttle:1,brake:0,steer:0});assert.equal(ctrl.throttle,0);assert.ok(ctrl.brake>0);
 const rival=car(172,3,20);planRaceLine(a,[a,rival,b],circuit,1/60);assert.equal(a.overtakingTargetName,'','live overtaking under yellow');
 const far=car(400,0,20);updateRaceSafety([a,b,far],circuit);assert.equal(far.yellowFlag,false,'yellow must stay local');
 a.raceLapsCompleted=b.wreckClearLap-1;updateRaceSafety([a,b],circuit);assert.equal(b.wreckRemoved,false);
 a.raceLapsCompleted=b.wreckClearLap;updateRaceSafety([a,b],circuit);assert.equal(b.wreckRemoved,true);assert.equal(a.yellowFlag,false);
 const after=avoidTraffic(a,[a,b],{throttle:1,brake:0,steer:0});assert.equal(after.brake,0,'removed wreck remains an obstacle');
 // Both overtaking corridors occupied: wait instead of cutting into another car.
 const waiting=car(150,0,25), slow=car(172,0,18), left=car(160,3.2,18), right=car(160,-3.2,18);
 planRaceLine(waiting,[waiting,slow,left,right],circuit,1/60);
 assert.equal(waiting.raceLineOffset,0);assert.equal(waiting.overtakingTargetName,'');
 // Future lane reservations behind the queue leader cannot deadlock a wreck bypass.
 const queueLeader=car(150,0),follower=car(140,0),queueWreck=car(180,0),occupiedLeft=car(165,-3.2);
 queueLeader.yellowFlag=follower.yellowFlag=true;queueWreck.isAlive=false;
 planRaceLine(follower,[follower,queueWreck],circuit,1/60);
 assert.ok(follower.raceLineOffset>0);
 planRaceLine(queueLeader,[queueLeader,follower,queueWreck,occupiedLeft],circuit,1/60);
 assert.ok(queueLeader.raceLineOffset>0,'rear reservation blocked the only physically free bypass');
 assert.equal(queueLeader.overtakingTargetName,'');
 // A real yellow-flag approach may avoid a wreck, but cannot pass a moving rival.
 const cautious=car(250,0,28), pace=car(270,0,18), wreck=car(400,0);
 cautious.brain=NeuralNetwork.createTrainedDriverNetwork(25);cautious.currentCheckpointIdx=3;cautious.mistakesEnabled=false;
 wreck.isAlive=false;wreck.eliminationReason='car';
 for(let step=0;step<300;step++) {
   updateRaceSafety([cautious,pace,wreck],circuit);assert.equal(cautious.yellowFlag,true);
   planRaceLine(cautious,[cautious,pace,wreck],circuit,1/60);cautious.updateSensors(circuit);
   const motion=captureMotion([cautious,pace,wreck]);
   cautious.updatePhysics(avoidTraffic(cautious,[cautious,pace,wreck],cautious.getAIControl(circuit),circuit),1/60,circuit);
   pace.pos.x+=18/60;resolveTraffic([cautious,pace,wreck],motion);
   assert.ok(cautious.pos.x<pace.pos.x,'moving rival was passed under yellow');
   assert.ok(cautious.isAlive,'yellow approach caused a crash');
 }
 // Waiting behind blocked traffic is not a driver-stagnation DNF.
 const queued=car(150,0),blocked=car(156,0);queued.brain=NeuralNetwork.createTrainedDriverNetwork(25);queued.currentCheckpointIdx=2;queued.framesSinceLastCheckpoint=599;
 for(let step=0;step<120;step++) queued.updatePhysics(avoidTraffic(queued,[queued,blocked],{throttle:1,brake:0,steer:0},circuit),1/60,circuit);
 assert.ok(queued.isAlive);assert.equal(queued.framesSinceLastCheckpoint,599);
 // A removed wreck has neither rendering nor physical collision presence.
 const removed=car(400,0);removed.isAlive=false;removed.wreckRemoved=true;
 const clear=car(380,0,50),clearMotion=captureMotion([clear,removed]);clear.pos.x=420;
 resolveTraffic([clear,removed],clearMotion);assert.ok(clear.isAlive);assert.equal(clear.recoveryTimer,0);
 // Independent SAT check of the rendered rectangles throughout real training.
 const overlap=(first,second)=>{
   const axes=[Vector2.fromAngle(first.heading),Vector2.fromAngle(first.heading).normal(),Vector2.fromAngle(second.heading),Vector2.fromAngle(second.heading).normal()];
   const delta=second.pos.sub(first.pos);
   return axes.every(axis=>{
     const radius=c=>c.length/2*Math.abs(Vector2.fromAngle(c.heading).dot(axis))+c.width/2*Math.abs(Vector2.fromAngle(c.heading).normal().dot(axis));
     return Math.abs(delta.dot(axis)) < radius(first)+radius(second)-.002;
   });
 };
 const {Presets}=await import(pathToFileURL(join(dir,'presets.mjs')));
 const checked=[];
 for(const initialSeed of [145,456,789]) {
   let seed=initialSeed;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
   const gp=Presets.createGrandPrixTrack(14),pop=new Population(10,gp);
   for(let step=0;step<120*60;step++) {
     pop.update(1/60,gp);
     for(let i=0;i<pop.cars.length;i++) for(let j=i+1;j<pop.cars.length;j++) assert.equal(overlap(pop.cars[i],pop.cars[j]),false,`rendered training bodies overlapped at seed ${initialSeed}, step ${step}, pair ${i}/${j}`);
   }
   checked.push({seed:initialSeed,laps:pop.teamRecords.reduce((sum,r)=>sum+r.lapsCount,0)});
 }
 console.log('120-second training runs without overlapping rendered bodies:',JSON.stringify(checked));
 console.log('Race traffic: actual pass completed, lateral separation',maxOffset.toFixed(2),'m; yellow flags and lap-based clearance passed.');
 console.log('Traffic regressions passed: swept rear-end/crossing collisions, light contact, separation, energy, passing and AI braking.');
} finally {await rm(dir,{recursive:true,force:true});}
