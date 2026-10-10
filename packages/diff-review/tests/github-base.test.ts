import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveReviewBase} from '../src/stack-base.ts';

async function fixture(fn) {
 const root=await mkdtemp(join(tmpdir(),'pr-base-'));await mkdir(join(root,'git'));
 const target={path:root,branch:'feature',repository:{defaultBase:'origin/main'}};
 const git=async(_cwd,args)=>{if(args[0]==='rev-parse')return join(root,'git');if(args[0]==='show-ref')return 'sha';throw Error('Unexpected git call');};
 try{await fn(target,git);}finally{await rm(root,{recursive:true,force:true});}
}
test('PR parent used with metadata; missing PR uses default',async()=>fixture(async(t,g)=>{
 const pr=await resolveReviewBase(t,undefined,g,async()=>[{number:42,baseRefName:'lower'}]);
 assert.deepEqual(pr,{base:'origin/lower',baseSource:'github-pr',basePR:42});
 assert.deepEqual(await resolveReviewBase(t,undefined,g,async()=>[]),{base:'origin/main',baseSource:'configured-default'});
}));
test('GitHub failure falls back with explicit note; override skips network',async()=>fixture(async(t,g)=>{
 const failed=await resolveReviewBase(t,undefined,g,async()=>{throw Error('offline');});
 assert.equal(failed.base,'origin/main');assert.match(failed.baseResolutionNote,/lookup failed/);
 assert.deepEqual(await resolveReviewBase(t,'chosen',g,async()=>{throw Error('must not run');}),{base:'chosen',baseSource:'explicit'});
}));
test('ambiguous PR or unavailable base never silently selects default',async()=>fixture(async(t,g)=>{
 await assert.rejects(resolveReviewBase(t,undefined,g,async()=>[{number:1},{number:2}]),/Multiple open PRs/);
 const missing=async(c,args)=>{if(args[0]==='show-ref')throw Error('missing');return g(c,args);};
 await assert.rejects(resolveReviewBase(t,undefined,missing,async()=>[{number:1,baseRefName:'lower'}]),/missing locally/);
}));
