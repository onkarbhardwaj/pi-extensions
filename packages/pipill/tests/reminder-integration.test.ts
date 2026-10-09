import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE_TYPE } from '../src/core.ts';
const available=['@earendil-works/pi-coding-agent','@earendil-works/pi-tui','typebox'].every(name=>{try{import.meta.resolve(name);return true;}catch{return false;}});
test('Pipill hook handles actual Pi projections, compaction retention, context edits and label updates',{
  skip:!available && 'Pi peers needed for projection integration test.',
},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pill-cadence-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'pipill.json'),JSON.stringify({ticketPrefixes:['KAN']}));
  const prior=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
  t.after(()=>{if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior;});
  const {buildSessionProjection}=await import('@earendil-works/pi-coding-agent');
  const {default:extension}=await import('../src/index.ts');const hooks=new Map();
  await extension({on:(name,fn)=>hooks.set(name,fn),registerCommand(){},registerTool(){},events:{on(){}}});
  const hook=hooks.get('before_agent_start');let entries=[];
  const ctx={sessionManager:{getEntries:()=>entries,getBranch:()=>entries,buildSessionProjection:()=>buildSessionProjection(entries,entries.at(-1)?.id??null)}};
  const initial=hook({},ctx).message;
  const timestamp='2026-10-01T00:00:00.000Z';
  const u={type:'message',id:'u',parentId:null,timestamp,message:{role:'user',content:'Hello',timestamp:1}};
  const r={type:'custom_message',id:'r',parentId:'u',timestamp,...initial};entries=[u,r];
  assert.equal(hook({},ctx),undefined);
  const c={type:'compaction',id:'c',parentId:'r',timestamp,firstKeptEntryId:'r',summary:'Summary mentions reminder',tokensBefore:100};
  entries=[u,r,c];assert(ctx.sessionManager.buildSessionProjection().messages.some(m=>m.role==='custom'&&m.customType==='pipill-reminder'));
  assert.deepEqual(hook({},ctx).message,initial,'retained pre-compaction reminder does not suppress fresh reminder');
  entries=[u,r,{type:'context_edit',id:'edit',parentId:'r',timestamp,targetId:'r',replacement:null}];
  assert.deepEqual(hook({},ctx).message,initial,'omitted reminder does not suppress injection');
  entries=[u,r,{type:'custom',id:'state',parentId:'r',timestamp,customType:STATE_TYPE,data:{version:1,pills:[{label:'KAN-81 Map planning'}]}}];
  const before=JSON.stringify(entries);const changed=hook({},ctx).message;
  assert(changed.content.includes('KAN-81 Map planning'));assert.equal(JSON.stringify(entries),before);
  entries.push({type:'custom_message',id:'r2',parentId:'state',timestamp,...changed});assert.equal(hook({},ctx),undefined);
});
