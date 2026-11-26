// 命令行版断线检验：npm run drill
// 两种交接策略跑同一套故障脚本，打印最终持有者、旧实例的活去了哪里、审计结论。
import { buildWorld } from '../src/drill.js';
import { audit } from '../src/invariants.js';

const pad = (s, n) => String(s).padEnd(n);

for (const strategy of ['takeover', 'wait']) {
  for (const oldReturns of [true, false]) {
    const world = buildWorld(strategy, { oldReturns });
    const verdict = audit({ server: world.server, controllers: world.controllers });
    const m = world.summary();
    console.log(`\n=== ${strategy} · 旧实例${oldReturns ? '重新上线' : '永不回来'} ===`);
    console.log(`事件乱序顺序：${m.outOfOrder.join(' → ')}`);
    console.log(`最终持有者：`);
    for (const h of world.server.finalHolders()) {
      const live = m.finalized.find((f) => f.key === h.key)?.ownerLive;
      console.log(
        `  ${pad(h.key, 12)} ${pad(h.owner ?? '无主', 8)} epoch=${h.epoch ?? '-'} ` +
          `${h.done}/${h.total} ${h.phase}${h.phase === 'done' ? '' : live ? '（在线）' : '（无人执行）'}`,
      );
    }
    console.log(`旧实例断线时的活：${m.handoffDestinations.map((d) => `${d.key}→${d.to}`).join('，')}`);
    console.log(
      `栅栏拦截 ${m.fenced} · 冲突重试 ${m.conflicts} · 完成 ${m.workDone} 格 · ` +
        `复活 ${m.ghostResurrected ? '有' : '无'} · 多持有者快照 ${m.multiOwnerWindows.length}`,
    );
    console.log(verdict.ok ? '审计：通过 ✓' : `审计：不通过 ✗\n  - ${verdict.violations.join('\n  - ')}`);
  }
}

console.log('\n结论：同一套断线脚本里，takeover 总能保证每个任务恰好有一个在线所有者；');
console.log('      wait 在旧实例不回来时会把活留在离线实例名下——归属还在，但没有执行者。');
