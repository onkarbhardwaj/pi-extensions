import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters as plain } from 'node:util';
import { messageFromEntry } from '../src/core.ts';

const hostAvailable = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'].every(name => {
  try { import.meta.resolve(name); return true; } catch { return false; }
});
let picker, extension, visibleWidth;
if (hostAvailable) {
  const sdk = await import('@earendil-works/pi-coding-agent'); sdk.initTheme('dark');
  ({ visibleWidth } = await import('@earendil-works/pi-tui'));
  ({ picker } = await import('../src/picker.ts'));
  ({ default: extension } = await import('../src/index.ts'));
}
const options = { skip: !hostAvailable && 'Install Pi peer dependencies to run component interaction tests.' };
const entries = [
  {type:'message',id:'a',parentId:null,message:{role:'user',content:'# First 世界\n\nA question.'}},
  {type:'message',id:'b',parentId:'a',message:{role:'assistant',content:[{type:'text',text:'Second answer'}]}},
  {type:'message',id:'c',parentId:'b',message:{role:'toolResult',toolName:'read',content:[{type:'text',text:'Tool output'}]}}
];
const tree=[{entry:entries[0],children:[{entry:entries[1],children:[{entry:entries[2],children:[]}]}]}];
const messages=entries.map(messageFromEntry);
const theme={appearance:'dark',fg:(_color,text)=>text,style:text=>text};
function fixture(){
  let result,completed=false;
  const view=picker({terminal:{rows:32},requestRender(){}},theme,value=>{result=value;completed=true;},tree,messages,'a');
  view.focused=true;
  const render=(width=90)=>view.render(width).map(plain);
  const click=label=>{const lines=render(),y=lines.findIndex(l=>l.includes(label));assert(y>=0,label);view.handleMouse({type:'click',button:'left',x:lines[y].indexOf(label)+1,y});};
  return {view,render,click,result:()=>result,completed:()=>completed};
}

test('checkboxes, inspection/back, search and filtering retain selections; Ready is chronological', options, () => {
  const f=fixture();
  for(const width of [120,55,20,8]){const lines=f.view.render(width);assert(lines.every(l=>visibleWidth(l)<=width));assert(lines.length<=27);}
  f.render();f.view.handleInput(' ');f.view.handleInput('i');assert(f.render().some(l=>l.includes('Inspect · user')));
  f.view.handleInput('\x1b');assert(f.render().some(l=>l.includes('[x]')));assert(!f.completed());
  f.view.handleInput('\x1b[B');f.view.handleInput(' '); // select second
  f.view.handleInput('/');f.view.handleInput('no matches');f.view.handleInput('\r');
  assert(f.render().some(l=>l.includes('No matching messages')));
  f.click('[All messages]');f.click('[Ready]');
  assert(f.completed());assert(f.result().includes('First 世界'));assert(f.result().includes('Second answer'));
  assert(f.result().indexOf('First 世界')<f.result().indexOf('Second answer'));assert(!f.result().includes('Tool output'));
});

test('mouse inspection does not select; tool selection works; Esc cancels and empty Ready stays open', options, () => {
  const f=fixture();f.click('[Ready]');assert(!f.completed());assert(f.render().some(l=>l.includes('Select at least')));
  f.click('[i]');f.view.handleInput('\x1b');assert(f.render().some(l=>l.includes('0 selected')));
  f.click('[All messages]');
  const lines=f.render(),y=lines.findIndex(l=>l.includes('toolResult'));assert(y>=0);
  f.view.handleMouse({type:'click',button:'left',x:5,y});f.click('[Ready]');assert(f.result().includes('BEGIN toolResult · read MESSAGE'));
  const cancelled=fixture();cancelled.view.handleInput(' ');cancelled.view.handleInput('\x1b');assert(cancelled.completed());assert.equal(cancelled.result(),undefined);
});

test('command appends only on Ready, retains latest draft, and never sends or navigates', options, async () => {
  let command, draft='Original draft', response='Selected context', session='one';
  extension({registerCommand:(name,definition)=>{assert.equal(name,'sel');command=definition;}});
  const ctx={mode:'tui',ui:{notify(){},getEditorText:()=>draft,setEditorText:value=>draft=value,
    custom:async factory=>{factory({terminal:{rows:32},requestRender(){}},theme,{},()=>{});draft='Draft edited meanwhile';return response;}},
    sessionManager:{getSessionId:()=>session,getEntries:()=>entries,getLeafId:()=> 'c',getTree:()=>tree}};
  await command.handler('',ctx);assert.equal(draft,'Draft edited meanwhile\n\nSelected context');
  response=undefined;await command.handler('',ctx);assert.equal(draft,'Draft edited meanwhile');
  ctx.ui.custom=async()=>{session='two';return 'Wrong session';};await command.handler('',ctx);assert.equal(draft,'Draft edited meanwhile');
});
