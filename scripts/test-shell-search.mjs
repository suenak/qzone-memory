import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import { computed, effectScope, nextTick, reactive, ref, toRefs, watch } from 'vue';
import { createMemoryHistory, createRouter, isNavigationFailure } from 'vue-router';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { createArchiveHarness } from './helpers/archive-store.mjs';

const { descriptor } = parse(readFileSync(new URL('../src/layouts/AppShell.vue', import.meta.url), 'utf8'));
const script = transpileModule(descriptor.scriptSetup.content, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '');
const icons = Object.fromEntries(descriptor.scriptSetup.content.match(/import\s*\{([^}]+)\}\s*from "lucide-vue-next"/s)[1]
  .split(',').map(name => name.trim()).filter(Boolean).map(name => [name.split(/\s+as\s+/).at(-1), {}]));
const expose = `return { submitSearch, handleSearchShortcut, searchInput, searchElement,
  searchSubmitting, mobileSearchVisible, logout, logoutLoading };`;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 12; turn++) await nextTick(); }

/** Real Vue Router navigation failures and source setup; only native/store boundaries are mocked. */
async function harness(t, overrides = {}) {
  const archive = createArchiveHarness();
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: {} }, { path: '/archives', component: {} },
  ] });
  router.onError(() => {});
  await router.push('/');
  const route = reactive({ path: '/', query: {} });
  router.afterEach((to, _from, failure) => { if (!failure) { route.path = to.path; route.query = to.query; } });
  const scope = effectScope(), unmounts = [], mounts = [], notifications = [];
  const calls = { routes: [], focus: 0, logouts: 0 };
  const events = new Map();
  const document = { dialog: false, querySelector: () => document.dialog ? {} : null,
    addEventListener: (type, fn) => events.set(type, fn), removeEventListener: type => events.delete(type) };
  const auth = reactive({ loggedIn: true, user: { uin: 'account-a' }, accountLabel: 'Fixture',
    openLogin: async () => {}, logout: async () => { calls.logouts++; await overrides.logout?.(); } });
  const dependencies = {
    ...icons, computed, nextTick, ref, watch, isNavigationFailure, storeToRefs: toRefs, defineProps: () => ({}),
    onMounted: callback => mounts.push(callback), onBeforeUnmount: callback => unmounts.push(callback),
    useArchiveStore: () => archive.store, useAuthStore: () => auth,
    useAppStore: () => reactive({ sidebarCollapsed: false, themeMode: 'light' }),
    useToast: () => Object.fromEntries(['error', 'success'].map(kind => [kind, message => notifications.push({ kind, message })])),
    useRoute: () => route, useRouter: () => ({ push: location => {
      calls.routes.push(location);
      return overrides.push?.(location) ?? router.push(location);
    } }),
    platform: () => 'windows', useMobileViewport: () => ({ keyboardVisible: ref(false) }),
    qqProgressNotice: () => null, describeError: (_reason, fallback) => fallback, document,
  };
  const view = scope.run(() => new Function(...Object.keys(dependencies), `${script}\n${expose}`)(...Object.values(dependencies)));
  view.searchElement.value = { focus: () => { calls.focus++; } };
  let disposed = false;
  function unmount() { if (!disposed) { disposed = true; unmounts.forEach(callback => callback()); scope.stop(); } }
  t.after(() => { unmount(); archive.dispose(); });
  return { view, auth, archive, calls, notifications, document, events, router, route, unmount,
    mount() { mounts.forEach(callback => callback()); } };
}

test('successful global search trims its keyword and clears the draft only after navigation', async t => {
  const h = await harness(t);
  h.view.searchInput.value = '  fixture query  ';
  h.view.mobileSearchVisible.value = true;
  await h.view.submitSearch();
  assert.equal(h.router.currentRoute.value.path, '/archives');
  assert.equal(h.router.currentRoute.value.query.q, 'fixture query');
  assert.equal(h.view.searchInput.value, '');
  assert.equal(h.view.mobileSearchVisible.value, false);
  assert.deepEqual(h.notifications, []);
});

test('a real router guard abort keeps the search draft and exposes a retryable error', async t => {
  const h = await harness(t);
  const remove = h.router.beforeEach(() => false);
  h.view.searchInput.value = 'fixture query';
  h.view.mobileSearchVisible.value = true;
  await h.view.submitSearch();
  assert.equal(h.view.searchInput.value, 'fixture query');
  assert.equal(h.view.mobileSearchVisible.value, true);
  assert.equal(h.view.searchSubmitting.value, false);
  assert.equal(h.notifications[0].kind, 'error');
  remove();
  await h.view.submitSearch();
  assert.equal(h.view.searchInput.value, '');
  assert.equal(h.router.currentRoute.value.query.q, 'fixture query');
});

test('duplicated navigation to the already displayed search is treated as success', async t => {
  const h = await harness(t);
  await h.router.push({ path: '/archives', query: { q: 'same query' } });
  h.view.searchInput.value = 'same query';
  await h.view.submitSearch();
  assert.equal(h.view.searchInput.value, '');
  assert.deepEqual(h.notifications, []);
});

test('navigation exceptions preserve the query and allow an explicit retry', async t => {
  let fail = true;
  const h = await harness(t, { push: async () => { if (fail) throw new Error('navigation failed'); } });
  h.view.searchInput.value = 'fixture query';
  await h.view.submitSearch();
  assert.equal(h.view.searchInput.value, 'fixture query');
  assert.equal(h.view.searchSubmitting.value, false);
  assert.equal(h.notifications.length, 1);
  fail = false;
  await h.view.submitSearch();
  assert.equal(h.view.searchInput.value, '');
});

test('a pending search blocks duplicate Enter while preserving a newer draft', async t => {
  const navigation = deferred();
  const h = await harness(t, { push: () => navigation.promise });
  h.view.searchInput.value = 'first query';
  h.view.mobileSearchVisible.value = true;
  const pending = h.view.submitSearch();
  await h.view.submitSearch();
  h.view.searchInput.value = 'newer query';
  assert.equal(h.view.searchSubmitting.value, true);
  navigation.resolve();
  await pending;
  assert.equal(h.calls.routes.length, 1);
  assert.equal(h.view.searchInput.value, 'newer query');
  assert.equal(h.view.mobileSearchVisible.value, true);
  assert.equal(h.view.searchSubmitting.value, false);
});

test('an old navigation error does not interrupt a newer search draft', async t => {
  const navigation = deferred();
  const h = await harness(t, { push: () => navigation.promise });
  h.view.searchInput.value = 'old query';
  const pending = h.view.submitSearch();
  h.view.searchInput.value = 'new query';
  navigation.reject(new Error('old navigation error'));
  await pending;
  assert.equal(h.view.searchInput.value, 'new query');
  assert.deepEqual(h.notifications, []);
});

test('IME composition Enter does not submit or cancel Chinese character selection', async t => {
  const h = await harness(t);
  h.view.searchInput.value = '正在组词';
  let prevented = 0;
  await h.view.submitSearch({ isComposing: true, preventDefault: () => { prevented++; } });
  assert.equal(prevented, 0);
  assert.equal(h.calls.routes.length, 0);
  await h.view.submitSearch({ isComposing: false, preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(h.calls.routes.length, 1);
});

test('whitespace-only drafts never navigate', async t => {
  const h = await harness(t);
  h.view.searchInput.value = '   ';
  await h.view.submitSearch();
  assert.equal(h.calls.routes.length, 0);
});

test('account changes invalidate old search cleanup without unlocking a newer navigation', async t => {
  const old = deferred(), current = deferred();
  let first = true;
  const h = await harness(t, { push: () => { if (first) { first = false; return old.promise; } return current.promise; } });
  h.view.searchInput.value = 'old account query';
  const previous = h.view.submitSearch();
  h.auth.user = { uin: 'account-b' };
  assert.equal(h.view.searchInput.value, '');
  h.view.searchInput.value = 'new account query';
  const pending = h.view.submitSearch();
  old.resolve();
  await previous;
  assert.equal(h.view.searchInput.value, 'new account query');
  assert.equal(h.view.searchSubmitting.value, true);
  current.resolve();
  await pending;
  assert.equal(h.view.searchSubmitting.value, false);
});

test('leaving the shell discards late navigation failures and cannot start another search', async t => {
  const navigation = deferred();
  const h = await harness(t, { push: () => navigation.promise });
  h.view.searchInput.value = 'fixture query';
  const pending = h.view.submitSearch();
  h.unmount();
  navigation.reject(new Error('late navigation error'));
  await pending;
  await h.view.submitSearch();
  assert.equal(h.calls.routes.length, 1);
  assert.deepEqual(h.notifications, []);
});

test('closing search before its next render prevents late focus', async t => {
  const h = await harness(t);
  h.view.handleSearchShortcut({ ctrlKey: true, key: 'k', preventDefault() {} });
  h.view.handleSearchShortcut({ key: 'Escape' });
  await settle();
  assert.equal(h.calls.focus, 0);
});

test('the search shortcut focuses an open search and respects dialogs and IME input', async t => {
  const h = await harness(t);
  h.document.dialog = true;
  h.view.handleSearchShortcut({ ctrlKey: true, key: 'k', preventDefault() {} });
  assert.equal(h.view.mobileSearchVisible.value, false);
  h.document.dialog = false;
  h.view.handleSearchShortcut({ ctrlKey: true, key: 'k', isComposing: true, preventDefault() {} });
  assert.equal(h.view.mobileSearchVisible.value, false);
  h.view.handleSearchShortcut({ ctrlKey: true, key: 'k', preventDefault() {} });
  await settle();
  assert.equal(h.calls.focus, 1);
  h.view.handleSearchShortcut({ metaKey: true, key: 'k', preventDefault() {} });
  await settle();
  assert.equal(h.calls.focus, 2);
});

test('pending focus and logout results cannot navigate or notify after shell disposal', async t => {
  const logout = deferred();
  const h = await harness(t, { logout: () => logout.promise });
  h.view.mobileSearchVisible.value = true;
  const pending = h.view.logout();
  h.unmount();
  logout.resolve();
  await pending;
  await settle();
  assert.equal(h.calls.focus, 0);
  assert.equal(h.calls.routes.length, 0);
  assert.deepEqual(h.notifications, []);
});
