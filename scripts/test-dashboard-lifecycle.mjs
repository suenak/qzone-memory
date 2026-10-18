import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import { computed, effectScope, nextTick, reactive, ref, toRefs, watch } from 'vue';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { createArchiveHarness, idleProgress } from './helpers/archive-store.mjs';

const { descriptor } = parse(readFileSync(new URL('../src/views/DashboardView.vue', import.meta.url), 'utf8'));
const script = transpileModule(descriptor.scriptSetup.content, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '');
const expose = `return { loadDashboard, loadAvatar, scheduleRefresh, handleVisibilityChange, primaryAction,
  overview, recent, ranking, archiveYears, loading, overviewLoaded, dashboardError, rankingError,
  recentError, yearsError, firstLoadPending, rankingPending, recentPending, avatarSources, yearSpan };`;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 15; turn++) await nextTick(); }
const stats = (dynamics = 2) => ({ dynamics, pictures: 1, comments: 3, likes: 4, databaseBytes: 1024 });
const item = (id = 1, authorUin) => ({ id, content: 'fixture', publishedAt: 1_000_000, authorUin, pictureUrls: [], likes: [], comments: [] });
const rank = (uin = 'fixture-person') => ({ uin, nickname: uin, interactions: 3, likes: 2, comments: 1 });
function avatarResponse(size = 4, contentType = 'image/png') {
  let read = false;
  return { ok: true, headers: { get: () => contentType }, body: { getReader: () => ({
    read: async () => { if (read) return { done: true }; read = true; return { done: false, value: new Uint8Array(size) }; },
    cancel: async () => {},
  }) } };
}

/** Actual dashboard and archive store; native reads, image HTTP and time are controlled. */
function harness(t, overrides = {}) {
  const archive = createArchiveHarness();
  const scope = effectScope(), mounts = [], unmounts = [], revoked = [], routes = [], fetches = [];
  const events = new Map(), timers = new Map();
  const calls = { stats: 0, recent: 0, ranking: 0, years: 0, login: 0, blobs: 0 };
  const auth = reactive({ loggedIn: overrides.loggedIn ?? true, user: overrides.loggedIn === false ? undefined : { uin: 'account-a' },
    openLogin: async () => { calls.login++; } });
  let nextTimer = 0, now = 1_000_000;
  const document = { visibilityState: 'visible', addEventListener: (type, fn) => events.set(type, fn), removeEventListener: type => events.delete(type) };
  const dependencies = {
    computed, reactive, ref, watch, storeToRefs: toRefs,
    onMounted: callback => mounts.push(callback), onBeforeUnmount: callback => unmounts.push(callback),
    useAuthStore: () => auth, useArchiveStore: () => archive.store, useRouter: () => ({ push: async route => { routes.push(route); } }),
    IDLE_ARCHIVE_PROGRESS: idleProgress(), document,
    Date: class extends Date { static now() { return now; } },
    window: {
      setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
      clearTimeout: id => timers.delete(id),
    },
    URL: { createObjectURL: () => `blob:avatar-${++calls.blobs}`, revokeObjectURL: url => revoked.push(url) },
    fetch: async (url, options) => { fetches.push({ url, options }); return overrides.fetch?.(url, options) ?? avatarResponse(); },
    getArchiveOverview: async () => { calls.stats++; return overrides.stats?.(calls.stats) ?? stats(); },
    listArchivedFeeds: async () => { calls.recent++; return overrides.recent?.() ?? [item()]; },
    getInteractionRanking: async () => { calls.ranking++; return overrides.ranking?.() ?? [rank()]; },
    listArchiveYears: async () => { calls.years++; return overrides.years?.() ?? [2024, 2023]; },
  };
  const view = scope.run(() => new Function(...Object.keys(dependencies), `${script}\n${expose}`)(...Object.values(dependencies)));
  let disposed = false;
  function unmount() { if (!disposed) { disposed = true; unmounts.forEach(callback => callback()); scope.stop(); } }
  t.after(() => { unmount(); archive.dispose(); });
  return {
    view, auth, archive, calls, fetches, revoked, routes, timers, events, document, unmount,
    async mount() { mounts.forEach(callback => callback()); await settle(); },
    advance(ms) { now += ms; },
    async tick(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay} ms timer`);
      timers.delete(entry[0]); entry[1].callback(); await settle();
    },
  };
}

test('initial dashboard sections show pending state before the first native response', t => {
  const h = harness(t);
  assert.equal(h.view.firstLoadPending.value, true);
  assert.equal(h.view.rankingPending.value, true);
  assert.equal(h.view.recentPending.value, true);
});

test('ranking failures do not discard successfully loaded statistics or recent records', async t => {
  const h = harness(t, { ranking: async () => { throw new Error('ranking failed'); } });
  await h.view.loadDashboard();
  assert.equal(h.view.overview.value.dynamics, 2);
  assert.equal(h.view.overviewLoaded.value, true);
  assert.equal(h.view.recent.value.length, 1);
  assert.equal(h.view.dashboardError.value, '');
  assert.match(h.view.rankingError.value, /ranking failed/);
  assert.equal(h.view.rankingPending.value, false);
});

test('overview failure does not hide successful ranking and recent records', async t => {
  const h = harness(t, { stats: async () => { throw new Error('statistics failed'); } });
  await h.view.loadDashboard();
  assert.equal(h.view.overviewLoaded.value, false);
  assert.match(h.view.dashboardError.value, /statistics failed/);
  assert.equal(h.view.ranking.value.length, 1);
  assert.equal(h.view.recent.value.length, 1);
  assert.equal(h.view.firstLoadPending.value, false);
});

test('recent-record failure has a separate retryable state', async t => {
  let fail = true;
  const h = harness(t, { recent: async () => { if (fail) throw new Error('recent failed'); return [item(2)]; } });
  await h.view.loadDashboard();
  assert.match(h.view.recentError.value, /recent failed/);
  assert.equal(h.view.recentPending.value, false);
  assert.equal(h.view.dashboardError.value, '');
  fail = false;
  await h.view.loadDashboard();
  assert.equal(h.view.recentError.value, '');
  assert.equal(h.view.recent.value[0].id, 2);
});

test('failed background reads keep the previously confirmed data and identify stale sections', async t => {
  let fail = false;
  const h = harness(t, {
    stats: async () => { if (fail) throw new Error('stats refresh failed'); return stats(9); },
    ranking: async () => { if (fail) throw new Error('ranking refresh failed'); return [rank()]; },
    years: async () => { if (fail) throw new Error('years refresh failed'); return [2024]; },
  });
  await h.view.loadDashboard();
  fail = true;
  await h.view.loadDashboard();
  assert.equal(h.view.overview.value.dynamics, 9);
  assert.equal(h.view.overviewLoaded.value, true);
  assert.equal(h.view.ranking.value.length, 1);
  assert.deepEqual(h.view.archiveYears.value, [2024]);
  assert.ok(h.view.dashboardError.value && h.view.rankingError.value && h.view.yearsError.value);
  fail = false;
  await h.view.loadDashboard();
  assert.equal(h.view.dashboardError.value + h.view.rankingError.value + h.view.yearsError.value, '');
});

test('an installation without any local account becomes a confirmed empty dashboard', async t => {
  const missing = async () => { throw '尚未登录 QQ 空间'; };
  const h = harness(t, { loggedIn: false, stats: missing, recent: missing, ranking: missing, years: missing });
  await h.view.loadDashboard();
  assert.equal(h.view.overviewLoaded.value, true);
  assert.equal(h.view.firstLoadPending.value, false);
  assert.equal(h.view.dashboardError.value + h.view.recentError.value + h.view.rankingError.value + h.view.yearsError.value, '');
  assert.deepEqual(h.view.recent.value, []);
  assert.equal(h.view.overview.value.dynamics, 0);
});

test('offline local reads still work without an active QQ login', async t => {
  const h = harness(t, { loggedIn: false });
  await h.view.loadDashboard();
  assert.equal(h.view.overview.value.dynamics, 2);
  assert.equal(h.view.recent.value.length, 1);
  assert.equal(h.calls.login, 0);
});

test('account changes clear old data immediately and reject both old results and old cleanup', async t => {
  const old = deferred(), current = deferred();
  const h = harness(t, { stats: count => count === 1 ? old.promise : current.promise });
  const first = h.view.loadDashboard();
  h.auth.user = { uin: 'account-b' };
  assert.deepEqual(h.view.recent.value, []);
  assert.equal(h.view.overviewLoaded.value, false);
  old.resolve(stats(99));
  await first;
  assert.equal(h.view.loading.value, true);
  assert.equal(h.view.overview.value.dynamics, 0);
  current.resolve(stats(4));
  await settle();
  assert.equal(h.view.overview.value.dynamics, 4);
  assert.equal(h.view.loading.value, false);
});

test('a task completion during an active read queues an immediate final dashboard refresh', async t => {
  const old = deferred();
  const h = harness(t, { stats: count => count === 1 ? old.promise : Promise.resolve(stats(7)) });
  const pending = h.view.loadDashboard();
  h.archive.store.beginRun();
  await settle();
  h.archive.store.finishRun({ ...idleProgress(), status: 'completed', saved: 7 });
  await settle();
  await h.tick(0);
  assert.equal(h.calls.stats, 1);
  old.resolve(stats(2));
  await pending;
  await h.tick(0);
  assert.equal(h.calls.stats, 2);
  assert.equal(h.view.overview.value.dynamics, 7);
});

test('hidden pages cancel scheduled reads and refresh when shown again', async t => {
  const h = harness(t);
  h.view.scheduleRefresh(true);
  h.document.visibilityState = 'hidden';
  h.view.handleVisibilityChange();
  assert.equal(h.timers.size, 0);
  h.document.visibilityState = 'visible';
  h.view.handleVisibilityChange();
  await h.tick(0);
  assert.equal(h.calls.stats, 1);
});

test('years use actual unique positive whole years in descending order', async t => {
  const h = harness(t, { years: async () => [2020, 2024, 0, 2024, -1, 2023.5] });
  await h.view.loadDashboard();
  assert.deepEqual(h.view.archiveYears.value, [2024, 2020]);
  assert.equal(h.view.yearSpan.value.count, 2);
});

test('avatar blobs no longer used by current records or ranking are revoked', async t => {
  const h = harness(t);
  h.view.avatarSources.valueUnused = 'blob:obsolete';
  await h.view.loadDashboard();
  assert.deepEqual(h.revoked, ['blob:obsolete']);
  assert.equal(h.view.avatarSources.valueUnused, undefined);
});

test('pruning cancels obsolete HTTP requests and rejects their late image bytes', async t => {
  const response = deferred();
  const h = harness(t, { fetch: () => response.promise });
  const pending = h.view.loadAvatar('12345');
  await h.view.loadDashboard();
  assert.equal(h.fetches[0].options.signal.aborted, true);
  response.resolve(avatarResponse());
  await pending;
  assert.equal(h.calls.blobs, 0);
  assert.equal(h.view.avatarSources['12345'], undefined);
});

test('avatar limits and non-image responses preserve the offline fallback', async t => {
  for (const [size, type] of [[512 * 1024 + 1, 'image/png'], [4, 'text/html']]) {
    const h = harness(t, { fetch: async () => avatarResponse(size, type) });
    await h.view.loadAvatar('12345');
    assert.equal(h.calls.blobs, 0);
    assert.equal(h.view.avatarSources['12345'], undefined);
    assert.equal(h.timers.size, 0);
  }
});

test('unmounting discards pending dashboard reads and revokes existing avatar blobs', async t => {
  const reading = deferred();
  const h = harness(t, { stats: () => reading.promise });
  const pending = h.view.loadDashboard();
  h.view.avatarSources.fixture = 'blob:fixture';
  h.unmount();
  reading.resolve(stats(99));
  await pending;
  await h.view.loadDashboard();
  assert.equal(h.calls.stats, 1);
  assert.equal(h.view.overview.value.dynamics, 0);
  assert.deepEqual(h.revoked, ['blob:fixture']);
});

test('the primary action opens existing task progress even after QQ login expires', async t => {
  const h = harness(t, { loggedIn: false });
  h.archive.store.beginRun();
  h.view.primaryAction();
  assert.deepEqual(h.routes, ['/tasks']);
  assert.equal(h.calls.login, 0);
});
