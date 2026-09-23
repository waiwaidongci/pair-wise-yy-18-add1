// 替换判定与阵容重算：纯逻辑，不直接读写数据库。
// 名词约定：
//   身位(slot)  一出戏里的一个表演位置，按 role（行当）占位
//   冻结(freeze) 提交巡演时把偶头/配件快照写进每个身位
//   占位(occupy) 身位当前生效引用；原占位一旦被替换即进入 blockedItemIds，不得再次分配

const HEAD_PACKED_STATUS = '已装箱';
const ACC_USABLE_STATUSES = ['在库'];

const STATUS_FLOW = {
  草稿: ['已装箱'],
  已装箱: ['巡演中', '草稿'],
  巡演中: ['返场清点中'],
  返场清点中: ['已闭环', '巡演中']
};

const MANAGED_FIELDS = [
  'lineup', 'frozenAt', 'frozenBy', 'rosterVersion',
  'replacements', 'reviewFlags', 'invalidations', 'blockedItemIds'
];

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function headPerformable(head) {
  return Boolean(head) && head.status !== '不可演出' && head.status !== '待修补' &&
    head.status !== '修补中' && head.status !== HEAD_PACKED_STATUS &&
    head.currentUsable !== false;
}

function accessoryPerformable(accessory) {
  return Boolean(accessory) && ACC_USABLE_STATUSES.includes(accessory.status);
}

function performable(itemType, item) {
  return itemType === 'head' ? headPerformable(item) : accessoryPerformable(item);
}

// 某箱单当前占用（他单不可再分）的物品：冻结身位 + 待确认替换 + 已确认替换目标
function busyItemIds(box) {
  const ids = new Set();
  for (const slot of box.lineup || []) {
    if (slot.head) ids.add(slot.head.itemId);
    (slot.accessories || []).forEach((reference) => ids.add(reference.itemId));
    if (slot.replacement) ids.add(slot.replacement.candidateId);
  }
  return ids;
}

// 全社当前已随已冻结箱单在外的物品
function globallyBusyIds(tourBoxes, selfBoxId) {
  const ids = new Set();
  for (const box of tourBoxes) {
    if (box.id === selfBoxId) continue;
    if (!box.frozenAt) continue;
    if (box.status === '已闭环') continue;
    busyItemIds(box).forEach((id) => ids.add(id));
  }
  return ids;
}

function buildContext(heads, accessories, tourBoxes, selfBoxId) {
  const globalBusy = globallyBusyIds(tourBoxes || [], selfBoxId);
  const headById = new Map();
  const accessoryById = new Map();
  for (const head of heads || []) {
    headById.set(head.id, head);
  }
  for (const accessory of accessories || []) {
    accessoryById.set(accessory.id, accessory);
  }
  return {
    headById,
    accessoryById,
    globalBusy,
    lookup(itemType, id) {
      return itemType === 'head' ? headById.get(id) : accessoryById.get(id);
    }
  };
}

function snapshotItem(itemType, item) {
  if (itemType === 'head') {
    return {
      itemType: 'head',
      itemId: item.id,
      role: item.role,
      play: item.play,
      status: item.status,
      paintStatus: item.paintStatus,
      mechanism: item.mechanism,
      boxNo: item.boxNo,
      snapshotAt: undefined
    };
  }
  return {
    itemType: 'accessory',
    itemId: item.id,
    name: item.name,
    role: item.role,
    play: item.play,
    status: item.status,
    boxNo: item.boxNo,
    snapshotAt: undefined
  };
}

function makeReference(itemType, item, frozenAt) {
  return { ...snapshotItem(itemType, item), snapshotAt: frozenAt };
}

// ---- 草稿身位：兼容旧 headIds/accessoryIds 提交，也支持显式 lineup ----
function buildDraftLineup(box, heads, accessories) {
  if (Array.isArray(box.lineup) && box.lineup.length) {
    return box.lineup.map((slot, index) => normalizeSlot(slot, index));
  }
  const byId = (items) => new Map(items.map((item) => [item.id, item]));
  const headMap = byId(heads);
  const accessoryMap = byId(accessories);
  const roles = new Map();
  const ensure = (role) => {
    if (!roles.has(role)) roles.set(role, { role, headIds: [], accessoryIds: [] });
    return roles.get(role);
  };
  (box.headIds || []).forEach((id) => {
    const head = headMap.get(id);
    if (head) ensure(head.role).headIds.push(id);
  });
  (box.accessoryIds || []).forEach((id) => {
    const accessory = accessoryMap.get(id);
    if (accessory) ensure(accessory.role).accessoryIds.push(id);
  });
  let index = 0;
  const slots = [];
  for (const group of roles.values()) {
    slots.push({
      slotId: 'slot-' + (index + 1),
      role: group.role,
      head: group.headIds[0] ? { itemType: 'head', itemId: group.headIds[0] } : null,
      accessories: group.accessoryIds.map((id) => ({ itemType: 'accessory', itemId: id }))
    });
    index += 1;
  }
  return slots;
}

function normalizeSlot(slot, index) {
  const head = slot.head
    ? { itemType: 'head', itemId: slot.head.itemId || slot.head.id }
    : null;
  const accessories = (slot.accessories || []).map((reference) => ({
    itemType: 'accessory',
    itemId: reference.itemId || reference.id
  }));
  return {
    slotId: slot.slotId || 'slot-' + (index + 1),
    role: slot.role,
    head,
    accessories
  };
}

// ---- 提交冻结：按身位保存偶头和配件快照 ----
function prepareFreeze(box, context, actor) {
  if (box.frozenAt) fail(409, '阵容已冻结，不能重复提交；如需修改请走临场替换或变更日期/剧目');
  const play = box.play;
  if (!play) fail(400, '缺少剧目，无法冻结阵容');
  const lineup = buildDraftLineup(box, [...context.headById.values()], [...context.accessoryById.values()]);
  if (!lineup.length) fail(400, '阵容为空，无法提交冻结');

  const localBusy = new Set();
  const frozenAt = new Date().toISOString();
  const frozenLineup = lineup.map((slot) => {
    if (!slot.role) fail(400, '身位 ' + slot.slotId + ' 缺少行当(role)');
    const frozenSlot = { ...slot, reviewState: '正常', head: null, accessories: [], replacement: null };
    const attach = (reference) => {
      const item = context.lookup(reference.itemType, reference.itemId);
      if (!item) fail(400, '物品不存在: ' + reference.itemType + '/' + reference.itemId);
      if (item.play !== play) fail(409, itemLabel(reference.itemType, item) + ' 不属于剧目《' + play + '》');
      if (item.role !== slot.role) fail(409, itemLabel(reference.itemType, item) + ' 行当为 ' + item.role + '，与身位 ' + slot.role + ' 不符');
      if (!performable(reference.itemType, item)) fail(409, itemLabel(reference.itemType, item) + ' 当前不可演出');
      if (context.globalBusy.has(item.id)) fail(409, itemLabel(reference.itemType, item) + ' 已随其他巡演装箱，不能重复分配');
      if (localBusy.has(item.id)) fail(409, itemLabel(reference.itemType, item) + ' 在本单内重复分配');
      localBusy.add(item.id);
      return makeReference(reference.itemType, item, frozenAt);
    };
    if (!slot.head) fail(400, '身位 ' + slot.role + ' 缺少偶头');
    frozenSlot.head = attach(slot.head);
    frozenSlot.accessories = slot.accessories.map(attach);
    return frozenSlot;
  });

  return {
    patch: {
      lineup: frozenLineup,
      frozenAt,
      frozenBy: actor || '',
      rosterVersion: (box.rosterVersion || 0) + 1,
      replacements: [],
      reviewFlags: [],
      invalidations: box.invalidations || [],
      blockedItemIds: []
    },
    frozenAt,
    itemIds: [...localBusy]
  };
}

// ---- 临场替换判定：同剧目、同角色、可演出；原占位不得再次分配 ----
function prepareReplace(box, input) {
  const { slotId, itemType, candidateId, reason, actor } = input;
  if (!box.frozenAt) fail(409, '阵容尚未冻结，草稿状态可直接调整身位，无需替换');
  if (!['head', 'accessory'].includes(itemType)) fail(400, 'itemType 必须是 head 或 accessory');
  const slot = (box.lineup || []).find((entry) => entry.slotId === slotId);
  if (!slot) fail(404, '身位不存在: ' + slotId);

  // 配件按具体 itemId 定位占位；未给 occupyItemId 时取该身位第一件配件
  const targetReference = itemType === 'accessory'
    ? (slot.accessories || []).find((reference) => reference.itemId === (input.occupyItemId || (slot.accessories[0] && slot.accessories[0].itemId)))
    : slot.head;
  if (!targetReference) fail(404, '该身位没有可替换的' + (itemType === 'head' ? '偶头' : '配件'));

  const candidate = itemType === 'head' ? box._context.headById.get(candidateId) : box._context.accessoryById.get(candidateId);
  if (!candidate) fail(404, '候选物品不存在: ' + candidateId);
  // 原占位一旦进入替换流程即被拉黑，不得再次分配（无论该替换是否已确认）
  if ((box.blockedItemIds || []).includes(candidateId)) fail(409, '该物品曾作为原占位被换下，不得再次分配');
  if (targetReference.itemId === candidateId) fail(400, '替换件与当前占位相同');
  if (candidate.play !== box.play) fail(409, '替换件须同剧目：候选属于《' + candidate.play + '》，本单为《' + box.play + '》');
  if (candidate.role !== slot.role) fail(409, '替换件须同角色：候选行当为 ' + candidate.role + '，身位为 ' + slot.role);
  if (!performable(itemType, candidate)) fail(409, '候选物品当前不可演出');
  if (busyItemIds(box).has(candidateId)) fail(409, '该物品已在本单身位中使用');
  if (box._context.globalBusy.has(candidateId)) fail(409, '该物品已随其他巡演装箱，不能分配');

  const replacement = {
    id: 'rep-' + box._newId(),
    slotId,
    itemType,
    occupyItemId: targetReference.itemId,
    occupySnapshot: targetReference,
    candidateId,
    candidateSnapshot: makeReference(itemType, candidate, new Date().toISOString()),
    reason: reason || '',
    actor: actor || '',
    status: '待确认',
    requestedAt: new Date().toISOString(),
    confirmedAt: null,
    rosterVersion: box.rosterVersion
  };
  return { replacement, occupyItemId: targetReference.itemId };
}

function itemLabel(itemType, item) {
  return itemType === 'head'
    ? '偶头[' + [item.role, item.play].filter(Boolean).join('/') + ']'
    : '配件[' + [item.name, item.role, item.play].filter(Boolean).join('/') + ']';
}

// 待确认替换期间名单仍展示原占位，候选以 pendingReplacement/pendingHead 呈现
function applyReplace(box, replacement) {
  const lineup = box.lineup.map((slot) => {
    if (slot.slotId !== replacement.slotId) return slot;
    const next = { ...slot, replacement, reviewState: slot.reviewState === '待复核' ? '待复核' : '正常' };
    if (replacement.itemType === 'head') {
      next.pendingHead = replacement.candidateSnapshot;
    } else {
      next.pendingAccessories = [...(slot.pendingAccessories || [])];
      if (!next.pendingAccessories.some((reference) => reference.itemId === replacement.candidateId)) {
        next.pendingAccessories.push(replacement.candidateSnapshot);
      }
    }
    return next;
  });
  const blockedItemIds = [...(box.blockedItemIds || [])];
  if (!blockedItemIds.includes(replacement.occupyItemId)) blockedItemIds.push(replacement.occupyItemId);
  return {
    patch: {
      lineup,
      blockedItemIds,
      replacements: [...(box.replacements || []), replacement]
    },
    replacement
  };
}

function prepareConfirm(box, replacementId) {
  const replacement = (box.replacements || []).find((entry) => entry.id === replacementId);
  if (!replacement) fail(404, '替换单不存在: ' + replacementId);
  if (replacement.status !== '待确认') fail(409, '该替换已确认，不能重复确认');
  const slot = (box.lineup || []).find((entry) => entry.slotId === replacement.slotId);
  if (!slot) fail(409, '替换身位已不存在（名单可能已重算）');
  return { replacement, slot };
}

function applyConfirm(box, replacement) {
  const confirmedAt = new Date().toISOString();
  const confirmed = { ...replacement, status: '已确认', confirmedAt };
  const lineup = box.lineup.map((slot) => {
    if (slot.slotId !== replacement.slotId) return slot;
    const next = { ...slot, replacement: confirmed };
    if (replacement.itemType === 'head') {
      next.head = { ...(slot.pendingHead || replacement.candidateSnapshot), snapshotAt: confirmedAt };
      next.pendingHead = null;
    } else {
      const accessories = [];
      for (const reference of slot.accessories || []) {
        if (reference.itemId === replacement.occupyItemId) {
          const candidate = [...(slot.pendingAccessories || [])].find((entry) => entry.itemId === replacement.candidateId)
            || replacement.candidateSnapshot;
          accessories.push({ ...candidate, snapshotAt: confirmedAt });
        } else {
          accessories.push(reference);
        }
      }
      if (!accessories.some((reference) => reference.itemId === replacement.candidateId)) {
        accessories.push({ ...replacement.candidateSnapshot, snapshotAt: confirmedAt });
      }
      next.accessories = accessories;
      next.pendingAccessories = (slot.pendingAccessories || []).filter((reference) => reference.itemId !== replacement.candidateId);
    }
    next.replacement = null;
    return next;
  });
  return {
    patch: {
      lineup,
      replacements: (box.replacements || []).map((entry) => entry.id === replacement.id ? confirmed : entry)
    },
    confirmed,
    releasedItemId: replacement.occupyItemId,
    packedItemId: replacement.candidateId
  };
}

// ---- 档案变化：冻结名单只能转待复核，不改快照 ----
const HEAD_SNAPSHOT_FIELDS = ['play', 'role', 'paintStatus', 'mechanism', 'boxNo'];
const ACC_SNAPSHOT_FIELDS = ['name', 'play', 'role', 'boxNo'];
const FIELD_LABELS = {
  play: '剧目', role: '行当', paintStatus: '脸谱状况', mechanism: '机关状况',
  boxNo: '箱号', name: '名称', status: '状态'
};

function detectDrift(box, itemType, itemId, item, actor) {
  if (!box.frozenAt || box.status === '已闭环') return null;
  const fields = itemType === 'head' ? HEAD_SNAPSHOT_FIELDS : ACC_SNAPSHOT_FIELDS;
  for (const slot of box.lineup || []) {
    const references = itemType === 'head'
      ? (slot.head ? [slot.head] : [])
      : (slot.accessories || []);
    const snapshot = references.find((reference) => reference.itemId === itemId);
    if (!snapshot) continue;
    const reasons = [];
    for (const field of fields) {
      if (item[field] !== snapshot[field]) {
        reasons.push((FIELD_LABELS[field] || field) + '由「' + snapshot[field] + '」变为「' + item[field] + '」');
      }
    }
    if (!performable(itemType, item)) reasons.push('档案状态变为「' + item.status + '」，已不可演出');
    if (!reasons.length) return null;
    return {
      box,
      slotId: slot.slotId,
      itemType,
      itemId,
      reasons,
      actor: actor || '',
      at: new Date().toISOString()
    };
  }
  return null;
}

function applyDrift(box, drift) {
  const lineup = box.lineup.map((slot) => {
    if (slot.slotId !== drift.slotId) return slot;
    return { ...slot, reviewState: '待复核' };
  });
  const flag = {
    id: 'flag-' + box._newId(),
    slotId: drift.slotId,
    itemType: drift.itemType,
    itemId: drift.itemId,
    reasons: drift.reasons,
    actor: drift.actor,
    at: drift.at,
    rosterVersion: box.rosterVersion,
    resolved: false
  };
  return {
    patch: {
      lineup,
      reviewFlags: [...(box.reviewFlags || []), flag]
    },
    flag
  };
}

// ---- 日期/剧目变化：旧名单失效，按当前有效物品重算 ----
// 仅对已冻结名单生效；草稿不做处理（草稿名单本就可直接编辑）。
function prepareRecalculate(box, patch, context) {
  if (!box.frozenAt) return { recalculated: false };
  const nextPlay = patch.play !== undefined ? patch.play : box.play;
  const nextDate = patch.tourDate !== undefined ? patch.tourDate : box.tourDate;
  const playChanged = nextPlay !== box.play;
  const dateChanged = nextDate !== box.tourDate;
  if (!playChanged && !dateChanged) return { recalculated: false };

  const frozenAt = new Date().toISOString();
  const invalidation = {
    version: box.rosterVersion || 0,
    reason: playChanged && dateChanged
      ? '剧目与巡演日期变更'
      : playChanged ? '剧目变更为《' + nextPlay + '》' : '巡演日期变更为 ' + nextDate,
    fromPlay: box.play,
    toPlay: nextPlay,
    fromTourDate: box.tourDate,
    toTourDate: nextDate,
    at: frozenAt,
    actor: patch._actor || ''
  };

  // 剧目变更：身位按新剧目当前可演出偶头的行当重建；仅日期变更：沿用原身位行当
  const previousSlots = box.lineup || [];
  let roles;
  if (playChanged) {
    roles = [];
    for (const head of context.headById.values()) {
      if (head.play === nextPlay && headPerformable(head) && !context.globalBusy.has(head.id) && !roles.includes(head.role)) {
        roles.push(head.role);
      }
    }
  } else {
    roles = previousSlots.map((slot) => slot.role);
  }

  // 重算与释放在同一笔业务内先后发生：本单原占用物品此刻仍是「已装箱」，
  // 但其装箱占用即将随旧名单失效而释放，因此选品时应把本单原占位视为可用
  // （前提是档案层面仍有效：非待修补/不可演出等）。
  const selfIds = new Set(collectItemIds(box));
  const usable = (itemType, item) => {
    if (!selfIds.has(item.id)) return performable(itemType, item);
    if (itemType === 'head') {
      return !['不可演出', '待修补', '修补中'].includes(item.status) && item.currentUsable !== false;
    }
    return item.status === '已装箱' || item.status === '在库';
  };
  const draftRef = (itemType, item) => ({ itemType, itemId: item.id });

  const used = new Set();
  const lineup = roles.map((role, index) => {
    const slot = {
      slotId: 'slot-' + (index + 1),
      role,
      reviewState: '正常',
      head: null,
      accessories: [],
      replacement: null,
      pendingHead: null,
      pendingAccessories: []
    };
    // 优先沿用旧名单中仍同戏同行当且可演出的物品
    const previous = previousSlots.find((entry) => entry.role === role);
    const tryKeep = (itemType, reference) => {
      if (!reference) return false;
      const item = context.lookup(itemType, reference.itemId);
      if (!item || item.play !== nextPlay || item.role !== role) return false;
      if (!usable(itemType, item) || context.globalBusy.has(item.id) || used.has(item.id)) return false;
      used.add(item.id);
      return true;
    };
    if (previous && previous.head && tryKeep('head', previous.head)) {
      slot.head = draftRef('head', context.lookup('head', previous.head.itemId));
    } else {
      const candidate = [...context.headById.values()].find((head) =>
        head.play === nextPlay && head.role === role && usable('head', head) &&
        !context.globalBusy.has(head.id) && !used.has(head.id)
      );
      if (candidate) {
        used.add(candidate.id);
        slot.head = draftRef('head', candidate);
      }
    }
    if (previous) {
      for (const reference of previous.accessories || []) {
        if (tryKeep('accessory', reference)) {
          slot.accessories.push(draftRef('accessory', context.lookup('accessory', reference.itemId)));
        }
      }
    }
    for (const accessory of context.accessoryById.values()) {
      if (accessory.play !== nextPlay || accessory.role !== role) continue;
      if (!usable('accessory', accessory)) continue;
      if (context.globalBusy.has(accessory.id) || used.has(accessory.id)) continue;
      used.add(accessory.id);
      slot.accessories.push(draftRef('accessory', accessory));
    }
    return slot;
  });

  return {
    recalculated: true,
    wasFrozen: true,
    invalidation,
    rosterPatch: {
      lineup,
      frozenAt: null,
      frozenBy: '',
      rosterVersion: (box.rosterVersion || 0) + 1,
      replacements: [],
      reviewFlags: [],
      blockedItemIds: [],
      invalidations: [...(box.invalidations || []), invalidation]
    },
    releasedItemIds: collectItemIds(box)
  };
}

function collectItemIds(box) {
  const ids = new Set();
  for (const slot of box.lineup || []) {
    if (slot.head) ids.add(slot.head.itemId);
    (slot.accessories || []).forEach((reference) => ids.add(reference.itemId));
    if (slot.replacement) ids.add(slot.replacement.candidateId);
  }
  return [...ids];
}

// ---- 状态流转与闭环闸门：返场清点前存在未确认替换不能结束 ----
function assertStatusTransition(box, nextStatus) {
  if (nextStatus === box.status) return;
  const allowed = STATUS_FLOW[box.status] || [];
  if (!allowed.includes(nextStatus)) {
    fail(409, '装箱单不能从「' + box.status + '」变为「' + nextStatus + '」');
  }
  if (nextStatus === '已闭环') {
    const pending = (box.replacements || []).filter((entry) => entry.status === '待确认');
    if (pending.length) {
      fail(409, '尚有 ' + pending.length + ' 笔临场替换未确认（身位: ' +
        pending.map((entry) => entry.slotId).join('、') + '），返场清点未完成，不能结束巡演单');
    }
  }
}

// ---- 对外视图：列表与时间线共用同一份汇总 ----
function summarize(box) {
  const slots = box.lineup || [];
  const pendingReplacements = [];
  const confirmedReplacements = [];
  for (const replacement of box.replacements || []) {
    if (replacement.status === '待确认') pendingReplacements.push(replacement);
    else confirmedReplacements.push(replacement);
  }
  const reviewSlots = slots.filter((slot) => slot.reviewState === '待复核').map((slot) => slot.slotId);
  return {
    frozen: Boolean(box.frozenAt),
    frozenAt: box.frozenAt || null,
    rosterVersion: box.rosterVersion || 0,
    slotCount: slots.length,
    pendingReplacementCount: pendingReplacements.length,
    confirmedReplacementCount: confirmedReplacements.length,
    reviewSlotCount: reviewSlots.length,
    reviewSlots,
    canClose: pendingReplacements.length === 0
  };
}

function presentBox(box) {
  const summary = summarize(box);
  return {
    ...box,
    roster: {
      ...summary,
      slots: presentLineup(box.lineup || [])
    }
  };
}

function presentLineup(lineup) {
  return lineup.map((slot) => {
    const pending = slot.replacement && slot.replacement.status === '待确认' ? slot.replacement : null;
    return {
      slotId: slot.slotId,
      role: slot.role,
      reviewState: slot.reviewState || '正常',
      head: slot.head || null,
      accessories: slot.accessories || [],
      pendingReplacement: pending ? {
        id: pending.id,
        itemType: pending.itemType,
        occupyItemId: pending.occupyItemId,
        candidate: pending.candidateSnapshot,
        reason: pending.reason,
        actor: pending.actor,
        requestedAt: pending.requestedAt
      } : null
    };
  });
}

module.exports = {
  HEAD_PACKED_STATUS,
  MANAGED_FIELDS,
  headPerformable,
  accessoryPerformable,
  performable,
  busyItemIds,
  buildContext,
  buildDraftLineup,
  prepareFreeze,
  prepareReplace,
  applyReplace,
  prepareConfirm,
  applyConfirm,
  detectDrift,
  applyDrift,
  prepareRecalculate,
  assertStatusTransition,
  summarize,
  presentBox,
  presentLineup,
  collectItemIds
};
