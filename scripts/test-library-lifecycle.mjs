import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { createArchiveHarness } from './helpers/archive-store.mjs';

// Run the actual view's setup logic with controlled native responses. No QQ session,
// credential store, network, filesystem media or browser window is accessed.
const source = readFileSync(new URL('../src/views/LibraryView.vue', import.meta.url), 'utf8');
const { descriptor } = parse(source);
const script = transpileModule(descriptor.scriptSetup.content, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '');
const expose = `return {
  load, sync, openMedia, originalImage, chooseVideo, loadVideoChoices, confirmVideoChoice,
  items, page, years, query, selectedYear, first, loading, error, notice, syncing,
  videoVisible, videoSource, videoError, videoChoicesVisible, videoChoices, choicesLoading,
  mediaOpening, originalSources, originalErrors, activeVideoItem,
};`;

const emptyPage = () => ({ items: [], total: 0, complete: false, syncedAt: 0 });
const item = (id = 1, isVideo = false) => ({
  id, isVideo, module: 'photos', title: `Item ${id}`, coverUrl: '', createdAt: 0,
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let turn = 0; turn < 8; turn++) await nextTick();
}
function harness(t, overrides = {}) {
  const scope = effectScope();
  const unmounts = [];
  const route = reactive({ meta: { module: 'photos' }, params: { albumId: 'a' }, query: {} });
  const auth = reactive({ user: { uin: 'account-a' } });
  const notifications = [];
  const calls = { lists: [], media: [], syncs: [] };
  const { store: archiveStore, dispose: disposeArchive } = createArchiveHarness({
    sync: (...args) => { calls.syncs.push(args); return overrides.sync?.(...args) ?? Promise.resolve({ saved: 0, complete: true }); },
  });
  const dependencies = {
    computed, nextTick, reactive, ref, watch,
    onMounted: () => {}, onBeforeUnmount: (callback) => unmounts.push(callback),
    useRoute: () => route, useRouter: () => ({ push: async () => {} }),
    useAuthStore: () => auth,
    useArchiveStore: () => archiveStore,
    useToast: () => Object.fromEntries(['error', 'info', 'success'].map(kind => [kind, message => notifications.push({ kind, message })])),
    describeError: (reason) => String(reason),
    convertFileSrc: (path) => `asset:${path}`,
    ImageRequestScope: class {
      generation = 0;
      clear() { this.generation++; }
    },
    IntersectionObserver: class { disconnect() {} observe() {} },
    document: { querySelectorAll: () => [] },
    listQzoneLibrary: (...args) => { calls.lists.push(args); return overrides.list?.(...args) ?? Promise.resolve(emptyPage()); },
    listQzoneLibraryYears: async () => [],
    loadLibraryMedia: (...args) => { calls.media.push(args); return overrides.media?.(...args) ?? Promise.resolve({ path: 'media' }); },
    linkLibraryVideo: (...args) => overrides.link?.(...args) ?? Promise.resolve(),
  };
  const view = scope.run(() => new Function(...Object.keys(dependencies), `${script}\n${expose}`)(...Object.values(dependencies)));
  let disposed = false;
  function unmount() {
    if (disposed) return;
    disposed = true;
    unmounts.forEach(callback => callback());
    scope.stop();
  }
  t.after(() => { unmount(); disposeArchive(); });
  return { view, route, auth, calls, notifications, unmount, archiveStore };
}

test('changing albums clears old content immediately and rejects late list results', async t => {
  const oldList = deferred();
  let first = true;
  const { view, route } = harness(t, { list: () => {
    if (first) { first = false; return oldList.promise; }
    return Promise.resolve({ ...emptyPage(), items: [item(2)], total: 1 });
  } });
  view.items.value = [item(99)];
  view.page.value = { ...emptyPage(), total: 99 };
  const pending = view.load();
  route.params.albumId = 'b';
  assert.deepEqual(view.items.value, []);
  assert.equal(view.page.value, undefined);
  assert.equal(view.loading.value, true);
  await settle();
  oldList.resolve({ ...emptyPage(), items: [item(1)] });
  await pending;
  assert.deepEqual(view.items.value.map(entry => entry.id), [2]);
});

test('resetting album filters performs one reload without a leftover search timer', async t => {
  const { view, route, calls } = harness(t);
  view.query.value = 'old search';
  view.selectedYear.value = 2020;
  await settle();
  const before = calls.lists.length;
  route.params.albumId = 'b';
  await settle();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(calls.lists.length - before, 1);
  assert.equal(view.query.value, '');
  assert.equal(view.selectedYear.value, 0);
});

for (const outcome of ['resolve', 'reject']) {
  test(`backup ${outcome} after unmount cannot reload or notify`, async t => {
    const backup = deferred();
    const { view, notifications, calls, unmount } = harness(t, { sync: () => backup.promise });
    const pending = view.sync();
    unmount();
    backup[outcome](outcome === 'resolve' ? { saved: 3, complete: true } : new Error('backup failed'));
    await pending;
    assert.equal(calls.lists.length, 0);
    assert.deepEqual(notifications, []);
    assert.equal(view.error.value, '');
  });
}

test('returning to the same album cannot revive an old backup result', async t => {
  const backup = deferred();
  const { view, route, notifications, calls } = harness(t, { sync: () => backup.promise });
  const pending = view.sync();
  route.params.albumId = 'b';
  route.params.albumId = 'a';
  await settle();
  const before = calls.lists.length;
  backup.resolve({ saved: 9, complete: true });
  await pending;
  assert.deepEqual(notifications, []);
  assert.equal(calls.lists.length, before);
  assert.equal(view.notice.value, '');
  assert.equal(view.syncing.value, false);
});

test('backup error cannot overwrite another album after its local reload', async t => {
  const list = deferred();
  let first = true;
  const { view, route } = harness(t, {
    sync: async () => { throw new Error('old backup failed'); },
    list: () => { if (first) { first = false; return list.promise; } return Promise.resolve(emptyPage()); },
  });
  const pending = view.sync();
  await settle();
  route.params.albumId = 'b';
  await settle();
  list.resolve(emptyPage());
  await pending;
  assert.equal(view.error.value, '');
});

test('closing video prevents an expired URL from starting a new backup', async t => {
  const media = deferred();
  const { view, calls } = harness(t, { media: () => media.promise });
  const pending = view.openMedia(item(1, true));
  view.videoVisible.value = false;
  media.reject(new Error('HTTP 403'));
  await pending;
  assert.equal(calls.syncs.length, 0);
  assert.equal(view.videoError.value, '');
  assert.equal(view.mediaOpening.size, 0);
});

test('old video responses cannot clear the loading state of a reopened video', async t => {
  const old = deferred(), fresh = deferred();
  let first = true;
  const { view } = harness(t, { media: () => { if (first) { first = false; return old.promise; } return fresh.promise; } });
  const oldRequest = view.openMedia(item(1, true));
  view.videoVisible.value = false;
  const newRequest = view.openMedia(item(1, true));
  old.resolve({ path: 'old' });
  await oldRequest;
  assert.equal(view.mediaOpening.has(1), true);
  assert.equal(view.videoSource.value, '');
  fresh.resolve({ path: 'fresh' });
  await newRequest;
  assert.equal(view.videoSource.value, 'asset:fresh');
  assert.equal(view.mediaOpening.has(1), false);
});

test('photo and video requests have independent lifetimes', async t => {
  const photo = deferred();
  const { view } = harness(t, { media: id => id === 1 ? photo.promise : Promise.resolve({ path: 'video' }) });
  const pending = view.originalImage(item());
  await view.openMedia(item(2, true));
  photo.resolve({ path: 'photo' });
  await pending;
  assert.equal(view.originalSources[1], 'asset:photo');
  assert.equal(view.mediaOpening.size, 0);
});

test('old photo cleanup cannot clear a new account request with the same local ID', async t => {
  const old = deferred(), fresh = deferred();
  let first = true;
  const { view, auth } = harness(t, { media: () => { if (first) { first = false; return old.promise; } return fresh.promise; } });
  const oldRequest = view.originalImage(item());
  auth.user.uin = 'account-b';
  await settle();
  const newRequest = view.originalImage(item());
  old.resolve({ path: 'old-account' });
  await oldRequest;
  assert.equal(view.mediaOpening.has(1), true);
  assert.equal(view.originalSources[1], undefined);
  fresh.resolve({ path: 'new-account' });
  await newRequest;
  assert.equal(view.originalSources[1], 'asset:new-account');
});

test('closing video choices discards errors from an unfinished search', async t => {
  const list = deferred();
  const { view, notifications } = harness(t, { list: () => list.promise });
  const pending = view.chooseVideo();
  view.videoChoicesVisible.value = false;
  list.reject(new Error('old search failed'));
  await pending;
  assert.deepEqual(notifications, []);
  assert.equal(view.choicesLoading.value, false);
});

test('closing video choices while linking cannot reopen playback', async t => {
  const link = deferred();
  const { view, calls } = harness(t, { link: () => link.promise });
  view.activeVideoItem.value = item(1, true);
  await view.chooseVideo();
  const pending = view.confirmVideoChoice(item(2, true));
  view.videoChoicesVisible.value = false;
  link.resolve();
  await pending;
  assert.equal(calls.media.length, 0);
  assert.equal(view.videoVisible.value, false);
});

for (const complete of [true, false]) {
  test(`active backup preserves its ${complete ? 'complete' : 'partial'} result and refreshes local content`, async t => {
    const { view, calls, notifications } = harness(t, {
      sync: async () => ({ saved: 3, complete }),
      list: async () => ({ ...emptyPage(), items: [item(3)], total: 1 }),
    });
    await view.sync();
    assert.equal(calls.lists.length, 1);
    assert.deepEqual(view.items.value.map(entry => entry.id), [3]);
    assert.equal(view.syncing.value, false);
    assert.match(view.notice.value, /已保存 3 条/);
    assert.equal(notifications[0].kind, complete ? 'success' : 'info');
  });
}

test('active backup failure preserves its cause even when the local reload also fails', async t => {
  const { view } = harness(t, {
    sync: async () => { throw new Error('backup failed'); },
    list: async () => { throw new Error('local reload failed'); },
  });
  await view.sync();
  assert.match(view.error.value, /backup failed/);
  assert.equal(view.loading.value, false);
  assert.equal(view.syncing.value, false);
});

test('active video still refreshes an expired URL once and plays the refreshed media', async t => {
  let first = true;
  const { view, calls } = harness(t, { media: async () => {
    if (first) { first = false; throw new Error('HTTP 403'); }
    return { path: 'refreshed-video' };
  } });
  await view.openMedia(item(1, true));
  assert.deepEqual(calls.syncs, [['videos', undefined]]);
  assert.equal(calls.media.length, 2);
  assert.equal(view.videoSource.value, 'asset:refreshed-video');
  assert.equal(view.videoError.value, '');
});

test('active video choice links and opens playback normally', async t => {
  const links = [];
  const { view } = harness(t, { link: async (...args) => { links.push(args); } });
  view.activeVideoItem.value = item(1, true);
  await view.chooseVideo();
  await view.confirmVideoChoice(item(2, true));
  assert.deepEqual(links, [[1, 2]]);
  assert.equal(view.videoChoicesVisible.value, false);
  assert.equal(view.videoVisible.value, true);
  assert.equal(view.videoSource.value, 'asset:media');
});

test('leaving the library keeps the shared backup state busy until native completion', async t => {
  const backup = deferred();
  const { view, archiveStore, unmount } = harness(t, { sync: () => backup.promise });
  const pending = view.sync();
  assert.equal(archiveStore.busy, true);
  unmount();
  assert.equal(archiveStore.busy, true);
  backup.resolve({ saved: 3, complete: true });
  await pending;
  await settle();
  assert.equal(archiveStore.busy, false);
});

test('an existing global sync disables duplicate backup requests in a new library page', async t => {
  const backup = deferred();
  const { view, archiveStore, calls } = harness(t, { sync: () => backup.promise });
  const existing = archiveStore.syncLibrary('albums');
  assert.equal(view.syncing.value, true);
  await view.sync();
  assert.equal(calls.syncs.length, 1);
  backup.resolve({ saved: 1, complete: true });
  await existing;
});

test('video address refresh remains globally busy after its playback dialog closes', async t => {
  const backup = deferred();
  const { view, archiveStore, calls } = harness(t, {
    media: async () => { throw new Error('HTTP 403'); },
    sync: () => backup.promise,
  });
  const pending = view.openMedia(item(1, true));
  await settle();
  assert.equal(archiveStore.busy, true);
  view.videoVisible.value = false;
  assert.equal(archiveStore.busy, true);
  backup.resolve({ saved: 1, complete: true });
  await pending;
  await settle();
  assert.equal(archiveStore.busy, false);
  assert.equal(calls.media.length, 1);
});
