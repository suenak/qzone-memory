import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import { computed, effectScope, nextTick, reactive, ref, toRefs } from 'vue';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { createArchiveHarness } from './helpers/archive-store.mjs';

const { descriptor } = parse(readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8'));
const script = transpileModule(descriptor.scriptSetup.content, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '');
const expose = `return {
  loadLocalAccounts, switchLocalAccount, clearArchiveContent, deleteEverything, logout,
  localAccounts, localAccount, localAccountsLoading, localAccountsError, switchingLocal,
  clearVisible, deleteVisible, clearing, deleting, error, settingsBusy,
  askRelease, askSignOut, confirmAccountAction, accountConfirmVisible, accountAction,
  releaseTarget, confirmError, openSeats, seatsBusy, seatError,
};`;
const accounts = () => [{ uin: '1', selected: true }, { uin: '2', selected: false }, { uin: '3', selected: false }];
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 10; turn++) await nextTick(); }
function harness(t, overrides = {}) {
  const archive = createArchiveHarness();
  const notifications = [], mounts = [], unmounts = [];
  const calls = { lists: 0, selects: [], clears: 0, deletes: 0, logouts: 0, refreshes: 0, signouts: 0, releases: [] };
  const auth = reactive({
    loggedIn: true, user: { uin: '1' }, loading: false, dialogVisible: false, status: 'success',
    logout: async () => {
      calls.logouts++;
      await overrides.logout?.();
      auth.user = undefined;
      auth.loggedIn = false;
      auth.status = 'loggedOut';
    },
  });
  const license = reactive({
    view: null, seats: [], lastError: '', seatsError: '', loading: false,
    refresh: async () => { calls.refreshes++; await overrides.refresh?.(); },
    signOut: async () => { calls.signouts++; },
    deactivateSeat: async id => { calls.releases.push(id); await overrides.release?.(id); },
    loadSeats: () => overrides.seats?.() ?? Promise.resolve(),
  });
  const scope = effectScope();
  const dependencies = {
    computed, ref, storeToRefs: toRefs,
    onMounted: callback => mounts.push(callback), onBeforeUnmount: callback => unmounts.push(callback),
    useAppStore: () => reactive({ themeMode: 'light', density: 'comfortable' }),
    useAuthStore: () => auth, useArchiveStore: () => archive.store,
    useLicenseStore: () => license, useUpdateStore: () => ({}), useRouter: () => ({}),
    Sun: {}, Moon: {}, Monitor: {}, getVersion: async () => '1.2.10',
    MIN_ARCHIVE_INTERVAL: 2000, MAX_ARCHIVE_INTERVAL: 30000,
    getArchiveInterval: () => 3000, setArchiveInterval: value => value,
    describeError: (reason, fallback) => fallback ?? String(reason),
    describeLicenseError: (reason, fallback) => fallback ?? String(reason),
    useToast: () => Object.fromEntries(['success', 'error'].map(kind => [kind, message => notifications.push({ kind, message })])),
    listLocalAccounts: () => { calls.lists++; return overrides.list?.() ?? Promise.resolve(accounts()); },
    selectLocalAccount: uin => { calls.selects.push(uin); return overrides.select?.(uin) ?? Promise.resolve(); },
    clearArchivedFeeds: () => { calls.clears++; return overrides.clear?.() ?? Promise.resolve(3); },
    deleteAllAppData: () => { calls.deletes++; return overrides.remove?.() ?? Promise.resolve(); },
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
  function seed() { view.localAccounts.value = accounts(); view.localAccount.value = '1'; }
  return { view, archive, auth, license, calls, notifications, unmount, seed };
}

test('local account lists expose a retryable error and accept a later successful read', async t => {
  let fail = true;
  const h = harness(t, { list: async () => { if (fail) throw new Error('read failed'); return accounts(); } });
  await h.view.loadLocalAccounts();
  assert.ok(h.view.localAccountsError.value);
  assert.equal(h.view.localAccountsLoading.value, false);
  fail = false;
  await h.view.loadLocalAccounts();
  assert.equal(h.view.localAccountsError.value, '');
  assert.equal(h.view.localAccount.value, '1');
});

test('account switch commits its captured target even if the dropdown changes while pending', async t => {
  const select = deferred();
  const h = harness(t, { select: () => select.promise });
  h.seed();
  h.auth.loggedIn = false;
  h.view.localAccount.value = '2';
  const pending = h.view.switchLocalAccount();
  h.view.localAccount.value = '3';
  await h.view.switchLocalAccount();
  assert.equal(h.view.localAccount.value, '2');
  select.resolve();
  await pending;
  assert.deepEqual(h.calls.selects, ['2']);
  assert.equal(h.view.localAccounts.value.find(account => account.selected).uin, '2');
});

test('a stale account-list read cannot undo a completed switch', async t => {
  const list = deferred();
  const h = harness(t, { list: () => list.promise });
  h.seed();
  h.auth.loggedIn = false;
  const pending = h.view.loadLocalAccounts();
  h.view.localAccount.value = '2';
  await h.view.switchLocalAccount();
  list.resolve(accounts());
  await pending;
  assert.equal(h.view.localAccount.value, '2');
});

test('failed switches restore the prior selection and release global activity', async t => {
  const h = harness(t, { select: async () => { throw new Error('select failed'); } });
  h.seed();
  h.auth.loggedIn = false;
  h.view.localAccount.value = '2';
  await h.view.switchLocalAccount();
  assert.equal(h.view.localAccount.value, '1');
  assert.equal(h.view.switchingLocal.value, false);
  assert.equal(h.archive.store.busy, false);
});

test('deletion remains globally busy through logout and licence refresh cleanup', async t => {
  const logout = deferred(), refresh = deferred();
  const h = harness(t, { logout: () => logout.promise, refresh: () => refresh.promise });
  h.view.deleteVisible.value = true;
  const pending = h.view.deleteEverything();
  await settle();
  assert.equal(h.calls.logouts, 1);
  assert.equal(h.view.deleting.value, true);
  assert.equal(h.archive.store.busy, true);
  await h.view.deleteEverything();
  assert.equal(h.calls.deletes, 1);
  logout.resolve();
  await settle();
  assert.equal(h.calls.refreshes, 1);
  assert.equal(h.archive.store.busy, true);
  refresh.resolve();
  await pending;
  assert.equal(h.archive.store.busy, false);
  assert.equal(h.view.deleting.value, false);
});

test('failed native deletion keeps confirmation open without running cleanup', async t => {
  const h = harness(t, { remove: async () => { throw new Error('delete failed'); } });
  h.view.deleteVisible.value = true;
  await h.view.deleteEverything();
  assert.equal(h.view.deleteVisible.value, true);
  assert.equal(h.calls.logouts + h.calls.refreshes, 0);
  assert.equal(h.archive.store.busy, false);
  assert.match(h.view.error.value, /delete failed/);
});

test('cleanup failures do not turn a completed deletion into a retryable deletion failure', async t => {
  const h = harness(t, {
    logout: async () => { throw new Error('logout failed'); },
    refresh: async () => { throw new Error('refresh failed'); },
  });
  h.view.deleteVisible.value = true;
  await h.view.deleteEverything();
  assert.equal(h.view.deleteVisible.value, false);
  assert.equal(h.view.error.value, '');
  assert.equal(h.calls.deletes, 1);
  assert.equal(h.notifications.filter(notice => notice.kind === 'success').length, 1);
  assert.equal(h.notifications.filter(notice => notice.kind === 'error').length, 2);
});

test('deletion finishing after navigation still settles the shared QQ session', async t => {
  const remove = deferred();
  const h = harness(t, { remove: () => remove.promise });
  h.view.deleteVisible.value = true;
  const pending = h.view.deleteEverything();
  h.unmount();
  assert.equal(h.archive.store.busy, true);
  remove.resolve();
  await pending;
  assert.equal(h.calls.logouts, 1);
  assert.equal(h.auth.loggedIn, false);
  assert.equal(h.archive.store.busy, false);
  assert.deepEqual(h.notifications, []);
});

test('old deletion cleanup cannot log out a subsequently signed-in account', async t => {
  const remove = deferred();
  const h = harness(t, { remove: () => remove.promise });
  h.view.deleteVisible.value = true;
  const pending = h.view.deleteEverything();
  h.auth.user = { uin: '2' };
  remove.resolve();
  await pending;
  assert.equal(h.calls.logouts, 0);
  assert.equal(h.auth.user.uin, '2');
});

test('clearing, deleting and switching cannot overlap', async t => {
  const clear = deferred();
  const h = harness(t, { clear: () => clear.promise });
  h.seed();
  h.view.clearVisible.value = true;
  const pending = h.view.clearArchiveContent();
  h.view.deleteVisible.value = true;
  await h.view.deleteEverything();
  await h.view.logout();
  h.auth.loggedIn = false;
  h.view.localAccount.value = '2';
  await h.view.switchLocalAccount();
  assert.equal(h.calls.deletes + h.calls.logouts + h.calls.selects.length, 0);
  clear.resolve(3);
  await pending;
  assert.equal(h.archive.store.busy, false);
});

test('destructive actions require their visible confirmation', async t => {
  const h = harness(t);
  await h.view.clearArchiveContent();
  await h.view.deleteEverything();
  assert.equal(h.calls.clears + h.calls.deletes, 0);
});

test('ongoing session verification blocks local data changes', async t => {
  const h = harness(t);
  h.auth.status = 'checking';
  h.view.deleteVisible.value = true;
  await h.view.deleteEverything();
  assert.equal(h.calls.deletes, 0);
});

test('late account reads and settings actions cannot write to an unmounted page', async t => {
  const list = deferred();
  const h = harness(t, { list: () => list.promise });
  const pending = h.view.loadLocalAccounts();
  h.unmount();
  list.resolve(accounts());
  await pending;
  await h.view.loadLocalAccounts();
  assert.deepEqual(h.view.localAccounts.value, []);
  assert.equal(h.calls.lists, 1);
});

test('licence sign-out rechecks task activity at confirmation time', async t => {
  const h = harness(t);
  h.view.askSignOut();
  h.archive.store.beginRun();
  await h.view.confirmAccountAction();
  assert.equal(h.calls.signouts, 0);
});

test('a missing release target never falls through to licence sign-out', async t => {
  const h = harness(t);
  h.view.accountAction.value = 'release';
  h.view.releaseTarget.value = null;
  h.view.accountConfirmVisible.value = true;
  await h.view.confirmAccountAction();
  assert.equal(h.calls.signouts, 0);
  assert.ok(h.view.confirmError.value);
});

test('device-list errors are caught and leave the settings page retryable', async t => {
  const h = harness(t, { seats: async () => { throw new Error('seat list failed'); } });
  await h.view.openSeats();
  assert.equal(h.view.seatsBusy.value, false);
  assert.ok(h.view.seatError.value);
});

test('device-list errors use their own state instead of unrelated status messages', async t => {
  const h = harness(t);
  h.license.lastError = 'unrelated heartbeat error';
  await h.view.openSeats();
  assert.equal(h.view.seatError.value, '');
  h.license.lastError = '';
  h.license.seatsError = 'device list failed';
  await h.view.openSeats();
  assert.ok(h.view.seatError.value);
});

test('a shared licence operation blocks settings mutations until it settles', async t => {
  const h = harness(t);
  h.seed();
  h.license.loading = true;
  h.view.askSignOut();
  assert.equal(h.view.accountConfirmVisible.value, false);
  h.view.clearVisible.value = true;
  await h.view.clearArchiveContent();
  assert.equal(h.calls.clears, 0);
  assert.equal(h.view.settingsBusy.value, true);
});
