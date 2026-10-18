import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@vue/compiler-sfc';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const { descriptor } = parse(readFileSync(new URL('../src/views/ActivationView.vue', import.meta.url), 'utf8'));
const script = transpileModule(descriptor.scriptSetup.content, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '');
const expose = `return { mode, username, password, deviceLabel, code, busy, error, notice,
  blockedSeats, releaseVisible, releaseTarget, releasePassword, releaseError,
  submit, submitRedeem, switchMode, openRelease, confirmRelease };`;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const seat = (id = 'seat-a') => ({ id, label: `Device ${id}`, platform: 'windows', current: false });
const success = () => ({ success: true, message: 'activated', seats: [] });

function harness(t, overrides = {}) {
  const unmounts = [], routes = [], focus = [];
  const calls = { activate: [], redeem: [], release: [] };
  const store = reactive({
    view: null, loading: false,
    activate: (...args) => { calls.activate.push(args); return overrides.activate?.(...args) ?? Promise.resolve(success()); },
    redeem: (...args) => { calls.redeem.push(args); return overrides.redeem?.(...args) ?? Promise.resolve('兑换成功'); },
    deactivateSeat: (...args) => { calls.release.push(args); return overrides.release?.(...args) ?? Promise.resolve(); },
  });
  const route = reactive({ query: { returnTo: '/tasks' } });
  const scope = effectScope();
  const dependencies = {
    computed, nextTick, ref, watch,
    onBeforeUnmount: callback => unmounts.push(callback),
    useLicenseStore: () => store,
    useAppStore: () => reactive({ themeMode: 'light' }),
    useRouter: () => ({ replace: async target => { routes.push(target); } }),
    useRoute: () => route, platform: () => 'windows',
    document: { getElementById: id => ({ focus: () => focus.push(id) }) },
    describeLicenseError: (reason, fallback) => fallback ?? String(reason),
  };
  const view = scope.run(() => new Function(...Object.keys(dependencies), `${script}\n${expose}`)(...Object.values(dependencies)));
  let disposed = false;
  function unmount() { if (!disposed) { disposed = true; unmounts.forEach(callback => callback()); scope.stop(); } }
  t.after(unmount);
  return {
    view, store, route, calls, routes, focus, unmount,
    seed() { view.username.value = 'account-a'; view.password.value = 'fixture-password'; view.deviceLabel.value = 'fixture-device'; },
    prepareRelease() {
      view.username.value = 'account-a';
      view.password.value = 'fixture-password';
      view.blockedSeats.value = [seat(), seat('seat-b')];
      view.openRelease(view.blockedSeats.value[0]);
    },
  };
}

test('activation validates required fields before any native action and focuses the missing input', async t => {
  const h = harness(t);
  await h.view.submit();
  await nextTick();
  assert.deepEqual(h.focus, ['license-username']);
  h.view.username.value = 'account-a';
  await h.view.submit();
  await nextTick();
  assert.equal(h.focus.at(-1), 'license-password');
  assert.equal(h.calls.activate.length, 0);
});

test('pending activation blocks duplicate submit, mode changes and seat actions', async t => {
  const activation = deferred();
  const h = harness(t, { activate: () => activation.promise });
  h.seed();
  h.view.blockedSeats.value = [seat()];
  const pending = h.view.submit();
  await h.view.submit();
  await h.view.submitRedeem();
  h.view.switchMode();
  h.view.openRelease(seat());
  assert.equal(h.view.busy.value, true);
  assert.equal(h.view.mode.value, 'activate');
  assert.equal(h.view.releaseVisible.value, false);
  assert.equal(h.calls.activate.length, 1);
  activation.resolve(success());
  await pending;
  assert.equal(h.view.busy.value, false);
});

test('activation returns to its captured local destination and clears the password', async t => {
  const activation = deferred();
  const h = harness(t, { activate: () => activation.promise });
  h.seed();
  const pending = h.view.submit();
  h.route.query.returnTo = '/settings';
  activation.resolve(success());
  await pending;
  assert.deepEqual(h.calls.activate, [['account-a', 'fixture-password', 'fixture-device']]);
  assert.deepEqual(h.routes, ['/tasks']);
  assert.equal(h.view.password.value, '');
});

test('activation rejects an external or activation-loop return destination', async t => {
  for (const target of ['//example.invalid', 'https://example.invalid', '/activation?returnTo=/tasks']) {
    const h = harness(t);
    h.seed();
    h.route.query.returnTo = target;
    await h.view.submit();
    assert.deepEqual(h.routes, ['/']);
  }
});

test('leaving activation ignores a successful response and clears secrets without navigating', async t => {
  const activation = deferred();
  const h = harness(t, { activate: () => activation.promise });
  h.seed();
  h.view.code.value = 'fixture-code';
  const pending = h.view.submit();
  h.unmount();
  activation.resolve(success());
  await pending;
  assert.deepEqual(h.routes, []);
  assert.equal(h.view.password.value, '');
  assert.equal(h.view.code.value, '');
  assert.equal(h.view.notice.value, '');
});

test('leaving activation ignores a failed response and queued validation focus', async t => {
  const activation = deferred();
  const h = harness(t, { activate: () => activation.promise });
  h.seed();
  const pending = h.view.submit();
  h.unmount();
  activation.reject(new Error('late activation failure'));
  await pending;
  assert.equal(h.view.error.value, '');
  const other = harness(t);
  const invalid = other.view.submit();
  other.unmount();
  await invalid;
  await nextTick();
  assert.deepEqual(other.focus, []);
});

test('account changes invalidate old activation results and occupied-device rows immediately', async t => {
  const activation = deferred();
  const h = harness(t, { activate: () => activation.promise });
  h.seed();
  const pending = h.view.submit();
  h.view.username.value = 'account-b';
  activation.resolve({ success: false, message: 'account-a seats full', seats: [seat()] });
  await pending;
  assert.deepEqual(h.view.blockedSeats.value, []);
  assert.equal(h.view.error.value, '');
  assert.equal(h.view.busy.value, false);
});

test('a business activation failure exposes occupied devices and supports a deliberate retry', async t => {
  let fail = true;
  const h = harness(t, { activate: async () => fail ? { success: false, message: '设备名额已满', seats: [seat()] } : success() });
  h.seed();
  await h.view.submit();
  assert.equal(h.view.blockedSeats.value.length, 1);
  assert.equal(h.view.busy.value, false);
  fail = false;
  await h.view.submit();
  assert.equal(h.view.password.value, '');
  assert.deepEqual(h.routes, ['/tasks']);
});

test('redeem mode validates the code and clears it only after confirmed success', async t => {
  const redeem = deferred();
  const h = harness(t, { redeem: () => redeem.promise });
  h.seed();
  h.view.switchMode();
  await h.view.submitRedeem();
  assert.equal(h.calls.redeem.length, 0);
  h.view.code.value = 'fixture-code';
  const pending = h.view.submitRedeem();
  assert.equal(h.view.code.value, 'fixture-code');
  redeem.resolve('兑换成功');
  await pending;
  assert.equal(h.view.code.value, '');
  assert.match(h.view.notice.value, /兑换成功/);
});

test('leaving redemption ignores the old result and later actions', async t => {
  const redeem = deferred();
  const h = harness(t, { redeem: () => redeem.promise });
  h.seed();
  h.view.switchMode();
  h.view.code.value = 'fixture-code';
  const pending = h.view.submitRedeem();
  h.unmount();
  redeem.resolve('兑换成功');
  await pending;
  await h.view.submit();
  await h.view.submitRedeem();
  assert.equal(h.view.notice.value, '');
  assert.equal(h.view.code.value, '');
  assert.equal(h.calls.redeem.length, 1);
  assert.equal(h.calls.activate.length, 0);
});

test('account changes close a release confirmation and cannot use its old seat with new credentials', async t => {
  const h = harness(t);
  h.prepareRelease();
  assert.equal(h.view.releaseVisible.value, true);
  h.view.username.value = 'account-b';
  assert.equal(h.view.releaseVisible.value, false);
  assert.equal(h.view.releasePassword.value, '');
  assert.equal(h.view.releaseTarget.value, null);
  await h.view.confirmRelease();
  h.view.openRelease(seat());
  assert.equal(h.calls.release.length, 0);
  assert.equal(h.view.releaseVisible.value, false);
});

test('closing release clears the confirmation password and makes hidden confirmations inert', async t => {
  const h = harness(t);
  h.prepareRelease();
  h.view.releaseVisible.value = false;
  assert.equal(h.view.releasePassword.value, '');
  await h.view.confirmRelease();
  assert.equal(h.calls.release.length, 0);
});

test('release submits the reviewed device and account once and preserves the copied device label', async t => {
  const release = deferred();
  const h = harness(t, { release: () => release.promise });
  h.prepareRelease();
  h.view.blockedSeats.value[0].label = 'changed list label';
  const pending = h.view.confirmRelease();
  await h.view.confirmRelease();
  assert.deepEqual(h.calls.release, [['seat-a', 'account-a', 'fixture-password']]);
  release.resolve();
  await pending;
  assert.deepEqual(h.view.blockedSeats.value.map(item => item.id), ['seat-b']);
  assert.match(h.view.notice.value, /Device seat-a/);
  assert.equal(h.view.releaseVisible.value, false);
  assert.equal(h.view.releasePassword.value, '');
});

test('failed release remains retryable and leaving the page suppresses late completion', async t => {
  let fail = true;
  const release = deferred();
  const h = harness(t, { release: () => fail ? Promise.reject(new Error('fixture release failed')) : release.promise });
  h.prepareRelease();
  await h.view.confirmRelease();
  assert.ok(h.view.releaseError.value);
  assert.equal(h.view.busy.value, false);
  fail = false;
  const pending = h.view.confirmRelease();
  h.unmount();
  release.resolve();
  await pending;
  assert.equal(h.view.notice.value, '');
  assert.equal(h.view.releasePassword.value, '');
});

test('a shared account operation from another page blocks activation, redemption and release', async t => {
  const h = harness(t);
  h.prepareRelease();
  h.store.loading = true;
  await h.view.submit();
  await h.view.submitRedeem();
  await h.view.confirmRelease();
  h.view.switchMode();
  assert.equal(h.view.busy.value, true);
  assert.equal(h.view.mode.value, 'activate');
  assert.equal(h.calls.activate.length + h.calls.redeem.length + h.calls.release.length, 0);
});
