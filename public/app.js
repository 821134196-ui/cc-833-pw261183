import { ApiServer } from '/src/apiserver.js';
import { Controller } from '/src/controller.js';
import { audit } from '/src/invariants.js';
import { buildWorld } from '/src/drill.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid.nodeType ? kid : document.createTextNode(kid));
  return node;
};

const OWNER_COLORS = { old: 'var(--series-1)', new: 'var(--series-2)' };
const ownerColor = (id) => OWNER_COLORS[id] ?? 'var(--ink-3)';
const phaseLabel = { pending: '待处理', running: '进行中', done: '已完成' };

function groupByKey(events) {
  const map = new Map();
  for (const ev of events) {
    if (!map.has(ev.key)) map.set(ev.key, []);
    map.get(ev.key).push(ev);
  }
  return map;
}

// ---------------- 实时沙盘 ----------------

const state = {
  strategy: 'takeover',
  oldReturns: true,
  server: null,
  controllers: [],
  selected: 'old',
  lastAction: null,
  lastFlash: null,
};

function resetSandbox() {
  const server = new ApiServer({
    tasks: [
      { key: 'task/a', owner: 'old', epoch: 1, total: 4, done: 1, phase: 'running', leaseUntil: 0, lineage: ['old@1'] },
      { key: 'task/b', owner: 'old', epoch: 1, total: 3, done: 1, phase: 'running', leaseUntil: 0, lineage: ['old@1'] },
    ],
  });
  const old = new Controller({ id: 'old', epoch: 1, server, strategy: state.strategy });
  // 新实例先不上线：让它从“旧检查点”上线，才能复现“先读到删除、后读到迟到的创建”
  const fresh = new Controller({ id: 'new', epoch: 2, server, strategy: state.strategy });
  state.server = server;
  state.controllers = [old, fresh];
  state.selected = 'old';
  state.lastAction = '初始：task/a、task/b 归 old@1；新实例尚未上线';
  state.lastFlash = null;

  old.start();
  render();
}

// ---------------- 渲染 ----------------

function render() {
  if (!state.server) return;
  renderVerdict();
  renderEvents();
  renderHolders();
  renderCards();
  renderLedger();
  renderJournal();
}

function liveControllers() {
  return state.controllers.filter((c) => c.online);
}

function taskRows() {
  const live = liveControllers();
  return state.server.finalHolders().map((h) => {
    const claimants = live.filter((c) => c.claims.has(h.key) && c.cache.get(h.key)?.data?.phase !== 'done');
    const ownerLive = h.owner != null && live.some((c) => c.id === h.owner && c.epoch === h.epoch);
    return { ...h, claimants: claimants.map((c) => c.id), ownerLive };
  });
}

function renderVerdict() {
  const rows = taskRows();
  const active = rows.filter((r) => r.phase !== 'done');
  const multi = active.filter((r) => r.claimants.length > 1);
  const zero = active.filter((r) => !r.ownerLive && r.claimants.length === 0);
  // 复活 = 删除之后又出现同 key 的 create；删除之前的那次创建是正常的
  const ghostResurrections = [];
  for (const [key, evs] of groupByKey(state.server.events)) {
    let deletedAt = null;
    for (const ev of evs) {
      if (ev.type === 'delete') deletedAt = ev.rv;
      else if (ev.type === 'create' && deletedAt != null) ghostResurrections.push({ key, at: ev.rv });
    }
  }
  const unresolved = state.controllers.flatMap((c) => (c.online ? c.ledger.filter((e) => !e.resolved) : []));

  let tone = 'good';
  let text = '每个未完成任务都恰好有一个在线持有者';
  if (multi.length) { tone = 'critical'; text = `${multi.length} 个任务被多个在线实例同时持有`; }
  else if (zero.length) { tone = 'serious'; text = `${zero.length} 个任务在服务器上有归属，但持有者不在线`; }
  else if (unresolved.length) { tone = 'warning'; text = `${unresolved.length} 项交接还没有归宿`; }
  if (ghostResurrections.length) { tone = 'critical'; text += ` · 有 ${ghostResurrections.length} 个已删除对象被复活`; }

  const icon = { good: '✓', warning: '!', serious: '!', critical: '✕' }[tone];
  const color = { good: 'var(--good)', warning: 'var(--warning)', serious: 'var(--serious)', critical: 'var(--critical)' }[tone];

  $('#verdict').replaceChildren(
    el('div', { class: 'big' },
      el('span', {
        class: 'mono',
        style: `display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:${color};color:#fff;font-size:12px`,
        text: icon,
      }),
      el('span', { text }),
    ),
    el('div', { class: 'metrics' },
      el('span', {}, '在线实例 ', el('b', { text: String(liveControllers().length) })),
      el('span', {}, '未完成任务 ', el('b', { text: String(active.length) })),
      el('span', {}, '多持有者 ', el('b', { text: String(multi.length) })),
      el('span', {}, '排队事件 ', el('b', { text: String(state.server.pending) })),
      el('span', {}, '栅栏拦截 ', el('b', { text: String(state.controllers.reduce((n, c) => n + c.fencedCount, 0)) })),
      el('span', { class: 'muted', text: state.lastAction ?? '' }),
    ),
  );
}

function renderEvents() {
  $('#serverRv').textContent = `rv=${state.server.rv} · clock=${state.server.clock}`;
  const pauseBtn = $('#pauseBtn');
  pauseBtn.textContent = state.server.paused ? '恢复投递' : '暂停投递';
  pauseBtn.setAttribute('aria-pressed', String(state.server.paused));
  const pendingPill = $('#pendingPill');
  pendingPill.textContent = `排队 ${state.server.pending}`;
  pendingPill.classList.toggle('hot', state.server.pending > 0);

  const subs = state.server.subs;
  const tbody = $('#eventTable tbody');
  const events = [...state.server.events].reverse();
  if (!events.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'muted', style: 'padding:16px 8px', text: '还没有事件。用上面的「故障注入」发一条，或在控制器卡片上「干一格」。' })));
    return;
  }
  tbody.replaceChildren(
    ...events.map((ev) => {
      const queuedFor = [...subs].filter((s) => !s.closed && s.queue.some((q) => q.rv === ev.rv));
      const delivered = [...ev.deliveredTo];
      const isFlash = state.lastFlash === ev.rv;
      const tr = el('tr', { class: queuedFor.length ? 'queued' : isFlash ? 'just-delivered' : '' },
        el('td', { class: 'mono num', text: String(ev.rv) }),
        el('td', {}, el('span', { class: `ev-type ev-${ev.type}`, text: ev.type })),
        el('td', { class: 'mono', text: ev.key }),
        el('td', { class: 'mono num muted', text: String(ev.clock) }),
        el('td', {},
          delivered.length
            ? delivered.map((id) => el('span', { class: `chip ${id}`, text: id }))
            : el('span', { class: 'muted', text: '—' }),
        ),
        el('td', {},
          queuedFor.length
            ? queuedFor.map((s) =>
                el('button', {
                  class: 'step-btn',
                  title: `只投给 ${s.id}`,
                  text: `投给 ${s.id}`,
                  onclick: () => {
                    state.server.step({ forId: s.id, rv: ev.rv });
                    state.lastFlash = ev.rv;
                    state.lastAction = `仅向 ${s.id} 投递 rv=${ev.rv}（${ev.type} ${ev.key}）`;
                    render();
                  },
                }),
              )
            : null,
        ),
      );
      return tr;
    }),
  );
}

function renderHolders() {
  const rows = taskRows();
  const strip = $('#holderStrip');
  strip.replaceChildren(
    ...rows.map((r) => {
      const who = r.owner ?? '无主';
      return el('div', {
        class: 'holder-seg',
        style: `flex:${Math.max(1, r.total)};background:color-mix(in srgb, ${ownerColor(r.owner)} 16%, transparent);border-left-color:${ownerColor(r.owner)}`,
        title: `${r.key} · ${who}@${r.epoch} · ${r.done}/${r.total}`,
        text: `${r.key.replace('task/', '')} ${r.done}/${r.total}`,
      });
    }),
  );

  const tbody = $('#holderTable tbody');
  tbody.replaceChildren(
    ...rows.map((r) => {
      const count = r.claimants.length;
      const bad = count > 1 || (!r.ownerLive && r.phase !== 'done');
      return el('tr', {},
        el('td', { class: 'mono', text: r.key }),
        el('td', {},
          el('span', {
            class: 'mono',
            style: `color:${ownerColor(r.owner)}`,
            text: r.owner ? `${r.owner}@${r.epoch}` : '无主',
          }),
          r.owner && !r.ownerLive ? el('span', { class: 'muted', text: ' · 离线' }) : null,
        ),
        el('td', { class: 'mono num', text: r.epoch == null ? '—' : String(r.epoch) }),
        el('td', { class: 'num' }, `${r.done}/${r.total}`,
          el('div', {
            style: 'height:4px;border-radius:2px;background:var(--grid);margin-top:4px;overflow:hidden',
          }, el('div', {
            style: `height:100%;width:${Math.round((r.done / Math.max(1, r.total)) * 100)}%;background:${ownerColor(r.owner)};border-radius:2px`,
          })),
        ),
        el('td', {}, el('span', { class: 'status' },
          el('span', {
            style: `color:${r.phase === 'done' ? 'var(--good)' : r.ownerLive ? 'var(--series-1)' : 'var(--serious)'}`,
            text: r.phase === 'done' ? '✓' : r.ownerLive ? '●' : '!',
          }),
          ` ${phaseLabel[r.phase] ?? r.phase}${r.phase !== 'done' && !r.ownerLive ? '（无人执行）' : ''}`,
        )),
        el('td', {},
          el('span', { class: `owner-count ${count > 1 ? 'bad' : count === 0 && r.phase !== 'done' ? 'warn' : ''}`, text: String(count) }),
        ),
      );
    }),
  );
}

function renderCards() {
  const wrap = $('#cards');
  wrap.replaceChildren(
    ...state.controllers.map((c) => {
      const isSel = state.selected === c.id;
      const live = c.online;
      const dot = !live ? 'off' : c.standby ? 'idle' : 'on';
      return el('button', {
        class: 'card',
        'aria-pressed': String(isSel),
        onclick: () => { state.selected = c.id; render(); },
      },
        el('div', { class: 'row' },
          el('div', { class: 'name' },
            el('span', { class: `dot ${dot}` }),
            `${c.id}@${c.epoch}`,
            c.standby ? el('span', { class: 'chip', text: '待命' }) : null,
            state.strategy === 'wait' ? el('span', { class: 'chip', text: '不抢占' }) : null,
          ),
          el('div', { class: 'meta mono', text: `rv ${c.lastRv ?? '—'}` }),
        ),
        el('div', { class: 'meta', text: live ? `在线 · 持有 ${c.liveClaims.length} · 完成 ${c.workDone} 格` : '离线 · 台账等待归宿' }),
        el('div', { class: 'claims' },
          c.liveClaims.map((k) => el('span', { class: 'chip', style: `color:${ownerColor(c.id)};border-color:${ownerColor(c.id)}`, text: k.replace('task/', '') })),
          c.fencedCount ? el('span', { class: 'chip', style: 'color:var(--critical);border-color:var(--critical)', text: `栅栏 ${c.fencedCount}` }) : null,
        ),
        el('div', { class: 'transport', style: 'margin-top:8px' },
          !live
            ? el('button', { class: 'step-btn', text: '上线', onclick: (e) => { e.stopPropagation(); startController(c); } })
            : el('button', { class: 'step-btn', text: '断线', onclick: (e) => { e.stopPropagation(); disconnectController(c); } }),
          live && !c.standby ? el('button', { class: 'step-btn', text: '协调一次', onclick: (e) => { e.stopPropagation(); act(c, 'reconcile'); } }) : null,
          live && !c.standby ? el('button', { class: 'step-btn', text: '干一格', onclick: (e) => { e.stopPropagation(); act(c, 'work'); } }) : null,
          c.standby ? el('button', { class: 'step-btn', text: '提升为活跃', onclick: (e) => { e.stopPropagation(); act(c, 'activate'); } }) : null,
        ),
      );
    }),
  );
}

function startController(c) {
  if (c.claims.size || c.lastRv != null) c.reconnect();
  else c.start();
  state.lastAction = `${c.id} 上线`;
  render();
}

function disconnectController(c) {
  c.disconnect('手动断线');
  state.lastAction = `${c.id} 断线，${c.ledger.filter((e) => !e.resolved).length} 项交接待归宿`;
  render();
}

function act(c, kind) {
  if (kind === 'reconcile') c.reconcile();
  if (kind === 'work') {
    const v = c.workOne();
    state.lastAction = v ? `${c.id} 推进 ${v.key} → ${v.data.done}/${v.data.total}` : `${c.id} 没有可推进的任务`;
  }
  if (kind === 'activate') { c.activate(); state.lastAction = `${c.id} 提升为活跃并重新列举`; }
  if (kind === 'retryCreate') {
    const v = c.retryCreate('task/ghost', { owner: c.id, epoch: c.epoch, total: 1, done: 0, phase: 'running', leaseUntil: 0, lineage: [] });
    state.lastAction = v ? `${c.id} 创建 task/ghost rv=${v.rv}` : `${c.id} 的迟到创建被拒绝`;
  }
  render();
}

function renderLedger() {
  const c = state.controllers.find((x) => x.id === state.selected);
  $('#ledgerWho').textContent = c ? `${c.id}@${c.epoch}` : '';
  $('#journalWho').textContent = c ? `${c.id}@${c.epoch}` : '';
  const list = $('#ledgerList');
  if (!c || !c.ledger.length) {
    list.replaceChildren(el('li', {}, el('span', { class: 'muted', text: c?.online ? '没有断线记录' : '离线实例的本地台账不可作证（可能已过期）' })));
    return;
  }
  list.replaceChildren(
    ...c.ledger.map((e) =>
      el('li', {},
        el('span', {}, el('b', { class: 'mono', text: e.key }), ` · ${e.reason}`),
        el('span', { class: e.resolved ? 'to ok' : 'to bad', text: e.resolved ? `→ ${e.to}` : '→ 未决' }),
      ),
    ),
  );
}

function renderJournal() {
  const c = state.controllers.find((x) => x.id === state.selected);
  const list = $('#journalList');
  if (!c) return;
  list.replaceChildren(
    ...c.journal.slice(-40).reverse().map((j) =>
      el('li', {},
        el('span', { class: 'k', text: `t${j.at}` }),
        el('span', { class: 'k', text: `rv${j.rv ?? '—'}` }),
        el('span', { class: `kind ${j.kind}`, text: j.kind }),
        el('span', { text: j.text }),
      ),
    ),
  );
}

// ---------------- 时序回放（同一个 drill） ----------------

const replay = { steps: [], index: 0 };

function loadReplay() {
  const world = buildWorld(state.strategy, { oldReturns: state.oldReturns });
  replay.steps = world.steps;
  replay.index = world.steps.length - 1;
  renderTimeline();
}

function renderTimeline() {
  const wrap = $('#timeline');
  wrap.replaceChildren(
    ...replay.steps.map((s, i) => {
      const marks = s.tasks.map((t) => {
        const count = t.liveClaimants.length;
        const zero = t.phase !== 'done' && !t.ownerLive && count === 0;
        const bg = t.owner ? `color-mix(in srgb, ${ownerColor(t.owner)} 22%, transparent)` : 'var(--grid)';
        return el('div', {
          class: `mark ${zero ? 'zero' : ''} ${count > 1 ? 'multi' : ''}`,
          style: `background:${bg};color:${ownerColor(t.owner)}`,
          title: `${t.key} · ${t.owner ?? '无主'}@${t.epoch ?? '-'} · ${phaseLabel[t.phase]} · 在线持有者 ${count}`,
          text: t.key.replace('task/', ''),
        });
      });
      return el('button', {
        class: `step-cell ${i === replay.index ? 'now' : ''}`,
        style: 'background:transparent;text-align:left;cursor:pointer',
        onclick: () => { replay.index = i; renderTimeline(); },
        title: `rv=${s.rv} · 排队 ${s.pending}`,
      },
        el('div', { class: 'lbl', text: s.label }),
        el('div', { class: 'lbl', text: `rv${s.rv} · ${s.paused ? `排队${s.pending}` : '投递中'}` }),
        el('div', { class: 'marks' }, marks),
      );
    }),
  );
}

// ---------------- 对比 ----------------

function renderCompare() {
  const wrap = $('#compare');
  const cards = ['takeover', 'wait'].map((strategy) => {
    const world = buildWorld(strategy, { oldReturns: state.oldReturns });
    const verdict = audit({ server: world.server, controllers: world.controllers });
    const m = world.summary();
    const ok = verdict.ok && m.stranded.length === 0 && m.zeroOwnerWindows.length === 0 && m.multiOwnerWindows.length === 0 && !m.ghostResurrected && m.handoffUnresolved === 0;
    const fates = m.handoffDestinations
      .map((d) => `${d.key.replace('task/', '')}→${d.to === 'stranded' ? '悬空' : d.to === 'deleted' ? '已删除' : d.to}`)
      .join('，') || '无';
    const checks = [
      [m.ghostResurrected === false, '迟到的创建没有复活已删除的对象'],
      [verdict.facts.doubleWork.length === 0, '没有任何一次推进由非持有者完成'],
      [m.multiOwnerWindows.length === 0, m.multiOwnerWindows.length ? `${m.multiOwnerWindows.length} 个快照里出现多个在线持有者` : '任何时刻都没有两个在线持有者'],
      [m.zeroOwnerWindows.length === 0, m.zeroOwnerWindows.length ? `接管后有 ${m.zeroOwnerWindows.length} 个快照里任务无人持有` : '接管后每个未完成任务都立即有在线持有者'],
      [m.stranded.length === 0, m.stranded.length ? `结束时 ${m.stranded.length} 个任务留在离线实例名下` : '结束时未完成任务全部有在线持有者'],
      [m.handoffUnresolved === 0, m.handoffUnresolved ? `旧实例有 ${m.handoffUnresolved} 个活仍无归宿` : '旧实例断线时的活都有明确归宿'],
    ];
    return el('div', { class: `cmp-card ${ok ? 'pass' : 'fail'}` },
      el('h3', {}, strategy === 'takeover' ? '接管 · takeover' : '直接等待 · wait',
        el('span', { class: 'badge', text: ok ? '有且只有一个所有者' : '不满足「有且只有一个」' })),
      el('div', { class: 'muted', style: 'font-size:12px', text: `栅栏拦截 ${m.fenced} · 冲突重试 ${m.conflicts} · 完成 ${m.workDone} 格 · 旧实例的活：${fates}` }),
      el('ul', {}, ...checks.map(([pass, text]) =>
        el('li', { class: pass ? 'pass' : 'fail', text: `${pass ? '✓' : '✕'} ${text}` }),
      )),
    );
  });
  wrap.replaceChildren(...cards);
}

// ---------------- 故障注入 ----------------

// 这些按钮对应 drill.js 里的时序，但改由用户手动触发，方便在页面上一点点复现。
function inject(kind) {
  const { server, controllers } = state;
  const old = controllers.find((c) => c.id === 'old');
  const fresh = controllers.find((c) => c.id === 'new');
  try {
    // 手动注入时默认先暂停：不然事件会立即投递，就看不到“排队”和乱序了
    if (kind !== 'new-online' && !server.paused) {
      server.pause();
      state.lastAction = '已自动暂停投递；写入只排队，事件等新实例上线后再放行';
    }
    if (kind === 'create-ghost') {
      const v = old.retryCreate('task/ghost', {
        owner: 'old', epoch: 1, total: 1, done: 0, phase: 'running', leaseUntil: 0, lineage: ['old@1'],
      });
      state.lastAction = v ? `旧实例在暂停期间发出 create task/ghost，rv=${v.rv} 已进队列` : 'create 被拒绝';
    }
    if (kind === 'delete-ghost') {
      const cur = server.get('task/ghost');
      if (!cur) { state.lastAction = 'task/ghost 不存在'; }
      else { server.remove('task/ghost', cur.rv, { actor: 'admin' }); state.lastAction = '删除 task/ghost（留下墓碑）'; }
    }
    if (kind === 'delete-b') {
      const cur = server.get('task/b');
      if (!cur) state.lastAction = 'task/b 不存在';
      else { server.remove('task/b', cur.rv, { actor: 'admin' }); state.lastAction = '删除 task/b'; }
    }
    if (kind === 'create-c') {
      server.create('task/c', { owner: null, epoch: 1, total: 2, done: 0, phase: 'pending', leaseUntil: 0, lineage: [] }, { epoch: 1, actor: 'admin' });
      state.lastAction = '新建 task/c（无主，等待领取）';
    }
    if (kind === 'new-online') {
      if (fresh.online) { state.lastAction = '新实例已经在线'; render(); return; }
      // 从旧实例断线时的检查点续订，不列举
      const checkpoint = old.lastRv ?? 2;
      fresh.start({ sinceRv: checkpoint });
      state.lastAction = `新实例从 rv=${checkpoint} 续订（未列举）；队列里同时有旧 create 和新 delete`;
    }
  } catch (err) {
    state.lastAction = `注入失败：${err.name}: ${err.message}`;
  }
  render();
}

document.querySelectorAll('[data-inject]').forEach((btn) => {
  btn.addEventListener('click', () => inject(btn.dataset.inject));
});

// ---------------- 按题目时序自动播放 ----------------

let playing = false;

async function playScript() {
  if (playing) return;
  playing = true;
  const btn = $('#playScript');
  btn.disabled = true;
  resetSandbox();
  const { server } = state;
  const old = state.controllers.find((c) => c.id === 'old');
  const fresh = state.controllers.find((c) => c.id === 'new');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // 1. 暂停投递
    server.pause();
    const checkpoint = old.lastRv;
    state.lastAction = '① 暂停事件投递：之后的写入只排队';
    render();
    await wait(900);

    // 2. 旧实例发出创建指令，然后断线
    old.retryCreate('task/ghost', { owner: 'old', epoch: 1, total: 1, done: 0, phase: 'running', leaseUntil: 0, lineage: ['old@1'] });
    old.disconnect('计划重启');
    state.lastAction = '② 旧实例发出 create task/ghost 后断线；事件仍在队列';
    render();
    await wait(1100);

    // 3. 管理员删除 ghost、删除 b、新建 c
    server.remove('task/ghost', server.get('task/ghost').rv, { actor: 'admin' });
    server.remove('task/b', server.get('task/b').rv, { actor: 'admin' });
    server.create('task/c', { owner: null, epoch: 1, total: 2, done: 0, phase: 'pending', leaseUntil: 0, lineage: [] }, { epoch: 1, actor: 'admin' });
    state.lastAction = '③ 管理员删除 ghost、删除 task/b、新建 task/c';
    render();
    await wait(1100);

    // 4. 新实例从旧检查点上线（不列举）
    fresh.start({ sinceRv: checkpoint });
    state.lastAction = `④ 新实例从 rv=${checkpoint} 续订，未列举——它还不知道服务器已经变了`;
    render();
    await wait(1100);

    // 5. 先投删除、再投更旧的创建
    const ghostCreate = server.events.find((e) => e.type === 'create' && e.key === 'task/ghost');
    const ghostDelete = server.events.find((e) => e.type === 'delete' && e.key === 'task/ghost');
    for (const ev of [ghostDelete, ghostCreate]) {
      if (!ev) continue;
      server.step({ forId: 'new', rv: ev.rv });
      state.lastFlash = ev.rv;
      state.lastAction = `⑤ 只投给新实例：rv=${ev.rv} ${ev.type} ${ev.key}`;
      render();
      await wait(1000);
    }
    state.lastAction = '⑤ 新实例先读到删除、后读到更旧的创建；版本号让它丢弃后者，ghost 没有复活';
    render();
    await wait(1300);

    // 6. 新实例列举并接管
    fresh.reconcile();
    state.lastAction = '⑥ 新实例列举并接管 task/a、task/c';
    render();
    await wait(1100);

    // 7. 旧实例回归，带着过期缓存写入
    if (state.oldReturns) {
      old.reconnect();
      old.workOne();
      old.retryCreate('task/ghost', { owner: 'old', epoch: 1, total: 1, done: 0, phase: 'running', leaseUntil: 0, lineage: ['old@1'] });
      old.resync();
      state.lastAction = state.strategy === 'takeover'
        ? '⑦ 旧实例回归：写入被 epoch 栅栏拒绝，task/a 的归宿记入台账'
        : '⑦ 旧实例回归：直接等待策略下它自己收回 task/a';
      render();
      await wait(1300);
    }

    // 8. 放完队列并干活
    server.resume();
    let guard = 0;
    while (guard++ < 60) {
      const a = old.online ? old.workOne() : null;
      const b = fresh.workOne();
      if (!a && !b) break;
    }
    state.lastAction = '⑧ 事件放完，两个实例各自推进；对比下方最终持有者与台账';
    state.lastFlash = null;
    render();
    await wait(600);
    $('#holdersPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } finally {
    playing = false;
    btn.disabled = false;
  }
}

$('#playScript').addEventListener('click', playScript);

// ---------------- 绑定 ----------------

document.querySelectorAll('[data-strategy]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.strategy = btn.dataset.strategy;
    document.querySelectorAll('[data-strategy]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    resetSandbox();
    loadReplay();
    renderCompare();
  });
});

$('#oldReturns').addEventListener('change', (e) => {
  state.oldReturns = e.target.checked;
  loadReplay();
  renderCompare();
});

$('#reset').addEventListener('click', () => {
  resetSandbox();
  loadReplay();
  renderCompare();
});

$('#runAll').addEventListener('click', () => {
  resetSandbox();
  loadReplay();
  renderCompare();
  $('#comparePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#pauseBtn').addEventListener('click', () => {
  if (state.server.paused) { state.server.resume(); state.lastAction = '恢复投递，队列清空'; }
  else { state.server.pause(); state.lastAction = '暂停投递：写入照常提交，事件只排队'; }
  state.lastFlash = null;
  render();
});

$('#stepBtn').addEventListener('click', () => {
  const ev = state.server.step();
  state.lastAction = ev ? `单步放行 rv=${ev.rv}（${ev.type} ${ev.key}）` : '队列为空';
  state.lastFlash = ev?.rv ?? null;
  render();
});

$('#resumeBtn').addEventListener('click', () => {
  state.server.resume();
  state.lastAction = '全部放行';
  state.lastFlash = null;
  render();
});

// 键盘：空格暂停/继续，n 单步
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, button')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#pauseBtn').click(); }
  if (e.key === 'n') { e.preventDefault(); $('#stepBtn').click(); }
});

resetSandbox();
loadReplay();
renderCompare();

// 供页面内调试与自动化测试使用
window.__sandbox = { state, inject, render, buildWorld, audit };
