"use strict";
/* Editor: text is edited on the page itself. A draft lives in this browser until "publish" writes it to the repository. */
const $ = s => document.querySelector(s);
const C = window.ADMIN_CONFIG, Store = window.Store;
const frame = $('#frame'), dlg = $('#dlg');
const HOME = 'index';
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const RESERVED = new Set(['index', 'assets', 'blog', 'data', 'src', 'admin', 'status']);
// what must not act inside the editor or the preview: scripts and automatic redirects
const INERT = /<script\b[\s\S]*?<\/script[^>]*>|<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi;
const PLACEHOLDER = /Напишите здесь свой текст|Новый заголовок|Короткое пояснение|Одно предложение о том/;
const WIDE = 1100; // from this width the block list is a side panel and the page shows as on a computer

let page = HOME, sha = null, published = '', baseline = null, scripts = [], sheetBlocks = {}, undo = [], last = '';
let saveTimer = null, phone = innerWidth < WIDE, remotePages = [HOME];
let busy = false, frozen = false, unsaved = false;
const freshPhotos = new Map(); // path -> picture, until the site has rebuilt
if (Store.photos) Object.entries(Store.photos()).forEach(([path, url]) => freshPhotos.set(path, url));
const undoByPage = new Map();

let quietTimer = null;
function say(t) {
  const el = $('#state');
  el.textContent = t; el.classList.remove('quiet');
  clearTimeout(quietTimer);
  // on a phone the status floats over the page: calm messages leave after a moment
  if (/^(Всё опубликовано|Черновик сохранён|Черновик сброшен|Опубликовано|Меняется|Квиз)/.test(t)) quietTimer = setTimeout(() => el.classList.add('quiet'), 3500);
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const doc = () => frame.contentDocument;
const pathOf = n => n === HOME ? 'src/template.html' : `${n}/index.html`;
const readOrNull = path => Store.read(path).catch(e => { if (e.status === 404) return null; throw e; });

function fail(e) {
  if (e.status === 401) { Store.forget(); showLogin(e.message); return; }
  say('Не получилось: ' + e.message);
}

/* ---------- veil: nothing can be touched while the editor loads or publishes ---------- */
function veil(text, label, action, otherLabel, otherAction) {
  $('#veiltext').textContent = text;
  [['#veilbtn', label, action], ['#veilalt', otherLabel, otherAction]].forEach(([id, caption, run]) => {
    const b = $(id); b.hidden = !caption; b.textContent = caption || ''; b.onclick = run || null;
  });
  $('#veil').classList.toggle('waiting', !label);
  if (frame.contentDocument && frame.contentDocument.activeElement) frame.contentDocument.activeElement.blur();
  frame.blur();
  $('#app').inert = true; $('#veil').hidden = false;
}
function unveil() {
  $('#veil').hidden = true; $('#app').inert = false;
  if (frozen) showFrozen();
}
async function locked(text, work) {
  if (busy) return;
  busy = true; veil(text);
  try { await work(); } catch (e) { fail(e); } finally { busy = false; unveil(); }
}

/* ---------- drafts ---------- */
const draftKey = n => `site-admin-draft:${C.owner}/${C.repo}:${n}`;
const backupKey = n => `site-admin-backup:${C.owner}/${C.repo}:${n}`;
function readKey(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
function writeKey(key, value) {
  try { value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key); return true; } catch (e) { return false; }
}
const getDraft = n => readKey(draftKey(n));
function setDraft(n, value) {
  const ok = writeKey(draftKey(n), value);
  if (!ok) say('Черновик не поместился в память браузера. Опубликуйте сейчас и не закрывайте страницу');
  return ok;
}
function namesUnder(prefix) {
  try { return Object.keys(localStorage).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)); } catch (e) { return []; }
}
const draftNames = () => namesUnder(draftKey(''));
const rawDraft = n => { try { return localStorage.getItem(draftKey(n)); } catch (e) { return null; } };
// copies of work she removed: the last three per page, newest first
const backupsOf = n => { const v = readKey(backupKey(n)); return Array.isArray(v) ? v : []; };
const keepBackups = (n, list) => writeKey(backupKey(n), list.length ? list.slice(0, 3) : null);
const addBackup = (n, copy) => keepBackups(n, [{html: copy.html, sha: copy.sha, at: Date.now()}, ...backupsOf(n).filter(b => b.html !== copy.html)]);
// what would be lost: her own edits, not an old version she opened and left untouched
function ownWork(n) {
  if (n === page && unsaved) return {html: serialise(), sha};
  const d = getDraft(n);
  return d && !d.restored ? d : null;
}
async function keepCopy(n, copy) {
  if (!copy || addBackup(n, copy)) return true;
  return ask('Копию сохранить не получилось', '<p>Память браузера занята. Если продолжить, эти правки пропадут.</p>', 'Всё равно убрать');
}
// two open tabs must not overwrite each other: the older one stops
function showFrozen() {
  veil('Эту страницу изменили в другой вкладке. Здесь правки остановлены.', 'Открыть свежую версию', () => locked('Открываю…', async () => {
    await readPages();
    await load(remotePages.includes(page) || getDraft(page) ? page : HOME);
    frozen = false;
  }));
}
addEventListener('storage', e => {
  if ($('#app').hidden || e.key !== draftKey(page)) return;
  frozen = true; clearTimeout(saveTimer); saveTimer = null; unsaved = false;
  if (dlg.open) dlg.close();
  if (!busy) showFrozen();
});
addEventListener('beforeunload', e => { if (unsaved) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- sheet blocks: the editor shows today's data, the saved file keeps its own ---------- */
const SYNC = /<!--sync:(\w+)-->([\s\S]*?)<!--\/sync:\1-->/g;
const blocksOf = html => Object.fromEntries([...html.matchAll(SYNC)].map(m => [m[1], m[2]]));
const withBlocks = (html, blocks) => html.replace(SYNC, (all, name, inner) => `<!--sync:${name}-->${name in blocks ? blocks[name] : inner}<!--/sync:${name}-->`);

/* ---------- loading ---------- */
/** change() runs only after the network answered: it may rewrite drafts, or return false to stop. */
async function load(name, change) {
  clearTimeout(saveTimer); saveTimer = null;
  const exists = remotePages.includes(name);
  if (!exists && !getDraft(name) && !change) throw new Error('Нет такой страницы');
  const remote = exists ? await Store.read(pathOf(name)) : null;
  const live = name === HOME ? (await Store.read('index.html')).text : '';
  if (change && await change() === false) return false;
  const draft = getDraft(name);
  if (!draft && !remote) throw new Error('Нет такой страницы');
  const parts = compose(draft ? draft.html : remote.text, blocksOf(live)); // may refuse: nothing has changed yet
  if (frame.dataset.ready) undoByPage.set(frame.dataset.ready, {undo, key: contentKey()});
  delete frame.dataset.ready;
  page = name;
  published = remote ? remote.text : '';
  sha = draft ? draft.sha : remote ? remote.sha : null;
  await show(parts);
  unsaved = false;
  baseline = draft ? null : serialise();
  const stale = draft && remote && draft.sha !== remote.sha;
  say(stale ? 'Черновик старее сайта. При публикации спрошу, что делать' : draft ? 'Есть неопубликованные изменения' : 'Всё опубликовано');
  frame.dataset.ready = name;
  return true;
}

function compose(html, live) {
  const found = [];
  let shown = withBlocks(html, live);
  freshPhotos.forEach((url, path) => { shown = shown.split(`"${path}"`).join(`"${url}"`); });
  const safe = shown
    .replace(INERT, m => { found.push(m); return `<template data-adm-script="${found.length - 1}"></template>`; });
  const based = safe.replace(/<head([^>]*)>/i, (m, a) => `<head${a}><base href="${C.site}" data-adm>`);
  if (new DOMParser().parseFromString(based, 'text/html').querySelector('script, iframe[srcdoc]')) throw new Error('на странице есть код, который редактор не может отключить. Напишите нам');
  return {based, found, blocks: blocksOf(html)};
}
async function show(parts) {
  scripts = parts.found; sheetBlocks = parts.blocks;
  await new Promise(res => { frame.onload = res; frame.srcdoc = parts.based; });
  prepare();
  last = snapshot();
  const kept = undoByPage.get(page);
  undo = kept && kept.key === contentKey() ? kept.undo : []; // only if the page is the one the steps came from
  changed.t = 0;
  $('#undo').disabled = !undo.length;
  fit(); list(); pageList();
}

function lockedNodes(d) {
  const set = new Map(), it = d.createNodeIterator(d.body, NodeFilter.SHOW_COMMENT);
  for (let c; (c = it.nextNode());) {
    const m = c.data.match(/^sync:(\w+)$/);
    if (!m) continue;
    let n = c.nextSibling;
    while (n && !(n.nodeType === 8 && n.data === '/sync:' + m[1])) {
      if (n.nodeType === 1) set.set(n, C.demo ? 'Меняется в таблице. Она настоящая, не тестовая' : 'Меняется в таблице');
      if (m[1] === 'allposts' && n.nodeType === 1) break;
      n = n.nextSibling;
    }
  }
  // the quiz script writes into this card
  const quiz = d.querySelector('#qcard');
  if (quiz) set.set(quiz, 'Квиз работает на сайте. Пока меняем его мы');
  return set;
}

const INLINE = new Set(['B', 'I', 'EM', 'STRONG', 'BR', 'SPAN', 'U', 'SMALL', 'SUP', 'SUB', 'A']);
function isText(el) {
  if (['SCRIPT', 'STYLE', 'SVG', 'VIDEO', 'IMG', 'TEMPLATE', 'SOURCE', 'TRACK', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName.toUpperCase())) return false;
  if (el.hasAttribute('data-empty')) return true; // she cleared it earlier: it must stay editable
  if (el.querySelector(':scope > .h1l')) return false; // each headline line is edited on its own
  const direct = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
  const inline = [...el.children].every(c => INLINE.has(c.tagName) && !c.classList.contains('btn') && [...c.querySelectorAll('*')].every(x => INLINE.has(x.tagName)));
  return inline && direct;
}
function editable(el) { el.setAttribute('contenteditable', 'true'); el.setAttribute('data-adm-ed', ''); }
const keepStyles = root => root.querySelectorAll('[style]').forEach(n => n.setAttribute('data-adm-style', ''));
// browsers add inline styles when lines are merged: only the styles the design came with survive
function tidy(el) {
  el.querySelectorAll('font').forEach(f => f.replaceWith(...f.childNodes));
  el.querySelectorAll('[style]:not([data-adm-style])').forEach(n => n.removeAttribute('style'));
}

function prepare() {
  const d = doc(), locks = lockedNodes(d);
  const css = d.createElement('style');
  css.setAttribute('data-adm', '');
  css.textContent = `[data-off]{display:revert!important;opacity:.28!important}
  [contenteditable]{outline:2px dashed transparent;outline-offset:3px;cursor:text;min-width:1ch}
  [contenteditable]:hover{outline-color:#8a5a00}[contenteditable]:focus{outline:2px solid #8a5a00}
  @media(hover:none){[contenteditable]{outline:1px dashed #8a5a00}a.btn[contenteditable]:not(:focus),button[contenteditable]:not(:focus),.h1l[contenteditable]:not(:focus){outline-color:transparent}h1:has(>.h1l){outline:1px dashed #8a5a00;outline-offset:3px}}
  [data-empty]{outline:2px dashed #a1261d!important;display:inline-block;min-width:6ch;min-height:1.2em}
  img[data-adm-img]{cursor:pointer}img[data-adm-img]:hover{filter:brightness(.85)}
  [data-adm-lock]{position:relative;outline:2px dotted #6b6a66;outline-offset:2px}
  [data-adm-lock]::after{content:attr(data-adm-lock);position:absolute;top:6px;right:6px;background:#1d1d1b;color:#fff;font:12px/1.2 sans-serif;padding:5px 8px;border-radius:6px;z-index:9}
  .h1l{opacity:1!important;transform:none!important;animation:none!important}.rv.extra{display:block!important}`;
  d.head.appendChild(css);
  keepStyles(d.body);
  // closed answers are opened for editing and closed again on save
  d.querySelectorAll('details:not([open])').forEach(x => { x.open = true; x.setAttribute('data-adm-open', ''); });
  locks.forEach((label, n) => n.setAttribute('data-adm-lock', label));
  (function walk(el) {
    if (el.hasAttribute('data-adm-lock')) return;
    if (el.tagName === 'IMG') { el.setAttribute('data-adm-img', ''); return; }
    if (el !== d.body && (el.classList.contains('h1l') || isText(el))) { editable(el); return; }
    [...el.children].forEach(walk);
  })(d.body);
  const host = n => n && (n.nodeType === 1 ? n : n.parentElement).closest('[data-adm-ed]');
  d.addEventListener('click', e => {
    if (e.target.closest('a,button,summary,label,area')) e.preventDefault();
    const lock = e.target.closest('[data-adm-lock]');
    if (lock) { say(lock.getAttribute('data-adm-lock')); return; }
    if (e.target.hasAttribute('data-adm-img')) { pickImage(e.target); return; }
    const btn = e.target.closest('a.btn');
    if (btn) editButton(btn);
  }, true);
  d.addEventListener('submit', e => e.preventDefault(), true);
  d.addEventListener('drop', e => e.preventDefault(), true);
  d.addEventListener('paste', e => {
    e.preventDefault();
    const el = host(e.target), text = e.clipboardData.getData('text/plain').replace(/\r/g, '');
    if (!el || !text) return;
    if (el.closest('summary,button')) { d.execCommand('insertText', false, text.replace(/\n+/g, ' ')); return; }
    text.split('\n').forEach((line, i) => {
      if (i) d.execCommand('insertLineBreak');
      if (line) d.execCommand('insertText', false, line);
    });
  });
  d.addEventListener('keydown', e => {
    if (!e.target.isContentEditable) return;
    const control = e.target.closest('summary,button'); // browsers treat Space and Enter there as a press
    if (e.key === 'Enter') { e.preventDefault(); if (!control) d.execCommand('insertLineBreak'); }
    else if (e.key === ' ' && control) { e.preventDefault(); d.execCommand('insertText', false, ' '); }
  });
  d.addEventListener('keyup', e => { if (e.key === ' ' && e.target.closest('summary,button')) e.preventDefault(); });
  d.addEventListener('input', e => {
    const el = host(e.target);
    if (el) {
      tidy(el);
      el.toggleAttribute('data-empty', !el.textContent.trim());
      // the phone menu repeats the top menu
      if (el.matches('nav.main a, a.hdr-cta')) d.querySelectorAll(`.mmenu a[href="${CSS.escape(el.getAttribute('href'))}"]`).forEach(a => { a.textContent = el.textContent; });
    }
    changed(true);
  });
}

/* ---------- serialise: remove everything the editor added ---------- */
function serialise() {
  const root = doc().documentElement.cloneNode(true);
  root.querySelectorAll('[data-adm]').forEach(n => n.remove());
  root.querySelectorAll('[data-adm-open]').forEach(n => { n.removeAttribute('open'); n.removeAttribute('data-adm-open'); });
  root.querySelectorAll('[data-adm-ed]').forEach(n => { n.removeAttribute('contenteditable'); n.removeAttribute('data-adm-ed'); });
  ['data-adm-img', 'data-adm-lock', 'data-adm-style'].forEach(a => root.querySelectorAll(`[${a}]`).forEach(n => n.removeAttribute(a)));
  let html = ('<!doctype html>\n' + root.outerHTML + '\n').replace(/<template data-adm-script="(\d+)"><\/template>/g, (m, i) => scripts[+i]);
  freshPhotos.forEach((url, path) => { html = html.split(`"${url}"`).join(`"${path}"`); });
  html = html.replace(/\s*<\/body>\s*<\/html>\s*$/, '\n</body></html>\n');
  return withBlocks(html, sheetBlocks);
}

const snapshot = () => doc().body.innerHTML;
const contentKey = () => serialise().replace(/\s+/g, ' ');
const isDirty = () => baseline === null || serialise() !== baseline;
function changed(typing) {
  if (frozen) return;
  const now = snapshot();
  if (now === last) return;
  if (!typing || !undo.length || !changed.t || Date.now() - changed.t > 1500) undo.push(last);
  changed.t = typing ? Date.now() : 0; // a block action is always a step of its own
  last = now;
  if (undo.length > 40) undo.shift();
  $('#undo').disabled = false;
  say('Сохраняю черновик…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
  if (!typing) list();
}
function save() {
  clearTimeout(saveTimer); saveTimer = null;
  if (frozen) return;
  unsaved = !setDraft(page, {html: serialise(), sha});
  if (!unsaved) { say('Черновик сохранён'); pageList(); }
}
const flush = () => { if (saveTimer) save(); };
addEventListener('pagehide', flush);
$('#undo').onclick = () => {
  const prev = undo.pop();
  if (prev === undefined) return;
  doc().body.innerHTML = prev; last = prev; changed.t = 0;
  $('#undo').disabled = !undo.length;
  list(); save();
};

/* ---------- blocks ---------- */
const sections = () => [...doc().querySelectorAll('main > section')];
function title(s) {
  const h = s.querySelector('h1,h2,h3');
  return (h ? h.innerText || h.textContent : s.textContent).replace(/\s+/g, ' ').trim() || 'Блок';
}
// scroll the page inside the frame only: scrollIntoView would also shift the editor around it
function reveal(s) {
  const w = frame.contentWindow;
  w.scrollTo({top: s.getBoundingClientRect().top + w.scrollY - 70, behavior: 'smooth'});
}
function list() {
  const box = $('#blocks'), all = sections(); box.innerHTML = '';
  all.forEach((s, i) => {
    const off = s.hasAttribute('data-off'), el = document.createElement('div');
    el.className = 'blk' + (off ? ' off' : '');
    el.innerHTML = `<button type="button" class="t">${esc(title(s))}${off ? ' (скрыт)' : ''}</button><div class="row">
      <button type="button" data-a="up" aria-label="Выше" title="Выше" ${i ? '' : 'disabled'}>↑</button><button type="button" data-a="down" aria-label="Ниже" title="Ниже" ${i < all.length - 1 ? '' : 'disabled'}>↓</button>
      <button type="button" data-a="off">${off ? 'Показать' : 'Скрыть'}</button><button type="button" data-a="theme">Цвет фона</button>
      <button type="button" data-a="copy">Дублировать</button><button type="button" data-a="del">Удалить</button></div>`;
    el.querySelector('.t').onclick = () => { reveal(s); sheet(false); };
    el.querySelector('.row').onclick = e => { const a = e.target.dataset.a; if (a) act(s, a); };
    box.appendChild(el);
  });
}
const linksTo = s => s.id ? doc().querySelectorAll(`a[href="#${CSS.escape(s.id)}"]`) : [];
async function act(s, a) {
  const all = sections(), i = all.indexOf(s);
  const linked = s.querySelector('[data-adm-lock]');
  if (a === 'up' && i > 0) all[i - 1].before(s);
  else if (a === 'down' && i < all.length - 1) all[i + 1].after(s);
  else if (a === 'off') {
    const off = !s.hasAttribute('data-off');
    s.toggleAttribute('data-off', off);
    linksTo(s).forEach(l => l.toggleAttribute('data-off', off));
    ensureOffRule();
  } else if (a === 'theme') { const dark = s.classList.contains('dark'); s.classList.toggle('dark', !dark); s.classList.toggle('light', dark); }
  else if (a === 'copy') {
    if (linked) return say('Этот блок связан с таблицей или квизом, копия невозможна');
    const c = s.cloneNode(true); c.removeAttribute('id'); c.querySelectorAll('[id]').forEach(x => x.removeAttribute('id'));
    c.querySelectorAll('.steps').forEach(x => x.classList.add('in')); // the site script animates only the original
    s.after(c);
  } else if (a === 'del') {
    if (linked) return say('Этот блок связан с таблицей или квизом. Его можно скрыть');
    if (!await ask('Удалить блок?', `<p>${esc(title(s))}</p><p>Вернуть можно кнопкой «Шаг назад», пока редактор открыт.</p>`, 'Удалить')) return;
    const links = linksTo(s);
    if (links.length) { links.forEach(l => l.setAttribute('data-off', '')); ensureOffRule(); } // no menu items that lead nowhere
    s.remove();
  }
  changed(false);
  if (s.isConnected) reveal(s);
}
function ensureOffRule() {
  const d = doc();
  if (d.querySelector('style[data-keep="off"]')) return;
  const st = d.createElement('style'); st.setAttribute('data-keep', 'off'); st.textContent = '[data-off]{display:none!important}';
  d.head.insertBefore(st, d.head.querySelector('style[data-adm]'));
}
const LIB = {
  text: '<div class="wrap"><h2>Новый заголовок</h2><p style="margin-top:18px">Напишите здесь свой текст.</p></div>',
  cards: '<div class="wrap"><h2>Три шага</h2><div class="steps in">' + [1, 2, 3].map(n => `<div class="step"><span class="num" style="background:var(--forest)">${n}</span><h3>Название</h3><p>Короткое пояснение.</p></div>`).join('') + '</div></div>',
  cta: '<div class="wrap"><h2>Напишите мне</h2><p>Одно предложение о том, что будет дальше.</p><p style="margin-top:24px"><a class="btn btn-lime tg" data-msg="Здравствуйте!" href="#">Написать мне</a></p></div>'
};
document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
  const d = doc(), main = d.querySelector('main');
  if (!main) return;
  const s = d.createElement('section'), all = sections();
  const before = all.length > 1 && all[all.length - 1].classList.contains('final') ? all[all.length - 1] : null;
  const neighbour = before ? before.previousElementSibling : all[all.length - 1];
  s.className = neighbour && neighbour.classList.contains('dark') ? 'light' : 'dark';
  s.innerHTML = LIB[b.dataset.add];
  keepStyles(s);
  s.querySelectorAll('h2,h3,p:not(:has(a)),.num').forEach(editable);
  if (before) before.before(s); else main.appendChild(s);
  sheet(false);
  changed(false);
  reveal(s);
});

/* ---------- dialogs, buttons, photos ---------- */
/** check() may return a message: the dialog then stays open and shows it. */
function ask(heading, body, ok, check) {
  dlg.innerHTML = `<form method="dialog"><h3>${heading}</h3>${body}<p class="warn" id="dlgerr" role="alert"></p><div class="acts"><button type="button" data-no>${ok ? 'Отмена' : 'Закрыть'}</button>${ok ? `<button class="main" value="ok">${ok}</button>` : ''}</div></form>`;
  dlg.querySelector('[data-no]').onclick = () => dlg.close('no');
  dlg.querySelector('form').onsubmit = e => {
    const problem = check ? check() : '';
    if (problem) { e.preventDefault(); $('#dlgerr').textContent = problem; }
  };
  dlg.returnValue = ''; dlg.showModal();
  // "close" arrives late: ignore the one left over from the dialog before this one
  return new Promise(res => { dlg.onclose = () => { if (!dlg.open) res(dlg.returnValue === 'ok'); }; });
}
function normaliseLink(value) {
  let href = value.trim().replace(/^(https?|mailto|tel):/i, m => m.toLowerCase());
  if (/^http:\/\//i.test(href)) href = 'https://' + href.slice(7);
  else if (/^[a-zа-я0-9-]+(\.[a-zа-я0-9-]+)+(\/|\?|$)/i.test(href)) href = 'https://' + href;
  return /^(https:\/\/\S+|#\S*|\/(?!\/)\S*|mailto:\S+|tel:\S+)$/.test(href) ? href : '';
}
async function editButton(a) {
  const tg = a.classList.contains('tg');
  const ok = await ask('Кнопка', `<label>Надпись</label><input id="bt" value="${esc(a.textContent.trim())}">` +
    (tg ? `<label>Сообщение, которое подставится в Telegram</label><textarea id="bm" rows="3">${esc(a.dataset.msg || '')}</textarea>`
        : `<label>Ссылка</label><input id="bl" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(a.getAttribute('href') || '')}">`), 'Готово',
    () => !tg && !normaliseLink($('#bl').value) ? 'Не похоже на ссылку. Например: https://t.me/имя или #format' : '');
  if (!ok) return;
  const label = $('#bt').value.trim();
  if (label && label !== a.textContent.trim()) {
    const icons = [...a.children].filter(c => c.tagName.toUpperCase() === 'SVG');
    a.textContent = label; icons.forEach(i => a.appendChild(i));
  }
  if (tg) a.dataset.msg = $('#bm').value; else a.setAttribute('href', normaliseLink($('#bl').value));
  changed(false);
}
let target = null;
function pickImage(img) { target = img; $('#file').value = ''; $('#file').click(); }
$('#file').onchange = async e => {
  const f = e.target.files[0];
  if (!f || !target) return;
  try {
    say('Уменьшаю фото…');
    const bmp = await createImageBitmap(f), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const alt = await ask('Новое фото', `<label>Что на фото (для поиска и незрячих)</label><input id="alt" value="${esc(target.alt || '')}">`, 'Заменить');
    if (!alt) return say('Фото не заменено');
    target.setAttribute('src', c.toDataURL('image/jpeg', .82));
    target.removeAttribute('srcset'); target.setAttribute('width', c.width); target.setAttribute('height', c.height);
    target.alt = $('#alt').value;
    changed(false);
  } catch (err) { say('Не получилось открыть это фото. Нужен JPEG или PNG'); }
};

/* ---------- publish ---------- */
function problems(html, name) {
  if (!/<\/html>\s*$/.test(html)) return 'страница сохранилась не целиком';
  if ([...doc().querySelectorAll('main h1, main h2')].some(h => !h.textContent.trim() && !h.closest('[data-off]'))) return 'на странице пустой заголовок. Напишите его или скройте блок';
  if (name !== HOME || !published) return '';
  const count = (s, m) => s.split(m).length - 1;
  const marks = published.match(/<!--\/?sync:\w+-->/g) || [];
  if (marks.some(m => count(html, m) !== count(published, m))) return 'потерян блок цен, отзывов или блога. Нажмите «Шаг назад»';
  if (['qbody', 'menuBtn', 'mmenu'].some(id => count(html, `id="${id}"`) !== count(published, `id="${id}"`))) return 'потерян квиз или меню. Нажмите «Шаг назад»';
  return '';
}
async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function uploadPhotos(html) {
  const found = [...new Set(html.match(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+(?=")/g) || [])];
  for (const url of found) {
    const base64 = url.split(',')[1];
    const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
    const path = `assets/up-${(await sha256(bytes)).slice(0, 16)}.jpg`;
    try { await Store.write(path, {base64}, 'Новое фото из редактора', null); }
    catch (e) { if (e.status !== 422) throw e; } // the same photo is already there
    freshPhotos.set('/' + path, url);
    html = html.split(url).join('/' + path);
  }
  return html;
}
/** Everything is passed in: nothing here depends on what is on the screen after the first wait. */
async function publish(name, base, content, note) {
  say('Публикую…');
  const mine = rawDraft(name), path = pathOf(name);
  const html = await uploadPhotos(content);
  const now = await readOrNull(path);
  const same = now && now.text === html; // an earlier try went through, only the answer was lost
  if (!same && (now ? now.sha !== base : base)) {
    const what = now ? 'Пока вы правили, эту страницу изменили: с другого устройства или мы.</p><p>Если опубликовать вашу версию, новые изменения пропадут со страницы. Они останутся в «Истории».'
      : 'Пока вы правили, эту страницу удалили с сайта. Публикация создаст её снова.';
    const ok = await ask(now ? 'Сайт уже изменился' : 'Страницу удалили', `<p>${what}</p>`, 'Опубликовать мою');
    if (!ok) return say('Не опубликовано: сайт изменился. Черновик цел');
  }
  if (frozen) return say('Не опубликовано: страницу изменили в другой вкладке');
  let newSha = same ? now.sha : null;
  try {
    if (!same) newSha = await Store.write(path, {text: html}, note, now ? now.sha : null);
  } catch (e) {
    if (e.status === 409 || e.status === 422) return say('Не опубликовано: сайт только что изменился. Черновик цел, нажмите «Опубликовать» ещё раз');
    throw e;
  }
  const newer = rawDraft(name) !== mine; // another tab wrote while we were sending
  if (!newer) setDraft(name, null);
  unsaved = false;
  if (!remotePages.includes(name)) remotePages.push(name);
  sha = newSha; published = html; baseline = serialise();
  try { await load(name); } catch (e) { return say('Опубликовано. Открыть страницу заново не получилось: ' + e.message); }
  say(newer ? 'Опубликовано. Более новые правки из другой вкладки остались в черновике' : C.demo ? 'Опубликовано в тестовой копии. Настоящий сайт не изменился' : 'Опубликовано. Сайт обновится через несколько минут');
}
$('#pub').onclick = async () => {
  if (busy || frozen) return;
  flush();
  if (!isDirty()) { setDraft(page, null); say('Изменений нет'); pageList(); return; }
  const bad = problems(serialise(), page);
  if (bad) return say('Не опубликовано: ' + bad);
  const warnings = [];
  if (PLACEHOLDER.test(doc().body.textContent)) warnings.push('На странице остался текст-заготовка.');
  if (sections().every(s => s.hasAttribute('data-off'))) warnings.push('Все блоки скрыты или удалены: страница будет пустой.');
  if (!await ask('Опубликовать?', warnings.map(w => `<p class="warn">${w}</p>`).join('') + `<p>${C.demo ? 'Это тест: настоящий сайт не изменится.' : 'Страницу увидят посетители.'} Вернуть прежнюю версию можно в «Истории».</p>` + '<label>Что изменили (необязательно)</label><input id="pn">', 'Опубликовать')) return;
  const note = $('#pn').value.trim().slice(0, 120) || 'Изменения из редактора';
  await locked('Публикую… Не закрывайте страницу', () => publish(page, sha, serialise(), note));
  pageList();
};

/* ---------- pages, preview, history ---------- */
function pageList() {
  const drafts = draftNames();
  const names = [...new Set([...remotePages, ...drafts])].sort((a, b) => (b === HOME) - (a === HOME) || a.localeCompare(b));
  $('#page').innerHTML = names.map(n => `<option value="${esc(n)}" ${n === page ? 'selected' : ''}>${n === HOME ? 'Главная' : '/' + esc(n)}${drafts.includes(n) ? ' (черновик)' : ''}</option>`).join('');
}
async function readPages() {
  const files = await Store.files();
  remotePages = [HOME, ...files.map(f => f.match(/^([^/]+)\/index\.html$/)).filter(m => m && SLUG.test(m[1]) && !RESERVED.has(m[1])).map(m => m[1])];
}
const mayLeave = async () => !unsaved || ask('Правки не сохранены', '<p>Они не поместились в память браузера и пропадут. Лучше сначала опубликовать.</p>', 'Всё равно уйти');
$('#page').onchange = async e => {
  const to = e.target.value;
  flush();
  if (await mayLeave()) await locked('Открываю…', () => load(to));
  pageList(); // if the page did not open, the list shows the one that is still on screen
};

function newPageHtml(template, t) {
  const d = new DOMParser().parseFromString(template, 'text/html');
  const telegram = (template.match(/var TG='([^'<]+)'/) || [])[1];
  d.querySelectorAll('script,link[rel=canonical],meta[property^="og:"],meta[name=robots]').forEach(s => s.remove());
  d.title = t;
  d.querySelector('meta[name=description]')?.setAttribute('content', t);
  d.head.insertAdjacentHTML('beforeend', '<meta name="robots" content="noindex"><style>body{min-height:100vh;display:flex;flex-direction:column}main{flex:1;display:flex;flex-direction:column}main>section:last-child{flex:1}</style>');
  d.querySelector('main').innerHTML = `<section class="light"><div class="wrap"><h2>${esc(t)}</h2><p style="margin-top:18px">Напишите здесь свой текст.</p></div></section>`;
  // the page lives in a folder: every address that started at the root must still do so
  const code = "<script>(function(){var b=document.getElementById('menuBtn'),m=document.getElementById('mmenu');if(b&&m)b.onclick=function(){var o=m.classList.toggle('open');b.setAttribute('aria-expanded',o)};" +
    (telegram ? `document.querySelectorAll('a.tg').forEach(function(a){a.href=${JSON.stringify(telegram)}+encodeURIComponent(a.dataset.msg||'');a.target='_blank';a.rel='noopener'});` : '') + "})()<\/script>";
  const out = ('<!doctype html>\n' + d.documentElement.outerHTML)
    .replace(/\b(src|href|poster)="(?![a-z][a-z0-9+.-]*:|\/|#)([^"]+)"/gi, '$1="/$2"').replace(/url\((['"]?)assets\//g, 'url($1/assets/')
    .replace(/href="#([^"]*)"/g, 'href="/#$1"')
    .replace('</body>', () => code + '</body>');
  return out + '\n';
}
$('#new').onclick = async () => {
  const slugOf = () => $('#ns').value.trim().toLowerCase();
  const ok = await ask('Новая страница', '<label>Название</label><input id="nt" placeholder="Деньги налегке"><label>Адрес латиницей</label><input id="ns" placeholder="dengi" autocapitalize="none">', 'Создать', () => {
    if (!SLUG.test(slugOf()) || RESERVED.has(slugOf())) return 'Адрес: латинские буквы, цифры и дефис. Служебные адреса заняты';
    return remotePages.includes(slugOf()) || getDraft(slugOf()) ? 'Такой адрес уже есть' : '';
  });
  if (!ok) return;
  const t = $('#nt').value.trim() || 'Новая страница', slug = slugOf();
  flush();
  if (!await mayLeave()) return;
  await locked('Создаю страницу…', async () => {
    await readPages();
    if (remotePages.includes(slug)) { pageList(); return say('Такой адрес уже есть'); }
    const home = await Store.read(pathOf(HOME));
    if (!setDraft(slug, {html: newPageHtml(home.text, t), sha: null})) return;
    await load(slug);
  });
};

$('#prev').onclick = () => {
  flush();
  locked('Готовлю просмотр…', async () => {
    let html = serialise();
    if (page === HOME) html = withBlocks(html, blocksOf((await Store.read('index.html')).text));
    freshPhotos.forEach((url, path) => { html = html.split(`"${path}"`).join(`"${url}"`); });
    $('#prevframe').srcdoc = html.replace(INERT, '').replace(/<head([^>]*)>/i, (m, a) => `<head${a}><base href="${C.site}"><style>a,button{pointer-events:none}</style>`);
    $('#preview').hidden = false;
  });
};
$('#closeprev').onclick = () => { $('#preview').hidden = true; $('#prevframe').srcdoc = ''; };

/** Replace or drop the draft only after a yes, and keep a copy of what she had made. */
async function useVersion(name, rev) {
  if (getDraft(name) || unsaved) {
    const gone = !rev && !remotePages.includes(name);
    const ok = await ask(rev ? 'Заменить черновик?' : gone ? 'Удалить черновик страницы?' : 'Сбросить черновик?',
      `<p>Неопубликованные правки уйдут со страницы. Копию можно вернуть из «Истории»${gone ? ' на главной' : ''}.</p>`, rev ? 'Заменить' : gone ? 'Удалить' : 'Сбросить');
    if (!ok) return;
  }
  await locked('Открываю…', async () => {
    if (!rev) {
      const done = await load(remotePages.includes(name) ? name : HOME, async () => {
        if (!await keepCopy(name, ownWork(name))) return false;
        setDraft(name, null); unsaved = false;
      });
      if (done) say('Черновик сброшен');
      return;
    }
    const old = await Store.read(pathOf(name), rev);
    const done = await load(name, async () => {
      const current = await Store.read(pathOf(name));
      if (!await keepCopy(name, ownWork(name))) return false;
      return setDraft(name, {html: old.text, sha: current.sha, restored: true});
    });
    if (done) say('Версия в черновике. Проверьте и опубликуйте');
  });
  pageList();
}
async function useBackup(name, index) {
  if (name !== page && !await mayLeave()) return;
  await locked('Открываю…', async () => {
    await load(name, async () => {
      const all = backupsOf(name), copy = all[index], current = ownWork(name);
      if (!copy) return false;
      keepBackups(name, all.filter((_, i) => i !== index)); // free the room first
      if (!await keepCopy(name, current) || !setDraft(name, {html: copy.html, sha: copy.sha})) { keepBackups(name, all); return false; }
      unsaved = false;
    });
  });
  pageList();
}
async function removePage(name) {
  if (!await ask('Удалить страницу?', `<p>Адрес /${esc(name)} перестанет открываться${getDraft(name) ? ', неопубликованные правки уйдут вместе с ним' : ''}.</p><p>Копию можно вернуть из «Истории» на главной.</p>`, 'Удалить')) return;
  await locked('Удаляю страницу…', async () => {
    const now = await readOrNull(pathOf(name));
    const copy = ownWork(name) || (now && {html: now.text});
    if (!await keepCopy(name, copy && {html: copy.html, sha: null})) return;
    if (now) await Store.remove(pathOf(name), now.sha, 'Страница удалена из редактора');
    setDraft(name, null); unsaved = false;
    await readPages(); remotePages = remotePages.filter(n => n !== name);
    await load(HOME);
    say('Страница удалена');
  });
  pageList();
}
$('#hist').onclick = () => {
  flush();
  const name = page;
  locked('Открываю историю…', async () => {
    const h = remotePages.includes(name) ? await Store.history(pathOf(name)) : [];
    const when = value => new Date(value).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
    const row = (heading, note, label, data) => `<div class="ver"><span>${heading}<br><small>${note}</small></span><button type="button" ${data}>${label}</button></div>`;
    let body = '';
    if (getDraft(name)) body += row('Черновик', 'убрать неопубликованные правки', 'Сбросить', 'data-rev=""');
    backupsOf(name).forEach((b, i) => { body += row('Черновик до замены', 'убран ' + esc(when(b.at)), 'Вернуть', `data-backup="${i}"`); });
    if (backupsOf(name).length) body += '<p><small>Здесь хранятся три последние копии черновика.</small></p>';
    if (name === HOME) namesUnder(backupKey('')).filter(n => !remotePages.includes(n) && !getDraft(n))
      .forEach(n => { body += row('Удалённая страница /' + esc(n), 'вернуть как черновик', 'Вернуть', `data-orphan="${esc(n)}"`); });
    body += h.length ? h.map(v => row(esc(when(v.date)), esc(v.title), 'Вернуть', `data-rev="${esc(v.rev)}"`)).join('') : '<p>Публикаций ещё не было.</p>';
    if (name !== HOME && remotePages.includes(name)) body += row('Эта страница', 'убрать с сайта совсем', 'Удалить', 'data-remove');
    ask('История версий', body);
    dlg.querySelectorAll('.ver button').forEach(b => b.onclick = () => {
      dlg.close();
      if (b.hasAttribute('data-remove')) return removePage(name);
      if (b.hasAttribute('data-backup')) return useBackup(name, +b.dataset.backup);
      if (b.hasAttribute('data-orphan')) return useBackup(b.dataset.orphan, 0);
      useVersion(name, b.dataset.rev);
    });
  });
};

/* ---------- size, sheet, login ---------- */
function fit() {
  const box = $('main');
  if (!box.clientWidth) return;
  const small = innerWidth < 760, pad = small ? 0 : 24, W = box.clientWidth - pad, H = box.clientHeight - pad;
  const w = small ? W : phone ? 390 : 1280, k = Math.min(1, W / w);
  frame.style.width = w + 'px'; frame.style.height = H / k + 'px'; frame.style.transform = `scale(${k})`;
  $('#stage').style.width = w * k + 'px';
  $('#dev').textContent = phone ? 'Вид компьютера' : 'Вид телефона';
}
$('#dev').onclick = () => { phone = !phone; fit(); };
function sheet(open) { $('#side').classList.toggle('open', open); $('#toggle').setAttribute('aria-pressed', open); }
$('#toggle').onclick = () => sheet(!$('#side').classList.contains('open'));
$('#done').onclick = () => sheet(false);
new ResizeObserver(fit).observe($('main'));

function loginNote(text, bad) { const m = $('#loginmsg'); m.textContent = text; m.classList.toggle('bad', !!bad); }
function showLogin(message) {
  frozen = false;
  if (dlg.open) dlg.close();
  $('#veil').hidden = true;
  $('#app').hidden = true; $('#preview').hidden = true; $('#login').hidden = false;
  loginNote(message ? message + '.' : '', message && message !== 'Вы вышли');
}
async function start() {
  $('#login').hidden = true; $('#app').hidden = false; unveil();
  let problem = null;
  await locked('Открываю сайт…', async () => {
    try { await readPages(); await load(HOME); } catch (e) { if (e.status === 401) throw e; problem = e; }
  });
  if (problem) veil('Не получилось открыть сайт: ' + problem.message, 'Повторить', start,
    'Ввести другой ключ', () => { Store.forget(); showLogin('Вы вышли'); });
}
$('#reponame').textContent = C.repo;
let entering = false;
$('#enter').onclick = async () => {
  if (entering) return;
  const value = $('#key').value.trim();
  if (!value && !C.demo) return loginNote('Вставьте ключ.', true);
  entering = true; loginNote('Проверяю…');
  try { await Store.login(value); $('#key').value = ''; await start(); }
  catch (e) { $('#key').value = ''; loginNote(e.message + '.', true); }
  finally { entering = false; }
};
$('#key').onkeydown = e => { if (e.key === 'Enter') $('#enter').click(); };
$('#ping').onclick = async () => {
  loginNote('Проверяю связь…');
  try { await Store.reachable(); loginNote('Связь есть: GitHub отвечает.'); }
  catch (e) { loginNote(e.message + '.', true); }
};
$('#logout').onclick = async () => {
  flush();
  if (!await mayLeave()) return;
  if (!await ask('Выйти?', C.demo ? '<p>Откроется первый экран теста. Черновики останутся.</p>' : '<p>Ключ удалится с этого устройства. Черновики останутся.</p>', 'Выйти')) return;
  Store.forget(); showLogin('Вы вышли');
};

if (Store.hasKey()) start(); else showLogin();
