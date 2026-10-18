import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import { computed, effectScope, nextTick, reactive, ref, toRefs, watch } from 'vue';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { createArchiveHarness, idleProgress } from './helpers/archive-store.mjs';

const { descriptor } = parse(readFileSync(new URL('../src/views/TasksView.vue', import.meta.url), 'utf8'));
const script = transpileModule(descriptor.scriptSetup.content, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '');
const expose = `return {
  refresh, start, cancel, retrySkip, skips, skipsError, refreshing, starting, stopping,
  actionError, actionNotice, skipNotice, retryingId, canRetrySkips,
};`;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 10; turn++) await nextTick(); }
function harness(t, overrides = {}) {
  const archive = createArchiveHarness(overrides);
  const auth = reactive({ loggedIn: true, user: { uin: 'account-a' }, reauthenticate: async () => {} });
  const license = reactive({ canArchive: true });
  const calls = { lists: 0, starts: 0, cancels: 0 };
  const unmounts = [];
  const scope = effectScope();
  const dependencies = {
    computed, nextTick, onBeforeUnmount: callback => unmounts.push(callback), onMounted: () => {},
    ref, watch, storeToRefs: toRefs,
    useAuthStore: () => auth, useArchiveStore: () => archive.store, useLicenseStore: () => license,
    IDLE_ARCHIVE_PROGRESS: idleProgress(),
    MIN_ARCHIVE_INTERVAL: 2000, MAX_ARCHIVE_INTERVAL: 30000,
    getArchiveInterval: () => 3000, setArchiveInterval: value => value,
    qqProgressNotice: () => null, qqSourceNotice: () => null,
    describeError: String, diagnosticError: String,
    clearInterval: () => {},
    listArchiveSkips: () => { calls.lists++; return overrides.list?.() ?? Promise.resolve([]); },
    startFeedArchive: () => { calls.starts++; return overrides.start?.() ?? Promise.resolve({ ...idleProgress(), status: 'completed' }); },
    cancelFeedArchive: () => { calls.cancels++; return overrides.cancel?.() ?? Promise.resolve(); },
  };
  const view = scope.run(() => new Function(...Object.keys(dependencies), `${script}\n${expose}`)(...Object.values(dependencies)));
  let disposed = false;
  function unmount() {
    if (disposed) return;
    disposed = true;
    unmounts.forEach(callback => callback());
    scope.stop();
  }
  t.after(() => { unmount(); archive.dispose(); });
  return { view, auth, license, calls, archive, unmount };
}

test('late skip records cannot replace the new account list', async t => {
  const old = deferred();
  let first = true;
  const { view, auth } = harness(t, { list: () => { if (first) { first = false; return old.promise; } return Promise.resolve([{ id: 2 }]); } });
  const pending = view.refresh();
  await settle();
  auth.user.uin = 'account-b';
  assert.deepEqual(view.skips.value, []);
  await settle();
  old.resolve([{ id: 1 }]);
  await pending;
  assert.deepEqual(view.skips.value, [{ id: 2 }]);
});

test('old list failure cannot clear the loading state of a new account request', async t => {
  const old = deferred(), fresh = deferred();
  let first = true;
  const { view, auth } = harness(t, { list: () => { if (first) { first = false; return old.promise; } return fresh.promise; } });
  const pending = view.refresh();
  await settle();
  auth.user.uin = 'account-b';
  await settle();
  old.reject(new Error('old account failure'));
  await pending;
  assert.equal(view.refreshing.value, true);
  assert.equal(view.skipsError.value, '');
  fresh.resolve([{ id: 2 }]);
  await settle();
  assert.equal(view.refreshing.value, false);
});

test('logging out discards an unfinished skip list', async t => {
  const list = deferred();
  const { view, auth } = harness(t, { list: () => list.promise });
  const pending = view.refresh();
  await settle();
  auth.loggedIn = false;
  await settle();
  list.resolve([{ id: 1 }]);
  await pending;
  assert.deepEqual(view.skips.value, []);
});

test('refresh cannot start a skip-list request after the page is unmounted', async t => {
  const progress = deferred();
  const { view, calls, unmount } = harness(t, { progress: () => progress.promise });
  const pending = view.refresh();
  unmount();
  progress.resolve(idleProgress());
  await pending;
  await view.refresh();
  assert.equal(calls.lists, 0);
});

test('concurrent refreshes share one skip-list request', async t => {
  const list = deferred();
  const { view, calls } = harness(t, { list: () => list.promise });
  const a = view.refresh(), b = view.refresh();
  await settle();
  assert.equal(calls.lists, 1);
  list.resolve([{ id: 1 }]);
  await Promise.all([a, b]);
  assert.deepEqual(view.skips.value, [{ id: 1 }]);
});

test('skip retries require login, archive access and the end of cooldown', async t => {
  const { view, auth, license, archive } = harness(t);
  auth.loggedIn = false;
  await view.retrySkip({ id: 1 });
  auth.loggedIn = true;
  license.canArchive = false;
  await view.retrySkip({ id: 1 });
  license.canArchive = true;
  await settle();
  archive.store.progress = { ...idleProgress(), status: 'partial', retryAt: Math.floor(Date.now() / 1000) + 600 };
  await view.retrySkip({ id: 1 });
  archive.store.progress = idleProgress();
  await view.retrySkip({ id: 1, resolvedAt: 1 });
  assert.deepEqual(archive.calls.retries, []);
});

test('skip retry remains global after navigating away and ignores late local notices', async t => {
  const retry = deferred();
  const { view, archive, calls, unmount } = harness(t, { retry: () => retry.promise });
  const pending = view.retrySkip({ id: 7 });
  assert.equal(view.retryingId.value, 7);
  assert.equal(archive.store.busy, true);
  unmount();
  assert.equal(archive.store.busy, true);
  retry.resolve({ success: true, message: 'Recovered', recoveredRecords: 1 });
  await pending;
  assert.equal(archive.store.busy, false);
  assert.equal(view.skipNotice.value, '');
  assert.equal(calls.lists, 0);
});

test('a pending skip retry blocks duplicate retries and starting a feed run', async t => {
  const retry = deferred();
  const { view, archive, calls } = harness(t, { retry: () => retry.promise });
  const pending = view.retrySkip({ id: 7 });
  await view.retrySkip({ id: 8 });
  await view.start();
  assert.deepEqual(archive.calls.retries, [7]);
  assert.equal(calls.starts, 0);
  retry.resolve({ success: false, message: 'Empty page retained' });
  await pending;
  assert.equal(view.skipNotice.value, 'Empty page retained');
});

for (const outcome of ['resolve', 'reject']) {
  test(`feed run ${outcome} after unmount still settles global state without local requests`, async t => {
    const start = deferred();
    const { view, archive, calls, unmount } = harness(t, { start: () => start.promise });
    const pending = view.start();
    assert.equal(archive.store.running, true);
    unmount();
    start[outcome](outcome === 'resolve' ? { ...idleProgress(), status: 'completed' } : new Error('start failed'));
    await pending;
    await settle();
    assert.equal(archive.store.running, false);
    assert.equal(view.actionError.value, '');
    assert.equal(calls.lists, 0);
  });
}

test('stop failures after unmount cannot update a discarded task page', async t => {
  const cancel = deferred();
  const { view, calls, unmount } = harness(t, { cancel: () => cancel.promise });
  const pending = view.cancel();
  unmount();
  cancel.reject(new Error('cancel failed'));
  await pending;
  assert.equal(view.actionError.value, '');
  assert.equal(calls.lists, 0);
});

test('retry completion refreshes past an older pending list and rejects its stale records', async t => {
  const old = deferred();
  let first = true;
  const { view, calls } = harness(t, { list: () => {
    if (first) { first = false; return old.promise; }
    return Promise.resolve([{ id: 7, resolvedAt: 100 }]);
  } });
  const pending = view.refresh();
  await settle();
  await view.retrySkip({ id: 7 });
  assert.equal(calls.lists, 2);
  assert.deepEqual(view.skips.value, [{ id: 7, resolvedAt: 100 }]);
  old.resolve([{ id: 7 }]);
  await pending;
  assert.deepEqual(view.skips.value, [{ id: 7, resolvedAt: 100 }]);
});

test('active stop failures remain visible and refresh the current task list', async t => {
  const { view, calls } = harness(t, { cancel: async () => { throw new Error('cancel failed'); } });
  await view.cancel();
  assert.match(view.actionError.value, /cancel failed/);
  assert.equal(view.stopping.value, false);
  assert.equal(calls.lists, 1);
});
