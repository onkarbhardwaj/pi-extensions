import test from 'node:test';
import assert from 'node:assert/strict';
import { renderedMatches } from '../src/core.ts';
import { stripVTControlCharacters as plain } from 'node:util';

test('rendered search is literal, case-insensitive and counts occurrences without ANSI', () => {
  assert.deepEqual(renderedMatches(['\x1b[1mAlpha ALPHA\x1b[0m', '世界 alpha'], 'alpha'),[
    {row:0,start:0,end:5},{row:0,start:6,end:11},{row:1,start:3,end:8}]);
  assert.equal(renderedMatches(['a.b aXb'], 'a.b').length,1);
  assert.equal(renderedMatches(['aaa'], '').length,0);
  assert.equal(renderedMatches(['İ I i'], 'i').length,2);
});

const available=['@earendil-works/pi-coding-agent','@earendil-works/pi-tui'].every(name=>{try{import.meta.resolve(name);return true;}catch{return false;}});
test('reader search navigates without modifying selection and leaves comment typing alone', {
  skip: !available && 'Pi peers needed for reader interaction test.',
}, async () => {
  const {initTheme}=await import('@earendil-works/pi-coding-agent');initTheme('dark');
  const {visibleWidth}=await import('@earendil-works/pi-tui');
  const {reader}=await import('../src/reader.ts');
  const theme={appearance:'dark',colors:{text:'text',accent:'accent',toolPendingBg:'bg',userMessageBg:'selected'},fg:(_c,t)=>t,
    style:(t,options)=>options.underline?'\x1b[4m'+t+'\x1b[0m':t};
  let result,closed=false;
  const files=[{path:'/a.md',name:'a.md',hash:'a',text:'Alpha first\n\nMiddle\n\nAlpha second alpha'},
    {path:'/b.md',name:'b.md',hash:'b',text:'Beta alpha'}];
  const view=reader({terminal:{rows:40},requestRender(){}},theme,r=>{result=r;closed=true;},
    {files,add:async()=>files[0],remove:async()=>{},refresh:async()=>files[0]});view.focused=true;
  const lines=(width=100)=>view.render(width).map(plain);
  const click=label=>{const display=lines(),y=display.findIndex(l=>l.includes(label));assert(y>=0,label);view.handleMouse({type:'click',button:'left',x:display[y].indexOf(label)+1,y});};
  assert(!lines().some(l=>l.includes('wheel: pane')));
  view.handleInput('?');assert(lines().some(l=>l.includes('Tab: focus controls')));
  view.handleInput('\x1b');assert(!closed);assert(!lines().some(l=>l.includes('Tab: focus controls')));
  click('[?] Help');assert(lines().some(l=>l.includes('Tab: focus controls')));
  view.handleInput('\x1b');
  click('Alpha first');
  view.handleInput('/');view.handleInput('alpa');view.handleInput('\x1b[D');view.handleInput('h');view.handleInput('\x1b[C');assert(lines().some(l=>l.includes('1/3')));
  view.handleInput('\x1b[B');assert(lines().some(l=>l.includes('2/3')));
  view.handleInput('\x1b[A');assert(lines().some(l=>l.includes('1/3')));
  view.handleInput('\x1b[A');assert(lines().some(l=>l.includes('3/3')));
  assert(view.render(100).some(l=>l.includes('\x1b[4m')));
  const before=lines().slice(4,7);view.handleInput('\r');assert(!lines().some(l=>l.includes('3/3')));
  assert.deepEqual(lines().slice(4,7),before);assert(!view.render(100).some(l=>l.includes('\x1b[4m')));
  click('[Comment]');view.handleInput('/np?');view.handleInput('\r');
  click('[Ready]');assert(result.includes('> Alpha first'));assert(result.includes('/np'));assert(closed);
  // Separate interaction covers file switches, missing matches, resize and Esc.
  closed=false;const second=reader({terminal:{rows:40},requestRender(){}},theme,()=>closed=true,{files,add:async()=>files[0],remove:async()=>{},refresh:async()=>files[0]});
  second.focused=true;second.render(100);second.handleInput('/');second.handleInput('alpha');second.render(100);second.handleInput('\x1b');assert(!closed);
  assert(!second.render(100).map(plain).some(l=>l.includes('1/3')));
  second.handleInput('\x1b[C');second.render(100);second.handleInput('/');second.handleInput('alpha');
  assert(second.render(100).map(plain).some(l=>l.includes('1/1')));
  for(const width of [100,60,30,8])assert(second.render(width).every(l=>visibleWidth(l)<=width));
  second.handleInput('/');second.handleInput('\x15');second.handleInput('missing');assert(second.render(100).map(plain).some(l=>l.includes('0/0')));
});
