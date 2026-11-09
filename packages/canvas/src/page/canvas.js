// The canvas page: frames as live iframes on a pannable, zoomable surface, with comments.
// Plain JavaScript, served as is; it talks only to its own server.

const name = document.body.dataset.canvas;
const api = path => `/${name}/api/${path}`;
const $ = selector => document.querySelector(selector);
const viewport = $('#viewport'), world = $('#world'), popover = $('#popover');

let state = { frames: [], comments: [], port: Number(location.port) || 80 };
let view = { x: 40, y: 40, k: 1 };
let connected = true;
let fittedOnce = false;
const elements = new Map();

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const frameUrl = f => `http://${f.id}--${name}.localhost:${state.port}/${f.entry}`;

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  $('#zoom').textContent = `${Math.round(view.k * 100)}%`;
}

function notice(text) {
  const el = $('#notice');
  el.textContent = text; el.hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

async function call(path, method, payload) {
  const response = await fetch(api(path), { method, headers: { 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  const result = await response.json().catch(() => ({}));
  if (response.status === 409) { notice('Someone else changed this frame; showing the current version.'); await load(); return null; }
  if (!response.ok) { notice(result.error || `Could not save (${response.status}).`); return null; }
  return result;
}

async function load() {
  const response = await fetch(api('state'));
  if (!response.ok) return;
  state = await response.json();
  render();
  if (!fittedOnce) { fittedOnce = true; if (!fitFromHash()) fit(); }
}

// ---------- frames ----------

function frameElement(frame) {
  const el = document.createElement('div');
  el.className = 'frame';
  el.innerHTML = '<div class="title"><strong></strong><span class="size"></span><span class="count"></span></div><div class="body"><iframe sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe><div class="shield"></div></div>';
  const title = el.querySelector('.title');
  title.addEventListener('pointerdown', event => startDrag(event, frame.id));
  title.addEventListener('dblclick', () => fit([frame.id]));
  el.querySelector('.shield').addEventListener('click', event => newComment(event, frame.id));
  world.appendChild(el);
  return el;
}

function render() {
  const seen = new Set();
  for (const frame of state.frames) {
    seen.add(frame.id);
    let entry = elements.get(frame.id);
    if (!entry) { entry = { el: frameElement(frame), hash: '', src: '' }; elements.set(frame.id, entry); }
    const { el } = entry;
    el.style.left = `${frame.x}px`; el.style.top = `${frame.y}px`;
    el.querySelector('.title strong').textContent = frame.title;
    el.querySelector('.size').textContent = `${frame.width}×${frame.height}`;
    const body = el.querySelector('.body');
    body.style.width = `${frame.width}px`; body.style.height = `${frame.height}px`;
    const iframe = el.querySelector('iframe');
    const src = frameUrl(frame);
    // Reload only when the frame's content or entry changed, not when it moved.
    const contentKey = `${src}|${frame.updatedAt}`;
    if (entry.src !== src || (entry.hash !== frame.hash && entry.content !== contentKey && !movedOnly(entry, frame))) iframe.src = src;
    entry.src = src; entry.hash = frame.hash; entry.content = contentKey; entry.x = frame.x; entry.y = frame.y; entry.w = frame.width; entry.h = frame.height;
    renderPins(frame, body, el);
  }
  for (const [id, entry] of elements) if (!seen.has(id)) { entry.el.remove(); elements.delete(id); }
  const open = state.comments.filter(c => c.state === 'open').length;
  $('#summary').textContent = `${state.frames.length} frame${state.frames.length === 1 ? '' : 's'} · ${open} open comment${open === 1 ? '' : 's'}`;
}

function movedOnly(entry, frame) {
  return entry.w === frame.width && entry.h === frame.height && (entry.x !== frame.x || entry.y !== frame.y);
}

function renderPins(frame, body, el) {
  body.querySelectorAll('.pin').forEach(p => p.remove());
  const mine = state.comments.filter(c => c.frame === frame.id);
  mine.forEach((comment, index) => {
    const pin = document.createElement('div');
    pin.className = `pin${comment.state === 'resolved' ? ' resolved' : ''}`;
    pin.textContent = String(index + 1);
    pin.style.left = `${clamp(comment.x, 0, frame.width)}px`;
    pin.style.top = `${clamp(comment.y, 0, frame.height)}px`;
    pin.title = comment.text;
    pin.addEventListener('click', event => { event.stopPropagation(); openComment(event, comment, index + 1); });
    body.appendChild(pin);
  });
  const open = mine.filter(c => c.state === 'open').length;
  el.querySelector('.count').textContent = open ? `${open} comment${open === 1 ? '' : 's'}` : '';
}

// ---------- moving ----------

function startDrag(event, id) {
  if (event.button !== 0 || !connected) return;
  event.preventDefault(); event.stopPropagation();
  const frame = state.frames.find(f => f.id === id);
  const el = elements.get(id).el;
  const start = { x: event.clientX, y: event.clientY, fx: frame.x, fy: frame.y };
  let moved = false;
  const onMove = e => {
    const dx = (e.clientX - start.x) / view.k, dy = (e.clientY - start.y) / view.k;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    el.style.left = `${Math.round(start.fx + dx)}px`; el.style.top = `${Math.round(start.fy + dy)}px`;
  };
  const onUp = async e => {
    window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
    if (!moved) return;
    const x = Math.round(start.fx + (e.clientX - start.x) / view.k), y = Math.round(start.fy + (e.clientY - start.y) / view.k);
    const result = await call('move', 'POST', { frame: id, x, y, hash: frame.hash });
    if (result?.frame) { Object.assign(frame, result.frame); render(); } else await load();
  };
  window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
}

// ---------- panning and zooming ----------

viewport.addEventListener('pointerdown', event => {
  if (event.target !== viewport && event.target !== world) return;
  closePopover();
  const start = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
  viewport.classList.add('panning');
  const onMove = e => { view.x = start.vx + e.clientX - start.x; view.y = start.vy + e.clientY - start.y; applyView(); };
  const onUp = () => { viewport.classList.remove('panning'); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
});

function zoomAt(factor, cx, cy) {
  const k = clamp(view.k * factor, 0.05, 3);
  view.x = cx - (cx - view.x) * (k / view.k);
  view.y = cy - (cy - view.y) * (k / view.k);
  view.k = k; applyView();
}

viewport.addEventListener('wheel', event => {
  event.preventDefault();
  const rect = viewport.getBoundingClientRect();
  if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
  else { view.x -= event.deltaX; view.y -= event.deltaY; applyView(); }
}, { passive: false });

function fit(ids) {
  const frames = ids?.length ? state.frames.filter(f => ids.includes(f.id) || ids.includes(f.title)) : state.frames;
  if (!frames.length) { applyView(); return; }
  const left = Math.min(...frames.map(f => f.x)), top = Math.min(...frames.map(f => f.y));
  const right = Math.max(...frames.map(f => f.x + f.width)), bottom = Math.max(...frames.map(f => f.y + f.height + 28));
  const rect = viewport.getBoundingClientRect();
  const k = clamp(Math.min((rect.width - 80) / (right - left), (rect.height - 80) / (bottom - top)), 0.05, 1.5);
  view = { k, x: (rect.width - (right - left) * k) / 2 - left * k, y: (rect.height - (bottom - top) * k) / 2 - top * k };
  applyView();
}

function fitFromHash() {
  const match = /^#fit=(.*)$/.exec(location.hash);
  if (!match) return false;
  fit(match[1].split(',').filter(Boolean).map(decodeURIComponent));
  return true;
}
window.addEventListener('hashchange', fitFromHash);

// ---------- comments ----------

function setCommenting(on) {
  document.body.classList.toggle('commenting', on);
  $('#comment').classList.toggle('on', on);
  if (!on) closePopover();
}

function placePopover(event) {
  popover.hidden = false;
  popover.style.left = `${clamp(event.clientX + 12, 8, innerWidth - 316)}px`;
  popover.style.top = `${clamp(event.clientY + 12, 52, innerHeight - 200)}px`;
}
function closePopover() { popover.hidden = true; popover.replaceChildren(); }

function button(label, onClick) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', onClick); return b;
}

function editor(initial, onSave) {
  const textarea = document.createElement('textarea');
  textarea.value = initial;
  textarea.placeholder = 'Comment';
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === 'Escape') closePopover();
  });
  const save = async () => { if (!textarea.value.trim()) return; if (await onSave(textarea.value)) closePopover(); };
  const actions = document.createElement('div'); actions.className = 'actions';
  actions.append(button('Cancel', closePopover), button('Save', save));
  popover.replaceChildren(textarea, actions);
  textarea.focus();
}

function newComment(event, frameId) {
  if (!connected) return;
  const body = event.currentTarget.parentElement;
  const rect = body.getBoundingClientRect();
  const x = Math.round((event.clientX - rect.left) / view.k), y = Math.round((event.clientY - rect.top) / view.k);
  placePopover(event);
  editor('', async text => !!(await call('comments', 'POST', { frame: frameId, x, y, text })) && (await load(), true));
}

function openComment(event, comment, number) {
  placePopover(event);
  const meta = document.createElement('div'); meta.className = 'meta';
  meta.textContent = `#${number} · ${comment.state} · ${new Date(comment.updatedAt).toLocaleString()}`;
  const text = document.createElement('p'); text.className = 'text'; text.textContent = comment.text;
  const actions = document.createElement('div'); actions.className = 'actions';
  const edit = button('Edit', () => editor(comment.text, async value => !!(await call(`comments/${comment.id}`, 'PATCH', { text: value })) && (await load(), true)));
  const toggle = button(comment.state === 'open' ? 'Resolve' : 'Reopen', async () => {
    if (await call(`comments/${comment.id}`, 'PATCH', { state: comment.state === 'open' ? 'resolved' : 'open' })) { closePopover(); await load(); }
  });
  const remove = button('Delete', async () => { if (await call(`comments/${comment.id}`, 'DELETE')) { closePopover(); await load(); } });
  for (const b of [edit, toggle, remove]) b.disabled = !connected;
  actions.append(remove, toggle, edit);
  popover.replaceChildren(meta, text, actions);
}

// ---------- controls ----------

$('#comment').addEventListener('click', () => setCommenting(!document.body.classList.contains('commenting')));
$('#fit').addEventListener('click', () => fit());
const zoomCentre = factor => { const r = viewport.getBoundingClientRect(); zoomAt(factor, r.width / 2, r.height / 2); };
$('#zoomin').addEventListener('click', () => zoomCentre(1.25));
$('#zoomout').addEventListener('click', () => zoomCentre(0.8));
window.addEventListener('keydown', event => {
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
  if (event.key === 'Escape') { closePopover(); setCommenting(false); }
  else if (event.key === 'c' || event.key === 'C') setCommenting(!document.body.classList.contains('commenting'));
  else if (event.key === 'f' || event.key === 'F') fit();
  else if (event.key === '+' || event.key === '=') zoomCentre(1.25);
  else if (event.key === '-' || event.key === '_') zoomCentre(0.8);
});

// ---------- live updates ----------

function setConnected(on) {
  if (connected === on) return;
  connected = on;
  $('#banner').hidden = on;
  $('#comment').disabled = !on;
  if (!on) setCommenting(false);
}

const events = new EventSource(api('events'));
events.addEventListener('change', () => load());
events.addEventListener('open', () => { setConnected(true); load(); });
events.addEventListener('error', () => setConnected(false));

applyView();
load();
