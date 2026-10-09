import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters as plain } from 'node:util';
import { messageFromEntry } from '../src/core.ts';

const hostAvailable = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'].every(name => {
  try { import.meta.resolve(name); return true; } catch { return false; }
});
let picker, extension, visibleWidth, SelectionTreeList, TreeSelectorComponent;
if (hostAvailable) {
  const sdk = await import('@earendil-works/pi-coding-agent'); sdk.initTheme('dark');
  const tui = await import('@earendil-works/pi-tui');
  ({ visibleWidth } = tui);
  tui.setKeybindings(new tui.KeybindingsManager({ ...tui.TUI_KEYBINDINGS,
    'app.tree.filter.all': { defaultKeys: 'ctrl+a' },
    'app.tree.foldOrUp': { defaultKeys: 'shift+up' },
    'app.tree.unfoldOrDown': { defaultKeys: 'shift+down' },
  }));
  ({ picker } = await import('../src/picker.ts'));
  ({ SelectionTreeList } = await import('../src/tree-list.ts'));
  ({ TreeSelectorComponent } = sdk);
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
const theme={appearance:'dark',fg:(_color,text)=>text,bg:(_color,text)=>text,bold:text=>text,style:text=>text};
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
  const listHeight=f.render().length;
  f.view.handleInput(' ');f.view.handleInput('i');assert(f.render().some(l=>l.includes('Inspect · user')));
  assert.equal(f.render().length,listHeight,'short preview keeps modal height');
  f.view.handleInput('\x1b');assert.equal(f.render().length,listHeight);assert(f.render().some(l=>l.includes('[x]')));assert(!f.completed());
  f.view.handleInput('\x1b[B');f.view.handleInput(' '); // select second
  f.view.handleInput('/');f.view.handleInput('no matches');
  assert(f.render().some(l=>l.includes('No entries found')));
  f.view.handleInput('\x01');f.click('[Ready]');
  assert(f.completed());assert(f.result().includes('First 世界'));assert(f.result().includes('Second answer'));
  assert(f.result().indexOf('First 世界')<f.result().indexOf('Second answer'));assert(!f.result().includes('Tool output'));
});

test('mouse inspection does not select; tool selection works; Esc cancels and empty Ready stays open', options, () => {
  const f=fixture();f.click('[Ready]');assert(!f.completed());assert(f.render().some(l=>l.includes('Select at least')));
  f.click('[i]');f.view.handleInput('\x1b');assert(f.render().some(l=>l.includes('0 selected')));
  f.view.handleInput('\x01');
  const lines=f.render(),y=lines.findIndex(l=>l.includes('toolResult'));assert(y>=0);
  f.view.handleMouse({type:'click',button:'left',x:4,y});f.click('[Ready]');assert(f.result().includes('BEGIN toolResult · read MESSAGE'));
  const cancelled=fixture();cancelled.view.handleInput(' ');cancelled.view.handleInput('\x1b');assert(cancelled.completed());assert.equal(cancelled.result(),undefined);
});

test('command appends only on Ready, retains latest draft, and never sends or navigates', options, async () => {
  let command, draft='Original draft', response='Selected context', session='one';
  extension({registerCommand:(name,definition)=>{assert.equal(name,'sel');command=definition;}});
  const ctx={mode:'tui',ui:{notify(){},getEditorText:()=>draft,setEditorText:value=>draft=value,
    custom:async (factory,options)=>{assert.equal(options.overlay,true);assert.equal(options.overlayOptions.width,'85%');factory({terminal:{rows:32},requestRender(){}},theme,{},()=>{});draft='Draft edited meanwhile';return response;}},
    sessionManager:{getSessionId:()=>session,getEntries:()=>entries,getLeafId:()=> 'c',getTree:()=>tree}};
  await command.handler('',ctx);assert.equal(draft,'Draft edited meanwhile\n\nSelected context');
  response=undefined;await command.handler('',ctx);assert.equal(draft,'Draft edited meanwhile');
  ctx.ui.custom=async()=>{session='two';return 'Wrong session';};await command.handler('',ctx);assert.equal(draft,'Draft edited meanwhile');
});

test('adapted tree retains Pi branch layout and active-path ordering', options, () => {
  const root={...entries[0]}, first={...entries[1]}, alternate={type:'message',id:'z',parentId:'a',message:{role:'user',content:'Alternate'}};
  const fork=[{entry:root,children:[{entry:first,children:[]},{entry:alternate,children:[]}]}];
  const map=new Map([root,first,alternate].map(e=>[e.id,messageFromEntry(e)]));
  const adapted=new SelectionTreeList(fork,'z',10,'z','no-tools',theme,map,new Set());
  const actual=new TreeSelectorComponent(fork,'z',20,()=>{},()=>{},undefined,'z','no-tools').getTreeList();
  const ours=adapted.render(300).map(plain).map(line=>line.replace('[ ][i]',''));
  const original=actual.render(300).map(plain);
  assert.deepEqual(ours,original);
  assert.deepEqual(adapted.filteredNodes.map(n=>n.node.entry.id),['a','z','b']);
});

test('adapted tree handles deep stored histories without recursive traversal', options, () => {
  const root={entry:entries[0],children:[]};let node=root;
  const map=new Map([[root.entry.id,messageFromEntry(root.entry)]]);
  for(let i=0;i<12000;i++){const child={entry:{type:'message',id:'deep-'+i,parentId:node.entry.id,message:{role:'user',content:'Next'}},children:[]};node.children.push(child);node=child;map.set(child.entry.id,messageFromEntry(child.entry));}
  const list=new SelectionTreeList([root],node.entry.id,10,node.entry.id,'no-tools',theme,map,new Set());
  assert.equal(list.filteredNodes.length,12001);assert.equal(list.filteredNodes.at(-1).indent,0);assert(list.render(80).length<=11);
});
