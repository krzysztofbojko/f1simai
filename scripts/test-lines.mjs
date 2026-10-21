import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-lines-'));
try {
 await build({configFile:false,logLevel:'silent',build:{outDir:dir,lib:{entry:{lines:resolve('src/ai/LineSearch.ts'),profile:resolve('src/ai/LineProfile.ts'),presets:resolve('src/track/Presets.ts'),linenet:resolve('src/ai/LineNet.ts')},formats:['es'],fileName:(_,name)=>name+'.mjs'}}});
 const {LineSearch}=await import(pathToFileURL(join(dir,'lines.mjs')));
 const {LineProfile}=await import(pathToFileURL(join(dir,'profile.mjs')));
 const {Presets}=await import(pathToFileURL(join(dir,'presets.mjs')));
 const {seedLineTarget}=await import(pathToFileURL(join(dir,'linenet.mjs')));
 // Driven-line radii: the centreline by default, a wider arc on outside-inside-outside, a tighter one when pinched.
 {
  const gp=Presets.createGrandPrixTrack(14), n=gp.points.length;
  const centre=new LineProfile(n);
  assert.ok(centre.matches(gp));
  for(let i=0;i<n;i++) assert.ok(Math.abs(centre.curvature(gp,i)-Math.abs(gp.points[i].curvature))<1e-9,'untrained profile follows the centreline');
  const wide=new LineProfile(n), pinched=new LineProfile(n), usable=gp.width/2-2.3;
  for(let i=0;i<n;i++){ wide.offsets[i]=seedLineTarget(gp,i)*usable; pinched.offsets[i]=-wide.offsets[i]; }
  wide.invalidate(); pinched.invalidate();
  // Planned corner speed scales with sqrt(radius): compare the arcs over every real corner.
  const speedRatio=profile=>{ const r=[]; for(let i=0;i<n;i++){ const k=Math.abs(gp.points[i].curvature); if(k>0.008) r.push(Math.sqrt(k/profile.curvature(gp,i))); } return r.reduce((a,b)=>a+b,0)/r.length; };
  assert.ok(speedRatio(wide)>1.015,`outside-apex-outside opens the corners: ${speedRatio(wide)}`);
  assert.ok(speedRatio(pinched)<0.99,`the mirrored line tightens them: ${speedRatio(pinched)}`);
  for(let i=0;i<n;i++){ const c=wide.curvature(gp,i), a=Math.abs(gp.points[i].curvature); assert.ok(c>=a*LineProfile.MIN_RATIO-1e-12&&c<=a*LineProfile.MAX_RATIO+LineProfile.MAX_SLACK+1e-12,'bounded'); }
  const learner=new LineProfile(n); for(let lap=0;lap<30;lap++) learner.record(5,3); assert.ok(Math.abs(learner.offsets[5]-3)<0.01,'profile converges to the driven offset');
  learner.record(-1,3); learner.record(n,3); learner.record(6,NaN); assert.equal(learner.offsets[6],0,'invalid samples ignored');
 }
 assert.equal(new Set(Array.from({length:10},(_,i)=>new LineSearch(i).offset(false))).size,5);
 const search=new LineSearch(0);
 search.finish(80,false); assert.equal(search.current,0); assert.equal(search.times[0].length,0);
 for(let i=0;i<5;i++) {
   assert.equal(search.current,i);
   search.finish(100 + Math.abs(i-2)*5,true);
   if(i<4) search.finish(1,true); // transition lap must not overwrite the score
 }
 assert.equal(search.best,2); assert.equal(search.offset(true),0);
 assert.ok(search.times.every(samples=>samples.length===1));
 const current=search.current; search.finish(NaN,true); assert.equal(search.current,current);
 const champion={...search.profiles[search.best]};
 for(let i=0;i<10;i++) search.finish(120,true);
 // Mutations only replace non-champion slots; the champion's trajectory is never edited in place.
 assert.ok(search.profiles.some(p=>JSON.stringify(p)===JSON.stringify({...champion})) || search.best!==2, 'champion preserved while it is the best');
 assert.ok(search.profiles.some((p,i)=>p.entry!==25+i*5), 'search must generate new trajectories');
 const points=Array.from({length:100},(_,i)=>({center:{dist:()=>2},curvature:i>=40&&i<=50?.02:0}));
 const track={points,width:14,totalLength:200,sampleSurface:pos=>({index:pos.x})};
 const profile=new LineSearch(2);
 const approach=profile.target(track,{x:25},false),apex=profile.target(track,{x:45},false),exit=profile.target(track,{x:60},false);
 assert.ok(approach<0&&apex>0&&exit<0,'outside / apex / outside trajectory');
 for(let i=0;i<100;i++) assert.ok(Math.abs(profile.target(track,{x:i},false))<=5.2);
 console.log('Racing lines: driven-line radii, distinct variants, clean timing, transition protection and best selection passed.');
} finally { await rm(dir,{recursive:true,force:true}); }
