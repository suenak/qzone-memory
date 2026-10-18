import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const source = transpileModule(readFileSync(new URL('../src/stores/license.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText.replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export const useLicenseStore =', 'return');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); }
const view = (username = 'account-a', extra = {}) => ({
  status: username ? 'active' : 'notActivated', activated: Boolean(username), canArchive: Boolean(username),
  username: username || null, message: null, platform: 'windows', installationId: 'test-device', ...extra,
});
const seat = (id = 'seat-a') => ({ id, label: id, current: false, platform: 'windows' });
const outcome = (username = 'account-b') => ({ success: true, message: 'activated', view: view(username), seats: [seat(`${username}-device`)] });

/** Real Pinia store; the native model makes credential-write ordering observable. */
function harness(t, handlers = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const native = { view: view(), seats: [seat()] };
  const commands = [];
  const invoke = async (command, args) => {
    commands.push({ command, args });
    if (handlers[command]) return handlers[command](native, args);
    if (command === 'get_license_status' || command === 'refresh_license') return { ...native.view };
    if (command === 'list_license_seats') return native.view.activated ? [...native.seats] : [];
    if (command === 'sign_out_license') { native.view = view(''); native.seats = []; return; }
    if (command === 'activate_license') {
      const result = outcome(args.username);
      native.view = result.view;
      native.seats = result.seats;
      return result;
    }
    if (command === 'deactivate_license_seat') {
      native.seats = native.seats.filter(item => item.id !== args.seatId);
      return { ...native.view };
    }
    if (command === 'redeem_license_code') return '兑换成功';
    assert.fail(`Unexpected command: ${command}`);
  };
  const dependencies = { defineStore, computed, ref, onScopeDispose, invoke };
  const store = new Function(...Object.keys(dependencies), source)(...Object.values(dependencies))(pinia);
  let disposed = false;
  function dispose() { if (!disposed) { disposed = true; store.$dispose(); } }
  t.after(dispose);
  return {
    store, native, commands, dispose,
    count: command => commands.filter(call => call.command === command).length,
    seed() { store.view = view(); store.seats = [seat()]; },
  };
}

test('native sign-out waits for a running heartbeat and remains the final credential write', async t => {
  const heartbeat = deferred();
  const h = harness(t, { refresh_license: async native => {
    await heartbeat.promise;
    native.view = view('account-a', { message: 'renewed old account' });
    return native.view;
  } });
  h.seed();
  const background = h.store.heartbeat();
  await settle();
  const exiting = h.store.signOut();
  assert.equal(h.store.loading, true);
  assert.equal(h.store.canArchive, false);
  await settle();
  assert.equal(h.count('sign_out_license'), 0);
  assert.equal(await h.store.heartbeat(), false, 'A foreground account operation blocks new heartbeats');
  heartbeat.resolve();
  assert.equal(await background, false, 'Superseded heartbeat results must not update the display');
  await exiting;
  assert.equal(h.native.view.activated, false);
  assert.equal(h.store.activated, false);
  assert.equal(h.store.canArchive, false);
  assert.equal(h.store.loading, false);
  assert.deepEqual(h.store.seats, []);
  assert.deepEqual(h.commands.map(call => call.command), ['refresh_license', 'sign_out_license', 'get_license_status']);
});

test('activation waits for an old heartbeat and becomes the native and displayed account', async t => {
  const heartbeat = deferred();
  const h = harness(t, { refresh_license: async native => {
    await heartbeat.promise;
    native.view = view('account-a');
    return native.view;
  } });
  const background = h.store.heartbeat();
  await settle();
  const activation = h.store.activate('account-b', 'fixture-password', 'fixture-label');
  await settle();
  assert.equal(h.count('activate_license'), 0);
  heartbeat.resolve();
  await Promise.all([background, activation]);
  assert.equal(h.native.view.username, 'account-b');
  assert.equal(h.store.username, 'account-b');
  assert.equal(h.store.canArchive, true);
  assert.equal(h.store.initialized, true);
});

test('an obsolete failed heartbeat cannot trigger a refresh over the pending account operation', async t => {
  const heartbeat = deferred();
  const h = harness(t, { refresh_license: () => heartbeat.promise });
  const background = h.store.heartbeat();
  await settle();
  const activation = h.store.activate('account-b', 'fixture-password', '');
  heartbeat.reject(new Error('old account revoked'));
  await Promise.all([background, activation]);
  assert.equal(h.store.username, 'account-b');
  assert.equal(h.store.lastError, '');
  assert.equal(h.count('get_license_status'), 0);
});

test('foreground account operations are mutually exclusive across pages and preserve pending state', async t => {
  const activation = deferred();
  const h = harness(t, { activate_license: () => activation.promise });
  h.seed();
  const pending = h.store.activate('account-b', 'fixture-password', '');
  for (const operation of [
    () => h.store.activate('account-c', 'fixture-password', ''),
    () => h.store.signOut(),
    () => h.store.deactivateSeat('seat-a'),
    () => h.store.redeem('account-b', 'fixture-password', 'fixture-code'),
  ]) await assert.rejects(operation(), /授权操作正在进行/);
  assert.equal(h.store.loading, true);
  assert.equal(h.store.canArchive, false);
  assert.equal(h.count('activate_license'), 1);
  assert.equal(h.count('sign_out_license'), 0);
  activation.resolve(outcome());
  await pending;
  assert.equal(h.store.loading, false);
  assert.equal(h.store.canArchive, true);
});

test('concurrent status, seat and heartbeat reads share their pending native requests', async t => {
  const status = deferred(), seats = deferred(), heartbeat = deferred();
  const h = harness(t, {
    get_license_status: () => status.promise,
    list_license_seats: () => seats.promise,
    refresh_license: () => heartbeat.promise,
  });
  const statuses = [h.store.refresh(), h.store.refresh(), h.store.refresh()];
  const seatLists = [h.store.loadSeats(), h.store.loadSeats()];
  const heartbeats = [h.store.heartbeat(), h.store.heartbeat()];
  await settle();
  assert.equal(h.count('get_license_status'), 1);
  status.resolve(view());
  await Promise.all(statuses);
  await settle();
  assert.equal(h.count('list_license_seats'), 1);
  seats.resolve([seat()]);
  await Promise.all(seatLists);
  await settle();
  assert.equal(h.count('refresh_license'), 1);
  heartbeat.resolve(view());
  assert.deepEqual(await Promise.all(heartbeats), [true, true]);
});

test('a pre-activation status read settles with the final account instead of its old snapshot', async t => {
  const oldStatus = deferred();
  let first = true;
  const h = harness(t, { get_license_status: native => {
    if (first) { first = false; return oldStatus.promise; }
    return { ...native.view };
  } });
  const reading = h.store.refresh();
  await settle();
  const activating = h.store.activate('account-b', 'fixture-password', '');
  const checkingAfterActivation = h.store.refresh();
  oldStatus.resolve(view('account-a'));
  const [result] = await Promise.all([reading, activating, checkingAfterActivation]);
  assert.equal(result.username, 'account-b');
  assert.equal(h.store.username, 'account-b');
  assert.equal(h.count('get_license_status'), 2);
});

test('a pre-sign-out seat list cannot repopulate the old account devices', async t => {
  const oldSeats = deferred();
  let first = true;
  const h = harness(t, { list_license_seats: native => {
    if (first) { first = false; return oldSeats.promise; }
    return native.view.activated ? native.seats : [];
  } });
  h.seed();
  const reading = h.store.loadSeats();
  await settle();
  const exiting = h.store.signOut();
  oldSeats.resolve([seat('old-device')]);
  const [result] = await Promise.all([reading, exiting]);
  assert.deepEqual(result, []);
  assert.deepEqual(h.store.seats, []);
  assert.equal(h.store.username, '');
});

for (const [command, operation] of [
  ['activate_license', store => store.activate('account-b', 'fixture-password', '')],
  ['deactivate_license_seat', store => store.deactivateSeat('seat-a')],
  ['redeem_license_code', store => store.redeem('account-a', 'fixture-password', 'fixture-code')],
  ['sign_out_license', store => store.signOut()],
]) {
  test(`${command} failure releases the operation and does not poison the next request`, async t => {
    let fail = true;
    const h = harness(t, { [command]: async () => {
      if (fail) throw new Error('fixture operation failed');
      if (command === 'activate_license') return outcome();
      if (command === 'deactivate_license_seat') return view();
      if (command === 'redeem_license_code') return '兑换成功';
    } });
    h.seed();
    await assert.rejects(operation(h.store), /fixture operation failed/);
    assert.equal(h.store.loading, false);
    assert.match(h.store.lastError, /fixture operation failed/);
    fail = false;
    await operation(h.store);
    await h.store.refresh();
    assert.equal(h.count(command), 2);
    assert.equal(h.store.lastError, '');
  });
}

test('a business activation failure keeps its occupied seats and permits a new attempt', async t => {
  let fail = true;
  const h = harness(t, { activate_license: async () => fail
    ? { success: false, message: '席位已满', view: view('', { message: '席位已满' }), seats: [seat('occupied')] }
    : outcome() });
  const blocked = await h.store.activate('account-b', 'fixture-password', '');
  assert.equal(blocked.success, false);
  assert.deepEqual(h.store.seats, [seat('occupied')]);
  assert.equal(h.store.loading, false);
  assert.equal(h.store.canArchive, false);
  fail = false;
  await h.store.activate('account-b', 'fixture-password', '');
  assert.equal(h.store.canArchive, true);
});

test('device-list errors survive status refreshes and clear on a successful list retry', async t => {
  let fail = true;
  const h = harness(t, { list_license_seats: async () => {
    if (fail) throw new Error('device list unavailable');
    return [seat('fresh-device')];
  } });
  h.seed();
  await h.store.loadSeats();
  assert.deepEqual(h.store.seats, []);
  assert.match(h.store.seatsError, /device list unavailable/);
  await h.store.refresh();
  await h.store.heartbeat();
  assert.match(h.store.seatsError, /device list unavailable/);
  assert.equal(h.store.lastError, '');
  fail = false;
  await h.store.loadSeats();
  assert.equal(h.store.seatsError, '');
  assert.deepEqual(h.store.seats, [seat('fresh-device')]);
});

test('seat release stays busy through its follow-up list and reports a list failure separately', async t => {
  const seats = deferred();
  const h = harness(t, { list_license_seats: () => seats.promise });
  h.seed();
  const pending = h.store.deactivateSeat('seat-a');
  await settle();
  assert.equal(h.count('deactivate_license_seat'), 1);
  assert.equal(h.store.loading, true);
  assert.equal(h.store.canArchive, false);
  seats.reject(new Error('post-release list failed'));
  await pending;
  assert.equal(h.store.loading, false);
  assert.equal(h.store.canArchive, true);
  assert.equal(h.store.lastError, '');
  assert.match(h.store.seatsError, /post-release list failed/);
});

test('redemption stays busy through status reconciliation and returns its successful result', async t => {
  const status = deferred();
  const h = harness(t, { get_license_status: () => status.promise });
  const pending = h.store.redeem('account-a', 'fixture-password', 'fixture-code');
  await settle();
  assert.equal(h.store.loading, true);
  status.resolve(view('account-a', { expiresAt: 2_000_000 }));
  assert.equal(await pending, '兑换成功');
  assert.equal(h.store.view.expiresAt, 2_000_000);
  assert.equal(h.store.loading, false);
});

test('a failed heartbeat uses the native grace state and remains nonfatal', async t => {
  const h = harness(t, { refresh_license: async () => { throw new Error('network offline'); } });
  h.native.view = view('account-a', { status: 'grace', message: '暂时离线可用' });
  assert.equal(await h.store.heartbeat(), false);
  assert.equal(h.store.inGrace, true);
  assert.equal(h.store.canArchive, true);
  assert.equal(h.store.lastError, '暂时离线可用');
  assert.equal(h.count('get_license_status'), 1);
});

test('a revoked heartbeat reconciles the cleared native licence', async t => {
  const h = harness(t, { refresh_license: async native => {
    native.view = view('', { message: '授权已失效' });
    throw new Error('revoked');
  } });
  h.seed();
  await h.store.heartbeat();
  assert.equal(h.store.activated, false);
  assert.equal(h.store.canArchive, false);
  assert.equal(h.store.lastError, '授权已失效');
});

test('a failed status read completes initialization and supports a deliberate retry', async t => {
  let fail = true;
  const h = harness(t, { get_license_status: async () => {
    if (fail) throw new Error('native status unavailable');
    return view();
  } });
  await h.store.refresh();
  assert.equal(h.store.initialized, true);
  assert.equal(h.store.canArchive, false);
  assert.match(h.store.lastError, /native status unavailable/);
  fail = false;
  await h.store.refresh();
  assert.equal(h.store.canArchive, true);
});

test('successful sign-out remains cleared even if its status reconciliation fails', async t => {
  const h = harness(t, { get_license_status: async () => { throw new Error('status read failed'); } });
  h.seed();
  await h.store.signOut();
  assert.equal(h.store.view, null);
  assert.deepEqual(h.store.seats, []);
  assert.equal(h.store.canArchive, false);
  assert.equal(h.store.loading, false);
  assert.match(h.store.lastError, /status read failed/);
});

test('disposing ignores an in-flight heartbeat and cancels queued account commands', async t => {
  const heartbeat = deferred();
  const h = harness(t, { refresh_license: () => heartbeat.promise });
  h.seed();
  const background = h.store.heartbeat();
  await settle();
  const queued = assert.rejects(h.store.signOut(), /已取消/);
  h.dispose();
  heartbeat.resolve(view('obsolete-account'));
  await Promise.all([background, queued]);
  assert.equal(h.store.username, 'account-a');
  assert.equal(h.count('sign_out_license'), 0);
  const before = h.commands.length;
  await h.store.refresh();
  await h.store.loadSeats();
  await h.store.heartbeat();
  await assert.rejects(h.store.activate('account-b', 'fixture-password', ''), /已结束/);
  assert.equal(h.commands.length, before);
});
