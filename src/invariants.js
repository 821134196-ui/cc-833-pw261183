// 不变量审计。判定只看服务器端的写入日志和最终状态，不看控制器自己的说法 ——
// 控制器可以以为自己持有活，但只有服务器接受的写入算数。
//
// 判定标准（“有且只有一个资源所有者”）：
//   live-owner   每个未完成的任务，服务器上记的持有者必须是一个「在线」的控制器，
//                且在线控制器里恰有一个声称持有它。offline 实例名下的活不算有人执行。
//   no-double    任意一次推进工作量的 accepted 写入，写前/写后持有者与写作者三者一致。
//   no-epoch-regress  同一个 key 被接受的写入，epoch 不得回退。
//   no-resurrection   delete 之后不允许再出现同 key 的 create 事件（迟到创建的复活）。
//   ledger-resolved   在线控制器的台账里不能有未决项；离线实例的本地台账不可用，不计入。
//   no-orphan    收尾时不能有“存在且未完成、却没有在线持有者”的资源。

export function audit({ server, controllers }) {
  const violations = [];
  const live = controllers.filter((c) => c.online);
  const liveById = new Map(live.map((c) => [c.id, c]));
  const facts = {
    workWrites: 0,
    resurrected: [],
    doubleWork: [],
    epochRegress: [],
    orphaned: [],
    unresolvedLedger: [],
    liveOwners: {},
  };

  // --- epoch 不得回退 ---
  const maxEpoch = new Map();
  for (const w of server.writeLog) {
    if (w.ownerAfter == null) continue;
    const prev = maxEpoch.get(w.key);
    if (prev != null && w.epochAfter < prev) {
      facts.epochRegress.push(w);
      violations.push(`epoch 回退：${w.key} 接受 epoch ${w.epochAfter} 的写入，之前已是 ${prev}`);
    }
    maxEpoch.set(w.key, Math.max(prev ?? -Infinity, w.epochAfter));
  }

  // --- 双写：推进工作量的写入必须由持有者本人完成 ---
  for (const w of server.writeLog) {
    if (w.type !== 'update') continue;
    if (!(w.doneAfter > w.doneBefore)) continue;
    facts.workWrites += 1;
    const writer = w.actor ?? w.ownerAfter;
    if (w.ownerBefore !== w.ownerAfter || w.ownerAfter !== writer || w.epochBefore !== w.epochAfter) {
      facts.doubleWork.push(w);
      violations.push(
        `双写：${w.key} 的推进由 ${writer} 完成，但持有者从 ${w.ownerBefore}@${w.epochBefore} 变为 ${w.ownerAfter}@${w.epochAfter}`,
      );
    }
  }

  // --- 复活 ---
  const byKey = new Map();
  for (const ev of server.events) {
    if (!byKey.has(ev.key)) byKey.set(ev.key, []);
    byKey.get(ev.key).push(ev);
  }
  for (const [key, evs] of byKey) {
    let deletedAt = null;
    for (const ev of evs) {
      if (ev.type === 'delete') deletedAt = ev.rv;
      else if (ev.type === 'create' && deletedAt != null) {
        facts.resurrected.push({ key, deleteRv: deletedAt, createRv: ev.rv });
        violations.push(`复活：${key} 在 rv=${deletedAt} 删除后又出现 rv=${ev.rv} 的 create`);
      }
    }
  }

  // --- 在线持有者唯一 ---
  const claimsByKey = new Map(); // key -> [controllerId]（仅在线）
  for (const c of live) {
    for (const key of c.claims) {
      const item = c.cache.get(key);
      if (!item || item.data?.phase === 'done') continue;
      if (!claimsByKey.has(key)) claimsByKey.set(key, []);
      claimsByKey.get(key).push(c.id);
    }
  }

  for (const item of server.finalHolders()) {
    if (item.phase === 'done') continue;
    const claimants = claimsByKey.get(item.key) ?? [];
    const ownerIsLive = item.owner != null && liveById.has(item.owner) &&
      server.get(item.key)?.data?.epoch === liveById.get(item.owner).epoch;
    if (!ownerIsLive) {
      facts.orphaned.push(item);
      violations.push(
        `无活持有者：${item.key} 在服务器上归 ${item.owner ?? '(无主)'}@${item.epoch}，但该实例不在线`,
      );
    }
    if (claimants.length > 1) {
      facts.doubleWork.push({ key: item.key, claimants });
      violations.push(`多持有者：${item.key} 同时被在线实例 ${claimants.join(', ')} 声称持有`);
    }
    if (ownerIsLive && claimants.length === 0) {
      violations.push(`状态不一致：${item.key} 服务器归 ${item.owner}，但该实例并不认为自己持有`);
    }
    facts.liveOwners[item.key] = claimants;
  }

  // --- 在线控制器的台账必须全部有归宿 ---
  for (const c of live) {
    for (const entry of c.ledger) {
      if (!entry.resolved) {
        facts.unresolvedLedger.push({ controller: c.id, ...entry });
        violations.push(`无归宿：在线实例 ${c.id} 的 ${entry.key} 一直没有明确归宿`);
      }
    }
  }

  return { ok: violations.length === 0, violations, facts };
}
