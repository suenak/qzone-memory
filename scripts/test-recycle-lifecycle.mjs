import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import { defineStore, storeToRefs } from 'pinia';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { createArchiveHarness } from './helpers/archive-store.mjs';

function compile(source) {
  return transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
    .replace(/^import[\s\S]*?;\r?\n/gm, '');
}
const { descriptor } = parse(readFileSync(new URL('../src/views/RecycleBinView.vue', import.meta.url), 'utf8'));
const script = compile(descriptor.scriptSetup.content);
const recycleScript = compile(readFileSync(new URL('../src/stores/recycle.ts', import.meta.url), 'utf8'))
  .replace('export const useRecycleSessionStore =', 'return');
const useRecycle = new Function('defineStore', 'ref', recycleScript)(defineStore, ref);
const expose = `return { verify, stopVerification, resetVerification, loadAll, loadPhotos,
  openRecoverDialogGuarded, selectDestinationMode, closeRecoverDialog, confirmWithRecover,
  openAlbumRecoverDialogGuarded, confirmAlbumRecover, closeAlbumDialog, onRecoverDialogHide,
  verifying, verified, loading, photos, albums, activeAlbumId, selectedIds, confirmVisible,
  recoveryPhotos, recoverConfirmed, recovering, recoveredCount, albumRecoverTarget, albumRecovering,
  destinationMode, recoveryAlbumName, destinationAlbums, destinationAlbumId, destinationLoading,
  destinationError, error, photoPending, photoGrid, observeCards, visiblePhotoIds };`;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 25; turn++) await nextTick(); }
const albumResponse = (...albums) => ({ data: { album: albums } });
const photoResponse = (...photos) => ({ data: { photo: photos } });
const photo = (id = 'p1', sourceAlbumId = 'source-a') => ({ id, sourceAlbumId, name: id });

/** Real page, shared archive store and recycle store; all native APIs are mocked. */
function harness(t, overrides = {}, sharedRecycle) {
  const archive = createArchiveHarness();
  const recycle = sharedRecycle ?? useRecycle();
  const mounts = [], unmounts = [], updates = [], notifications = [], windows = [], observers = [];
  const commands = [], timers = new Map();
  const auth = reactive({ loggedIn: true, user: { uin: 'account-a' }, loading: false, dialogVisible: false,
    openLogin: async () => { commands.push({ command: 'login' }); } });
  const license = reactive({ canArchive: true, loading: false });
  let nextTimer = 0;
  const call = (command, args = [], fallback) => {
    commands.push({ command, args });
    return overrides[command]?.(...args) ?? Promise.resolve(fallback);
  };
  const scope = effectScope();
  const dependencies = {
    computed, ref, watch, storeToRefs,
    onMounted: callback => mounts.push(callback), onBeforeUnmount: callback => unmounts.push(callback), onUpdated: callback => updates.push(callback),
    useAuthStore: () => auth, useArchiveStore: () => archive.store, useRecycleSessionStore: () => recycle, useLicenseStore: () => license,
    useToast: () => ({ success: message => notifications.push(message) }),
    describeError: (reason, fallback) => fallback ?? String(reason), isTauri: () => true,
    platform: () => overrides.platform ?? 'windows',
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    openRecyclePasswordWindow: () => call('open'), checkRecyclePassword: () => call('check', [], null),
    closeRecyclePasswordWindow: () => call('close'), prepareRecyclePasswordWindow: () => call('prepare', [], 'https://user.qzone.qq.com/fixture/photo/recycle'),
    syncCookiesToWebview: () => call('sync'),
    listRecycleAlbums: token => call('albums', [token], albumResponse()),
    listRecyclePhotos: (...args) => call('photos', args, photoResponse()),
    listQzoneAlbums: () => call('destinations', [], albumResponse({ id: 'target-a', name: 'Target A' })),
    createQzoneAlbum: name => call('create', [name], { id: 'created-album' }),
    recoverRecyclePhotos: (...args) => call('recover', args, {}), recoverRecycleAlbum: (...args) => call('recoverAlbum', args, {}),
    loadRecyclePhotoPreview: url => call('preview', [url], 'data:image/png;base64,fixture'),
    WebviewWindow: class {
      static async getByLabel() { return null; }
      constructor(label) { windows.push(label); }
      async once(event, callback) { if (event === 'tauri://created') callback(); return () => {}; }
    },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; this.elements = []; observers.push(this); }
      observe(element) { this.elements.push(element); }
      disconnect() { this.elements = []; }
    },
  };
  const view = scope.run(() => new Function(...Object.keys(dependencies), `${script}\n${expose}`)(...Object.values(dependencies)));
  let disposed = false;
  function unmount() { if (!disposed) { disposed = true; unmounts.forEach(callback => callback()); scope.stop(); } }
  t.after(() => { unmount(); archive.dispose(); });
  return {
    view, auth, license, recycle, archive, commands, timers, notifications, windows, observers, unmount,
    mount() { mounts.forEach(callback => callback()); },
    count: name => commands.filter(call => call.command === name).length,
    seed(items = [photo(), photo('p2', 'source-b')]) {
      recycle.setVerified('fixture-signature', 'account-a');
      view.photos.value = items;
      view.selectedIds.value = items.map(item => item.id);
    },
    async prepare(items) { this.seed(items); await view.openRecoverDialogGuarded(); view.recoverConfirmed.value = true; },
    async tick(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected ${delay} ms timer`);
      timers.delete(entry[0]); entry[1].callback(); await settle();
    },
  };
}

test('verification requires a matching logged-in owner before any recycle data request', async t => {
  const h = harness(t);
  h.recycle.setVerified('fixture-signature', 'another-account');
  assert.equal(h.view.verified.value, false);
  await h.view.loadAll();
  await h.view.loadPhotos();
  assert.equal(h.count('albums') + h.count('photos'), 0);
});

test('stopping an in-flight verification check cannot write its late signature', async t => {
  const check = deferred();
  const h = harness(t, { check: () => check.promise });
  const pending = h.view.verify();
  await settle();
  assert.equal(h.count('check'), 1);
  h.view.stopVerification();
  check.resolve('obsolete-signature');
  await pending;
  assert.equal(h.recycle.pwd2sig, '');
  assert.equal(h.view.verifying.value, false);
  assert.equal(h.count('albums'), 0);
});

test('account changes and unmounts discard late verification success and failure', async t => {
  for (const outcome of ['success', 'failure']) {
    const check = deferred();
    const h = harness(t, { check: () => check.promise });
    const pending = h.view.verify();
    await settle();
    if (outcome === 'success') h.auth.user = { uin: 'account-b' };
    else h.unmount();
    if (outcome === 'success') check.resolve('obsolete-signature');
    else check.reject(new Error('obsolete check failed'));
    await pending;
    assert.equal(h.recycle.pwd2sig, '');
    assert.equal(h.view.error.value, '');
  }
});

test('stopping verification clears its polling timer and settles without an extra check', async t => {
  const h = harness(t);
  const pending = h.view.verify();
  await settle();
  assert.equal(h.timers.size, 1);
  h.view.stopVerification();
  await pending;
  assert.equal(h.timers.size, 0);
  assert.equal(h.count('check'), 1);
});

test('an old page window close finishes before the next page opens a verification window', async t => {
  const open = deferred();
  const old = harness(t, { open: () => open.promise });
  const first = old.view.verify();
  await settle();
  old.unmount();
  const current = harness(t, {}, old.recycle);
  const second = current.view.verify();
  await settle();
  assert.equal(current.count('open'), 0);
  open.resolve();
  await first;
  await settle();
  assert.equal(old.count('close'), 1);
  assert.equal(old.count('check'), 0);
  assert.equal(current.count('open'), 1);
  current.view.stopVerification();
  await second;
});

test('macOS preparation cancelled by navigation never constructs a late native window', async t => {
  const prepare = deferred();
  const h = harness(t, { platform: 'macos', prepare: () => prepare.promise });
  const pending = h.view.verify();
  await settle();
  h.unmount();
  prepare.resolve('https://user.qzone.qq.com/fixture/photo/recycle');
  await pending;
  assert.deepEqual(h.windows, []);
  assert.equal(h.count('sync'), 0);
});

test('verification success stores the captured owner and loads the recycle lists once', async t => {
  const h = harness(t, { check: async () => 'fixture-signature' });
  await h.view.verify();
  assert.equal(h.view.verified.value, true);
  assert.equal(h.recycle.ownerUin, 'account-a');
  assert.equal(h.count('albums'), 1);
  assert.equal(h.count('photos'), 1);
  assert.equal(h.view.verifying.value, false);
});

test('album switches clear old photos immediately and reject older list responses', async t => {
  const old = deferred(), current = deferred();
  const h = harness(t, { photos: (_token, album) => album === 'old' ? old.promise : current.promise });
  h.seed();
  const first = h.view.loadPhotos('old');
  assert.deepEqual(h.view.photos.value, []);
  const second = h.view.loadPhotos('new');
  old.resolve(photoResponse({ id: 'old-photo' }));
  await first;
  assert.equal(h.view.loading.value, true);
  assert.deepEqual(h.view.photos.value, []);
  current.resolve(photoResponse({ id: 'new-photo' }));
  await second;
  assert.equal(h.view.photos.value[0].id, 'new-photo');
  assert.equal(h.view.loading.value, false);
});

test('a late photo list cannot restore photos after resetting verification or changing account', async t => {
  const photos = deferred();
  const h = harness(t, { photos: () => photos.promise });
  h.seed();
  const pending = h.view.loadPhotos();
  h.view.resetVerification();
  photos.resolve(photoResponse({ id: 'obsolete' }));
  await pending;
  assert.deepEqual(h.view.photos.value, []);
  assert.equal(h.view.loading.value, false);
  assert.equal(h.view.verified.value, false);
});

test('failed or missing previews finish as unavailable rather than permanent loading placeholders', async t => {
  const h = harness(t, {
    photos: async () => photoResponse({ id: 'missing' }, { id: 'failed', pre: 'https://fixture.invalid/image' }),
    preview: async () => { throw new Error('preview unavailable'); },
  });
  h.seed();
  await h.view.loadPhotos();
  for (const item of h.view.photos.value) {
    assert.equal(item.url, undefined);
    assert.equal(h.view.photoPending(item), false);
  }
});

test('closing a destination dialog prevents its old response from filling a newly opened dialog', async t => {
  const old = deferred(), current = deferred();
  let first = true;
  const h = harness(t, { destinations: () => { if (first) { first = false; return old.promise; } return current.promise; } });
  h.seed();
  const opening = h.view.openRecoverDialogGuarded();
  h.view.closeRecoverDialog();
  const reopening = h.view.openRecoverDialogGuarded();
  old.resolve(albumResponse({ id: 'obsolete-target' }));
  await opening;
  assert.equal(h.view.destinationLoading.value, true);
  assert.deepEqual(h.view.destinationAlbums.value, []);
  current.resolve(albumResponse({ id: 'current-target' }));
  await reopening;
  assert.equal(h.view.destinationAlbumId.value, 'current-target');
});

test('destination mode changes ignore old failures and permit a fresh list retry', async t => {
  const old = deferred();
  let first = true;
  const h = harness(t, { destinations: () => { if (first) { first = false; return old.promise; } return Promise.resolve(albumResponse({ id: 'current-target' })); } });
  h.seed();
  const opening = h.view.openRecoverDialogGuarded();
  await h.view.selectDestinationMode('create');
  old.reject(new Error('obsolete list failed'));
  await opening;
  assert.equal(h.view.destinationError.value, '');
  assert.equal(h.view.destinationLoading.value, false);
  await h.view.selectDestinationMode('existing');
  assert.equal(h.view.destinationAlbumId.value, 'current-target');
});

test('photo recovery requires a visible reviewed confirmation and a listed destination', async t => {
  const h = harness(t);
  h.seed();
  await h.view.confirmWithRecover();
  await h.prepare();
  h.view.destinationAlbumId.value = 'unlisted-target';
  await h.view.confirmWithRecover();
  assert.equal(h.count('recover'), 0);
  assert.ok(h.view.error.value);
  h.view.closeRecoverDialog();
  await h.view.confirmWithRecover();
  await h.view.confirmAlbumRecover();
  assert.equal(h.count('recoverAlbum'), 0);
  assert.deepEqual(h.notifications, []);
});

test('recovery uses reviewed photos and captured destination even if drafts change while pending', async t => {
  const first = deferred();
  let calls = 0;
  const h = harness(t, { recover: () => ++calls === 1 ? first.promise : Promise.resolve({}) });
  await h.prepare();
  h.view.selectedIds.value = ['unreviewed'];
  const pending = h.view.confirmWithRecover();
  h.view.destinationAlbumId.value = 'changed-target';
  await h.view.confirmWithRecover();
  assert.equal(h.archive.store.busy, true);
  first.resolve({});
  await pending;
  const submissions = h.commands.filter(call => call.command === 'recover').map(call => call.args);
  assert.deepEqual(submissions, [
    ['fixture-signature', 'source-a', 'target-a', ['p1']],
    ['fixture-signature', 'source-b', 'target-a', ['p2']],
  ]);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.archive.store.busy, false);
});

test('partially successful recovery retries only groups that have not completed', async t => {
  let fail = true;
  const h = harness(t, { recover: async (_token, source) => { if (source === 'source-b' && fail) throw new Error('second group failed'); return {}; } });
  await h.prepare();
  await h.view.confirmWithRecover();
  assert.equal(h.view.recoveredCount.value, 1);
  assert.match(h.view.error.value, /已成功恢复 1 张/);
  assert.deepEqual(h.view.recoveryPhotos.value.map(item => item.id), ['p2']);
  assert.deepEqual(h.view.selectedIds.value, ['p2']);
  assert.deepEqual(h.view.photos.value.map(item => item.id), ['p2']);
  fail = false;
  await h.view.confirmWithRecover();
  assert.deepEqual(h.commands.filter(call => call.command === 'recover').map(call => call.args[1]), ['source-a', 'source-b', 'source-b']);
  assert.equal(h.notifications.length, 1);
});

test('invalid source metadata fails before creating a destination album', async t => {
  const h = harness(t);
  await h.prepare([photo('invalid', '')]);
  await h.view.selectDestinationMode('create');
  await h.view.confirmWithRecover();
  assert.equal(h.count('create'), 0);
  assert.equal(h.count('recover'), 0);
  assert.match(h.view.error.value, /来源相册 ID/);
});

test('new-album mode reuses an existing named album without another creation request', async t => {
  const h = harness(t, { destinations: async () => albumResponse({ id: 'existing-recovery', name: '恢复相册' }) });
  await h.prepare([photo()]);
  await h.view.selectDestinationMode('create');
  await h.view.confirmWithRecover();
  assert.equal(h.count('create'), 0);
  assert.equal(h.commands.find(call => call.command === 'recover').args[2], 'existing-recovery');
});

test('leaving while creating an album prevents subsequent lookup and recovery requests', async t => {
  const create = deferred();
  const h = harness(t, { destinations: async () => albumResponse(), create: () => create.promise });
  await h.prepare([photo()]);
  await h.view.selectDestinationMode('create');
  const pending = h.view.confirmWithRecover();
  await settle();
  assert.equal(h.count('create'), 1);
  h.unmount();
  assert.equal(h.archive.store.busy, true);
  const before = h.count('destinations');
  create.resolve({ id: 'created-album' });
  await pending;
  assert.equal(h.count('destinations'), before);
  assert.equal(h.count('recover'), 0);
  assert.equal(h.archive.store.busy, false);
  assert.deepEqual(h.notifications, []);
});

test('leaving during new-album propagation clears its delay and stops recovery', async t => {
  let created = false;
  const h = harness(t, {
    destinations: async () => created ? albumResponse({ id: 'created', name: '恢复相册' }) : albumResponse(),
    create: async () => { created = true; return { id: 'created' }; },
  });
  await h.prepare([photo()]);
  await h.view.selectDestinationMode('create');
  const pending = h.view.confirmWithRecover();
  await settle();
  assert.equal(h.timers.size, 1);
  h.unmount();
  await pending;
  assert.equal(h.timers.size, 0);
  assert.equal(h.count('recover'), 0);
  assert.equal(h.archive.store.busy, false);
});

test('an in-flight group remains globally busy after navigation and cannot dispatch its next group', async t => {
  const recover = deferred();
  const h = harness(t, { recover: () => recover.promise });
  await h.prepare();
  const pending = h.view.confirmWithRecover();
  h.unmount();
  assert.equal(h.archive.store.recoveringRecycle, true);
  await assert.rejects(h.archive.store.withDataChange(async () => {}));
  recover.resolve({});
  await pending;
  assert.equal(h.count('recover'), 1);
  assert.equal(h.archive.store.busy, false);
  assert.deepEqual(h.notifications, []);
});

test('account changes during an in-flight recovery stop later groups and clear old selections', async t => {
  const recover = deferred();
  const h = harness(t, { recover: () => recover.promise });
  await h.prepare();
  const pending = h.view.confirmWithRecover();
  h.auth.user = { uin: 'account-b' };
  assert.equal(h.view.verified.value, false);
  assert.deepEqual(h.view.selectedIds.value, []);
  recover.resolve({});
  await pending;
  assert.equal(h.count('recover'), 1);
  assert.deepEqual(h.notifications, []);
});

test('resetting verification and closing confirmation are blocked while recovery is pending', async t => {
  const recover = deferred();
  const h = harness(t, { recover: () => recover.promise });
  await h.prepare([photo()]);
  const pending = h.view.confirmWithRecover();
  h.view.resetVerification();
  h.view.closeRecoverDialog();
  assert.equal(h.recycle.pwd2sig, 'fixture-signature');
  assert.equal(h.view.confirmVisible.value, true);
  recover.resolve({});
  await pending;
});

test('album recovery uses the reviewed album once and cannot report success after navigation', async t => {
  const recover = deferred();
  const h = harness(t, { recoverAlbum: () => recover.promise });
  h.seed();
  h.view.albums.value = [{ id: 'album-a', name: 'Album A', count: 3 }];
  h.view.openAlbumRecoverDialogGuarded(h.view.albums.value[0]);
  h.view.albums.value[0].id = 'changed-id';
  const pending = h.view.confirmAlbumRecover();
  await h.view.confirmAlbumRecover();
  assert.equal(h.commands.find(call => call.command === 'recoverAlbum').args[1], 'album-a');
  h.unmount();
  recover.resolve({});
  await pending;
  assert.equal(h.count('recoverAlbum'), 1);
  assert.deepEqual(h.notifications, []);
});

test('archive activity and restricted licences block new recovery attempts', async t => {
  const h = harness(t);
  h.seed();
  h.archive.store.beginRun();
  await h.view.openRecoverDialogGuarded();
  assert.equal(h.view.confirmVisible.value, false);
  h.archive.store.finishRun();
  h.license.canArchive = false;
  await h.view.openRecoverDialogGuarded();
  assert.equal(h.view.confirmVisible.value, false);
  assert.equal(h.count('recover'), 0);
});

test('photo observation stays inside the current page and ignores stale cards', async t => {
  const h = harness(t);
  h.seed();
  const current = { dataset: { photoId: 'p1' } }, stale = { dataset: { photoId: 'stale' } };
  h.view.photoGrid.value = { contains: target => target === current, querySelectorAll: () => [current] };
  h.view.observeCards();
  const observer = h.observers[0];
  assert.deepEqual(observer.elements, [current]);
  observer.callback([{ target: stale, isIntersecting: true }, { target: current, isIntersecting: true }]);
  assert.deepEqual([...h.view.visiblePhotoIds.value], ['p1']);
  h.unmount();
  observer.callback([{ target: stale, isIntersecting: true }]);
  assert.deepEqual([...h.view.visiblePhotoIds.value], ['p1']);
});

test('a created album is reused when retrying only the failed recovery group', async t => {
  let created = false, fail = true;
  const h = harness(t, {
    destinations: async () => created ? albumResponse({ id: 'created', name: '恢复相册' }) : albumResponse(),
    create: async () => { created = true; return { id: 'created' }; },
    recover: async (_token, source) => { if (source === 'source-b' && fail) throw new Error('group failed'); return {}; },
  });
  await h.prepare();
  await h.view.selectDestinationMode('create');
  const first = h.view.confirmWithRecover();
  await settle();
  await h.tick(1800);
  await first;
  assert.equal(h.count('create'), 1);
  assert.deepEqual(h.view.recoveryPhotos.value.map(item => item.id), ['p2']);
  fail = false;
  await h.view.confirmWithRecover();
  assert.equal(h.count('create'), 1);
  assert.deepEqual(h.commands.filter(call => call.command === 'recover').map(call => call.args.slice(1)), [
    ['source-a', 'created', ['p1']], ['source-b', 'created', ['p2']], ['source-b', 'created', ['p2']],
  ]);
});

test('album recovery failures keep the reviewed target for retry and never emit success', async t => {
  let fail = true;
  const h = harness(t, { recoverAlbum: async () => { if (fail) throw new Error('album failed'); return {}; } });
  h.seed();
  h.view.albums.value = [{ id: 'album-a', name: 'Album A', count: 3 }];
  h.view.openAlbumRecoverDialogGuarded(h.view.albums.value[0]);
  await h.view.confirmAlbumRecover();
  assert.equal(h.view.albumRecoverTarget.value.id, 'album-a');
  assert.match(h.view.error.value, /album failed/);
  assert.deepEqual(h.notifications, []);
  assert.equal(h.archive.store.busy, false);
  fail = false;
  await h.view.confirmAlbumRecover();
  assert.equal(h.view.albumRecoverTarget.value, null);
  assert.equal(h.notifications.length, 1);
});

test('a failed native window open does not poison the shared window queue for retry', async t => {
  let fail = true;
  const h = harness(t, {
    open: async () => { if (fail) throw new Error('window failed'); },
    check: async () => 'fixture-signature',
  });
  await h.view.verify();
  assert.match(h.view.error.value, /window failed/);
  assert.equal(h.view.verifying.value, false);
  fail = false;
  await h.view.verify();
  assert.equal(h.view.verified.value, true);
});

test('returning to the page during recovery waits and loads data once shared activity ends', async t => {
  const recovery = deferred();
  const h = harness(t);
  h.seed();
  h.view.photos.value = [];
  const pending = h.archive.store.withRecycleRecovery(() => recovery.promise);
  h.mount();
  assert.equal(h.view.loading.value, true);
  assert.equal(h.count('albums'), 0);
  recovery.resolve();
  await pending;
  await settle();
  assert.equal(h.count('albums'), 1);
  assert.equal(h.view.loading.value, false);
});
