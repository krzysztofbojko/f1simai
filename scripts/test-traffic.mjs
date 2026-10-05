import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-traffic-'));
try {
 await build({configFile:false,logLevel:'silent',build:{outDir:dir,lib:{entry:{traffic:resolve('src/physics/Traffic.ts'),car:resolve('src/physics/Car.ts'),vector:resolve('src/math/Vector2.ts')},formats:['es'],fileName:(_,name)=>name+'.mjs'}}});
 const {Car} = await import(pathToFileURL(join(dir,'car.mjs')));
 const {Vector2} = await import(pathToFileURL(join(dir,'vector.mjs')));
 const {captureMotion,resolveTraffic,avoidTraffic} = await import(pathToFileURL(join(dir,'traffic.mjs')));
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
 console.log('Traffic regressions passed: swept rear-end/crossing collisions, light contact, separation, energy, passing and AI braking.');
} finally {await rm(dir,{recursive:true,force:true});}
