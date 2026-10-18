import assert from 'node:assert/strict';
import test from 'node:test';
import { createArchiveHarness, idleProgress } from './helpers/archive-store.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}
function harness(t, overrides) {
  const result = createArchiveHarness(overrides);
  t.after(result.dispose);
  return result;
}

test('library IPC marks global activity before native dispatch and releases it on success', async t => {
  const sync = deferred();
  let busyAtDispatch;
  const { store, calls } = harness(t, { sync: () => { busyAtDispatch = store.busy; return sync.promise; } });
  const pending = store.syncLibrary('photos', 'album-a');
  assert.equal(busyAtDispatch, true);
  assert.equal(store.syncing, true);
  assert.deepEqual(calls.syncs, [['photos', 'album-a']]);
  const result = { saved: 3, complete: false };
  sync.resolve(result);
  assert.deepEqual(await pending, result);
  await settle();
  assert.equal(store.busy, false);
  assert.equal(calls.progress, 1);
});

test('library IPC rejection and synchronous dispatch errors release pending activity', async t => {
  for (const immediate of [false, true]) {
    const failure = new Error('sync failed');
    const { store } = harness(t, { sync: () => { if (immediate) throw failure; return Promise.reject(failure); } });
    await assert.rejects(store.syncLibrary('albums'), error => error === failure);
    await settle();
    assert.equal(store.busy, false);
  }
});

test('idle polling cannot override pending library activity', async t => {
  const sync = deferred();
  const { store } = harness(t, { sync: () => sync.promise });
  const pending = store.syncLibrary('albums');
  await store.refresh();
  assert.equal(store.progress.librarySyncing, false);
  assert.equal(store.syncing, true);
  assert.equal(store.busy, true);
  sync.resolve({ complete: true });
  await pending;
});

test('finishing one concurrent request cannot unlock another pending sync', async t => {
  const first = deferred(), second = deferred();
  const { store } = harness(t, { sync: module => module === 'albums' ? first.promise : second.promise });
  const a = store.syncLibrary('albums'), b = store.syncLibrary('videos');
  first.reject(new Error('native sync already running'));
  await assert.rejects(a);
  await settle();
  assert.equal(store.busy, true);
  second.resolve({ complete: true });
  await b;
  await settle();
  assert.equal(store.busy, false);
});

test('a progress read started before sync cannot overwrite its newer snapshot', async t => {
  const old = deferred(), sync = deferred();
  let first = true;
  const { store } = harness(t, {
    sync: () => sync.promise,
    progress: () => { if (first) { first = false; return old.promise; } return Promise.resolve({ ...idleProgress(), saved: 7 }); },
  });
  const oldRead = store.refresh();
  const pending = store.syncLibrary('albums');
  await store.refresh();
  old.resolve({ ...idleProgress(), saved: 99 });
  await oldRead;
  assert.equal(store.progress.saved, 7);
  sync.resolve({ complete: true });
  await pending;
});

test('sync completion rejects in-flight snapshots that still report syncing', async t => {
  const old = deferred(), sync = deferred();
  let first = true;
  const { store } = harness(t, {
    sync: () => sync.promise,
    progress: () => { if (first) { first = false; return old.promise; } return Promise.resolve(idleProgress()); },
  });
  const pending = store.syncLibrary('albums');
  const oldRead = store.refresh();
  sync.resolve({ complete: true });
  await pending;
  await settle();
  old.resolve({ ...idleProgress(), librarySyncing: true });
  await oldRead;
  assert.equal(store.syncing, false);
});

test('a remotely reported sync stays busy until a fresh native snapshot confirms completion', async t => {
  const sync = deferred(), progress = deferred();
  const { store } = harness(t, { sync: () => sync.promise, progress: () => progress.promise });
  store.progress = { ...idleProgress(), librarySyncing: true };
  const pending = store.syncLibrary('albums');
  sync.resolve({ complete: true });
  await pending;
  assert.equal(store.syncing, true);
  progress.resolve(idleProgress());
  await store.refresh();
  assert.equal(store.syncing, false);
});

test('activity boundaries reschedule idle polling immediately and leave only one timer', async t => {
  const sync = deferred();
  const { store, timers } = harness(t, { sync: () => sync.promise });
  store.startPolling();
  await settle();
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [15000]);
  const pending = store.syncLibrary('albums');
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [2000]);
  sync.resolve({ complete: true });
  await pending;
  await settle();
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [15000]);
});

test('concurrent progress reads still share their native request', async t => {
  const progress = deferred();
  const { store, calls } = harness(t, { progress: () => progress.promise });
  const a = store.refresh(), b = store.refresh();
  assert.equal(calls.progress, 1);
  progress.resolve(idleProgress());
  await Promise.all([a, b]);
});

test('library completion never clears a running feed archive', async t => {
  const { store } = harness(t, { progress: async () => ({ ...idleProgress(), status: 'running' }) });
  store.beginRun();
  await store.syncLibrary('albums');
  await settle();
  assert.equal(store.syncing, false);
  assert.equal(store.running, true);
  assert.equal(store.busy, true);
});

test('disposing the store stops polling even if an IPC response arrives later', async t => {
  const progress = deferred();
  const { store, timers, dispose } = harness(t, { progress: () => progress.promise });
  store.startPolling();
  assert.equal(timers.size, 1);
  dispose();
  assert.equal(timers.size, 0);
  progress.resolve(idleProgress());
  await settle();
  assert.equal(timers.size, 0);
});

test('skip retry marks global activity before dispatch and clears it on success', async t => {
  const retry = deferred();
  let busyAtDispatch;
  const { store, calls } = harness(t, { retry: () => { busyAtDispatch = store.busy; return retry.promise; } });
  const pending = store.retrySkip(7);
  assert.equal(busyAtDispatch, true);
  assert.equal(store.retryingSkipId, 7);
  const result = { success: false, message: 'Empty page retained', recoveredRecords: 0 };
  retry.resolve(result);
  assert.deepEqual(await pending, result);
  await settle();
  assert.equal(store.retryingSkipId, undefined);
  assert.equal(store.busy, false);
  assert.equal(calls.progress, 1);
});

test('skip retry failures release activity and preserve the original error', async t => {
  for (const immediate of [false, true]) {
    const failure = new Error('retry failed');
    const { store } = harness(t, { retry: () => { if (immediate) throw failure; return Promise.reject(failure); } });
    await assert.rejects(store.retrySkip(7), error => error === failure);
    await settle();
    assert.equal(store.retrying, false);
    assert.equal(store.busy, false);
  }
});

test('one skip retry prevents another retry and library backup from dispatching', async t => {
  const retry = deferred();
  const { store, calls } = harness(t, { retry: () => retry.promise });
  const pending = store.retrySkip(7);
  await assert.rejects(store.retrySkip(8));
  await assert.rejects(store.syncLibrary('albums'));
  assert.deepEqual(calls.retries, [7]);
  assert.equal(calls.syncs.length, 0);
  assert.equal(store.retryingSkipId, 7);
  retry.resolve({ success: true });
  await pending;
});

test('a feed run or library backup prevents skip retries from dispatching', async t => {
  const sync = deferred();
  const { store, calls } = harness(t, { sync: () => sync.promise });
  store.beginRun();
  await assert.rejects(store.retrySkip(7));
  store.finishRun(idleProgress());
  const pending = store.syncLibrary('albums');
  await assert.rejects(store.retrySkip(7));
  assert.deepEqual(calls.retries, []);
  sync.resolve({ complete: true });
  await pending;
});

test('idle snapshots cannot unlock a pending skip retry', async t => {
  const retry = deferred();
  const { store } = harness(t, { retry: () => retry.promise });
  const pending = store.retrySkip(7);
  await store.refresh();
  assert.equal(store.busy, true);
  assert.equal(store.retryingSkipId, 7);
  retry.resolve({ success: true });
  await pending;
});

test('retry completion discards pre-completion progress and uses a fresh skipped count', async t => {
  const retry = deferred(), old = deferred();
  let first = true;
  const { store } = harness(t, {
    retry: () => retry.promise,
    progress: () => { if (first) { first = false; return old.promise; } return Promise.resolve({ ...idleProgress(), skipped: 0 }); },
  });
  const pending = store.retrySkip(7);
  const oldRead = store.refresh();
  retry.resolve({ success: true });
  await pending;
  await settle();
  old.resolve({ ...idleProgress(), skipped: 9 });
  await oldRead;
  assert.equal(store.progress.skipped, 0);
});

test('local data changes stay globally busy until required cleanup finishes', async t => {
  const cleanup = deferred();
  const { store } = harness(t);
  const pending = store.withDataChange(async () => {
    assert.equal(store.busy, true);
    await cleanup.promise;
    return 3;
  });
  assert.equal(store.dataChanging, true);
  await store.refresh();
  assert.equal(store.busy, true);
  cleanup.resolve();
  assert.equal(await pending, 3);
  assert.equal(store.dataChanging, false);
});

test('local data changes block duplicate changes, archive starts, syncs and retries', async t => {
  const operation = deferred();
  const { store, calls } = harness(t);
  const pending = store.withDataChange(() => operation.promise);
  let duplicateCalled = false;
  await assert.rejects(store.withDataChange(async () => { duplicateCalled = true; }));
  assert.throws(() => store.beginRun());
  await assert.rejects(store.syncLibrary('albums'));
  await assert.rejects(store.retrySkip(1));
  assert.equal(duplicateCalled, false);
  assert.equal(calls.syncs.length + calls.retries.length, 0);
  operation.resolve();
  await pending;
});

test('failed local data changes release activity and preserve their error', async t => {
  const failure = new Error('data change failed');
  const { store, calls } = harness(t);
  await assert.rejects(store.withDataChange(async () => { throw failure; }), reason => reason === failure);
  assert.equal(store.dataChanging, false);
  assert.equal(store.busy, false);
  assert.equal(calls.progress, 1);
});

test('local data changes cannot start during archive activity', async t => {
  const { store } = harness(t);
  store.beginRun();
  let called = false;
  await assert.rejects(store.withDataChange(async () => { called = true; }));
  assert.equal(called, false);
  assert.equal(store.running, true);
});

test('recycle recovery remains globally busy even when native progress reports idle', async t => {
  const recovery = deferred();
  const { store } = harness(t);
  const pending = store.withRecycleRecovery(() => recovery.promise);
  assert.equal(store.recoveringRecycle, true);
  await store.refresh();
  assert.equal(store.busy, true);
  recovery.resolve(2);
  assert.equal(await pending, 2);
  assert.equal(store.recoveringRecycle, false);
  assert.equal(store.busy, false);
});

test('recycle recovery blocks account data changes and competing native task writes', async t => {
  const recovery = deferred();
  const { store, calls } = harness(t);
  const pending = store.withRecycleRecovery(() => recovery.promise);
  assert.throws(() => store.beginRun());
  await assert.rejects(store.syncLibrary('albums'));
  await assert.rejects(store.retrySkip(1));
  let called = false;
  await assert.rejects(store.withDataChange(async () => { called = true; }));
  await assert.rejects(store.withRecycleRecovery(async () => { called = true; }));
  assert.equal(called, false);
  assert.equal(calls.syncs.length + calls.retries.length, 0);
  recovery.resolve();
  await pending;
});

test('recycle recovery failures release shared activity and allow a deliberate retry', async t => {
  const { store } = harness(t);
  await assert.rejects(store.withRecycleRecovery(async () => { throw new Error('recovery failed'); }), /recovery failed/);
  assert.equal(store.recoveringRecycle, false);
  assert.equal(store.busy, false);
  assert.equal(await store.withRecycleRecovery(async () => 1), 1);
});

test('an active archive task rejects recycle recovery before its callback runs', async t => {
  const { store } = harness(t);
  store.beginRun();
  let called = false;
  await assert.rejects(store.withRecycleRecovery(async () => { called = true; }));
  assert.equal(called, false);
  assert.equal(store.recoveringRecycle, false);
});
