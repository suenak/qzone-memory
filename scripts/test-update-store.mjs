import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import { computed, onScopeDispose, reactive, ref, watch } from 'vue';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

function script(path) {
  return transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '');
}
const updateScript = script('../src/stores/update.ts').replace('export const useUpdateStore =', 'return');
const errorScript = script('../src/utils/uiError.ts').replace(/^export /gm, '');
const describeError = new Function('qqSourceNotice', 'requiresQqLogin', `${errorScript}\nreturn describeError;`)(() => null, () => false);
const release = (version = '1.3.0') => ({ version, download: { fileName: `app-${version}.exe`, platform: 'windows-x86_64', size: 100 } });
const progress = (status, version = '1.3.0') => ({ status, version, fileName: 'app.exe', downloaded: status === 'completed' ? 100 : 0, total: 100, message: status });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); }

/** Real store and error formatter, with native IPC, browser events and time controlled. */
function harness(t, overrides = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const timers = new Map(), windowEvents = new Map(), documentEvents = new Map();
  const archive = reactive({ busy: false });
  const calls = { check: 0, download: [], poll: 0, cancel: 0, open: 0, reveal: 0, page: 0 };
  const storage = new Map();
  let nextTimer = 0, now = 1_000_000;
  function schedule(kind, callback, delay) { const id = ++nextTimer; timers.set(id, { kind, callback, delay }); return id; }
  const document = {
    visibilityState: 'visible',
    addEventListener: (type, callback) => documentEvents.set(type, callback),
    removeEventListener: type => documentEvents.delete(type),
  };
  const dependencies = {
    defineStore, computed, onScopeDispose, ref, watch, describeError,
    useArchiveStore: () => archive,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: (callback, delay) => schedule('timeout', callback, delay),
    setInterval: (callback, delay) => schedule('interval', callback, delay),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    Date: { now: () => now }, document,
    window: {
      addEventListener: (type, callback) => windowEvents.set(type, callback),
      removeEventListener: type => windowEvents.delete(type),
    },
    checkForUpdate: () => { calls.check++; return overrides.check?.() ?? Promise.resolve(release()); },
    downloadUpdate: version => { calls.download.push(version); return overrides.download?.(version) ?? Promise.resolve(progress('completed', version)); },
    getUpdateDownloadProgress: () => { calls.poll++; return overrides.poll?.() ?? Promise.resolve(progress('idle', '')); },
    cancelUpdateDownload: () => { calls.cancel++; return overrides.cancel?.() ?? Promise.resolve(); },
    openUpdatePackage: () => { calls.open++; return overrides.open?.() ?? Promise.resolve(); },
    revealUpdatePackage: () => { calls.reveal++; return overrides.reveal?.() ?? Promise.resolve(); },
    openDownloadPage: () => { calls.page++; return Promise.resolve(); },
  };
  const useUpdateStore = new Function(...Object.keys(dependencies), updateScript)(...Object.values(dependencies));
  const store = useUpdateStore(pinia);
  let disposed = false;
  function dispose() { if (!disposed) { disposed = true; store.$dispose(); } }
  t.after(dispose);
  return {
    store, calls, archive, timers, windowEvents, documentEvents, document, dispose,
    offer() { store.available = release(); },
    ready() { store.available = release(); store.progress = progress('completed'); },
    advance(duration) { now += duration; },
    async poll() {
      const entry = [...timers].find(([, timer]) => timer.kind === 'timeout');
      assert.ok(entry, 'A progress poll must be scheduled');
      timers.delete(entry[0]);
      entry[1].callback();
      await settle();
    },
  };
}

test('old terminal and other-version progress snapshots cannot unlock a pending download', async t => {
  for (const [status, version] of [['completed', '1.3.0'], ['cancelled', '1.3.0'], ['error', '1.3.0'], ['downloading', '1.2.0']]) {
    const download = deferred();
    const h = harness(t, { download: () => download.promise, poll: async () => progress(status, version) });
    h.offer();
    const pending = h.store.download();
    await h.poll();
    assert.equal(h.store.downloading, true);
    assert.equal(h.store.downloaded, false);
    assert.equal(h.store.progress.status, 'preparing');
    await h.store.download();
    await h.store.check();
    assert.equal(h.calls.download.length, 1);
    assert.equal(h.calls.check, 0);
    download.resolve(progress('completed'));
    await pending;
    assert.equal(h.store.downloaded, true);
    assert.equal(h.timers.size, 0);
  }
});

test('active progress is shown but a late poll cannot replace the command result', async t => {
  const download = deferred(), oldPoll = deferred();
  let first = true;
  const h = harness(t, { download: () => download.promise, poll: () => {
    if (first) { first = false; return Promise.resolve({ ...progress('downloading'), downloaded: 30 }); }
    return oldPoll.promise;
  } });
  h.offer();
  const pending = h.store.download();
  await h.poll();
  assert.equal(h.store.progress.downloaded, 30);
  await h.poll();
  download.resolve(progress('completed'));
  await pending;
  oldPoll.resolve(progress('downloading'));
  await settle();
  assert.equal(h.store.downloaded, true);
  assert.equal(h.timers.size, 0);
});

test('download rejection releases pending state and allows a deliberate retry', async t => {
  let fail = true;
  const h = harness(t, { download: async () => { if (fail) throw new Error('network timeout'); return progress('completed'); } });
  h.offer();
  await h.store.download();
  assert.equal(h.store.downloading, false);
  assert.equal(h.store.progress.status, 'error');
  assert.equal(h.timers.size, 0);
  fail = false;
  await h.store.download();
  assert.equal(h.store.downloaded, true);
  assert.equal(h.calls.download.length, 2);
});

test('pending cancellation is deduplicated and blocks a new download until it settles', async t => {
  const download = deferred(), cancel = deferred();
  const h = harness(t, { download: () => download.promise, cancel: () => cancel.promise });
  h.offer();
  const pending = h.store.download();
  const cancellation = h.store.cancelDownload();
  await h.store.cancelDownload();
  assert.equal(h.calls.cancel, 1);
  download.resolve(progress('cancelled'));
  await pending;
  assert.equal(h.store.cancelling, true);
  assert.equal(h.store.downloading, true);
  await h.store.download();
  assert.equal(h.calls.download.length, 1);
  cancel.resolve();
  await cancellation;
  assert.equal(h.store.downloading, false);
});

test('failed cancellation leaves the actual download running and can be retried', async t => {
  const download = deferred();
  let fail = true;
  const h = harness(t, { download: () => download.promise, cancel: async () => { if (fail) throw new Error('cancel failed'); } });
  h.offer();
  const pending = h.store.download();
  await h.store.cancelDownload();
  assert.equal(h.store.cancelling, false);
  assert.equal(h.store.downloading, true);
  assert.ok(h.store.actionError);
  fail = false;
  await h.store.cancelDownload();
  assert.equal(h.calls.cancel, 2);
  assert.equal(h.store.actionError, '');
  download.resolve(progress('cancelled'));
  await pending;
});

test('a pending manifest check prevents a manual download of an outdated offer', async t => {
  const check = deferred();
  const h = harness(t, { check: () => check.promise });
  h.offer();
  const pending = h.store.check();
  await h.store.download();
  assert.deepEqual(h.calls.download, []);
  check.resolve(release('1.4.0'));
  await pending;
  await h.store.download();
  assert.deepEqual(h.calls.download, ['1.4.0']);
});

test('automatic download stays off by default and starts only when enabled', async t => {
  const h = harness(t);
  await h.store.check({ silent: true });
  assert.deepEqual(h.calls.download, []);
  h.store.autoDownload = true;
  await h.store.check({ silent: true });
  await settle();
  assert.deepEqual(h.calls.download, ['1.3.0']);
  assert.equal(h.store.downloaded, true);
});

test('automatic checks do not repeatedly restart a failed or cancelled package download', async t => {
  for (const status of ['error', 'cancelled']) {
    const h = harness(t);
    h.offer();
    h.store.autoDownload = true;
    h.store.progress = progress(status);
    await h.store.check({ silent: true });
    assert.deepEqual(h.calls.download, []);
  }
});

test('a withdrawn offer clears stale download feedback even during silent checks', async t => {
  const h = harness(t, { check: async () => null });
  h.ready();
  h.store.message = 'old package downloaded';
  h.store.actionError = 'old error';
  await h.store.check({ silent: true });
  assert.equal(h.store.available, null);
  assert.equal(h.store.progress, null);
  assert.equal(h.store.dialogVisible, false);
  assert.equal(h.store.actionError, '');
  assert.doesNotMatch(h.store.message, /old/);
});

test('missing or changed packages enter retry state before their errors are translated', async t => {
  for (const method of ['openPackage', 'showPackage']) {
    for (const reason of ['安装包已被移除，请重新下载', '安装包已变更，请重新下载', '安装包已不可用，请重新下载']) {
      const h = harness(t, { [method === 'openPackage' ? 'open' : 'reveal']: async () => { throw new Error(reason); } });
      h.ready();
      await h.store[method]();
      assert.equal(h.store.progress.status, 'error');
      assert.equal(h.store.downloaded, false);
      assert.match(h.store.actionError, /重新下载/);
      assert.match(h.store.progress.message, /重新下载/);
    }
  }
});

test('an ordinary package opener failure keeps the downloaded package available for retry', async t => {
  for (const reason of ['system opener failed', '系统安装服务已不可用']) {
    const h = harness(t, { open: async () => { throw new Error(reason); } });
    h.ready();
    await h.store.openPackage();
    assert.equal(h.store.downloaded, true);
    assert.equal(h.store.opening, false);
    assert.ok(h.store.actionError);
  }
});

test('package opening and revealing share an operation guard', async t => {
  for (const method of ['openPackage', 'showPackage']) {
    const action = deferred();
    const h = harness(t, { [method === 'openPackage' ? 'open' : 'reveal']: () => action.promise });
    h.ready();
    const pending = h.store[method]();
    await h.store.openPackage();
    await h.store.showPackage();
    await h.store.check();
    assert.equal(h.calls.open + h.calls.reveal, 1);
    assert.equal(h.calls.check, 0);
    action.resolve();
    await pending;
    assert.equal(h.store.opening || h.store.revealing, false);
  }
});

test('installation cannot be opened while an archive task is busy', async t => {
  const h = harness(t);
  h.ready();
  h.archive.busy = true;
  await h.store.openPackage();
  assert.equal(h.calls.open, 0);
  h.archive.busy = false;
  await h.store.openPackage();
  assert.equal(h.calls.open, 1);
});

test('stopping automatic checks discards an in-flight result without starting a download', async t => {
  const check = deferred();
  const h = harness(t, { check: () => check.promise });
  h.store.autoDownload = true;
  const pending = h.store.check({ silent: true });
  h.store.stopAutomaticChecks();
  check.resolve(release());
  await pending;
  assert.equal(h.store.available, null);
  assert.equal(h.store.checking, false);
  assert.deepEqual(h.calls.download, []);
});

test('a stopped check cannot clear the loading state of a newer check', async t => {
  const old = deferred(), fresh = deferred();
  let first = true;
  const h = harness(t, { check: () => { if (first) { first = false; return old.promise; } return fresh.promise; } });
  const a = h.store.check();
  h.store.stopAutomaticChecks();
  const b = h.store.check();
  old.resolve(release('1.3.0'));
  await a;
  assert.equal(h.store.checking, true);
  assert.equal(h.store.available, null);
  fresh.resolve(release('1.4.0'));
  await b;
  assert.equal(h.store.checking, false);
  assert.equal(h.store.available.version, '1.4.0');
});

test('stopping automatic checks preserves progress polling for a manually started download', async t => {
  const download = deferred();
  const h = harness(t, { download: () => download.promise });
  h.offer();
  const pending = h.store.download();
  h.store.stopAutomaticChecks();
  assert.equal(h.timers.size, 1);
  await h.poll();
  assert.equal(h.calls.poll, 1);
  download.resolve(progress('completed'));
  await pending;
});

test('automatic checks are idempotent and only recheck on visible foreground after six hours', async t => {
  const h = harness(t);
  h.store.startAutomaticChecks();
  h.store.startAutomaticChecks();
  await settle();
  assert.equal(h.calls.check, 1);
  assert.equal(h.timers.size, 1);
  assert.equal(h.windowEvents.size, 1);
  h.advance(6 * 60 * 60 * 1000);
  h.document.visibilityState = 'hidden';
  h.windowEvents.get('focus')();
  assert.equal(h.calls.check, 1);
  h.document.visibilityState = 'visible';
  h.documentEvents.get('visibilitychange')();
  await settle();
  assert.equal(h.calls.check, 2);
  h.store.stopAutomaticChecks();
  assert.equal(h.timers.size, 0);
  assert.equal(h.windowEvents.size + h.documentEvents.size, 0);
});

test('disposing the store drops late polling and command results and cannot restart timers', async t => {
  const download = deferred(), poll = deferred();
  const h = harness(t, { download: () => download.promise, poll: () => poll.promise });
  h.offer();
  const pending = h.store.download();
  await h.poll();
  h.dispose();
  poll.resolve(progress('downloading'));
  download.resolve(progress('completed'));
  await pending;
  await settle();
  assert.equal(h.store.progress.status, 'preparing');
  assert.equal(h.timers.size, 0);
  h.store.startAutomaticChecks();
  await h.store.openPackage();
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.open, 0);
});
