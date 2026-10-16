import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

const source = readFileSync(new URL('../src/utils/qqSession.ts', import.meta.url), 'utf8');
const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } });
const { QqSessionState, requiresQqLogin, qqSession } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

assert.equal(requiresQqLogin('QQ 空间动态接口返回错误 -3000：请先登录'), true);
assert.equal(requiresQqLogin('QQ_LOGIN_REQUIRED: 登录失效'), true);
assert.equal(requiresQqLogin(new Error('请先登录')), true);
assert.equal(requiresQqLogin('尚未登录 QQ 空间'), true);
for (const message of ['接口错误 -30001', '网络超时', '授权已到期', 'HTTP 500']) assert.equal(requiresQqLogin(message), false);

const state = new QqSessionState();
let notifications = 0;
state.onExpired(() => { notifications += 1; });
await assert.rejects(state.request(async () => { throw new Error('请先登录'); }));
assert.equal(state.expired, true);
assert.equal(notifications, 1);
state.expire();
assert.equal(notifications, 1);

state.beginLogin();
state.authenticated();
assert.equal(state.expired, false);
let rejectOld;
const oldRequest = state.request(() => new Promise((_, reject) => { rejectOld = reject; }));
state.beginLogin();
state.authenticated();
rejectOld('QQ_LOGIN_REQUIRED: old session');
await assert.rejects(oldRequest);
assert.equal(state.expired, false, 'Old requests must not expire a fresh login');

await state.request(async () => ({ status: 'error', message: 'QQ_LOGIN_REQUIRED: session expired' }), true);
assert.equal(state.expired, true, 'Resolved recovery errors must update login state');
state.authenticated();
await assert.rejects(state.request(async () => { throw new Error('网络超时'); }));
assert.equal(state.expired, false, 'Network errors must preserve login state');
await state.request(async () => ({ status: 'error', message: 'QQ_LOGIN_REQUIRED: historical task' }));
assert.equal(state.expired, false, 'Old saved progress must not invalidate a new login');
// Exercise the real Pinia store with mocked IPC; never access an actual QQ account or vault.
const { defineStore, createPinia, setActivePinia } = await import('pinia');
const { computed, onScopeDispose, ref } = await import('vue');
const authSource = readFileSync(new URL('../src/stores/auth.ts', import.meta.url), 'utf8');
const authJs = transpileModule(authSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
let statusRequests = 0;
let recycleCleared = 0;
let profileLoader = async () => ({ uin: 'test-account', nickname: 'Test account', avatarImage: 'test-avatar' });
const dependencies = {
  defineStore, computed, onScopeDispose, ref, qqSession, requiresQqLogin,
  invoke: async (command) => {
    if (command === 'cancel_web_login') return;
    assert.equal(command, 'get_login_status');
    statusRequests += 1;
    return { status: 'restored', message: 'restored', auth: { uin: 'test-account' } };
  },
  getQzoneLoginUser: () => profileLoader(),
  syncCookiesToWebview: async () => {},
  openWebLogin: async () => {}, checkWebLogin: async () => {},
  router: {}, platform: () => 'windows',
  useLicenseStore: () => ({ canArchive: true, refresh: async () => {} }),
  useRecycleSessionStore: () => ({ clear: () => { recycleCleared += 1; } }),
};
const useAuthStore = new Function(...Object.keys(dependencies),
  authJs.replace(/^import .*;\r?\n/gm, '').replace('export const useAuthStore =', 'return'))(...Object.values(dependencies));
setActivePinia(createPinia());
const auth = useAuthStore();
await auth.restoreSession();
assert.equal(auth.loggedIn, true);
assert.equal(auth.user.avatarImage, 'test-avatar');
await assert.rejects(qqSession.request(async () => { throw 'QQ_LOGIN_REQUIRED: expired'; }));
assert.equal(auth.loggedIn, false);
assert.equal(auth.user, undefined, 'Expired QQ identity and avatar must disappear together');
assert.equal(auth.status, 'expired');
assert.equal(recycleCleared, 1);
await auth.restoreSession();
assert.equal(statusRequests, 1, 'Focus must not silently restore a known expired native session');
auth.$dispose();

// A saved cookie cannot become "logged in" while online confirmation is pending.
qqSession.loggedOut();
setActivePinia(createPinia());
const checking = useAuthStore();
let finishProfile;
profileLoader = () => new Promise(resolve => { finishProfile = resolve; });
const pendingRestore = checking.restoreSession();
for (let turn = 0; turn < 5 && !finishProfile; turn++) await Promise.resolve();
assert.equal(checking.status, 'checking');
assert.equal(checking.loggedIn, false);
assert.equal(checking.user, undefined);
finishProfile({ uin: 'test-account', nickname: 'Confirmed' });
await pendingRestore;
assert.equal(checking.loggedIn, true);

// An already logged-in client must also revalidate after focus / update restart.
profileLoader = async () => { throw new Error('QQ_LOGIN_REQUIRED: expired saved cookie'); };
await checking.restoreSession(true);
assert.equal(checking.status, 'expired');
assert.equal(checking.loggedIn, false);
assert.equal(checking.user, undefined);
checking.$dispose();

qqSession.loggedOut();
setActivePinia(createPinia());
const uncertain = useAuthStore();
for (const failure of ['网络超时', 'HTTP 501 QQ_REQUEST_BLOCKED']) {
  profileLoader = async () => { throw new Error(failure); };
  await uncertain.restoreSession(true);
  assert.equal(uncertain.status, 'unverified');
  assert.equal(uncertain.loggedIn, false);
  assert.equal(qqSession.expired, false, 'Unavailable network must not destroy the saved session');
}
profileLoader = async () => ({ uin: 'test-account', nickname: 'Reconnected' });
await uncertain.restoreSession(true);
assert.equal(uncertain.loggedIn, true);

// A result requested before a new login cannot clear the newer display identity.
let failOldProfile;
profileLoader = () => new Promise((_, reject) => { failOldProfile = reject; });
const oldRestore = uncertain.restoreSession(true);
for (let turn = 0; turn < 5 && !failOldProfile; turn++) await Promise.resolve();
uncertain.closeLogin();
qqSession.authenticated();
uncertain.user = { uin: 'new-account', nickname: 'New session' };
uncertain.status = 'success';
failOldProfile(new Error('QQ_LOGIN_REQUIRED: expired old cookie'));
await oldRestore;
assert.equal(uncertain.loggedIn, true);
assert.equal(uncertain.user.uin, 'new-account');
uncertain.$dispose();
console.log('QQ session and auth store regression checks passed');
