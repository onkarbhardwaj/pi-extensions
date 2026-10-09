import test from 'node:test';
import assert from 'node:assert/strict';
import { diffMatches } from '../src/core.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters as plain } from 'node:util';

test('diff search counts original diff text including added and removed lines, not line numbers', () => {
  const rows=[{kind:'delete',text:'ALPHA alpha',oldLine:123},{kind:'add',text:'alpha a.b',newLine:123}];
  assert.equal(diffMatches(rows,'alpha').length,3);assert.equal(diffMatches(rows,'123').length,0);
  assert.equal(diffMatches(rows,'a.b').length,1);assert.equal(diffMatches(rows,'').length,0);
});
const available=['@earendil-works/pi-coding-agent','@earendil-works/pi-tui'].every(name=>{try{import.meta.resolve(name);return true;}catch{return false;}});
test('diff viewer searches a snapshot, highlights wrapping, and never intercepts comment input', {
  skip: !available && 'Pi peers needed for viewer interaction test.',
}, async t => {
  const root=await mkdtemp(join(tmpdir(),'diff-search-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const run=promisify(execFile);const git=(...args)=>run('git',['-C',root,...args]);
  await git('init','-q','-b','search-test');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
  await writeFile(join(root,'a.txt'),'Old alpha ALPHA\n');await writeFile(join(root,'b.txt'),'Old beta\n');
  await git('add','.');await git('-c','commit.gpgsign=false','commit','-qm','Baseline');
  await writeFile(join(root,'a.txt'),'New alpha ALPHA '+ 'filler '.repeat(20)+'alpha\n');await writeFile(join(root,'b.txt'),'New beta\n');
  const agent=join(root,'agent');await mkdir(join(agent,'diff-review'),{recursive:true});
  await writeFile(join(agent,'diff-review','config.json'),JSON.stringify({version:1,repositories:[{name:'test',path:root,defaultBase:'HEAD'}]}));
  const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agent;
  t.after(()=>{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;});
  const {initTheme}=await import('@earendil-works/pi-coding-agent');initTheme('dark');
  const {visibleWidth}=await import('@earendil-works/pi-tui');const {default:extension}=await import('../src/index.ts');let command;
  extension({registerCommand:(_n,c)=>command=c,on(){},events:{on(){}}});
  const theme={appearance:'dark',colors:{accent:'accent'},style:(text,options)=>options.underline?'\x1b[4m'+text+'\x1b[0m':text};
  let draft='Existing';
  const ctx={mode:'tui',ui:{notify(){},getEditorText:()=>draft,setEditorText:v=>draft=v,custom:async factory=>new Promise(resolve=>{
    const view=factory({terminal:{rows:40},requestRender(){}},theme,{},resolve);view.focused=true;
    const lines=(width=110)=>view.render(width).map(plain);
    const click=label=>{const display=lines(),y=display.findIndex(l=>l.includes(label));assert(y>=0,label);view.handleMouse({type:'click',button:'left',x:display[y].indexOf(label)+1,y});};
    lines();view.handleInput('/');view.handleInput('alpa');view.handleInput('\x1b[D');view.handleInput('h');view.handleInput('\x1b[C');assert(lines().some(l=>l.includes('1/5')));
    view.handleInput('\x1b[A');assert(lines().some(l=>l.includes('5/5')));
    view.handleInput('\x1b[B');assert(lines().some(l=>l.includes('1/5')));
    assert(view.render(110).some(l=>l.includes('\x1b[4m')));
    for(const width of [110,60,30,8])assert(view.render(width).every(l=>visibleWidth(l)<=width));
    const body=lines().slice(5,9);view.handleInput('\r');assert(!lines().some(l=>l.includes('1/5')));
    assert.deepEqual(lines().slice(5,9),body);
    // Jumping through matches must not replace the original code-line selection.
    click('[ Add comment ]');view.handleInput('/np');view.handleInput('\r');
    view.handleInput('\x1b[C');lines();view.handleInput('/');view.handleInput('alpha');assert(lines().some(l=>l.includes('0/0')));
    view.handleInput('\x1b');assert(!lines().some(l=>l.includes('0/0')));
    view.handleInput('\x1b[D');lines();view.handleInput('/');view.handleInput('alpha');assert(lines().some(l=>l.includes('1/5')));
    view.handleInput('\x1b');
    click('[ Ready ]');
  })}};
  await command.handler('search-test',ctx);
  assert(draft.startsWith('Existing\n\n'));assert(draft.includes('/np'));assert(draft.includes('Old alpha ALPHA'));
});
