// 同一次断线检验。
//
// 两种交接策略跑完全相同的故障时序，唯一变量是「新实例遇到旧实例名下的任务时怎么做」：
//   wait      直接等待。只领无主任务；旧实例名下的活等它自己回来。
//   takeover  新实例接管。用更高 epoch 直接接手，旧实例的写入被栅栏拒绝。
//
// 故障时序（关键在事件被暂停投递、且允许乱序到达）：
//   1. 旧实例 old@1 持有 task/a、task/b，干了一部分活。
//   2. 暂停事件投递。此后所有写入只进事件日志、先排队。
//   3. old 发出 create task/ghost（它以为还没提交），随即断线。
//   4. 管理员删除 task/ghost，再删除 task/b，并新建 task/c。
//   5. 新实例 new@2 从旧的检查点 rv 续订（不列举），于是队列里同时有
//      “创建 ghost”和“删除 ghost”两条事件。
//   6. 页面按“最新优先”单步放行：new 先读到删除事件、后读到更旧的创建事件。
//      控制器必须凭版本号丢弃旧事件，ghost 不能在本地复活。
//   7. new 列举并接管；old 带着过期缓存重连，先做一次“断线前就已发出的”写入，
//      再重新列举。
//   8. 审计：不复活、不双写、离线实例的活有明确归宿。
//
// 最后用同一脚本再跑一遍「旧实例永远不回来」，比较两种策略：
// wait 的活会一直挂在离线实例名下（无人执行），takeover 会把它交给在线实例。

import { ApiServer } from './apiserver.js';
import { Controller } from './controller.js';

export function buildWorld(strategy, { oldReturns = true } = {}) {
  const server = new ApiServer({
    tasks: [
      { key: 'task/a', owner: 'old', epoch: 1, total: 4, done: 1, phase: 'running', leaseUntil: 0, lineage: ['old@1'] },
      { key: 'task/b', owner: 'old', epoch: 1, total: 3, done: 1, phase: 'running', leaseUntil: 0, lineage: ['old@1'] },
    ],
  });

  const old = new Controller({ id: 'old', epoch: 1, server, strategy });
  const fresh = new Controller({ id: 'new', epoch: 2, server, strategy });
  const ctrls = [old, fresh];
  let strandedAtDisconnect = [];

  const steps = [];
  let observing = false;
  const record = (label) => {
    steps.push({ label, observing, ...snapshot(server, ctrls) });
  };

  // 1. 旧实例上线并持有 a、b
  old.start();
  record('old.start');

  // 2. 暂停事件投递
  server.pause();
  const checkpoint = old.lastRv; // 旧实例断线前看到的最后一个版本
  record('pause');

  // 3. old 发出创建指令（服务器接受，事件进队列），随即断线
  old.retryCreate('task/ghost', {
    owner: 'old',
    epoch: 1,
    total: 1,
    done: 0,
    phase: 'running',
    leaseUntil: 0,
    lineage: ['old@1'],
  });
  strandedAtDisconnect = old.liveClaims.slice();
  old.disconnect('计划重启，事件暂停中');
  record('old.disconnect');

  // 4. 管理员删除 ghost（留下墓碑）、删除 b、新建 c
  server.remove('task/ghost', server.get('task/ghost').rv, { actor: 'admin' });
  server.remove('task/b', server.get('task/b').rv, { actor: 'admin' });
  server.create(
    'task/c',
    { owner: null, epoch: 1, total: 2, done: 0, phase: 'pending', leaseUntil: 0, lineage: [] },
    { epoch: 1, actor: 'admin' },
  );
  record('admin edits');

  // 5. 新实例从旧检查点续订（模拟重启后沿用本地 rv，不列举）
  fresh.start({ sinceRv: checkpoint });
  record('new.start(checkpoint)');

  // 6. 乱序单步：对 new 明确先放行「删除 ghost」再放行更旧的「创建 ghost」。
  //    这是题目里那句危险的时序：新实例先读到删除、后读到旧实例发出的创建。
  const order = [];
  const ghostCreate = server.events.find((e) => e.type === 'create' && e.key === 'task/ghost');
  const ghostDelete = server.events.find((e) => e.type === 'delete' && e.key === 'task/ghost');
  for (const ev of [ghostDelete, ghostCreate]) {
    if (!ev) continue;
    const out = server.step({ forId: 'new', rv: ev.rv });
    if (out) order.push(`${out.type}:${out.key}@${out.rv}`);
  }
  record('step new (delete first, then stale create)');

  // 7. new 列举并接管；这就是“恢复完成”的观察起点
  fresh.reconcile();
  observing = true;
  record('new.reconcile');

  if (oldReturns) {
    // 8. old 重连：先按过期缓存做一次在途写入，再重新列举
    old.reconnect();
    old.workOne(); // 断线前就已发出的写入，现在才真正落盘
    old.retryCreate('task/ghost', { owner: 'old', epoch: 1, total: 1, done: 0, phase: 'running', leaseUntil: 0, lineage: ['old@1'] });
    old.resync();
    record('old.reconnect(stale write) + resync');
  }

  // 9. 放完事件队列，然后让两个实例干活直到没有可推进的
  server.resume();
  let guard = 0;
  while (guard++ < 60) {
    const a = old.online ? old.workOne() : null;
    const b = fresh.workOne();
    if (!a && !b) break;
  }
  record('drain work');

  if (oldReturns) old.resync();
  record('final');

  return {
    strategy,
    oldReturns,
    server,
    controllers: ctrls,
    steps,
    outOfOrder: order,
    summary() {
      const holders = server.finalHolders();
      const live = ctrls.filter((c) => c.online);
      const liveOwner = (h) =>
        h.owner != null && live.some((c) => c.id === h.owner && c.epoch === h.epoch);
      const stranded = holders.filter((h) => h.phase !== 'done' && !liveOwner(h));
      const observed = steps.filter((s) => s.observing);
      const windows = observed.map((s) => ({
        label: s.label,
        tasks: s.tasks,
      }));
      const zeroOwnerWindows = windows.filter((w) =>
        w.tasks.some((t) => t.phase !== 'done' && t.liveClaimants.length === 0 && !t.ownerLive),
      );
      const multiOwnerWindows = windows.filter((w) => w.tasks.some((t) => t.liveClaimants.length > 1));
      const ledger = ctrls.flatMap((c) =>
        c.ledger.map((e) => ({ by: c.id, key: e.key, to: e.to, resolved: e.resolved, reason: e.reason })),
      );
      // 「旧实例断线时手上的活」最终归宿，只看服务器最终状态：
      // 归在线实例 → 该实例；资源不存在 → 已删除；其余 → 未决。
      const byKey = new Map(holders.map((h) => [h.key, h]));
      const handoffDestinations = strandedAtDisconnect.map((key) => {
        const h = byKey.get(key);
        if (!h) return { key, to: 'deleted' };
        if (liveOwner(h)) return { key, to: `${h.owner}@${h.epoch}` };
        return { key, to: 'stranded' };
      });
      return {
        strategy,
        oldReturns,
        ghostEverCreated: server.events.some((e) => e.type === 'create' && e.key === 'task/ghost'),
        ghostResurrected: server.events.some((e) => e.type === 'create' && e.key === 'task/ghost' && e.rv > (server.tombstones.get('task/ghost')?.rv ?? Infinity)),
        outOfOrder: order,
        finalized: holders.map((h) => ({
          key: h.key,
          owner: h.owner,
          epoch: h.epoch,
          phase: h.phase,
          done: h.done,
          total: h.total,
          ownerLive: liveOwner(h),
        })),
        stranded: stranded.map((h) => h.key),
        zeroOwnerWindows: zeroOwnerWindows.map((w) => w.label),
        multiOwnerWindows: multiOwnerWindows.map((w) => w.label),
        fenced: old.fencedCount,
        conflicts: old.conflictCount + fresh.conflictCount,
        workDone: old.workDone + fresh.workDone,
        ledger,
        unresolvedLedgerOnline: live.flatMap((c) => c.ledger.filter((e) => !e.resolved)).length,
        handoffDestinations,
        handoffUnresolved: handoffDestinations.filter((d) => d.to === 'stranded').length,
      };
    },
  };
}

function snapshot(server, controllers) {
  const live = controllers.filter((c) => c.online);
  const tasks = server.finalHolders().map((h) => ({
    key: h.key,
    phase: h.phase,
    owner: h.owner,
    epoch: h.epoch,
    ownerLive: h.owner != null && live.some((c) => c.id === h.owner && c.epoch === h.epoch),
    liveClaimants: live.filter((c) => c.claims.has(h.key) && c.cache.get(h.key)?.data?.phase !== 'done').map((c) => c.id),
  }));
  return {
    rv: server.rv,
    clock: server.clock,
    paused: server.paused,
    pending: server.pending,
    tasks,
    controllers: controllers.map((c) => ({
      id: c.id,
      epoch: c.epoch,
      online: c.online,
      lastRv: c.lastRv,
      claims: c.liveClaims,
      cacheKeys: [...c.cache.keys()],
      fenced: c.fencedCount,
    })),
  };
}
