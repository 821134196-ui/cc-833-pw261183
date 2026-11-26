// 本地模拟的 API Server：带版本号的任务资源存储，支持 list / watch / CAS 冲突。
//
// 三条语义，后面所有故障场景都建立在它们之上：
//   1. 每次写都推进全局 resourceVersion；事件按 rv 严格排序，不会有两件事同版本。
//   2. update / remove 必须携带基础 rv，不匹配抛 Conflict（附当前对象）。
//   3. 事件投递可以暂停：写照常提交进事件日志，但先排队；之后逐个（step）
//      或整批（resume）放行。排队顺序是版本顺序，但控制器不能假设自己按顺序收到。
//
// 另外两条防止幽灵资源的规则：
//   - 墓碑：删除时记下该 key 的 epoch；之后任何 epoch 不大于墓碑的 create 一律拒绝。
//     旧实例断线前发出的创建指令迟到时，不会把已经删除的对象复活。
//   - 单调应用：控制器只应用 rv 严格递增的事件，删除之后才到的创建事件被丢弃。

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export class ApiError extends Error {}

export class Conflict extends ApiError {
  constructor(current, rv) {
    super('resourceVersion conflict');
    this.name = 'Conflict';
    this.current = current;
    this.rv = rv;
  }
}

export class Fenced extends ApiError {
  constructor(current, reason) {
    super(reason || 'fencing token rejected');
    this.name = 'Fenced';
    this.current = current;
  }
}

export class StaleCreate extends ApiError {
  constructor(key, tombstoneEpoch) {
    super(`${key} 已在 epoch ${tombstoneEpoch} 被删除，迟到的 create 被墓碑拒绝`);
    this.name = 'StaleCreate';
    this.key = key;
    this.tombstoneEpoch = tombstoneEpoch;
  }
}

export class ApiServer {
  constructor({ tasks = [] } = {}) {
    this.rv = 0;
    this.clock = 0;
    this.objects = new Map(); // key -> { key, rv, deleted, data }
    this.tombstones = new Map(); // key -> { epoch, rv }
    this.events = []; // { rv, type, key, data, clock, deliveredTo:Set }
    this.subs = new Set();
    this.hold = false;
    this.changed = new Set();
    this.writeLog = []; // 每次成功写入：谁写的、写前/写后归谁

    for (const t of tasks) this.seedTask(t);
  }

  onChange(fn) {
    this.changed.add(fn);
    return () => this.changed.delete(fn);
  }

  _notify() {
    for (const fn of this.changed) fn();
  }

  // ---- 时间 ----

  advance(n = 1) {
    this.clock += n;
    this._notify();
    return this.clock;
  }

  // ---- 读 ----

  _view(obj) {
    if (!obj) return null;
    return { key: obj.key, rv: obj.rv, deleted: obj.deleted, data: clone(obj.data) };
  }

  list(prefix = '') {
    const items = [];
    for (const obj of this.objects.values()) {
      if (obj.deleted || !obj.key.startsWith(prefix)) continue;
      items.push(this._view(obj));
    }
    items.sort((a, b) => a.key.localeCompare(b.key));
    return { items, rv: this.rv, clock: this.clock };
  }

  get(key) {
    const obj = this.objects.get(key);
    return obj && !obj.deleted ? this._view(obj) : null;
  }

  // 种子资源：模拟「控制器启动前就已存在」的任务，不产生事件、不写日志
  seedTask({
    key,
    owner = null,
    epoch = 1,
    total = 3,
    done = 0,
    phase = 'pending',
    leaseUntil = 0,
    lineage = [],
  }) {
    this.rv += 1;
    this.objects.set(key, {
      key,
      rv: this.rv,
      deleted: false,
      data: { owner, epoch, total, done, phase, leaseUntil, lineage },
    });
    return this._view(this.objects.get(key));
  }

  // ---- 写 ----

  create(key, data = {}, { epoch = 0, actor = null } = {}) {
    const cur = this.objects.get(key);
    if (cur && !cur.deleted) throw new Conflict(this._view(cur), this.rv);
    const tomb = this.tombstones.get(key);
    if (tomb && epoch <= tomb.epoch) throw new StaleCreate(key, tomb.epoch);
    return this._commit('create', key, data, false, { actor });
  }

  update(key, baseRv, mutator, { fence = null, actor = null } = {}) {
    const cur = this.objects.get(key);
    if (!cur || cur.deleted) throw new Conflict(null, this.rv);
    if (baseRv != null && cur.rv !== baseRv) throw new Conflict(this._view(cur), this.rv);
    if (fence && (cur.data.owner !== fence.owner || cur.data.epoch !== fence.epoch)) {
      throw new Fenced(
        this._view(cur),
        `epoch ${fence.epoch} 已失效，当前持有者 ${cur.data.owner ?? '无主'}@${cur.data.epoch}`,
      );
    }
    const next = mutator(clone(cur.data), this._view(cur));
    if (next === undefined) throw new Error('update mutator 必须返回新数据');
    return this._commit('update', key, next, false, { actor });
  }

  remove(key, baseRv = null, { actor = null } = {}) {
    const cur = this.objects.get(key);
    if (!cur || cur.deleted) return null; // 幂等
    if (baseRv != null && cur.rv !== baseRv) throw new Conflict(this._view(cur), this.rv);
    const tomb = this.tombstones.get(key);
    const epoch = Math.max(tomb?.epoch ?? 0, cur.data?.epoch ?? 0);
    this.tombstones.set(key, { epoch, rv: this.rv + 1 });
    return this._commit('delete', key, null, true, { actor, tombstoneEpoch: epoch });
  }

  _commit(type, key, data, deleted, meta = {}) {
    const before = this.objects.get(key)?.data ?? null;
    this.rv += 1;
    const obj = { key, rv: this.rv, deleted, data: clone(data) };
    this.objects.set(key, obj);
    this.writeLog.push({
      key,
      type,
      rv: obj.rv,
      clock: this.clock,
      actor: meta.actor,
      ownerBefore: before?.owner ?? null,
      ownerAfter: data?.owner ?? null,
      epochBefore: before?.epoch ?? null,
      epochAfter: data?.epoch ?? null,
      doneBefore: before?.done ?? null,
      doneAfter: data?.done ?? null,
      tombstoneEpoch: meta.tombstoneEpoch ?? null,
    });
    const ev = {
      rv: obj.rv,
      type,
      key,
      data: clone(data),
      clock: this.clock,
      deliveredTo: new Set(),
    };
    this.events.push(ev);
    for (const sub of this.subs) sub.offer(ev);
    this._notify();
    return this._view(obj);
  }

  // ---- watch ----

  watch({ sinceRv = null, onEvent, id = 'sub' } = {}) {
    const start = sinceRv == null ? this.rv : Number(sinceRv);
    const sub = { id, cursor: start, queue: [], onEvent, closed: false };
    sub.offer = (ev) => {
      if (sub.closed || ev.rv <= sub.cursor) return;
      if (this.hold) {
        sub.queue.push(ev);
        return;
      }
      sub.cursor = ev.rv;
      ev.deliveredTo.add(sub.id);
      sub.onEvent(ev);
    };
    this.subs.add(sub);
    // 从旧版本订阅时重放历史；重放同样遵守暂停开关
    for (const ev of this.events) if (ev.rv > start) sub.offer(ev);
    return {
      id,
      get cursor() {
        return sub.cursor;
      },
      get pending() {
        return sub.queue.length;
      },
      close: () => {
        sub.closed = true;
        this.subs.delete(sub);
      },
    };
  }

  // ---- 投递控制 ----

  pause() {
    this.hold = true;
    this._notify();
  }

  resume() {
    this.hold = false;
    let guard = 0;
    while (this.pending > 0 && guard++ < 10000) this.step();
    this._notify();
  }

  // 放行一个版本的事件。
  //   forId       只投给这个订阅者（页面里「单步切换控制器」）
  //   newestFirst 挑版本号最大的事件投递，用来制造乱序
  //   rv          明确指定要放行的版本（页面点某一行事件）
  // 不指定 rv 时默认投版本号最小的那个，跨控制器保持同步推进。
  step({ forId = null, newestFirst = false, rv = null } = {}) {
    const pool = [...this.subs].filter(
      (s) => !s.closed && s.queue.length && (forId == null || s.id === forId),
    );
    let pick = null;
    if (rv != null) {
      pick = { rv };
    } else {
      for (const sub of pool) {
        for (const ev of sub.queue) {
          if (!pick || (newestFirst ? ev.rv > pick.rv : ev.rv < pick.rv)) pick = ev;
        }
      }
    }
    if (!pick) return null;
    let delivered = null;
    for (const sub of pool) {
      const i = sub.queue.findIndex((e) => e.rv === pick.rv);
      if (i === -1) continue;
      const [ev] = sub.queue.splice(i, 1);
      sub.cursor = Math.max(sub.cursor, ev.rv);
      ev.deliveredTo.add(sub.id);
      sub.onEvent(ev);
      delivered = ev;
    }
    this._notify();
    return delivered;
  }

  get pending() {
    let n = 0;
    for (const sub of this.subs) if (!sub.closed) n += sub.queue.length;
    return n;
  }

  get paused() {
    return this.hold;
  }

  // 某个事件投给了谁（页面用）
  deliveryOf(ev) {
    return [...ev.deliveredTo];
  }

  // 每个任务最终记在服务器上的持有者
  finalHolders() {
    const out = [];
    for (const obj of this.objects.values()) {
      if (obj.deleted) continue;
      out.push({
        key: obj.key,
        rv: obj.rv,
        owner: obj.data?.owner ?? null,
        epoch: obj.data?.epoch ?? null,
        phase: obj.data?.phase ?? null,
        done: obj.data?.done ?? 0,
        total: obj.data?.total ?? 0,
      });
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  }
}
