import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-lines-'));
try {
 await build({configFile:false,logLevel:'silent',build:{outDir:dir,lib:{entry:{lines:resolve('src/ai/LineSearch.ts'),profile:resolve('src/ai/LineProfile.ts'),presets:resolve('src/track/Presets.ts'),racing:resolve('src/track/RacingLine.ts'),track:resolve('src/track/Track.ts'),spline:resolve('src/math/Spline.ts'),vector:resolve('src/math/Vector2.ts')},formats:['es'],fileName:(_,name)=>name+'.mjs'}}});
 const {LineSearch}=await import(pathToFileURL(join(dir,'lines.mjs')));
 const {LineProfile}=await import(pathToFileURL(join(dir,'profile.mjs')));
 const {Presets}=await import(pathToFileURL(join(dir,'presets.mjs')));
 const {RacingLine,getRacingLine}=await import(pathToFileURL(join(dir,'racing.mjs')));
 const {Track}=await import(pathToFileURL(join(dir,'track.mjs')));
 const {Spline}=await import(pathToFileURL(join(dir,'spline.mjs')));
 const {Vector2}=await import(pathToFileURL(join(dir,'vector.mjs')));
 const monzaData=JSON.parse(await readFile('tracks/it-1922-monza.json','utf8'));
 const monzaWidth=Math.round(monzaData.trackWidth);
 const monza=new Track(Spline.generateClosedTrack(monzaData.rawPoints.map(p=>new Vector2(p.x,p.y)),monzaWidth,18,true),monzaWidth);
 // Minimum-curvature racing line: inside the white lines, outside / kerb at the apex / outside, deterministic.
 let wideCorners=0;
 for(const [name,track] of [['gp',Presets.createGrandPrixTrack(14)],['monza',monza]]) {
  const line=getRacingLine(track), n=track.points.length, half=track.width/2;
  assert.equal(getRacingLine(track),line,'one cached line per track and style');
  assert.deepEqual(Array.from(new RacingLine(track).offsets),Array.from(line.offsets),'the line is deterministic (UI thread and worker agree)');
  for(let i=0;i<n;i++){
   assert.ok(line.offsets[i]>=line.lower[i]-1e-9&&line.offsets[i]<=line.upper[i]+1e-9,`${name}: line inside its bounds at ${i}`);
   assert.ok(line.upper[i]<=half-RacingLine.INSIDE_MARGIN+1e-9&&line.lower[i]>=-half+RacingLine.INSIDE_MARGIN-1e-9,`${name}: bounds keep the car on the asphalt at ${i}`);
  }
  // Every isolated corner: the apex at the inside kerb, entry and exit out wide.
  const smooth=i=>{let k=0;for(let d=-2;d<=2;d++)k+=track.points[(i+d+n)%n].curvature*(3-Math.abs(d))/9;return k;};
  let corners=0, wide=0;
  for(let i=0;i<n;i++){
   const k=smooth(i);
   // Peaks of the corner curvature; an S (an opposite corner close by) is a compromise, not tested here.
   if(Math.abs(k)<0.01||[-3,-2,-1,1,2,3].some(d=>Math.abs(smooth(i+d))>Math.abs(k))) continue;
   if(Array.from({length:13},(_,d)=>d-6).some(d=>Math.sign(smooth(i+d))===-Math.sign(k)&&Math.abs(smooth(i+d))>0.006)) continue;
   corners++;
   const side=Math.sign(k), inside=j=>side*line.offsetAt(j);
   const apex=Math.max(...Array.from({length:7},(_,d)=>inside(i+d-3)));
   assert.ok(apex>half-RacingLine.INSIDE_MARGIN-0.5,`${name}: apex of the corner at ${i} reaches the inside (${apex.toFixed(2)} of ${half})`);
   // Out wide on the approach and the run-off of the corner (unless another bend in the same direction follows: a double apex).
   const calm=from=>Array.from({length:6},(_,d)=>from+d).every(j=>Math.abs(smooth(j))<0.006);
   if(calm(i-9)) { const entry=Math.min(...Array.from({length:6},(_,d)=>inside(i-9+d))); assert.ok(entry<0,`${name}: corner at ${i} is entered from the outside (${entry.toFixed(2)})`); }
   if(calm(i+4)) { const exit=Math.min(...Array.from({length:6},(_,d)=>inside(i+4+d))); assert.ok(exit<0,`${name}: corner at ${i} is left to the outside (${exit.toFixed(2)})`); }
   if(calm(i-9)&&calm(i+4)) wide++;
  }
  assert.ok(corners>=2,`${name}: found ${corners} isolated corners`);
  wideCorners+=wide;
  // Wider arcs than the centreline: the planned corner speed rises with sqrt(radius).
  const ratio=[];for(let i=0;i<n;i++){const k=Math.abs(track.points[i].curvature);if(k>0.008)ratio.push(Math.sqrt(k/Math.max(1e-5,Math.abs(line.curvature[i]))));}
  const gain=ratio.reduce((a,b)=>a+b,0)/ratio.length;
  assert.ok(gain>1.05,`${name}: racing line opens the corners (${gain.toFixed(3)})`);
  // Corners onto a straight: a late-apex driver turns later than a geometric-apex one.
  const early=getRacingLine(track,0), late=getRacingLine(track,1);
  // Where along each corner the car is deepest on the inside (index centroid from the turn-in).
  const runs=[];for(let i=0;i<n;i++){if(Math.abs(smooth(i))>RacingLine.CORNER_CURVATURE&&Math.abs(smooth(i-1))<=RacingLine.CORNER_CURVATURE){let e=i;while(Math.abs(smooth(e+1))>RacingLine.CORNER_CURVATURE&&e-i<n)e++;runs.push([i,e]);}}
  const centroid=(l,[a,b])=>{let w=0,c=0;for(let j=a-3;j<=b+3;j++){const v=Math.max(0,Math.sign(smooth(j))*l.offsetAt(j));w+=v;c+=v*(j-a);}return w?c/w:0;};
  const shifts=runs.map(r=>centroid(late,r)-centroid(early,r));
  assert.ok(shifts.every(d=>d>-0.3)&&shifts.some(d=>d>0.2),`${name}: late apex style moves the apex later (${shifts.map(d=>d.toFixed(2)).join(' ')})`);
  const speeds=line.speedProfile(1,0.004,0.7);
  assert.ok(speeds.every(v=>v>0&&Number.isFinite(v)),`${name}: finite speed profile`);
 }
 assert.ok(wideCorners>=1,`corners with straights on both sides checked: ${wideCorners}`);
 // Driven-line radii: the centreline by default, the racing line's arcs when seeded from it, tighter when pinched.
 {
  const gp=Presets.createGrandPrixTrack(14), n=gp.points.length, line=getRacingLine(gp);
  const centre=new LineProfile(n);
  assert.ok(centre.matches(gp));
  for(let i=0;i<n;i++) assert.ok(Math.abs(centre.curvature(gp,i)-Math.abs(gp.points[i].curvature))<1e-9,'untrained profile follows the centreline');
  const wide=LineProfile.fromLine(gp,line.offsets), pinched=new LineProfile(n);
  for(let i=0;i<n;i++) pinched.offsets[i]=-line.offsets[i];
  pinched.invalidate();
  // Planned corner speed scales with sqrt(radius): compare the arcs over every real corner.
  const speedRatio=profile=>{ const r=[]; for(let i=0;i<n;i++){ const k=Math.abs(gp.points[i].curvature); if(k>0.008) r.push(Math.sqrt(k/profile.curvature(gp,i))); } return r.reduce((a,b)=>a+b,0)/r.length; };
  assert.ok(speedRatio(wide)>1.05,`outside-apex-outside opens the corners: ${speedRatio(wide)}`);
  assert.ok(speedRatio(pinched)<0.99,`the mirrored line tightens them: ${speedRatio(pinched)}`);
  for(let i=0;i<n;i++){ const c=pinched.curvature(gp,i), a=Math.abs(gp.points[i].curvature); assert.ok(c>=a*LineProfile.MIN_RATIO*(1-1e-6)&&c<=(a*LineProfile.MAX_RATIO+LineProfile.MAX_SLACK)*(1+1e-6),'bounded'); }
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
 console.log('Racing lines: minimum-curvature geometry (apex, entry/exit, bounds, late apex), driven-line radii, distinct variants, clean timing, transition protection and best selection passed.');
} finally { await rm(dir,{recursive:true,force:true}); }
