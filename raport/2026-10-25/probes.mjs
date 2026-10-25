import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../', import.meta.url));
const out=await mkdtemp(join(tmpdir(), 'f1-physics-audit-'));
try {
await build({root,configFile:false,logLevel:'silent',build:{outDir:out,emptyOutDir:true,minify:false,lib:{entry:{car:root+'/src/physics/Car.ts'},formats:['es'],fileName:(_,n)=>n+'.mjs'}}});
const {Car}=await import(pathToFileURL(out+'/car.mjs'));
const plane={checkpoints:[],timingGates:[],width:76,isOutOfBounds:()=>false};
const idle={throttle:0,brake:0,steer:0};
function fresh(vx=60,vy=0){Math.random=()=>0.5; const c=new Car({x:0,y:0,clone(){return this}},0);c.pos=c.vel.clone();c.prevPos=c.vel.clone();c.vel.set(vx,vy);c.speed=c.vel.mag();c.speedKmh=c.speed*3.6;c.lapPowerFactor=c.lapGripFactor=c.lapDragFactor=1;c.mistakesEnabled=false;return c;}
const result={};
function coast(harvest){const c=fresh();c.ersEnergy=1e6;c.ersHarvestedLap=harvest?0:Car.ERS_LAP_HARVEST;for(let i=0;i<60;i++)c.updatePhysics(idle,1/60,plane);return {speed:c.speed,x:c.pos.x,batteryGain:c.ersEnergy-1e6};}
result.coast={enabled:coast(true),budgetExhausted:coast(false)};
assert.equal(result.coast.enabled.speed,result.coast.budgetExhausted.speed);assert.equal(result.coast.enabled.x,result.coast.budgetExhausted.x);assert.ok(result.coast.enabled.batteryGain>90000);
function aero(wind){Car.config.weather.windX=wind;Car.config.weather.windY=0;const c=fresh(0,60);let loads;const original=c.stepSuspension.bind(c);c.stepSuspension=(dt,f,r,...args)=>{loads={front:f,rear:r,total:f+r};return original(dt,f,r,...args)};c.updatePhysics(idle,1/60,plane);return loads;}
result.sidewaysAero={zeroWind:aero(0),negligibleWind:aero(1e-12)};Car.config.weather.windX=0;
assert.ok(result.sidewaysAero.negligibleWind.total<result.sidewaysAero.zeroWind.total*.9);
function steer(delta){const c=fresh();c.wheelAngle=c.steeringHands=delta;c.updatePhysics({...idle,steer:delta/c.maxSteerAngle},1/60,plane);return {vx:c.vel.x,vy:c.vel.y,frontLateral:c.frontLateralInUse,omittedLongitudinalProjection:-c.frontLateralInUse*Math.sin(delta),delta};}
result.steering={straight:steer(0),turned:steer(.25)};assert.equal(result.steering.straight.vx,result.steering.turned.vx);assert.ok(result.steering.turned.frontLateral>1000);
result.dt=[];
for(const hz of [30,60,120]){const c=fresh(0,60);let calls=0;Math.random=()=>{calls++;return .5};for(let i=0;i<hz;i++){c.framesSinceLastCheckpoint=0;c.updatePhysics(idle,1/hz,plane)}result.dt.push({hz,randomCalls:calls,speed:c.speed,heading:c.heading});}
result.stuckTimeout=[];
for(const hz of [30,60,120]){const c=fresh(0,0);c.recoveryTimer=0;let steps=0;while(c.isAlive&&steps<2000){c.updatePhysics(idle,1/hz,plane);steps++;}result.stuckTimeout.push({hz,steps,seconds:steps/hz,reason:c.eliminationReason});assert.equal(c.eliminationReason,'stuck');}
{const c=fresh(31);c.fuelKg=0;c.gear=6;c.engineRpm=5000;c.ersEnergy=1e6;const initialK=.5*c.totalMass*c.speed*c.speed;for(let i=0;i<6;i++)c.updatePhysics(idle,1/60,plane);const lost=initialK-.5*c.totalMass*c.speed*c.speed;result.emptyFuelCoast={seconds:.1,kineticLoss:lost,batteryGain:c.ersEnergy-1e6,totalEnergyGain:c.ersEnergy-1e6-lost};}
console.log(JSON.stringify(result,null,2));

} finally {
  await rm(out, { recursive: true, force: true });
}
