import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRecentReminder } from '../src/reminder.ts';
const reminder=(id='r',content='current',customType='pipill-reminder')=>({type:'custom_message',id,customType,content});
const message=(id,role='user',content='Hello')=>({type:'message',id,message:{role,content:role==='assistant'?[{type:'text',text:content}]:content}});
function projection(entries){return entries.map(e=>({sourceEntry:e,messages:e.type==='custom_message'?[{role:'custom',customType:e.customType,content:e.content}]:e.type==='message'?[e.message]:[]}));}
const check=(branch,p=projection(branch))=>hasRecentReminder(branch,p,'pipill-reminder','current');

test('unchanged recent reminder suppresses injection; six conversational messages expire it',()=>{
  assert(!check([]));const r=reminder();assert(check([r,message('u'),message('a','assistant')]));
  assert(check([r,...Array.from({length:5},(_,i)=>message('m'+i))]));
  assert(!check([r,...Array.from({length:6},(_,i)=>message('m'+i))]));
});
test('changed labels or guidance need a new message, even if an older reminder matched',()=>{
  assert(!check([reminder('old'),reminder('new','outdated labels')]));
  assert(check([reminder('old','outdated'),reminder('new')]));
});
test('tool messages, other reminders and bookkeeping do not advance the interval',()=>{
  const items=[reminder(),...Array.from({length:20},(_,i)=>({type:'message',id:'t'+i,message:{role:'toolResult',content:[]}})),
    reminder('tao','tao','tao-critical-system-reminder'),{type:'custom',id:'state'}];
  assert(check(items));
  items.push({type:'message',id:'call',message:{role:'assistant',content:[{type:'toolCall',name:'read'}]}});assert(check(items));
});
test('actual compaction entry stops look-back, irrespective of projection ordering or summary text',()=>{
  const r=reminder(),c={type:'compaction',id:'c',summary:'current reminder mentioned here'},u=message('u');
  // Pi can put the compaction summary before retained older messages.
  assert(!check([r,c,u],[{sourceEntry:c,messages:[{role:'compactionSummary',summary:c.summary}]},...projection([r,u])]));
  assert(check([r,c,reminder('fresh'),u]));
});
test('only projected reminders count; omitted or replaced reminders cannot suppress injection',()=>{
  const r=reminder();assert(!check([r],[{sourceEntry:r,messages:[]} ]));
  assert(!check([r],[{sourceEntry:r,messages:[{role:'custom',customType:'pipill-reminder',content:'replaced'}]}]));
});
test('active branch governs detection; another branch cannot supply a reminder',()=>{
  const u=message('u');assert(!check([u],projection([reminder(),u])));
});
test('a quoted reminder or XML tag in a user message is not a reminder',()=>{
  assert(!check([message('u','user','pipill-reminder current')]));
});
test('look-back never mutates branch history or its projected contributions',()=>{
  const entries=[reminder(),message('u')],p=projection(entries),before=JSON.stringify({entries,p});
  check(entries,p);assert.equal(JSON.stringify({entries,p}),before);
});
