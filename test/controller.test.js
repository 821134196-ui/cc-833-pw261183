import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer, Conflict, Fenced, StaleCreate } from '../src/apiserver.js';
import { Controller } from '../src/controller.js';
import { audit } from '../src/invariants.js';
import { buildWorld } from '../src/drill.js';

const task = (over = {}) => ({
  owner: null,
  epoch: 1,
  total: 3,
  done: 0,
  phase: 'pending',
  leaseUntil: 0,
  lineage: [],
  ...over,
});

// ---------- API Server ----------

test('update 带错的基础 rv 抛 Conflict，并附当前对象', () => {
  const s = new ApiServer();
  s.seedTask({ key: 'task/a' });
  const stale = s.get('task/a');
  s.update('task/a', stale.rv, (d) => ({ ...d, done: 1 }));
  assert.throws(
    () => s.update('task/a', stale.rv, (d) => ({ ...d, done: 2 })),
    (err) => err instanceof Conflict && err.current.data.done === 1,
  );
});

test('删除后墓碑拒绝低 epoch 的迟到 create', () => {
  const s = new ApiServer();
  s.seedTask({ key: 'task/a', epoch: 1 });
  s.remove('task/a');
  assert.throws(() => s.create('task/a', task({ owner: 'old', epoch: 1 }), { epoch: 1 }), StaleCreate);
  const v = s.create('task/a', task({ owner: 'new', epoch: 2 }), { epoch: 2 });
  assert.equal(v.data.owner, 'new');
});

test('epoch 栅栏拒绝过期世代写入', () => {
  const s = new ApiServer();
  s.seedTask({ key: 'task/a', owner: 'old', epoch: 1 });
  const cur = s.get('task/a');
  s.update('task/a', cur.rv, (d) => ({ ...d, owner: 'new', epoch: 2 }));
  const now = s.get('task/a');
  assert.throws(
    () => s.update('task/a', now.rv, (d) => ({ ...d, done: 9 }), { fence: { owner: 'old', epoch: 1 } }),
    Fenced,
  );
});

test('暂停投递时事件只排队；step 每次只放行一个版本', () => {
  const s = new ApiServer();
  const got = [];
  s.watch({ id: 'w', sinceRv: 0, onEvent: (e) => got.push(e.rv) });
  s.pause();
  s.create('task/a', task());
  s.update('task/a', s.get('task/a').rv, (d) => ({ ...d, done: 1 }));
  assert.equal(got.length, 0);
  assert.equal(s.pending, 2);
  s.step();
  assert.equal(got.length, 1);
  s.step();
  assert.equal(got.length, 2);
});

test('newestFirst / 指定 rv 能制造“删除先于创建被读到”的乱序', () => {
  const s = new ApiServer();
  const got = [];
  s.watch({ id: 'w', sinceRv: 0, onEvent: (e) => got.push(`${e.type}:${e.key}@${e.rv}`) });
  s.pause();
  s.create('task/a', task());
  s.remove('task/a');
  s.step({ rv: 2 });
  s.step({ rv: 1 }); // 更旧的 create 后到
  assert.deepEqual(got, ['delete:task/a@2', 'create:task/a@1']);
});

test('newestFirst 默认挑版本最大的事件', () => {
  const s = new ApiServer();
  const got = [];
  s.watch({ id: 'w', sinceRv: 0, onEvent: (e) => got.push(`${e.type}:${e.key}@${e.rv}`) });
  s.pause();
  s.create('task/a', task());
  s.remove('task/a');
  s.step({ newestFirst: true });
  s.step({ newestFirst: true });
  assert.deepEqual(got, ['delete:task/a@2', 'create:task/a@1']);
});

// ---------- 控制器 ----------

test('乱序事件里，删除之后才到的创建事件不会让缓存复活', () => {
  const s = new ApiServer();
  const c = new Controller({ id: 'new', epoch: 2, server: s });
  c.start();
  s.pause();
  s.create('task/x', task());
  s.remove('task/x');
  s.step({ forId: 'new', newestFirst: true }); // delete
  s.step({ forId: 'new', newestFirst: true }); // 更旧的 create
  assert.equal(c.cache.has('task/x'), false);
  assert.ok(c.journal.some((j) => j.kind === 'stale-event' && j.key === 'task/x'));
});

test('断线重连后写入被栅栏拒绝，台账记下明确归宿', () => {
  const s = new ApiServer({ tasks: [{ key: 'task/a', owner: 'old', epoch: 1, total: 3, done: 0, phase: 'running' }] });
  const old = new Controller({ id: 'old', epoch: 1, server: s });
  old.start();
  old.disconnect('断线');
  const fresh = new Controller({ id: 'new', epoch: 2, server: s });
  fresh.start();
  assert.deepEqual(fresh.liveClaims, ['task/a']);
  // 暂停投递，让旧实例重连后无法先收到那段更新，只能带着过期缓存去写
  s.pause();
  old.reconnect();
  old.workOne();
  assert.equal(old.fencedCount, 1);
  const entry = old.ledger.find((e) => e.key === 'task/a' && e.resolved);
  assert.ok(entry, '应有已解决的台账项');
  assert.equal(entry.to, 'new@2');
  assert.equal(old.liveClaims.length, 0);
});

test('两个实例并发领取同一无主任务，只有一个成功（CAS）', () => {
  const s = new ApiServer({ tasks: [{ key: 'task/a', total: 3 }] });
  const a = new Controller({ id: 'a', epoch: 1, server: s });
  const b = new Controller({ id: 'b', epoch: 1, server: s });
  a.start();
  b.start();
  assert.equal(a.liveClaims.length + b.liveClaims.length, 1);
  assert.equal(s.finalHolders().filter((h) => h.key === 'task/a').length, 1);
});

test('同一 epoch 的两个实例不靠列举打架，租约过期前不抢', () => {
  const s = new ApiServer({ tasks: [{ key: 'task/a', owner: 'a', epoch: 1, total: 3, phase: 'running', leaseUntil: 99 }] });
  const a = new Controller({ id: 'a', epoch: 1, server: s });
  const b = new Controller({ id: 'b', epoch: 1, server: s });
  a.start();
  b.start();
  assert.deepEqual(b.liveClaims, []);
  s.advance(100);
  b.reconcile();
  assert.deepEqual(b.liveClaims, ['task/a']);
  assert.equal(a.fencedCount, 0); // 同世代不走栅栏，a 靠事件/列举让位
});

// ---------- 同一次断线检验 ----------

test('takeover：同一套断线脚本下不复活、不双写、全部有归宿', () => {
  const w = buildWorld('takeover');
  const r = audit({ server: w.server, controllers: w.controllers });
  assert.deepEqual(r.violations, []);
  const m = w.summary();
  assert.equal(m.ghostResurrected, false);
  assert.equal(m.stranded.length, 0);
  assert.deepEqual(m.zeroOwnerWindows, []);
  assert.deepEqual(m.multiOwnerWindows, []);
  assert.ok(m.fenced >= 1, '旧实例应被 epoch 栅栏挡住至少一次');
  assert.deepEqual(m.outOfOrder, ['delete:task/ghost@4', 'create:task/ghost@3']);
  assert.ok(m.handoffDestinations.every((d) => d.to !== 'stranded'));
});

test('wait：同一套断线脚本不复活、不双写，旧实例回来后自己收回原活', () => {
  const w = buildWorld('wait');
  const r = audit({ server: w.server, controllers: w.controllers });
  assert.deepEqual(r.violations, []);
  const m = w.summary();
  assert.equal(m.ghostResurrected, false);
  assert.deepEqual(m.multiOwnerWindows, []);
  assert.equal(m.fenced, 0, 'wait 不具备栅栏');
  // 测的是同一段故障、同一种“旧实例最终回来”；这时 wait 靠旧实例自己把活干完
  assert.equal(m.stranded.length, 0);
  assert.ok(m.handoffDestinations.some((d) => d.key === 'task/a' && d.to === 'old@1'));
  // 但在新实例接管完成之前，wait 留下过一个「无人执行」的窗口
  assert.ok(m.zeroOwnerWindows.length > 0);
});

test('同一脚本、旧实例永不再上线：takeover 有归宿，wait 留悬空', () => {
  const t = buildWorld('takeover', { oldReturns: false });
  const w = buildWorld('wait', { oldReturns: false });
  const ts = t.summary();
  const ws = w.summary();
  assert.equal(ts.stranded.length, 0, `takeover 不应悬空，实际 ${ts.stranded}`);
  assert.ok(ws.stranded.length > 0, 'wait 应留下悬空任务');
  assert.ok(ws.stranded.every((k) => ['task/a', 'task/b'].includes(k)));
  assert.equal(ts.ghostResurrected, false);
  assert.equal(ws.ghostResurrected, false);
  // 也应当落在审计上：takeover 通过，wait 因为“无活持有者”不通过
  assert.deepEqual(audit({ server: t.server, controllers: t.controllers }).violations, []);
  assert.ok(audit({ server: w.server, controllers: w.controllers }).violations.some((v) => v.includes('无活持有者')));
});
