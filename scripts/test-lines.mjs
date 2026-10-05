import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-lines-'));
try {
 await build({configFile:false,logLevel:'silent',build:{outDir:dir,lib:{entry:resolve('src/ai/LineSearch.ts'),formats:['es'],fileName:()=> 'lines.mjs'}}});
 const {LineSearch}=await import(pathToFileURL(join(dir,'lines.mjs')));
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
 assert.deepEqual(search.profiles[2],champion);
 assert.ok(search.profiles.some((p,i)=>p.entry!==25+i*5), 'search must generate new trajectories');
 const points=Array.from({length:100},(_,i)=>({center:{dist:()=>2},curvature:i>=40&&i<=50?.02:0}));
 const track={points,width:14,totalLength:200,sampleSurface:pos=>({index:pos.x})};
 const profile=new LineSearch(2);
 const approach=profile.target(track,{x:25},false),apex=profile.target(track,{x:45},false),exit=profile.target(track,{x:60},false);
 assert.ok(approach<0&&apex>0&&exit<0,'outside / apex / outside trajectory');
 for(let i=0;i<100;i++) assert.ok(Math.abs(profile.target(track,{x:i},false))<=5.2);
 console.log('Racing lines: distinct variants, clean timing, transition protection and best selection passed.');
} finally { await rm(dir,{recursive:true,force:true}); }
