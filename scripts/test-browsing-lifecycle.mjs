import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import { computed, effectScope, markRaw, nextTick, reactive, ref, watch } from 'vue';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const exposed = {
  Contacts: `load, openComments, showMore, contacts, loading, error, query, visibleCount,
    sentinel, hasMore, commentsVisible, commentsLoading, commentsError, commentThreads`,
  Media: `load, loadImage, observeImages, openOriginal, playVideo, media, selectedYear,
    loading, error, total, exhausted, imageSources, imageLoading, imageErrors,
    imageFallbackAttempted, lightboxIndex, lightboxList, detail, detailVisible,
    detailLoading, detailError, videoSource, videoLoading`,
};
const scripts = Object.fromEntries(Object.keys(exposed).map(name => {
  const { descriptor } = parse(readFileSync(new URL(`../src/views/${name}View.vue`, import.meta.url), 'utf8'));
  const script = transpileModule(descriptor.scriptSetup.content, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '');
  return [name, `${script}\nreturn {${exposed[name]}};`];
}));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 10; turn++) await nextTick(); }
const contact = uin => ({ uin, nickname: `Common ${uin}`, total: 2, likes: 1, comments: 1, lastAt: 0 });
const mediaItem = key => ({ key, dynamicId: 1, mediaType: 'photo', url: `https://example.test/${key}.jpg`, publishedAt: 0 });
const feed = id => ({ id, pictureUrls: [], videoUrl: 'video', content: '', publishedAt: 0 });
const page = (items = [], total = items.length) => ({ items, total, years: [] });

/** Actual setup functions with controlled native responses and observer callbacks. */
function harness(t, name, overrides = {}) {
  const scope = effectScope();
  const mounts = [], unmounts = [], observers = [], revoked = [];
  const calls = { contacts: 0, comments: [], pages: [], images: [], videos: [], details: [] };
  const loadSentinel = {};
  const dependencies = {
    computed, nextTick, reactive, ref, watch,
    onMounted: callback => mounts.push(callback), onBeforeUnmount: callback => unmounts.push(callback),
    describeError: String, convertFileSrc: path => `asset:${path}`, useToast: () => ({}),
    URL: { revokeObjectURL: source => revoked.push(source) },
    document: { querySelectorAll: () => [], querySelector: () => loadSentinel },
    IntersectionObserver: class {
      observed = new Set();
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.observed.add(target); }
      unobserve(target) { this.observed.delete(target); }
      disconnect() { this.observed.clear(); }
    },
    ImageRequestScope: class {
      generation = 0;
      clear() { this.generation++; }
      load(url) { return overrides.remote?.(url) ?? Promise.resolve(`blob:${url}`); }
    },
    listInteractors: () => { calls.contacts++; return overrides.contacts?.() ?? Promise.resolve([]); },
    listContactCommentThreads: uin => { calls.comments.push(uin); return overrides.comments?.(uin) ?? Promise.resolve([]); },
    listArchivedMedia: (...args) => { calls.pages.push(args); return overrides.pages?.(...args) ?? Promise.resolve(page()); },
    loadArchivedImage: (...args) => { calls.images.push(args); return overrides.image?.(...args) ?? Promise.resolve('image'); },
    loadArchivedVideo: id => { calls.videos.push(id); return overrides.video?.(id) ?? Promise.resolve('video'); },
    getArchivedFeed: id => { calls.details.push(id); return overrides.detail?.(id) ?? Promise.resolve(feed(id)); },
  };
  const view = scope.run(() => new Function(...Object.keys(dependencies), scripts[name])(...Object.values(dependencies)));
  let disposed = false;
  function unmount() {
    if (disposed) return;
    disposed = true;
    unmounts.forEach(callback => callback());
    scope.stop();
  }
  t.after(unmount);
  return {
    view, calls, observers, revoked, unmount,
    async mount() { await Promise.all(mounts.map(callback => callback())); await settle(); },
  };
}

test('contacts observe a replacement sentinel even when there are still more results', async t => {
  const { view, mount, observers } = harness(t, 'Contacts', {
    contacts: async () => Array.from({ length: 70 }, (_, index) => contact(String(index))),
  });
  await mount();
  const old = markRaw({}), fresh = markRaw({});
  view.sentinel.value = old;
  await settle();
  const observer = observers[0];
  assert.equal(observer.observed.has(old), true);
  view.sentinel.value = fresh;
  await settle();
  assert.equal(observer.observed.has(old), false);
  assert.equal(observer.observed.has(fresh), true);
  observer.callback([{ isIntersecting: true, target: old }]);
  assert.equal(view.visibleCount.value, 24);
  observer.callback([{ isIntersecting: true, target: fresh }]);
  assert.equal(view.visibleCount.value, 48);
});

test('contacts re-arm after each rendered batch and stop at the real list length', async t => {
  const { view, mount, observers } = harness(t, 'Contacts', {
    contacts: async () => Array.from({ length: 70 }, (_, index) => contact(String(index))),
  });
  await mount();
  const sentinel = markRaw({});
  view.sentinel.value = sentinel;
  await settle();
  const observer = observers[0];
  observer.callback([{ isIntersecting: true, target: sentinel }]);
  await settle();
  assert.equal(observer.observed.has(sentinel), true);
  observer.callback([{ isIntersecting: true, target: sentinel }]);
  await settle();
  assert.equal(view.visibleCount.value, 70);
  assert.equal(view.hasMore.value, false);
  assert.equal(observer.observed.size, 0);
  view.showMore();
  assert.equal(view.visibleCount.value, 70);
});

test('a failed contact refresh preserves existing contacts and can be retried', async t => {
  let fail = true;
  const { view } = harness(t, 'Contacts', { contacts: async () => {
    if (fail) throw new Error('local read failed');
    return [contact('2')];
  } });
  view.contacts.value = [contact('1')];
  await view.load();
  assert.equal(view.contacts.value[0].uin, '1');
  assert.equal(view.loading.value, false);
  assert.match(view.error.value, /local read failed/);
  fail = false;
  await view.load();
  assert.equal(view.contacts.value[0].uin, '2');
  assert.equal(view.error.value, '');
});

test('contact list responses after unmount cannot write old data', async t => {
  const list = deferred();
  const { view, calls, unmount } = harness(t, 'Contacts', { contacts: () => list.promise });
  const pending = view.load();
  unmount();
  list.resolve([contact('1')]);
  await pending;
  await view.load();
  assert.deepEqual(view.contacts.value, []);
  assert.equal(calls.contacts, 1);
});

for (const outcome of ['resolve', 'reject']) {
  test(`closing contact comments discards late ${outcome} results`, async t => {
    const comments = deferred();
    const { view } = harness(t, 'Contacts', { comments: () => comments.promise });
    const pending = view.openComments(contact('1'));
    view.commentsVisible.value = false;
    comments[outcome](outcome === 'resolve' ? [feed(1)] : new Error('old comment error'));
    await pending;
    assert.deepEqual(view.commentThreads.value, []);
    assert.equal(view.commentsError.value, '');
    assert.equal(view.commentsLoading.value, false);
  });
}

test('a previous contact response cannot replace the newly selected contact comments', async t => {
  const old = deferred(), fresh = deferred();
  const { view } = harness(t, 'Contacts', { comments: uin => uin === '1' ? old.promise : fresh.promise });
  const a = view.openComments(contact('1')), b = view.openComments(contact('2'));
  old.resolve([feed(1)]);
  await a;
  assert.equal(view.commentsLoading.value, true);
  assert.deepEqual(view.commentThreads.value, []);
  fresh.resolve([feed(2)]);
  await b;
  assert.equal(view.commentThreads.value[0].id, 2);
});

test('media reset releases old blob images, error flags, previews and detail state', async t => {
  const { view, revoked } = harness(t, 'Media');
  view.imageSources.photo = 'blob:old-photo';
  view.imageSources.local = 'asset:local-file';
  view.imageLoading.photo = true;
  view.imageErrors.photo = 'old error';
  view.imageFallbackAttempted.photo = true;
  view.detail.value = feed(1);
  view.detailVisible.value = true;
  view.lightboxIndex.value = 0;
  view.lightboxList.value = [{ key: 'old-photo' }];
  await view.load(true);
  assert.deepEqual(revoked, ['blob:old-photo']);
  assert.deepEqual(view.imageSources, {});
  assert.deepEqual(view.imageLoading, {});
  assert.deepEqual(view.imageErrors, {});
  assert.deepEqual(view.imageFallbackAttempted, {});
  assert.equal(view.detailVisible.value, false);
  assert.equal(view.detail.value, undefined);
  assert.equal(view.lightboxIndex.value, -1);
  assert.deepEqual(view.lightboxList.value, []);
});

test('switching media year immediately invalidates an old page without clearing new loading state', async t => {
  const old = deferred(), fresh = deferred();
  const { view } = harness(t, 'Media', { pages: (limit, offset, year) => year === 2020 ? fresh.promise : old.promise });
  const pending = view.load(true);
  view.selectedYear.value = 2020;
  old.resolve(page([mediaItem('old')]));
  await pending;
  assert.equal(view.loading.value, true);
  assert.deepEqual(view.media.value, []);
  fresh.resolve(page([mediaItem('new')]));
  await settle();
  assert.equal(view.media.value[0].key, 'new');
  assert.equal(view.loading.value, false);
});

test('old image cleanup after media reset cannot unlock a fresh request for the same URL', async t => {
  const old = deferred(), fresh = deferred();
  let first = true;
  const { view } = harness(t, 'Media', { image: () => { if (first) { first = false; return old.promise; } return fresh.promise; } });
  const a = view.loadImage('photo', 1, 0);
  await view.load(true);
  const b = view.loadImage('photo', 1, 0);
  old.resolve('old-image');
  await a;
  assert.equal(view.imageLoading.photo, true);
  assert.equal(view.imageSources.photo, undefined);
  fresh.resolve('fresh-image');
  await b;
  assert.equal(view.imageSources.photo, 'asset:fresh-image');
  assert.equal(view.imageLoading.photo, false);
});

test('stale media image observers cannot start requests for a previous year', async t => {
  const { view, calls, observers } = harness(t, 'Media');
  view.observeImages();
  const oldObserver = observers[0];
  await view.load(true);
  oldObserver.callback([{ isIntersecting: true, target: { dataset: { mediaImage: 'old-photo', dynamicId: '1', pictureIndex: '0' } } }]);
  await settle();
  assert.deepEqual(calls.images, []);
});

test('closing media detail discards its unfinished native detail lookup', async t => {
  const detail = deferred();
  const { view } = harness(t, 'Media', { detail: () => detail.promise });
  const pending = view.openOriginal(mediaItem('photo'));
  view.detailVisible.value = false;
  detail.resolve(feed(1));
  await pending;
  assert.equal(view.detail.value, undefined);
  assert.equal(view.detailLoading.value, false);
});

test('closing media detail discards an unfinished video request', async t => {
  const video = deferred();
  const { view } = harness(t, 'Media', { video: () => video.promise });
  await view.openOriginal(mediaItem('video'));
  const pending = view.playVideo();
  view.detailVisible.value = false;
  video.resolve('old-video');
  await pending;
  assert.equal(view.videoSource.value, '');
  assert.equal(view.videoLoading.value, false);
});

test('active media detail still loads its video normally', async t => {
  const { view } = harness(t, 'Media');
  await view.openOriginal(mediaItem('video'));
  await view.playVideo();
  assert.equal(view.detail.value.id, 1);
  assert.equal(view.videoSource.value, 'asset:video');
  assert.equal(view.videoLoading.value, false);
});

test('media pagination failure waits for explicit retry at the same offset', async t => {
  let fail = true;
  const { view, calls, mount, observers } = harness(t, 'Media', { pages: async (limit, offset) => {
    if (!offset) return page([mediaItem('one')], 5);
    if (fail) throw new Error('page read failed');
    return page([], 5);
  } });
  await mount();
  observers.find(observer => observer.observed.size).callback([{ isIntersecting: true }]);
  await settle();
  assert.match(view.error.value, /page read failed/);
  const before = calls.pages.length;
  observers.find(observer => observer.observed.size).callback([{ isIntersecting: true }]);
  await settle();
  assert.equal(calls.pages.length, before);
  fail = false;
  await view.load();
  assert.equal(calls.pages.at(-1)[1], 1);
  assert.equal(view.exhausted.value, true);
  assert.equal(view.total.value, 5);
});

test('unmounted media pages cannot dispatch new list, detail or image requests', async t => {
  const { view, calls, unmount } = harness(t, 'Media');
  unmount();
  await view.load(true);
  await view.openOriginal(mediaItem('photo'));
  await view.loadImage('photo', 1, 0);
  assert.deepEqual(calls.pages, []);
  assert.deepEqual(calls.details, []);
  assert.deepEqual(calls.images, []);
});
