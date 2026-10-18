import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { createArchiveHarness, idleProgress } from './helpers/archive-store.mjs';

const { descriptor } = parse(readFileSync(new URL('../src/views/ArchivesView.vue', import.meta.url), 'utf8'));
const script = transpileModule(descriptor.scriptSetup.content, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '');
const expose = `return {
  load, loadMore, ensureFilled, observeSentinel, askDelete, confirmDelete, exportHtml, dismissError,
  records, totalRecords, first, query, category, loading, loadingMore, loadMoreFailed,
  selectedIds, deleteIds, confirmVisible, error, deleting, exporting, sentinelEl,
  selectedYear, descending, clearFilters,
};`;
const item = id => ({ id, cellId: `cell-${id}`, publishedAt: 0, pictureUrls: [], likes: [], comments: [] });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 10; turn++) await nextTick(); }
function harness(t, overrides = {}) {
  const archive = createArchiveHarness();
  const scope = effectScope();
  const unmounts = [], observers = [], notifications = [];
  const calls = { lists: [], counts: [], deletes: [], exports: [], saves: 0, routes: [] };
  const auth = reactive({ loggedIn: true, user: { uin: 'account-a' } });
  const route = reactive({ query: { ...overrides.routeQuery } });
  const timers = new Map();
  let nextTimer = 0;
  const dependencies = {
    computed, nextTick, reactive, ref, watch,
    onMounted: () => {}, onBeforeUnmount: callback => unmounts.push(callback),
    useArchiveStore: () => archive.store, useAuthStore: () => auth,
    useRoute: () => route, useRouter: () => ({ replace: async location => { calls.routes.push(location); await overrides.replace?.(location); } }),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    useToast: () => Object.fromEntries(['info', 'success', 'error'].map(kind => [kind, message => notifications.push({ kind, message })])),
    User: {}, Users: {}, platform: () => 'browser', describeError: String, diagnosticError: String,
    convertFileSrc: path => `asset:${path}`,
    ImageRequestScope: class { generation = 0; clear() { this.generation++; } },
    IntersectionObserver: class {
      constructor(callback) { observers.push(callback); }
      observe() {} unobserve() {} disconnect() {}
    },
    document: { querySelectorAll: () => [], querySelector: () => null },
    listArchivedFeeds: (...args) => { calls.lists.push(args); return overrides.list?.(...args) ?? Promise.resolve([]); },
    countArchivedFeeds: async (...args) => { calls.counts.push(args); return overrides.total ?? 0; },
    listArchiveYears: async () => overrides.years ?? [],
    deleteArchivedFeeds: ids => { calls.deletes.push([...ids]); return overrides.remove?.(ids) ?? Promise.resolve(ids.length); },
    exportArchivedHtml: (...args) => { calls.exports.push(args); return overrides.export?.(...args) ?? Promise.resolve({ records: 1, mediaFiles: 0, missingMedia: 0 }); },
    save: () => { calls.saves++; return overrides.save?.() ?? Promise.resolve('chosen.html'); },
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
  function seed() {
    view.records.value = [item(1)];
    view.totalRecords.value = 5;
    view.first.value = 1;
  }
  async function showSentinel() {
    view.sentinelEl.value = {};
    await nextTick();
    view.observeSentinel();
    observers.at(-1)([{ isIntersecting: true }]);
  }
  return { view, archive, auth, route, timers, notifications, calls, unmount, seed, showSentinel,
    async tick(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay} ms debounce`);
      timers.delete(entry[0]); entry[1].callback(); await settle();
    },
  };
}

test('pagination failure stops automatic retries until the user explicitly retries', async t => {
  let fail = true;
  const { view, calls, seed, showSentinel } = harness(t, { list: async () => {
    if (fail) throw new Error('page read failed');
    return [];
  } });
  seed();
  await showSentinel();
  await settle();
  assert.equal(calls.lists.length, 1);
  assert.equal(view.loadMoreFailed.value, true);
  assert.equal(view.first.value, 1);
  view.dismissError();
  await view.ensureFilled();
  await settle();
  assert.equal(calls.lists.length, 1);
  fail = false;
  await view.loadMore();
  assert.equal(calls.lists.length, 2);
  assert.equal(calls.lists[1][1], 1);
  assert.equal(view.loadMoreFailed.value, false);
});

test('search changes immediately block old pagination during the debounce window', async t => {
  const page = deferred();
  const { view, calls, seed } = harness(t, { list: () => page.promise });
  seed();
  view.selectedIds.value = [1];
  const pending = view.loadMore();
  view.query.value = 'new query';
  assert.equal(view.loading.value, true);
  assert.equal(view.loadingMore.value, false);
  assert.deepEqual(view.selectedIds.value, []);
  await view.loadMore();
  assert.equal(calls.lists.length, 1);
  page.resolve([item(2)]);
  await pending;
  assert.deepEqual(view.records.value, []);
});

test('a fresh first page releases old pagination state without old cleanup unlocking a new request', async t => {
  const old = deferred(), fresh = deferred();
  let moreCalls = 0;
  const { view, seed } = harness(t, {
    total: 5,
    list: (limit, offset) => offset === 0 ? Promise.resolve([item(2)]) : (++moreCalls === 1 ? old.promise : fresh.promise),
  });
  seed();
  const oldRequest = view.loadMore();
  await view.load();
  assert.equal(view.loadingMore.value, false);
  const freshRequest = view.loadMore();
  old.resolve([item(99)]);
  await oldRequest;
  assert.equal(view.loadingMore.value, true);
  fresh.resolve([item(3)]);
  await freshRequest;
  assert.deepEqual(view.records.value.map(record => record.id), [2, 3]);
});

test('failed full refresh cannot start appending pages onto the old list', async t => {
  const failure = deferred();
  const { view, calls, seed, showSentinel } = harness(t, { list: () => failure.promise });
  seed();
  const pending = view.load();
  await showSentinel();
  failure.reject(new Error('local read failed'));
  await pending;
  await settle();
  assert.equal(calls.lists.length, 1);
  assert.match(view.error.value, /local read failed/);
});

test('delete confirmation keeps the reviewed IDs and reports the actual removed count', async t => {
  const { view, calls, notifications, seed } = harness(t, { remove: async () => 1 });
  seed();
  view.selectedIds.value = [1, 2, 3];
  view.askDelete();
  view.selectedIds.value = [4, 5];
  await view.confirmDelete();
  assert.deepEqual(calls.deletes, [[1, 2, 3]]);
  assert.equal(notifications[0].message, '已删除 1 条备份记录');
});

test('delete confirmation cannot dispatch twice while its native request is pending', async t => {
  const remove = deferred();
  const { view, calls, seed } = harness(t, { remove: () => remove.promise });
  seed();
  view.selectedIds.value = [1];
  view.askDelete();
  const pending = view.confirmDelete();
  await view.confirmDelete();
  assert.equal(calls.deletes.length, 1);
  remove.resolve(1);
  await pending;
});

test('delete checks busy state again when confirmation is submitted', async t => {
  const { view, archive, calls, seed } = harness(t);
  seed();
  view.selectedIds.value = [1];
  view.askDelete();
  archive.store.beginRun();
  await view.confirmDelete();
  assert.deepEqual(calls.deletes, []);
  archive.store.finishRun(idleProgress());
  await view.confirmDelete();
  assert.deepEqual(calls.deletes, [[1]]);
});

test('delete selection respects the native limit before opening confirmation', t => {
  const { view, seed } = harness(t);
  seed();
  view.selectedIds.value = Array.from({ length: 501 }, (_, index) => index + 1);
  view.askDelete();
  assert.equal(view.confirmVisible.value, false);
  assert.match(view.error.value, /500/);
});

test('changing filters invalidates pending deletion confirmation', async t => {
  const { view, calls, seed } = harness(t);
  seed();
  view.selectedIds.value = [1];
  view.askDelete();
  view.query.value = 'new query';
  await view.confirmDelete();
  assert.equal(view.confirmVisible.value, false);
  assert.deepEqual(view.deleteIds.value, []);
  assert.deepEqual(calls.deletes, []);
});

test('failed deletion retains its reviewed IDs for a deliberate retry', async t => {
  const { view, notifications, seed } = harness(t, { remove: async () => { throw new Error('delete failed'); } });
  seed();
  view.selectedIds.value = [1];
  view.askDelete();
  await view.confirmDelete();
  assert.equal(view.confirmVisible.value, true);
  assert.deepEqual(view.deleteIds.value, [1]);
  assert.equal(view.deleting.value, false);
  assert.match(view.error.value, /delete failed/);
  assert.deepEqual(notifications, []);
});

test('deletion completion after leaving cannot reload or notify the discarded page', async t => {
  const remove = deferred();
  const { view, calls, notifications, seed, unmount } = harness(t, { remove: () => remove.promise });
  seed();
  view.selectedIds.value = [1];
  view.askDelete();
  const pending = view.confirmDelete();
  unmount();
  remove.resolve(1);
  await pending;
  assert.deepEqual(notifications, []);
  assert.equal(calls.lists.length, 0);
});

test('export keeps its chosen IDs while the native save dialog is open', async t => {
  const save = deferred();
  const { view, calls, seed } = harness(t, { save: () => save.promise });
  seed();
  view.selectedIds.value = [1, 2];
  const pending = view.exportHtml(true);
  view.selectedIds.value = [3];
  save.resolve('chosen.html');
  await pending;
  assert.deepEqual(calls.exports, [['self', 'chosen.html', [1, 2]]]);
});

for (const change of ['unmount', 'account']) {
  test(`save dialog returning after ${change} cannot export a different account`, async t => {
    const save = deferred();
    const { view, calls, auth, seed, unmount } = harness(t, { save: () => save.promise });
    seed();
    const pending = view.exportHtml(false);
    if (change === 'unmount') unmount();
    else auth.user.uin = 'account-b';
    save.resolve('chosen.html');
    await pending;
    assert.deepEqual(calls.exports, []);
  });
}

test('canceling the native save dialog releases export state without an error', async t => {
  const { view, calls, notifications, seed } = harness(t, { save: async () => null });
  seed();
  await view.exportHtml(false);
  assert.equal(view.exporting.value, false);
  assert.equal(view.error.value, '');
  assert.deepEqual(calls.exports, []);
  assert.deepEqual(notifications, []);
});

test('offline archives remain exportable while deletion requires a QQ session', async t => {
  const { view, calls, auth, seed } = harness(t);
  seed();
  auth.loggedIn = false;
  auth.user = undefined;
  view.selectedIds.value = [1];
  view.askDelete();
  assert.equal(view.confirmVisible.value, false);
  await view.exportHtml(false);
  assert.equal(calls.exports.length, 1);
});

test('changing year cancels pending typing debounce and dispatches one final filter request', async t => {
  const h = harness(t, { years: [2024, 2020] });
  h.view.query.value = 'needle';
  await settle();
  assert.equal(h.timers.size, 1);
  h.view.selectedYear.value = 2020;
  await settle();
  assert.equal(h.calls.lists.length, 1);
  assert.deepEqual(h.calls.lists[0], [20, 0, 'self', 2020, true, 'needle']);
  assert.deepEqual(h.calls.counts[0], ['self', 2020, 'needle']);
  assert.equal(h.timers.size, 0);
});

test('changing order cancels typing debounce instead of issuing the same request twice', async t => {
  const h = harness(t);
  h.view.query.value = 'needle';
  await settle();
  h.view.descending.value = false;
  await settle();
  assert.equal(h.calls.lists.length, 1);
  assert.equal(h.calls.lists[0][4], false);
  assert.equal(h.calls.lists[0][5], 'needle');
  assert.equal(h.timers.size, 0);
});

test('route keyword and year changes are loaded together without intermediate requests', async t => {
  const h = harness(t, { years: [2020] });
  h.route.query = { q: '  needle  ', year: '2020' };
  await settle();
  assert.equal(h.calls.lists.length, 1);
  assert.deepEqual(h.calls.lists[0], [20, 0, 'self', 2020, true, 'needle']);
  assert.equal(h.timers.size, 0);
});

test('a new global search applies the route year instead of retaining a local year filter', async t => {
  const h = harness(t, { years: [2020] });
  h.view.selectedYear.value = 2020;
  await settle();
  h.route.query = { q: 'global needle' };
  await settle();
  assert.equal(h.view.selectedYear.value, 0);
  assert.deepEqual(h.calls.lists.at(-1), [20, 0, 'self', undefined, true, 'global needle']);
  assert.equal(h.calls.lists.length, 2);
  assert.equal(h.timers.size, 0);
});

test('category reset clears route filters and batches its multiple state changes into one read', async t => {
  const h = harness(t, { routeQuery: { q: 'old needle', year: '2020', keep: 'value' }, years: [2020] });
  h.view.category.value = 'other';
  await settle();
  assert.deepEqual(h.calls.routes, [{ query: { keep: 'value' } }]);
  assert.deepEqual(h.calls.lists, [[20, 0, 'other', undefined, true, undefined]]);
  assert.equal(h.timers.size, 0);
});

test('typing after a category change in the same event is preserved by the batched reload', async t => {
  const h = harness(t);
  h.view.category.value = 'other';
  h.view.query.value = 'new category needle';
  await settle();
  assert.equal(h.view.query.value, 'new category needle');
  assert.deepEqual(h.calls.lists, [[20, 0, 'other', undefined, true, 'new category needle']]);
  assert.equal(h.timers.size, 0);
});

test('manual refresh cancels an already scheduled search request', async t => {
  const h = harness(t);
  h.view.query.value = 'needle';
  await settle();
  await h.view.load();
  await settle();
  assert.equal(h.calls.lists.length, 1);
  assert.equal(h.timers.size, 0);
});

test('manual refresh before filter watchers flush does not schedule a redundant request', async t => {
  const h = harness(t);
  h.view.query.value = 'needle';
  await h.view.load();
  await settle();
  assert.equal(h.calls.lists.length, 1);
  assert.equal(h.timers.size, 0);
});

test('equivalent whitespace edits do not invalidate already loaded records', async t => {
  const h = harness(t);
  h.seed();
  h.view.query.value = '   ';
  await settle();
  assert.equal(h.view.loading.value, false);
  assert.deepEqual(h.view.records.value.map(item => item.id), [1]);
  assert.equal(h.calls.lists.length, 0);
  h.view.query.value = 'needle';
  await settle();
  await h.tick(260);
  h.view.query.value = '  needle  ';
  await settle();
  assert.equal(h.calls.lists.length, 1);
  assert.equal(h.timers.size, 0);
});

test('invalid route years never become native year filters', async t => {
  for (const year of ['-1', 'Infinity', '2023.5', '1e3', ['2020'], '10000']) {
    const h = harness(t, { routeQuery: { year } });
    await h.view.load();
    assert.equal(h.view.selectedYear.value, 0);
    assert.equal(h.calls.lists[0][3], undefined);
  }
});

test('valid initial route filters are normalized before their first native request', async t => {
  const h = harness(t, { routeQuery: { q: '  needle  ', year: '2020' }, years: [2020] });
  await h.view.load();
  assert.equal(h.view.query.value, 'needle');
  assert.deepEqual(h.calls.lists, [[20, 0, 'self', 2020, true, 'needle']]);
});

test('clearing keyword and year once does not reload again for the route echo', async t => {
  const h = harness(t, { routeQuery: { q: 'needle', year: '2020', keep: 'value' } });
  h.view.clearFilters();
  h.route.query = { keep: 'value' };
  await settle();
  assert.deepEqual(h.calls.lists, [[20, 0, 'self', undefined, true, undefined]]);
  assert.equal(h.timers.size, 0);
});

test('route update errors are handled separately from successfully cleared filters', async t => {
  const h = harness(t, { routeQuery: { q: 'needle', year: '2020' }, replace: async () => { throw new Error('route update failed'); } });
  h.view.clearFilters();
  await settle();
  assert.equal(h.view.query.value, '');
  assert.equal(h.view.selectedYear.value, 0);
  assert.equal(h.view.error.value, '');
  assert.equal(h.notifications.at(-1).kind, 'error');
});

test('leaving the page cancels its pending typing request', async t => {
  const h = harness(t);
  h.view.query.value = 'needle';
  await settle();
  assert.equal(h.timers.size, 1);
  h.unmount();
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.lists.length, 0);
});

test('unrelated route parameters do not erase locally selected search and year filters', async t => {
  const h = harness(t, { years: [2020] });
  h.view.query.value = 'local needle';
  h.view.selectedYear.value = 2020;
  await settle();
  const before = h.calls.lists.length;
  h.route.query = { keep: 'unrelated parameter' };
  await settle();
  assert.equal(h.view.query.value, 'local needle');
  assert.equal(h.view.selectedYear.value, 2020);
  assert.equal(h.calls.lists.length, before);
});

test('the category route echo preserves a newer draft entered in the same event', async t => {
  const h = harness(t, {
    routeQuery: { q: 'old route needle', year: '2020', keep: 'value' },
    replace: async location => { await Promise.resolve(); h.route.query = location.query; },
  });
  h.view.category.value = 'other';
  h.view.query.value = 'new category needle';
  await settle();
  assert.equal(h.view.query.value, 'new category needle');
  assert.deepEqual(h.calls.routes, [{ query: { q: 'new category needle', keep: 'value' } }]);
  assert.deepEqual(h.calls.lists, [[20, 0, 'other', undefined, true, 'new category needle']]);
});
