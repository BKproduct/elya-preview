"use strict";
/* Test copy for the client: same editor, but "GitHub" lives in this browser. Nothing is written anywhere.
   Same interface as github.js. Snapshot of the real site: snapshot.js. */
window.Store = (() => {
  const KEY = 'site-demo-files-v1', ON = 'site-demo-started';
  class StoreError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }
  const mark = text => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return (h >>> 0).toString(16) + '-' + text.length; };
  const fresh = () => ({files: {...window.DEMO_SNAPSHOT.files}, photos: {},
    commits: [{rev: 'start', date: window.DEMO_SNAPSHOT.date, title: 'Сайт, как он есть сейчас', path: 'src/template.html', text: window.DEMO_SNAPSHOT.files['src/template.html']}]});
  let state = fresh(), saved = false, started = false;
  try { started = !!localStorage.getItem(ON); } catch (e) { /* private window */ }
  function sync() {
    // another tab may have written or started again since this one last looked
    try {
      const raw = localStorage.getItem(KEY), found = raw && JSON.parse(raw);
      if (found && found.files) { state = found; saved = true; }
      else if (saved) { state = fresh(); saved = false; }
    } catch (e) { /* private window: this tab keeps its own copy */ }
    // pictures published in another tab must show here too (freshPhotos belongs to app.js)
    if (typeof freshPhotos !== 'undefined') Object.entries(state.photos).forEach(([path, url]) => freshPhotos.set(path, url));
  }
  /** All or nothing: the new state counts only after the browser has stored it. */
  function change(apply) {
    sync();
    const next = JSON.parse(JSON.stringify(state));
    const result = apply(next);
    for (;;) {
      try { localStorage.setItem(KEY, JSON.stringify(next)); break; }
      catch (e) {
        // photos and old versions are the heavy part: drop the oldest versions if the browser is full
        if (next.commits.length > 2) next.commits.splice(next.commits.length - 2, 1);
        else throw new StoreError('В памяти браузера не хватает места. Нажмите «Начать тест заново»', 0);
      }
    }
    state = next; saved = true;
    return result;
  }
  sync();
  const clash = () => new StoreError('Страница изменилась после того, как вы её открыли', 409);
  const later = value => new Promise(res => setTimeout(() => res(value), 150));
  function log(s, path, text, title) {
    s.commits.unshift({rev: 'r' + Date.now() + '-' + s.commits.length, date: new Date().toISOString(), title, path, text});
    if (s.commits.length > 20) s.commits.splice(s.commits.length - 2, 1); // the first version stays
  }
  return {
    StoreError,
    hasKey: () => started,
    async login() { started = true; try { localStorage.setItem(ON, '1'); } catch (e) { /* until the tab closes */ } },
    forget() { started = false; try { localStorage.removeItem(ON); } catch (e) { /* ignore */ } },
    async reachable() {
      let ok = false;
      try { ok = (await fetch('https://api.github.com/zen', {cache: 'no-store'})).status < 500; } catch (e) { /* blocked */ }
      if (!ok) throw new StoreError('Связи с GitHub нет', 0);
      return true;
    },
    photos: () => state.photos,
    async read(path, ref) {
      sync();
      const text = ref && ref !== 'main' ? (state.commits.find(c => c.rev === ref && c.path === path) || {}).text : state.files[path];
      if (text === undefined) throw new StoreError('Файл не найден', 404);
      return later({text, sha: mark(text)});
    },
    async write(path, {text, base64}, message, sha) {
      return later(change(s => {
        if (base64) {
          if (s.photos['/' + path]) throw new StoreError('Уже есть', 422);
          s.photos['/' + path] = 'data:image/jpeg;base64,' + base64;
          return 'photo';
        }
        const old = s.files[path];
        if (old !== undefined ? sha !== mark(old) : sha) throw clash();
        s.files[path] = text; log(s, path, text, message);
        return mark(text);
      }));
    },
    async remove(path, sha) {
      change(s => {
        if (s.files[path] === undefined || mark(s.files[path]) !== sha) throw clash();
        delete s.files[path];
      });
      return later();
    },
    async files() { sync(); return later(Object.keys(state.files)); },
    async history(path) { sync(); return later(state.commits.filter(c => c.path === path).map(({rev, date, title}) => ({rev, date, title}))); }
  };
})();

/* "start again" in one tab: the others drop what they hold and reload, so nothing comes back */
addEventListener('storage', e => {
  if (e.key !== 'site-demo-files-v1' || e.newValue !== null) return;
  frozen = true; unsaved = false; clearTimeout(saveTimer); saveTimer = null; // app.js state
  location.reload();
});

/* the test screen: connection line and "start again" */
addEventListener('DOMContentLoaded', () => {
  const line = document.querySelector('#netline');
  if (line) window.Store.reachable().then(() => { line.textContent = 'Связь с GitHub: есть.'; }).catch(() => { line.textContent = 'Связь с GitHub: нет. Напишите об этом Борису.'; line.classList.add('bad'); });
  document.querySelector('#reset').onclick = () => {
    if (!document.querySelector('#reset').dataset.sure) {
      const b = document.querySelector('#reset'); b.dataset.sure = '1'; b.textContent = 'Нажмите ещё раз: сотрёт ваши тестовые правки';
      setTimeout(() => { delete b.dataset.sure; b.textContent = 'Начать тест заново'; }, 4000);
      return;
    }
    try { Object.keys(localStorage).filter(k => k.startsWith('site-demo') || k.includes(':demo/')).forEach(k => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
    location.reload();
  };
});
