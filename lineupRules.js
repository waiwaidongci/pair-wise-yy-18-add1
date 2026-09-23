// 阵容名单判定层（纯逻辑）：身位快照的组装、档案变更复核、临场替换校验、结案校验。
// 不接触数据库与 HTTP，输入全部由参数传入。

const ITEM_COLLECTIONS = {
  head: 'puppetHeads',
  accessory: 'accessories'
};

const SLOT_STATES = {
  ACTIVE: '有效',
  REVIEW: '待复核',
  REPLACED: '已替换'
};

const LINEUP_ACTIVE = '生效中';
const LINEUP_INVALID = '已失效';

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// 可演出判定：偶头要求状态为「可演出」且未标记停用；配件要求「在库」。
function isUsable(itemType, item) {
  if (!item) return false;
  if (itemType === 'head') {
    return item.status === '可演出' && item.currentUsable !== false;
  }
  return item.status === '在库';
}

// 冻结时刻的档案快照，之后档案如何变化都不改写这里。
function snapshotOf(itemType, item) {
  if (!item) return null;
  if (itemType === 'head') {
    return {
      status: item.status,
      role: item.role,
      play: item.play,
      paintStatus: item.paintStatus,
      mechanism: item.mechanism,
      boxNo: item.boxNo,
      currentUsable: item.currentUsable !== false
    };
  }
  return {
    status: item.status,
    name: item.name,
    role: item.role,
    play: item.play,
    boxNo: item.boxNo
  };
}

function makeSlot(itemType, seq, itemId, item) {
  return {
    slotId: itemType + '-' + seq,
    itemType,
    itemId,
    role: (item && item.role) || '',
    play: (item && item.play) || '',
    snapshot: snapshotOf(itemType, item),
    state: item && isUsable(itemType, item) ? SLOT_STATES.ACTIVE : SLOT_STATES.REVIEW,
    replacedBy: null
  };
}

// 按身位组装名单。
// 提交巡演（onlyUsable=false）：装箱单上的偶头和配件全部留快照，当前不可用的身位转待复核。
// 日期/剧目变化后重算（onlyUsable=true）：旧名单已失效，只按当前有效物品入单，其余进 dropped。
function buildSlots(box, loadItem, options = {}) {
  const onlyUsable = options.onlyUsable === true;
  const slots = [];
  const dropped = [];
  const plan = [
    { itemType: 'head', ids: box.headIds || [] },
    { itemType: 'accessory', ids: box.accessoryIds || [] }
  ];
  for (const { itemType, ids } of plan) {
    let seq = 0;
    for (const itemId of ids) {
      seq += 1;
      const item = loadItem(itemType, itemId);
      if (onlyUsable && !isUsable(itemType, item)) {
        dropped.push({
          itemType,
          itemId,
          reason: item ? '当前状态[' + item.status + ']不可入单' : '档案不存在'
        });
        continue;
      }
      slots.push(makeSlot(itemType, seq, itemId, item));
    }
  }
  return { slots, dropped };
}

// 档案变化：只把生效名单中对应身位转为待复核，快照内容保持冻结时的原样。
function flagItemSlots(lineup, itemType, itemId) {
  let count = 0;
  for (const slot of lineup.slots) {
    if (
      slot.itemType === itemType &&
      String(slot.itemId) === String(itemId) &&
      slot.state === SLOT_STATES.ACTIVE
    ) {
      slot.state = SLOT_STATES.REVIEW;
      count += 1;
    }
  }
  return count;
}

// 临场替换判定：同剧目、同角色、当前可演出；原占位一经替换不得再次分配；不得与名单重复。
function validateReplacement(lineup, slotId, newItem, newItemId) {
  if (!lineup) throw fail(409, '该装箱单尚未冻结阵容名单');
  if (lineup.status !== LINEUP_ACTIVE) throw fail(409, '阵容名单已失效，不能进行临场替换');

  const slot = lineup.slots.find((candidate) => candidate.slotId === slotId);
  if (!slot) throw fail(404, '身位不存在: ' + slotId);
  if (slot.state === SLOT_STATES.REPLACED) {
    throw fail(409, '原占位不得再次分配: ' + slotId);
  }
  if (String(slot.itemId) === String(newItemId)) {
    throw fail(409, '替换件不能与原占位物品相同');
  }
  if (!newItem) throw fail(404, '替换件档案不存在: ' + newItemId);
  if ((newItem.play || '') !== slot.play || (newItem.role || '') !== slot.role) {
    throw fail(409, '替换件须同剧目同角色: 需要「' + slot.play + ' / ' + slot.role + '」');
  }
  if (!isUsable(slot.itemType, newItem)) {
    throw fail(409, '替换件当前不可演出: ' + (newItem.status || '未知状态'));
  }
  const occupied = lineup.slots.some(
    (candidate) =>
      candidate.slotId !== slot.slotId &&
      candidate.itemType === slot.itemType &&
      candidate.state !== SLOT_STATES.REPLACED &&
      String(candidate.itemId) === String(newItemId)
  );
  const usedAsReplacement = lineup.replacements.some(
    (replacement) => String(replacement.newItemId) === String(newItemId)
  );
  if (occupied || usedAsReplacement) {
    throw fail(409, '替换件已在本名单中占用，不能重复分配');
  }
  return slot;
}

function applyReplacement(lineup, slot, newItem, newItemId, context) {
  const replacement = {
    id: context.id,
    slotId: slot.slotId,
    itemType: slot.itemType,
    originalItemId: slot.itemId,
    newItemId,
    newSnapshot: snapshotOf(slot.itemType, newItem),
    status: '待确认',
    actor: context.actor || '',
    note: context.note || '',
    createdAt: context.now,
    confirmedAt: null,
    confirmedBy: null
  };
  lineup.replacements.push(replacement);
  slot.state = SLOT_STATES.REPLACED;
  slot.replacedBy = context.id;
  return replacement;
}

function confirmReplacement(lineup, replacementId, actor, timestamp) {
  const replacement = lineup.replacements.find((candidate) => candidate.id === replacementId);
  if (!replacement) throw fail(404, '替换记录不存在: ' + replacementId);
  if (replacement.status !== '待确认') throw fail(409, '该替换已确认，无需重复确认');
  replacement.status = '已确认';
  replacement.confirmedAt = timestamp;
  replacement.confirmedBy = actor || '';
  return replacement;
}

function pendingReplacements(lineup) {
  if (!lineup) return [];
  return lineup.replacements.filter((replacement) => replacement.status === '待确认');
}

// 返场清点前存在未确认替换时，该单不能结束（已闭环）。
function assertClosable(lineup) {
  const pending = pendingReplacements(lineup);
  if (pending.length > 0) {
    throw fail(409, '存在 ' + pending.length + ' 条未确认替换，该单不能结束');
  }
}

module.exports = {
  ITEM_COLLECTIONS,
  SLOT_STATES,
  LINEUP_ACTIVE,
  LINEUP_INVALID,
  fail,
  isUsable,
  snapshotOf,
  buildSlots,
  flagItemSlots,
  validateReplacement,
  applyReplacement,
  confirmReplacement,
  pendingReplacements,
  assertClosable
};
