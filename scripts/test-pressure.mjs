import {build} from 'vite';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=await mkdtemp(join(tmpdir(),'f1-pressure-'));
const originalRandom=Math.random;
const seeded=seed=>()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
try {
 await build({configFile:false,logLevel:'silent',build:{outDir:dir,lib:{entry:Object.fromEntries(Object.entries({population:'ai/Population',presets:'track/Presets',pressure:'ai/DriverPressure',mistakes:'ai/DriverMistakes',battle:'ai/BattlePush'}).map(([name,file])=>[name,resolve(`src/${file}.ts`)])),formats:['es'],fileName:(_,name)=>name+'.mjs'}}});
 const {Population}=await import(pathToFileURL(join(dir,'population.mjs')));
 const {Presets}=await import(pathToFileURL(join(dir,'presets.mjs')));
 const {pressureProfile,normalizePressure}=await import(pathToFileURL(join(dir,'pressure.mjs')));
 const {DriverMistakes}=await import(pathToFileURL(join(dir,'mistakes.mjs')));
 const {BattlePush}=await import(pathToFileURL(join(dir,'battle.mjs')));
 assert.equal(normalizePressure(NaN),0);assert.equal(normalizePressure(100),10);assert.equal(normalizePressure(-100),-10);
 for(const p of [-10,0,10]) assert.ok(pressureProfile(p).cornerGrip>0);
 assert.deepEqual(pressureProfile(0),{cornerGrip:.45,braking:1,coastMargin:.15,brakeFloor:.65,attacks:1,mistakes:1});
 const track=Presets.createGrandPrixTrack(14);
 // Identical positions/speeds/brain: positive pressure changes the actual AI brake policy.
 const probe=new Population(1,track).cars[0],policies=[];
 probe.brakingAggression=1.2;
 for(const p of [0,10]) {
   probe.setDriverPressure(p,true);
   let braking=0,coasting=0,throttle=0;
   for(const point of track.points) {
     probe.pos=point.center.clone();probe.heading=point.tangent.heading();
     probe.vel=point.tangent.mul(60);probe.speed=60;probe.speedKmh=216;probe.raceLineOffset=0;
     let nearest=0,distance=Infinity;
     track.checkpoints.forEach((cp,i)=>{const d=cp.center.dist(probe.pos);if(d<distance){distance=d;nearest=i;}});
     probe.currentCheckpointIdx=(nearest+1)%track.checkpoints.length;
     probe.updateSensors(track);
     const control=probe.getAIControl(track);
     throttle+=control.throttle;braking+=control.brake;if(control.brake===0&&control.throttle===0)coasting++;
   }
   policies.push({pressure:p,braking,coasting,throttle});
 }
 assert.ok(policies[1].braking<policies[0].braking,'actual controller must brake less at +10');
 assert.ok(policies[1].throttle>policies[0].throttle,'actual controller must retain more throttle at +10');
 console.log('Identical-state AI brake comparison:',policies);
 const pop=new Population(1,track),car=pop.cars[0],identity=car,brain=car.brain;
 const originalLine=car.lineSearch;originalLine.finish(80,true);
 pop.setDriverPressure(10);
 assert.equal(car,identity);assert.equal(car.brain,brain);assert.ok(car.pressureLearningBlocked);
 car.advanceDriverPressure(1);assert.equal(car.effectiveDriverPressure,5);
 car.advanceDriverPressure(1);assert.equal(car.effectiveDriverPressure,10);
 assert.notEqual(car.lineSearch,originalLine);
 const highLine=car.lineSearch;
 const event={lapTime:60,trajectory:[],maxSpeed:300,avgSpeed:180,fuelRemaining:90,pressure:10};
 pop.recordLap(event,car,false,track);
 assert.equal(pop.teamRecords[0].bestLapTime,null);assert.equal(highLine.times.flat().length,0);
 car.pressureLearningBlocked=false;car.lapCompromised=false;
 pop.recordLap(event,car,false,track);
 assert.equal(pop.teamRecords[0].bestLapPressure,10);assert.equal(highLine.times.flat().length,1);
 pop.setDriverPressure(0);assert.equal(car.lineSearch,originalLine);
 pop.setDriverPressure(10);assert.equal(car.lineSearch,highLine);
 pop.setDriverPressure(0,true);car.pressureLearningBlocked=false;
 car.brain.layers[0].weights[0][0]=12345;
 pop.recordLap({...event,lapTime:100,pressure:0},car,false,track);
 assert.equal(car.brain.layers[0].weights[0][0],12345,'different pressure must not trigger rollback');
 pop.setDriverPressure(-10);car.advanceDriverPressure(2);
 const savedLine=car.lineSearch;
 car.reset(car.pos.clone(),car.heading,true);assert.equal(car.driverPressure,-10);assert.equal(car.lineSearch,savedLine);
 pop.evolve(track,true);assert.equal(pop.cars[0],identity);assert.equal(car.driverPressure,-10);
 pop.evolve(track,false);assert.equal(pop.cars[0].driverPressure,-10);assert.equal(pop.cars[0].lineSearch,savedLine);
 pop.setTopology('Standard',track);assert.equal(pop.cars[0].driverPressure,-10);
 // A real changed-pressure lap clears the block only at the next start/finish crossing.
 const contexts=new Population(1,track),savedContexts=new Map();
 for(let p=-10;p<=10;p++) {contexts.setDriverPressure(p,true);savedContexts.set(p,contexts.cars[0].lineSearch);}
 assert.equal(contexts.cars[0].lineSearchByPressure.size,21);
 for(let p=-10;p<=10;p++) {contexts.setDriverPressure(p,true);assert.equal(contexts.cars[0].lineSearch,savedContexts.get(p));}
 Math.random=seeded(2345);
 const training=new Population(1,track);training.autoEvolutionEnabled=false;
 const learner=training.cars[0];learner.mistakesEnabled=false;
 training.setDriverPressure(-5);
 const newLine=learner.lineSearch;
 for(let frame=0;frame<60*240 && learner.raceLapsCompleted<2;frame++) {
   training.update(1/60,track);
   if(learner.raceLapsCompleted===0) assert.equal(training.teamRecords[0].bestLapTime,null);
   if(learner.raceLapsCompleted===1) {
     assert.equal(learner.pressureLearningBlocked,false);
     assert.equal(training.teamRecords[0].bestLapTime,null);
     assert.equal(newLine.times.flat().length,0);
   }
 }
 assert.equal(learner.raceLapsCompleted,2);
 assert.ok(training.teamRecords[0].bestLapTime>0);
 assert.equal(training.teamRecords[0].bestLapPressure,-5);
 assert.equal(newLine.times.flat().length,1);
 // Saturated traction raises hazard; changing dt retains the same Poisson law.
 for(const multiplier of [.25,1,4]) {
   const p=DriverMistakes.probability(1,1,multiplier);
   assert.ok(Math.abs(p-(1-(1-DriverMistakes.probability(1,1/120,multiplier))**120))<1e-12);
 }
 const counts=[];
 for(const hz of [30,60,120]) {
   let total=0;
   for(let seed=1;seed<=8;seed++) {
     const errors=new DriverMistakes(seeded(seed));
     for(let i=0;i<hz*6000;i++) errors.step({throttle:1,brake:0,steer:.2},1/hz,1,true,4);
     total+=errors.count;
   }
   counts.push(total);
 }
 assert.ok(Math.max(...counts)/Math.min(...counts)<1.3);
 const attack=new BattlePush(()=>0);attack.step(1/60,'rival',false,2);assert.equal(attack.remaining,0);
 const safe=new Population(1,track);safe.setDriverPressure(10,true);
 const c=safe.cars[0];c.yellowFlag=true;c.speed=30;c.vel.set(30,0);c.tireUtilization=1;c.mistakes=new DriverMistakes(()=>0);
 c.updatePhysics({throttle:0,brake:0,steer:0},1/60,track);assert.equal(c.mistakes.count,0);
 c.yellowFlag=false;c.isManual=true;c.updatePhysics({throttle:0,brake:0,steer:0},1/60,track);assert.equal(c.mistakes.count,0);
 console.log('Pressure regressions passed: interpolation, isolated lines, model protection, continuity, flags, manual control and dt-independent hazards:',counts);
 if (!process.argv.includes('--unit')) {
 const rows=[];
 const fieldSize=process.argv.includes('--full')?10:3;
 for(const seed of [145,456,789]) for(const p of (process.argv.includes('--high-only')?[10]:[-10,0,10])) {
   Math.random=seeded(seed);
   const t=Presets.createGrandPrixTrack(14),population=new Population(fieldSize,t);
   population.isRaceMode=true;population.autoEvolutionEnabled=false;population.setDriverPressure(p,true);
   population.cars.forEach(c=>{c.isRaceMode=true;});
   let skid=0,offRoad=0,util=0,samples=0;
   const braking=new Map(population.cars.map(c=>[c,{seconds:0,effort:0}]));
   for(let frame=0;frame<60*900;frame++) {
     population.update(1/60,t);
     for(const c of population.cars) {
       if(c.isAlive&&!c.isFinishedRace) {
         const trace=braking.get(c);if(c.currentControl.brake>.05)trace.seconds+=1/60;trace.effort+=c.currentControl.brake/60;
         samples++;util+=c.tireUtilization;if(c.isSkidding)skid++;if(c.surfaceFractions.asphalt<1)offRoad++;
         if(c.raceLapsCompleted>=10)c.isFinishedRace=true;
       }
     }
     if(population.cars.every(c=>!c.isAlive||c.isFinishedRace))break;
   }
   const finished=population.cars.filter(c=>c.isFinishedRace);
   const brakeSecondsPerLap=finished.reduce((sum,c)=>sum+braking.get(c).seconds/c.raceLapsCompleted,0)/Math.max(1,finished.length);
   const brakeEffortPerLap=finished.reduce((sum,c)=>sum+braking.get(c).effort/c.raceLapsCompleted,0)/Math.max(1,finished.length);
   rows.push({seed,pressure:p,brakeSecondsPerLap,brakeEffortPerLap,finishers:population.cars.filter(c=>c.isFinishedRace).length,dnf:population.cars.filter(c=>!c.isAlive).length,laps:population.cars.map(c=>c.raceLapsCompleted),best:population.globalBestLap,utilization:util/Math.max(1,samples),skidSeconds:skid/60,offRoadSeconds:offRoad/60,errors:population.cars.reduce((n,c)=>n+c.mistakes.count,0)});
   console.log('Pressure race:',JSON.stringify(rows.at(-1)));
 }
 const high=rows.filter(r=>r.pressure===10),base=rows.filter(r=>r.pressure===0),low=rows.filter(r=>r.pressure===-10);
 const sum=(rs,key)=>rs.reduce((n,r)=>n+r[key],0);
 assert.ok(sum(high,'finishers')>0,'finishing at +10 must remain physically possible');
 if(base.length) {
 assert.ok(sum(high,'skidSeconds')+sum(high,'offRoadSeconds')>sum(base,'skidSeconds')+sum(base,'offRoadSeconds'),'high pressure must increase physical risk');
 assert.ok(sum(high,'utilization')>sum(base,'utilization'));
 assert.ok(sum(high,'brakeSecondsPerLap')<sum(base,'brakeSecondsPerLap'),'high pressure should spend less time braking');
 assert.ok(sum(high,'brakeEffortPerLap')<sum(base,'brakeEffortPerLap'),'high pressure should reduce integrated brake usage');
 assert.ok(sum(low,'skidSeconds')<sum(base,'skidSeconds'));
 }
 console.log('Pressure calibration passed.');
 }
} finally {Math.random=originalRandom;await rm(dir,{recursive:true,force:true});}
