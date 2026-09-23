// 清单存取层：装箱单持久化 + 偶头/配件档案状态联动，全部走事务。
const db = require('./db');
const rules = require('./replacements');

const TOUR_COLLECTION = 'tourBoxes';

function listHeads() {
  return db.listRecords('puppetHeads');
}

function listAccessories() {
  return db.listRecords('accessories');
}

function listBoxes() {
  return db.listRecords(TOUR_COLLECTION);
}

function getBox(id) {
  return db.getRecord(TOUR_COLLECTION, id);
}

function buildContext(boxId) {
  return rules.buildContext(listHeads(), listAccessories(), listBoxes(), boxId);
}

// 给纯逻辑对象挂上运行期依赖，不入库
function withRuntime(box, context) {
  return Object.assign(box, { _context: context, _newId: db.newId });
}

function stripRuntime(box) {
  const clean = { ...box };
  delete clean._context;
  delete clean._newId;
  return clean;
}

function setItemStatus(itemType, itemId, status, event) {
  const collection = itemType === 'head' ? 'puppetHeads' : 'accessories';
  const item = db.getRecord(collection, itemId);
  if (!item) return;
  const data = { ...item, status };
  db.updateRecord(collection, itemId, data, status, event ? {
    action: event.action,
    actor: event.actor || 'system',
    note: event.note || '',
    data: { status, tourBoxId: event.tourBoxId, itemType, itemId }
  } : null);
}

function releaseItem(itemType, reference, boxId, reason) {
  if (!reference) return;
  const collection = itemType === 'head' ? 'puppetHeads' : 'accessories';
  const live = db.getRecord(collection, reference.itemId);
  if (!live) return;
  let restoreStatus;
  if (live.status !== rules.HEAD_PACKED_STATUS) {
    // 档案已被改成待修补/缺损等真实状态时保留，不用装箱快照覆盖
    restoreStatus = live.status;
  } else if (itemType === 'accessory') {
    restoreStatus = '在库';
  } else {
    restoreStatus = reference.status && reference.status !== rules.HEAD_PACKED_STATUS ? reference.status : '可演出';
  }
  if (restoreStatus === live.status) return;
  setItemStatus(itemType, reference.itemId, restoreStatus, {
    action: reason || '巡演名单释放',
    tourBoxId: boxId,
    note: '箱单 ' + boxId + ' 释放物品'
  });
}

function markPacked(itemType, itemId, boxId, action, actor, note) {
  setItemStatus(itemType, itemId, rules.HEAD_PACKED_STATUS, {
    action: action || '随巡演装箱',
    actor: actor || 'system',
    tourBoxId: boxId,
    note: note || ''
  });
}

function saveBox(box, status, event) {
  const data = stripRuntime(box);
  delete data.id;
  delete data.collection;
  delete data.createdAt;
  delete data.updatedAt;
  return db.updateRecord(TOUR_COLLECTION, box.id, data, status, event ? {
    action: event.action,
    actor: event.actor || '',
    note: event.note || '',
    data: event.data || {}
  } : null);
}

// 新建装箱单（草稿，不冻结）
function createBox(body) {
  const collectionConfig = db.findCollection(TOUR_COLLECTION);
  const data = { ...collectionConfig.defaults, ...body };
  const status = collectionConfig.defaultStatus || '草稿';
  data.status = status;
  // 校验必填（lineup 与旧 headIds 二选一，提交冻结时才完整校验身位）
  for (const field of ['showName', 'venue', 'play']) {
    if (data[field] === undefined || data[field] === '') {
      throw db.httpError(400, '缺少必填字段: ' + field);
    }
  }
  const context = buildContext(null);
  const draft = {
    ...data,
    lineup: rules.buildDraftLineup(data, listHeads(), listAccessories()),
    frozenAt: null,
    frozenBy: '',
    rosterVersion: 0,
    replacements: [],
    reviewFlags: [],
    invalidations: [],
    blockedItemIds: []
  };
  return db.transaction(() => {
    const record = db.insertRecord(TOUR_COLLECTION, {
      status,
      data: { ...draft, status },
      action: body.action || '创建装箱单',
      actor: body.actor || '',
      note: body.note || ''
    });
    return rules.presentBox(record);
  });
}

// 提交巡演：冻结阵容，按身位保存快照
function freezeBox(boxId, body = {}) {
  const box = getBox(boxId);
  if (!box) throw db.httpError(404, '装箱单不存在');
  const context = buildContext(boxId);
  withRuntime(box, context);
  const result = rules.prepareFreeze(box, context, body.actor);
  const status = '已装箱';
  return db.transaction(() => {
    Object.assign(box, result.patch, { status });
    delete box.headIds;
    delete box.accessoryIds;
    for (const itemId of result.itemIds) {
      const itemType = context.headById.has(itemId) ? 'head' : 'accessory';
      markPacked(itemType, itemId, boxId, '提交巡演冻结阵容', body.actor, '剧目《' + box.play + '》');
    }
    const saved = saveBox(box, status, {
      action: '提交巡演·阵容冻结',
      actor: body.actor || '',
      note: body.reason || ('按 ' + result.patch.lineup.length + ' 个身位保存偶头与配件快照'),
      data: { frozenAt: result.frozenAt, rosterVersion: result.patch.rosterVersion, itemIds: result.itemIds }
    });
    return rules.presentBox(saved);
  });
}

// 临场替换：登记待确认
function requestReplacement(boxId, body) {
  const box = getBox(boxId);
  if (!box) throw db.httpError(404, '装箱单不存在');
  const context = buildContext(boxId);
  withRuntime(box, context);
  const prepared = rules.prepareReplace(box, {
    slotId: body.slotId,
    itemType: body.itemType,
    candidateId: body.candidateId,
    occupyItemId: body.occupyItemId,
    reason: body.reason,
    actor: body.actor
  });
  const applied = rules.applyReplace(box, prepared.replacement);
  return db.transaction(() => {
    Object.assign(box, applied.patch);
    // 替换候选立刻锁定为已装箱，防止另作他用；原占位仍在身位上待确认
    markPacked(prepared.replacement.itemType, prepared.replacement.candidateId, boxId,
      '临场替换·锁定替换件', body.actor, '身位 ' + body.slotId + '，原因：' + (body.reason || ''));
    const saved = saveBox(box, box.status, {
      action: '临场替换·待确认',
      actor: body.actor || '',
      note: '身位 ' + body.slotId + '：' + prepared.replacement.occupyItemId + ' → ' + prepared.replacement.candidateId + (body.reason ? '（' + body.reason + '）' : ''),
      data: { replacementId: prepared.replacement.id, slotId: body.slotId }
    });
    return { box: rules.presentBox(saved), replacement: prepared.replacement };
  });
}

// 确认替换：候选上位、原占位进入黑名单释放
function confirmReplacement(boxId, replacementId, body = {}) {
  const box = getBox(boxId);
  if (!box) throw db.httpError(404, '装箱单不存在');
  const context = buildContext(boxId);
  withRuntime(box, context);
  const prepared = rules.prepareConfirm(box, replacementId);
  const applied = rules.applyConfirm(box, prepared.replacement);
  return db.transaction(() => {
    Object.assign(box, applied.patch);
    const itemType = prepared.replacement.itemType;
    // 原占位快照保留在 replacements 历史中；档案释放为可演出/在库，且本单不得再次分配
    releaseItem(itemType, { itemType, itemId: applied.releasedItemId, status: itemType === 'accessory' ? '在库' : prepared.replacement.occupySnapshot.status },
      boxId, '临场替换·原占位换下');
    markPacked(itemType, applied.packedItemId, boxId, '临场替换·确认上位', body.actor, '身位 ' + prepared.replacement.slotId);
    const saved = saveBox(box, box.status, {
      action: '临场替换·已确认',
      actor: body.actor || '',
      note: '身位 ' + prepared.replacement.slotId + ' 替换确认：' + applied.releasedItemId + ' → ' + applied.packedItemId,
      data: { replacementId, slotId: prepared.replacement.slotId }
    });
    return { box: rules.presentBox(saved), replacement: applied.confirmed };
  });
}

// 偶头/配件档案被改动后调用：冻结名单只能转待复核
function notifyArchiveChanged(itemType, itemId, actor) {
  const collection = itemType === 'head' ? 'puppetHeads' : 'accessories';
  const item = db.getRecord(collection, itemId);
  if (!item) return [];
  const touched = [];
  for (const box of listBoxes()) {
    if (!box.frozenAt || box.status === '已闭环') continue;
    const context = buildContext(box.id);
    withRuntime(box, context);
    const drift = rules.detectDrift(box, itemType, itemId, item, actor);
    if (!drift) continue;
    const applied = rules.applyDrift(box, drift);
    Object.assign(box, applied.patch);
    saveBox(box, box.status, {
      action: '档案变化·转待复核',
      actor: actor || 'system',
      note: '身位 ' + drift.slotId + ' 的' + (itemType === 'head' ? '偶头' : '配件') + '档案变化：' + drift.reasons.join('；'),
      data: { flagId: applied.flag.id, itemType, itemId, slotId: drift.slotId, reasons: drift.reasons }
    });
    touched.push({ boxId: box.id, slotId: drift.slotId });
  }
  return touched;
}

// 装箱单普通更新：冻结后名单字段禁写；日期/剧目变化触发失效重算
function patchBox(boxId, body) {
  const box = getBox(boxId);
  if (!box) throw db.httpError(404, '装箱单不存在');

  const managedTouched = rules.MANAGED_FIELDS.filter((field) => body[field] !== undefined);
  if (managedTouched.length) {
    if (box.frozenAt) {
      throw db.httpError(409, '阵容已冻结，名单字段不可改写（' + managedTouched.join(', ') + '）；请走临场替换或变更日期/剧目');
    }
    throw db.httpError(400, '名单字段由系统维护，不可直接写入: ' + managedTouched.join(', '));
  }

  const status = body.status || box.status;
  if (status !== box.status) rules.assertStatusTransition(box, status);

  const actor = body.actor || '';
  const incoming = { ...body };
  delete incoming.status;
  delete incoming.actor;
  delete incoming.action;
  delete incoming.note;

  const context = buildContext(boxId);
  withRuntime(box, context);
  const recalc = rules.prepareRecalculate(box, { play: incoming.play, tourDate: incoming.tourDate, _actor: actor }, context);

  return db.transaction(() => {
    let eventAction = body.action || '更新装箱单';
    let eventNote = body.note || '';

    if (recalc.recalculated) {
      if (recalc.wasFrozen) {
        // 旧名单失效：释放旧冻结物品及待确认替换件的装箱占用
        for (const itemId of recalc.releasedItemIds) {
          const itemType = context.headById.has(itemId) ? 'head' : 'accessory';
          const reference = findReference(box, itemType, itemId);
          releaseItem(itemType, { itemType, itemId, status: reference ? reference.status : undefined },
            boxId, '名单失效·释放物品');
        }
        eventAction = '日期/剧目变更·旧名单失效';
        eventNote = recalc.invalidation.reason + '，已按当前有效物品重算（版本 ' + recalc.rosterPatch.rosterVersion + '）';
      }
      Object.assign(box, recalc.rosterPatch);
    }

    for (const [key, value] of Object.entries(incoming)) {
      if (key === 'play' || key === 'tourDate') {
        box[key] = value;
      } else if (key === 'lineup' && !box.frozenAt) {
        box.lineup = rules.buildDraftLineup({ ...box, lineup: value }, listHeads(), listAccessories());
      } else if (['headIds', 'accessoryIds'].includes(key) && !box.frozenAt) {
        box[key] = value;
        box.lineup = rules.buildDraftLineup({ ...box, lineup: [], headIds: incoming.headIds !== undefined ? incoming.headIds : box.headIds, accessoryIds: incoming.accessoryIds !== undefined ? incoming.accessoryIds : box.accessoryIds },
          listHeads(), listAccessories());
      } else {
        box[key] = value;
      }
    }
    box.status = status;

    const saved = saveBox(box, status, {
      action: eventAction,
      actor,
      note: eventNote,
      data: {
        rosterVersion: box.rosterVersion,
        invalidated: recalc.recalculated && recalc.wasFrozen ? true : false
      }
    });
    return rules.presentBox(saved);
  });
}

function findReference(box, itemType, itemId) {
  for (const slot of box.lineup || []) {
    if (itemType === 'head' && slot.head && slot.head.itemId === itemId) return slot.head;
    if (itemType === 'accessory') {
      const found = (slot.accessories || []).find((reference) => reference.itemId === itemId);
      if (found) return found;
      if (slot.replacement && slot.replacement.candidateId === itemId) return slot.replacement.candidateSnapshot;
    }
    if (slot.pendingHead && itemType === 'head' && slot.pendingHead.itemId === itemId) return slot.pendingHead;
  }
  return null;
}

// 仅状态流转（事件接口）：闭环前闸门同样生效
function transitionStatus(boxId, body) {
  const box = getBox(boxId);
  if (!box) throw db.httpError(404, '装箱单不存在');
  const nextStatus = body.status || box.status;
  rules.assertStatusTransition(box, nextStatus);
  const context = buildContext(boxId);
  withRuntime(box, context);
  return db.transaction(() => {
    const fields = body.fields || {};
    for (const field of rules.MANAGED_FIELDS) delete fields[field];
    Object.assign(box, fields);
    box.status = nextStatus;

    if (nextStatus === '已闭环') {
      // 返场清点结束、巡演单闭环：随身物品全部归库，后续巡演可再次装箱
      for (const itemId of rules.collectItemIds(box)) {
        const itemType = context.headById.has(itemId) ? 'head' : 'accessory';
        const reference = findReference(box, itemType, itemId);
        releaseItem(itemType, { itemType, itemId, status: reference ? reference.status : undefined },
          boxId, '返场闭环·物品归库');
      }
    }

    const saved = saveBox(box, nextStatus, {
      action: body.action || nextStatus,
      actor: body.actor || '',
      note: body.note || '',
      data: { rosterVersion: box.rosterVersion, closed: nextStatus === '已闭环' }
    });
    return rules.presentBox(saved);
  });
}

module.exports = {
  TOUR_COLLECTION,
  getBox,
  listBoxes,
  buildContext,
  createBox,
  patchBox,
  freezeBox,
  requestReplacement,
  confirmReplacement,
  notifyArchiveChanged,
  transitionStatus,
  presentBox: rules.presentBox
};
