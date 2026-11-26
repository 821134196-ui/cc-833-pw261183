// 控制器实例。
//
// 三条不变量在这里落地：
//   A. 只应用 rv 严格递增的事件。删除之后才到的创建事件被丢弃，对象不会复活。
//   B. 每次写入都带基础 rv；冲突就用服务器返回的 rv 乐观重试。
//   C. 接管策略下写入再带 (owner, epoch) 栅栏；过期世代的写入被拒绝，
//      旧实例必须把活明确交出去，并把归宿记进台账。
//
// 交接策略：
//   wait      只领无主任务，从不抢旧实例名下的任务。旧实例若不再回来，
//             它的活就一直挂在旧名字下——没有实际执行者。
//   takeover  用更高 epoch 直接接管。旧实例的写入被栅栏拒绝，
//             每个任务的归宿都能在台账里查到。

export const PHASE = Object.freeze({ PENDING: 'pending', RUNNING: 'running', DONE: 'done' });

export class Controller {
  constructor({ id, epoch, server, strategy = 'takeover', prefix = 'task/', leaseTtl = 4, standby = false }) {
    if (!id) throw new Error('controller 需要 id');
    this.id = id;
    this.epoch = epoch;
    this.server = server;
    this.strategy = strategy;
    this.prefix = prefix;
    this.leaseTtl = leaseTtl;
    this.standby = standby;

    this.online = false;
    this.lastRv = null;
    this.cache = new Map(); // key -> { key, rv, data }
    this.claims = new Set();
    this.journal = [];
    this.ledger = []; // 交接台账 { key, at, to, reason, resolved, resolvedAt }
    this.fencedCount = 0;
    this.conflictCount = 0;
    this.workDone = 0;
    this.sub = null;
    this.seenCreates = new Set();
  }

  // ---- 生命周期 ----

  // 首次上线。sinceRv 给定时不列举，只从旧检查点续订——模拟「重启后沿用本地旧 rv」。
  start({ sinceRv = null } = {}) {
    if (this.online) return this;
    this.online = true;
    this.note('start', null, `上线 epoch=${this.epoch}（${this.strategy}${this.standby ? '，待命' : ''}）`);
    if (sinceRv != null) {
      this.lastRv = Math.max(this.lastRv ?? 0, Number(sinceRv));
      this.watchFrom(this.lastRv);
    } else {
      this.sync();
      this.watchFrom(this.lastRv);
      if (!this.standby) this.reconcile();
    }
    return this;
  }

  // 断线：关 watch，但保留「我持有这些任务」的记忆；台账记下未决归宿。
  disconnect(reason = '网络分区') {
    if (!this.online) return this;
    this.online = false;
    this.sub?.close();
    this.sub = null;
    for (const key of this.claims) {
      if (!this.ledger.some((e) => e.key === key && !e.resolved)) {
        this.ledger.push({ key, at: this.server.clock, to: null, reason: `${reason}，尚无归宿`, resolved: false });
      }
    }
    this.note('offline', null, `${reason}；本地仍认为持有 ${this.claims.size} 个任务`);
    return this;
  }

  // 重连：只从本地最后看到的 rv 续订，不重新列举。
  // 缓存可能已过期；正确性要靠服务器端 CAS 与 epoch 栅栏，而不是本地记忆。
  reconnect() {
    if (this.online) return this;
    this.online = true;
    this.note('reconnect', null, `从 rv=${this.lastRv ?? '?'} 续订，未重新列举`);
    this.watchFrom(this.lastRv);
    return this;
  }

  // 待命实例提升为活跃：做一次权威列举，然后开始领取。
  activate() {
    this.standby = false;
    if (!this.online) this.start();
    this.note('activate', null, '提升为活跃实例并重新列举');
    this.reconcile();
    return this;
  }

  watchFrom(rv) {
    this.sub = this.server.watch({
      id: this.id,
      sinceRv: rv,
      onEvent: (ev) => this.onEvent(ev),
    });
  }

  // ---- 事件 ----

  onEvent(ev) {
    if (this.lastRv != null && ev.rv <= this.lastRv) {
      this.note('stale-event', ev.key, `丢弃 rv=${ev.rv}（已应用到 rv=${this.lastRv}）`);
      return;
    }
    this.lastRv = ev.rv;
    if (ev.type === 'delete') {
      this.cache.delete(ev.key);
      if (this.claims.delete(ev.key)) {
        this.resolveHandoff(ev.key, 'none', '资源被删除，不再持有');
        this.note('delete', ev.key, `rv=${ev.rv} 已删除，放弃持有`);
      } else {
        this.note('delete', ev.key, `rv=${ev.rv} 已删除`);
      }
      return;
    }
    this.cache.set(ev.key, { key: ev.key, rv: ev.rv, data: ev.data });
    if (this.claims.has(ev.key) && !this.owns(ev.data)) {
      this.yieldClaim(ev.key, ev.data, `观察到 rv=${ev.rv} 起已由他人持有`);
    }
  }

  owns(data) {
    return !!data && data.owner === this.id && data.epoch === this.epoch;
  }

  // ---- 快照与领取 ----

  // list 一个一致快照，并把 lastRv 推进到快照 rv：
  // 之后按序到达的、rv 不大于它的事件都已包含在快照里，必须忽略。
  sync() {
    const snap = this.server.list(this.prefix);
    const seen = new Set();
    for (const item of snap.items) {
      seen.add(item.key);
      this.cache.set(item.key, item);
      if (this.claims.has(item.key) && !this.owns(item.data)) {
        this.yieldClaim(item.key, item.data, '列举发现已被接管');
      }
    }
    for (const key of [...this.claims]) {
      if (!seen.has(key)) {
        this.claims.delete(key);
        this.resolveHandoff(key, 'none', '资源已不存在');
      }
    }
    this.lastRv = Math.max(this.lastRv ?? 0, snap.rv);
    return snap;
  }

  // 重新列举并按权威状态调整本地持有。断线重连后、或怀疑缓存过期时调用。
  resync() {
    if (!this.online) return;
    this.reconcile();
  }

  reconcile() {
    if (!this.online || this.standby) return;
    const snap = this.sync();
    for (const item of snap.items) {
      if (this.claims.has(item.key)) continue;
      if (item.data.phase === PHASE.DONE) continue;
      // 服务器上本来就记在我名下（断线前的在途写入、或重启后沿用旧身份）：
      // 直接接纳为本地持有，不需要再写一次。
      if (this.owns(item.data)) {
        this.claims.add(item.key);
        this.note('adopt', item.key, `服务器仍记我持有 rv=${item.rv}，重新接纳`);
        continue;
      }
      if (this.shouldClaim(item.data)) this.tryClaim(item);
    }
    // 旧实例断线时的未决台账：若重新列举后仍归自己，补上归宿
    for (const entry of this.ledger) {
      if (!entry.resolved && this.claims.has(entry.key)) {
        entry.to = `${this.id}@${this.epoch}`;
        entry.reason += ' → 恢复后继续持有';
        entry.resolved = true;
        entry.resolvedAt = this.server.clock;
      }
    }
  }

  shouldClaim(data) {
    if (!data) return false;
    if (data.owner == null) return true;
    if (this.strategy === 'wait') return false; // 直接等待：不碰旧实例名下的活
    if (data.epoch < this.epoch) return true; // 接管：更高世代直接接
    if (data.epoch === this.epoch && data.owner !== this.id) {
      return (data.leaseUntil ?? 0) <= this.server.clock; // 同世代只有租约过期才接
    }
    return false;
  }

  tryClaim(item) {
    try {
      const view = this.server.update(
        item.key,
        item.rv,
        (d) => ({
          ...d,
          owner: this.id,
          epoch: this.epoch,
          phase: d.phase === PHASE.DONE ? d.phase : PHASE.RUNNING,
          leaseUntil: this.server.clock + this.leaseTtl,
          lineage: [...(d.lineage ?? []), `${this.id}@${this.epoch}`],
        }),
        { actor: this.id },
      );
      this.cache.set(item.key, view);
      this.lastRv = Math.max(this.lastRv ?? 0, view.rv);
      this.claims.add(item.key);
      this.note('claim', item.key, `领取成功 rv=${view.rv}`);
    } catch (err) {
      this.conflictCount += 1;
      this.note('claim-conflict', item.key, `领取失败：${err.name}`);
    }
  }

  // ---- 干活：每调用一次推进一格 ----

  workOne() {
    if (!this.online || this.standby) return null;
    for (const key of this.claims) {
      const item = this.cache.get(key);
      if (!item || item.data.phase === PHASE.DONE) continue;
      const result = this.doWork(item);
      if (result) return result;
    }
    return null;
  }

  doWork(item) {
    const d = item.data;
    const nextDone = Math.min(d.done + 1, d.total);
    const finish = nextDone >= d.total;
    const patch = {
      ...d,
      owner: this.id,
      epoch: this.epoch,
      done: nextDone,
      phase: finish ? PHASE.DONE : PHASE.RUNNING,
      leaseUntil: finish ? 0 : this.server.clock + this.leaseTtl,
      lineage: [...(d.lineage ?? []), `${this.id}@${this.epoch}`],
    };
    const fence = this.strategy === 'takeover' ? { owner: this.id, epoch: this.epoch } : null;
    try {
      let view;
      try {
        view = this.server.update(item.key, item.rv, () => patch, { fence, actor: this.id });
      } catch (err) {
        if (err.name === 'Conflict' && !err.current) {
          // 资源已经不在了：这不是矛盾，是「活没了」，直接销账
          this.claims.delete(item.key);
          this.resolveHandoff(item.key, 'none', '写入时资源已被删除');
          this.note('gone', item.key, `写入被拒：资源 rv=${item.rv} 已不存在`);
          return null;
        }
        if (err.name !== 'Conflict' || !err.current) throw err;
        this.conflictCount += 1;
        // 乐观重试：用服务器刚返回的 rv 再写一次；栅栏仍会拦住过期世代。
        view = this.server.update(err.current.key, err.current.rv, () => patch, { fence, actor: this.id });
      }
      this.cache.set(item.key, view);
      this.lastRv = Math.max(this.lastRv ?? 0, view.rv);
      this.workDone += 1;
      this.note('work', item.key, `推进到 ${view.data.done}/${view.data.total}${finish ? '，完成' : ''}`);
      if (finish) this.claims.delete(item.key);
      return view;
    } catch (err) {
      if (err.name === 'Fenced') {
        this.fencedCount += 1;
        this.claims.delete(item.key);
        const holder = err.current?.data;
        const to = holder ? `${holder.owner}@${holder.epoch}` : 'unknown';
        this.resolveHandoff(item.key, to, 'epoch 栅栏拒绝，明确交出');
        this.note('fenced', item.key, `写入被栅栏拒绝；${to} 已持有该任务`);
        return null;
      }
      this.note('work-error', item.key, `${err.name}: ${err.message}`);
      return null;
    }
  }

  // 旧实例重发一条断线前发出的创建指令
  retryCreate(key, data = {}) {
    try {
      const view = this.server.create(key, data, { epoch: this.epoch, actor: this.id });
      this.note('create', key, `创建成功 rv=${view.rv}`);
      return view;
    } catch (err) {
      this.note('create-rejected', key, `${err.name}: ${err.message}`);
      return null;
    }
  }

  // ---- 台账 ----

  yieldClaim(key, data, reason) {
    if (!this.claims.delete(key)) return;
    const to = data ? `${data.owner}@${data.epoch}` : 'none';
    this.resolveHandoff(key, to, reason);
    this.note('yield', key, `${reason}；交由 ${to}`);
  }

  resolveHandoff(key, to, reason) {
    const entry = [...this.ledger].reverse().find((e) => e.key === key && !e.resolved);
    if (entry) {
      entry.to = to;
      entry.reason = `${reason}（原：${entry.reason}）`;
      entry.resolved = true;
      entry.resolvedAt = this.server.clock;
    } else {
      this.ledger.push({ key, at: this.server.clock, to, reason, resolved: true, resolvedAt: this.server.clock });
    }
  }

  note(kind, key, text) {
    this.journal.push({ at: this.server.clock, rv: this.lastRv, kind, key, text });
  }

  get liveClaims() {
    return [...this.claims].filter((k) => {
      const item = this.cache.get(k);
      return item && item.data?.phase !== PHASE.DONE;
    });
  }

  snapshot() {
    return {
      id: this.id,
      epoch: this.epoch,
      strategy: this.strategy,
      standby: this.standby,
      online: this.online,
      lastRv: this.lastRv,
      claims: this.liveClaims,
      cache: [...this.cache.values()],
      journal: this.journal,
      ledger: this.ledger,
      fencedCount: this.fencedCount,
      conflictCount: this.conflictCount,
      workDone: this.workDone,
    };
  }
}
