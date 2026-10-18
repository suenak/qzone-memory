import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import { computed, onScopeDispose, reactive, ref } from 'vue';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

function script(path) {
  return transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '');
}
const authScript = script('../src/stores/auth.ts').replace('export const useAuthStore =', 'return');
const sessionScript = script('../src/utils/qqSession.ts').replace(/^export /gm, '');
const { QqSessionState, requiresQqLogin } = new Function(`${sessionScript}\nreturn { QqSessionState, requiresQqLogin };`)();
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); }
const success = (uin = 'account-a') => ({ status: 'success', message: '登录成功', auth: { uin } });

/** Real auth store and session tracker; IPC, licence responses and time are controlled. */
function harness(t, overrides = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = new QqSessionState();
  const timers = new Map(), commands = [], routes = [];
  const calls = { access: 0, profile: 0, sync: 0, recycle: 0, web: 0, webPoll: 0 };
  const archive = reactive({ dataChanging: false, recoveringRecycle: false });
  const license = reactive({ canArchive: true, refresh: async () => {
    calls.access++;
    await overrides.access?.(license);
  } });
  let nextTimer = 0;
  const dependencies = {
    defineStore, computed, onScopeDispose, ref, qqSession: session, requiresQqLogin,
    useArchiveStore: () => archive, useLicenseStore: () => license,
    useRecycleSessionStore: () => ({ clear: () => { calls.recycle++; } }),
    platform: () => overrides.platform ?? 'windows',
    router: { currentRoute: ref({ path: '/tasks', fullPath: '/tasks?tab=history' }), push: async route => { routes.push(route); } },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    Date: { now: () => 1_000_000 },
    invoke: (command) => {
      commands.push(command);
      if (overrides.invoke) {
        const result = overrides.invoke(command);
        if (result !== undefined) return result;
      }
      if (command === 'get_login_status') return Promise.resolve({ status: 'restored', auth: { uin: 'account-a' }, message: 'restored' });
      if (command === 'start_qr_login') return Promise.resolve({ qrImage: 'test-qr-image' });
      if (command === 'poll_qr_login') return Promise.resolve({ status: 'expired', message: '二维码已过期' });
      if (command === 'cancel_web_login' || command === 'logout_qzone') return Promise.resolve();
      assert.fail(`Unexpected native command: ${command}`);
    },
    getQzoneLoginUser: () => { calls.profile++; return overrides.profile?.() ?? Promise.resolve({ uin: 'account-a', nickname: 'Account A' }); },
    syncCookiesToWebview: async () => { calls.sync++; },
    openWebLogin: () => { calls.web++; return overrides.web?.() ?? Promise.resolve({ status: 'webLoginOpened', message: 'window opened' }); },
    checkWebLogin: () => { calls.webPoll++; return overrides.webPoll?.() ?? Promise.resolve({ status: 'webLoginWaiting', message: 'waiting' }); },
  };
  const store = new Function(...Object.keys(dependencies), authScript)(...Object.values(dependencies))(pinia);
  let disposed = false;
  function dispose() { if (!disposed) { disposed = true; store.$dispose(); } }
  t.after(dispose);
  return {
    store, session, archive, license, calls, commands, routes, timers, dispose,
    count: command => commands.filter(value => value === command).length,
    seed() { session.authenticated(); store.user = { uin: 'account-a', nickname: 'Account A' }; store.status = 'success'; },
    async tick(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay} ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
      await settle();
    },
  };
}

for (const action of ['openLogin', 'refreshQrCode', 'startWebLogin']) {
  test(`closing login invalidates a pending licence check from ${action}`, async t => {
    const access = deferred();
    const h = harness(t, { access: () => access.promise });
    const pending = h.store[action]();
    assert.equal(h.store.loading, true);
    h.store.closeLogin();
    access.resolve();
    await pending;
    assert.equal(h.store.dialogVisible, false);
    assert.equal(h.store.loading, false);
    assert.equal(h.count('start_qr_login'), 0);
    assert.equal(h.calls.web, 0);
    assert.equal(h.timers.size, 0);
  });
}

test('an older denied licence check cannot redirect or replace a newer login mode', async t => {
  const oldAccess = deferred();
  let first = true;
  const h = harness(t, { access: async license => {
    if (first) { first = false; await oldAccess.promise; license.canArchive = false; }
  } });
  const old = h.store.openLogin();
  const current = h.store.startWebLogin();
  await settle();
  assert.equal(h.calls.web, 1);
  oldAccess.resolve();
  await old;
  assert.equal(h.store.webLoginMode, true);
  assert.equal(h.store.dialogVisible, true);
  assert.deepEqual(h.routes, []);
  assert.equal(h.count('start_qr_login'), 0);
  h.store.closeLogin();
  await current;
});

test('a late licence rejection after closing cannot overwrite the current message', async t => {
  const access = deferred();
  const h = harness(t, { access: () => access.promise });
  const pending = h.store.openLogin();
  h.store.closeLogin();
  const previous = h.store.message;
  access.reject(new Error('old validation failed'));
  await pending;
  assert.equal(h.store.message, previous);
  assert.equal(h.store.status, 'loggedOut');
});

test('opening login validates once and selects the native platform login flow', async t => {
  for (const platform of ['windows', 'android']) {
    const h = harness(t, { platform });
    const pending = h.store.openLogin();
    await settle();
    assert.equal(h.calls.access, 1);
    assert.equal(h.count('start_qr_login'), platform === 'windows' ? 1 : 0);
    assert.equal(h.calls.web, platform === 'android' ? 1 : 0);
    h.store.closeLogin();
    await pending;
  }
});

test('a current licence denial redirects to activation with the original destination', async t => {
  const h = harness(t, { access: async license => { license.canArchive = false; } });
  await h.store.openLogin();
  assert.deepEqual(h.routes, [{ path: '/activation', query: { returnTo: '/tasks?tab=history' } }]);
  assert.equal(h.store.dialogVisible, false);
  assert.equal(h.store.loading, false);
  assert.equal(h.count('start_qr_login'), 0);
});

test('opening an already authenticated account keeps its identity without restarting login', async t => {
  const h = harness(t);
  h.seed();
  h.store.webLoginMode = true;
  await h.store.openLogin();
  assert.equal(h.store.loggedIn, true);
  assert.equal(h.store.user.uin, 'account-a');
  assert.equal(h.store.dialogVisible, true);
  assert.equal(h.store.webLoginMode, false);
  assert.equal(h.store.loading, false);
  assert.equal(h.count('start_qr_login'), 0);
  assert.equal(h.calls.web, 0);
});

test('a known QQ expiry during authorization invalidates the pending login attempt', async t => {
  const access = deferred();
  const h = harness(t, { access: () => access.promise });
  const pending = h.store.openLogin();
  h.session.expire();
  access.resolve();
  await pending;
  assert.equal(h.store.status, 'expired');
  assert.equal(h.store.loading, false);
  assert.equal(h.store.dialogVisible, false);
  assert.equal(h.count('start_qr_login'), 0);
});

test('closing a polling login cancels its timer and settles without another native poll', async t => {
  const h = harness(t);
  const pending = h.store.openLogin();
  await settle();
  assert.equal(h.timers.size, 1);
  h.store.closeLogin();
  await pending;
  assert.equal(h.timers.size, 0);
  assert.equal(h.count('poll_qr_login'), 0);
});

test('returning from web login waits for native cancellation before starting QR login', async t => {
  const cancel = deferred();
  const h = harness(t, { invoke: command => command === 'cancel_web_login' ? cancel.promise : undefined });
  const web = h.store.startWebLogin();
  await settle();
  h.store.cancelWebLogin();
  await web;
  await settle();
  assert.equal(h.store.loading, true);
  assert.equal(h.count('cancel_web_login'), 1);
  assert.equal(h.count('start_qr_login'), 0);
  assert.equal(h.timers.size, 0);
  cancel.resolve();
  await settle();
  assert.equal(h.count('start_qr_login'), 1);
  assert.equal(h.store.webLoginMode, false);
  h.store.closeLogin();
  await settle();
});

test('a late QR success cannot authenticate over a newer web login attempt', async t => {
  const poll = deferred();
  const h = harness(t, { invoke: command => command === 'poll_qr_login' ? poll.promise : undefined });
  h.session.expire();
  const qr = h.store.openLogin();
  await settle();
  await h.tick(1800);
  const web = h.store.startWebLogin();
  await settle();
  poll.resolve(success('old-account'));
  await qr;
  assert.equal(h.session.expired, true);
  assert.equal(h.store.user, undefined);
  assert.equal(h.store.webLoginMode, true);
  assert.equal(h.calls.profile, 0);
  h.store.closeLogin();
  await web;
});

test('a late web success cannot replace a newer QR login attempt', async t => {
  const poll = deferred();
  const h = harness(t, { webPoll: () => poll.promise });
  const web = h.store.startWebLogin();
  await settle();
  await h.tick(2000);
  h.store.cancelWebLogin();
  await settle();
  poll.resolve(success('old-account'));
  await web;
  assert.equal(h.store.user, undefined);
  assert.equal(h.store.webLoginMode, false);
  assert.equal(h.store.qrImage, 'test-qr-image');
  assert.equal(h.calls.profile, 0);
  h.store.closeLogin();
  await settle();
});

test('logout is deduplicated and blocks login, reauthentication and foreground checks until completion', async t => {
  const logout = deferred();
  const h = harness(t, { invoke: command => command === 'logout_qzone' ? logout.promise : undefined });
  h.seed();
  const pending = h.store.logout();
  const duplicate = h.store.logout();
  await settle();
  assert.equal(h.store.loading, true);
  assert.equal(h.store.loggedIn, false);
  assert.equal(h.store.user, undefined);
  h.store.closeLogin();
  h.store.cancelWebLogin();
  await h.store.openLogin();
  await h.store.refreshQrCode();
  await h.store.startWebLogin();
  await h.store.reauthenticate();
  await h.store.restoreSession(true);
  assert.equal(h.store.loading, true);
  assert.equal(h.session.expired, false);
  assert.equal(h.calls.access, 0);
  assert.equal(h.count('get_login_status'), 0);
  assert.equal(h.count('logout_qzone'), 1);
  logout.resolve();
  await Promise.all([pending, duplicate]);
  assert.equal(h.store.status, 'loggedOut');
  assert.equal(h.store.loading, false);
  assert.equal(h.calls.recycle, 1);
});

test('logout invalidates an earlier login authorization response', async t => {
  const access = deferred(), logout = deferred();
  const h = harness(t, { access: () => access.promise, invoke: command => command === 'logout_qzone' ? logout.promise : undefined });
  const opening = h.store.openLogin();
  const exiting = h.store.logout();
  access.resolve();
  await opening;
  assert.equal(h.store.dialogVisible, false);
  assert.equal(h.store.loading, true);
  assert.equal(h.count('start_qr_login'), 0);
  logout.resolve();
  await exiting;
});

test('failed logout retains a known expiry, releases busy state and supports retry', async t => {
  let fail = true;
  const h = harness(t, { invoke: command => command === 'logout_qzone' ? (fail ? Promise.reject(new Error('native logout failed')) : Promise.resolve()) : undefined });
  h.session.expire();
  await assert.rejects(h.store.logout(), /native logout failed/);
  assert.equal(h.session.expired, true);
  assert.equal(h.store.status, 'expired');
  assert.equal(h.store.loading, false);
  assert.equal(h.calls.recycle, 1, 'Only the original expiry cleared the recycle session');
  fail = false;
  await h.store.logout();
  assert.equal(h.session.expired, false);
  assert.equal(h.store.status, 'loggedOut');
  assert.equal(h.count('logout_qzone'), 2);
});

test('a failed logout leaves identity unverified and permits immediate session verification', async t => {
  const h = harness(t, { invoke: command => command === 'logout_qzone' ? Promise.reject(new Error('partially failed')) : undefined });
  await h.store.restoreSession();
  assert.equal(h.store.loggedIn, true);
  await assert.rejects(h.store.logout(), /partially failed/);
  assert.equal(h.store.status, 'unverified');
  assert.equal(h.store.user, undefined);
  await h.store.restoreSession();
  assert.equal(h.count('get_login_status'), 2, 'Logout failure must not leave the previous foreground throttle in force');
  assert.equal(h.store.loggedIn, true);
});

test('a profile response from before logout cannot resurrect the displayed account', async t => {
  const profile = deferred();
  const h = harness(t, { profile: () => profile.promise });
  const restore = h.store.restoreSession();
  await settle();
  assert.equal(h.calls.profile, 1);
  await h.store.logout();
  profile.resolve({ uin: 'account-a', nickname: 'Old account' });
  await restore;
  assert.equal(h.store.status, 'loggedOut');
  assert.equal(h.store.user, undefined);
  assert.equal(h.calls.sync, 0);
});

test('an obsolete profile check cannot block or unlock the next session verification', async t => {
  const oldProfile = deferred(), currentProfile = deferred();
  let first = true;
  const h = harness(t, {
    profile: () => { if (first) { first = false; return oldProfile.promise; } return currentProfile.promise; },
    invoke: command => command === 'logout_qzone' ? Promise.reject(new Error('logout failed')) : undefined,
  });
  const old = h.store.restoreSession();
  await settle();
  await assert.rejects(h.store.logout(), /logout failed/);
  const current = h.store.restoreSession(true);
  await settle();
  assert.equal(h.count('get_login_status'), 2);
  oldProfile.resolve({ uin: 'account-a', nickname: 'Old profile' });
  await old;
  await h.store.restoreSession(true);
  assert.equal(h.count('get_login_status'), 2, 'The old check must not release the current verification guard');
  assert.equal(h.store.status, 'checking');
  currentProfile.resolve({ uin: 'account-a', nickname: 'Current profile' });
  await current;
  assert.equal(h.store.user.nickname, 'Current profile');
});

test('old QQ request failures cannot expire a session while native logout is pending', async t => {
  const oldRequest = deferred(), logout = deferred();
  const h = harness(t, { invoke: command => command === 'logout_qzone' ? logout.promise : undefined });
  h.seed();
  const stale = h.session.request(() => oldRequest.promise);
  const pending = h.store.logout();
  oldRequest.reject(new Error('QQ_LOGIN_REQUIRED: old response'));
  await assert.rejects(stale, /old response/);
  assert.equal(h.session.expired, false);
  assert.equal(h.store.loading, true);
  logout.resolve();
  await pending;
});

test('disposing the store invalidates pending authorization and prevents future commands', async t => {
  const access = deferred();
  const h = harness(t, { access: () => access.promise });
  const pending = h.store.openLogin();
  h.dispose();
  const snapshot = { status: h.store.status, message: h.store.message, loading: h.store.loading };
  access.resolve();
  await pending;
  h.session.expire();
  await h.store.openLogin();
  await h.store.reauthenticate();
  await h.store.restoreSession(true);
  await h.store.logout();
  assert.deepEqual({ status: h.store.status, message: h.store.message, loading: h.store.loading }, snapshot);
  assert.equal(h.count('start_qr_login'), 0);
  assert.equal(h.count('logout_qzone'), 0);
  assert.equal(h.calls.recycle, 0);
});

test('disposing during polling clears timers and ignores a late native response', async t => {
  const poll = deferred();
  const h = harness(t, { invoke: command => command === 'poll_qr_login' ? poll.promise : undefined });
  const pending = h.store.openLogin();
  await settle();
  await h.tick(1800);
  h.dispose();
  poll.resolve(success());
  await pending;
  assert.equal(h.store.user, undefined);
  assert.equal(h.calls.profile, 0);
  assert.equal(h.timers.size, 0);
});

test('disposing while waiting for the next poll clears the timer and settles login', async t => {
  const h = harness(t);
  const pending = h.store.startWebLogin();
  await settle();
  assert.equal(h.timers.size, 1);
  h.dispose();
  await pending;
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.webPoll, 0);
});

test('data cleanup starting during native cancellation prevents the next QR request', async t => {
  const cancel = deferred();
  const h = harness(t, { invoke: command => command === 'cancel_web_login' ? cancel.promise : undefined });
  h.store.closeLogin();
  const pending = h.store.openLogin();
  await settle();
  h.archive.dataChanging = true;
  cancel.resolve();
  await pending;
  assert.equal(h.count('start_qr_login'), 0);
  assert.equal(h.store.dialogVisible, false);
  assert.equal(h.store.loading, false);
});

test('disposing during a pending logout prevents late store and session updates', async t => {
  const logout = deferred();
  const h = harness(t, { invoke: command => command === 'logout_qzone' ? logout.promise : undefined });
  h.session.expire();
  const pending = h.store.logout();
  await settle();
  h.dispose();
  logout.resolve();
  await pending;
  assert.equal(h.store.status, 'expired');
  assert.equal(h.session.expired, true);
  assert.equal(h.calls.recycle, 1);
});

for (const mode of ['qr', 'web']) {
  test(`${mode} login completes with its identity and closes without leaking timers`, async t => {
    const h = harness(t, {
      invoke: command => command === 'poll_qr_login' ? Promise.resolve(success()) : undefined,
      webPoll: async () => success(),
    });
    const pending = mode === 'qr' ? h.store.openLogin() : h.store.startWebLogin();
    await settle();
    await h.tick(mode === 'qr' ? 1800 : 2000);
    assert.equal(h.store.loggedIn, true);
    assert.equal(h.store.user.nickname, 'Account A');
    await h.tick(700);
    await pending;
    assert.equal(h.store.dialogVisible, false);
    assert.equal(h.store.webLoginMode, false);
    assert.equal(h.store.loading, false);
    assert.equal(h.calls.sync, 1);
    assert.equal(h.timers.size, 0);
  });
}

test('a login result missing account identity reports a retryable error', async t => {
  const h = harness(t, { invoke: command => command === 'poll_qr_login' ? Promise.resolve({ status: 'success', message: 'bad response' }) : undefined });
  const pending = h.store.openLogin();
  await settle();
  await h.tick(1800);
  await pending;
  assert.equal(h.store.status, 'error');
  assert.equal(h.store.user, undefined);
  assert.equal(h.store.loading, false);
  assert.equal(h.timers.size, 0);
  const retry = h.store.refreshQrCode();
  await settle();
  assert.equal(h.count('start_qr_login'), 2);
  h.store.closeLogin();
  await retry;
});

test('an in-flight recycle recovery blocks restoring, replacing and logging out the QQ session', async t => {
  const h = harness(t);
  h.seed();
  h.archive.recoveringRecycle = true;
  await h.store.restoreSession(true);
  await h.store.openLogin();
  await h.store.reauthenticate();
  await assert.rejects(h.store.logout(), /回收站恢复/);
  assert.equal(h.calls.access, 0);
  assert.equal(h.count('get_login_status'), 0);
  assert.equal(h.count('logout_qzone'), 0);
  assert.equal(h.session.expired, false);
  assert.equal(h.store.user.uin, 'account-a');
  assert.equal(h.store.loggedIn, true);
});

test('login rechecks recycle recovery activity after asynchronous licence validation', async t => {
  const access = deferred();
  const h = harness(t, { access: () => access.promise });
  const pending = h.store.openLogin();
  h.archive.recoveringRecycle = true;
  access.resolve();
  await pending;
  assert.equal(h.store.dialogVisible, false);
  assert.equal(h.store.loading, false);
  assert.equal(h.count('start_qr_login'), 0);
  assert.match(h.store.message, /回收站恢复/);
});
