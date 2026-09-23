// 巡演装箱接入层：阵容冻结、临场替换、替换确认、名单查询的 HTTP 入口，
// 以及通用 PATCH / events / delete 接口在巡演装箱单或偶头/配件变化时调用的钩子。
// 本层只负责参数拼装与响应，判定走 lineupRules，持久化走 lineupStore。

const express = require('express');

module.exports = function createTourAccess({
  loadRecord,
  saveRecord,
  insertEvent,
  store,
  rules,
  now,
  randomUUID
}) {
  const router = express.Router();

  function loadBox(id) {
    const box = loadRecord('tourBoxes', id);
    if (!box) throw rules.fail(404, 'tourBox not found: ' + id);
    return box;
  }

  function loadItem(itemType, itemId) {
    return loadRecord(rules.ITEM_COLLECTIONS[itemType], itemId);
  }

  function stripMeta(record) {
    const data = { ...record };
    delete data.id;
    delete data.collection;
    delete data.createdAt;
    delete data.updatedAt;
    return data;
  }

  // 把名单摘要写回装箱单（列表接口直接可见），保证列表刷新后与时间线、名单接口口径一致。
  function syncBoxSummary(tourBoxId) {
    const box = loadRecord('tourBoxes', tourBoxId);
    if (!box) return;
    const versions = store.listByBox(tourBoxId);
    const active = versions.find((lineup) => lineup.status === rules.LINEUP_ACTIVE) || null;
    const data = stripMeta(box);
    data.lineupStatus = active ? rules.LINEUP_ACTIVE : versions.length > 0 ? rules.LINEUP_INVALID : '未冻结';
    data.lineupVersion = active ? active.version : 0;
    data.pendingReplacementCount = active ? rules.pendingReplacements(active).length : 0;
    saveRecord('tourBoxes', tourBoxId, data, box.status);
  }

  // 冻结一份新名单：当前生效版本先置失效，再按装箱内容落快照。
  function freezeLineup(box, options) {
    const { slots, dropped } = rules.buildSlots(box, loadItem, { onlyUsable: options.onlyUsable });
    const old = store.getActive(box.id);
    if (old) store.invalidate(old);
    const lineup = store.create(box.id, slots);
    syncBoxSummary(box.id);
    insertEvent({
      recordId: box.id,
      collection: 'tourBoxes',
      action: options.action,
      status: box.status,
      actor: options.actor || '',
      note: options.note || '',
      data: {
        lineupId: lineup.id,
        version: lineup.version,
        slotCount: slots.length,
        dropped
      }
    });
    return lineup;
  }

  // POST /api/tourBoxes/:id/submit —— 提交巡演：按身位保存偶头和配件快照。
  router.post('/:id/submit', (req, res, next) => {
    try {
      let box = loadBox(req.params.id);
      if (['返场清点中', '已闭环'].includes(box.status)) {
        throw rules.fail(409, '当前状态[' + box.status + ']不能冻结阵容名单');
      }
      const actor = req.body.actor || '';
      const note = req.body.note || '';
      if (box.status === '草稿') {
        const data = stripMeta(box);
        data.status = '已装箱';
        saveRecord('tourBoxes', box.id, data, '已装箱');
        insertEvent({
          recordId: box.id,
          collection: 'tourBoxes',
          action: '提交巡演',
          status: '已装箱',
          actor,
          note,
          data: {}
        });
        box = loadBox(req.params.id);
      }
      const lineup = freezeLineup(box, {
        actor,
        note,
        onlyUsable: false,
        action: '阵容冻结'
      });
      res.status(201).json({ box: loadBox(box.id), lineup });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/tourBoxes/:id/lineup —— 当前生效名单与历史版本。
  router.get('/:id/lineup', (req, res, next) => {
    try {
      const box = loadBox(req.params.id);
      const history = store.listByBox(box.id);
      const lineup = history.find((item) => item.status === rules.LINEUP_ACTIVE) || null;
      res.json({ boxId: box.id, lineup, history });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/tourBoxes/:id/replacements —— 临场替换。
  // body: { slotId, newItemId, actor, note }
  router.post('/:id/replacements', (req, res, next) => {
    try {
      const box = loadBox(req.params.id);
      if (['返场清点中', '已闭环'].includes(box.status)) {
        throw rules.fail(409, '当前状态[' + box.status + ']不能进行临场替换');
      }
      const slotId = req.body && req.body.slotId;
      const newItemId = req.body && req.body.newItemId;
      if (!slotId || !newItemId) {
        throw rules.fail(400, 'missing required fields: slotId, newItemId');
      }
      const lineup = store.getActive(box.id);
      const targetSlot = lineup ? lineup.slots.find((slot) => slot.slotId === slotId) : null;
      const newItem = targetSlot ? loadItem(targetSlot.itemType, newItemId) : null;

      const slot = rules.validateReplacement(lineup, slotId, newItem, newItemId);
      const replacement = rules.applyReplacement(lineup, slot, newItem, newItemId, {
        id: randomUUID(),
        actor: req.body.actor,
        note: req.body.note,
        now: now()
      });
      store.save(lineup);
      syncBoxSummary(box.id);
      insertEvent({
        recordId: box.id,
        collection: 'tourBoxes',
        action: '临场替换',
        status: box.status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: {
          replacementId: replacement.id,
          slotId,
          originalItemId: replacement.originalItemId,
          newItemId
        }
      });
      res.status(201).json({ box: loadBox(box.id), lineup: store.getActive(box.id) });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/tourBoxes/:id/replacements/:replacementId/confirm —— 确认替换。
  router.post('/:id/replacements/:replacementId/confirm', (req, res, next) => {
    try {
      const box = loadBox(req.params.id);
      if (box.status === '已闭环') throw rules.fail(409, '该单已结束，不能再确认替换');
      const lineup = store.getActive(box.id);
      if (!lineup) throw rules.fail(409, '该装箱单尚未冻结阵容名单');
      const replacement = rules.confirmReplacement(
        lineup,
        req.params.replacementId,
        req.body.actor,
        now()
      );
      store.save(lineup);
      syncBoxSummary(box.id);
      insertEvent({
        recordId: box.id,
        collection: 'tourBoxes',
        action: '替换确认',
        status: box.status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: {
          replacementId: replacement.id,
          slotId: replacement.slotId,
          newItemId: replacement.newItemId
        }
      });
      res.json({ box: loadBox(box.id), lineup: store.getActive(box.id) });
    } catch (error) {
      next(error);
    }
  });

  function mergedFields(changes) {
    const fields = { ...(changes.fields || {}), ...changes };
    delete fields.fields;
    delete fields.action;
    delete fields.actor;
    delete fields.note;
    return fields;
  }

  // 通用更新 / 事件写入前的校验：未确认替换未处理完时不能结案。
  function beforeBoxUpdate(box, changes) {
    const nextStatus = changes.status || (changes.fields && changes.fields.status);
    if (nextStatus === '已闭环') {
      rules.assertClosable(store.getActive(box.id));
    }
  }

  // 通用更新 / 事件写入后：巡演日期或剧目变化 → 旧名单失效，按当前有效物品重算。
  function afterBoxUpdate(box, changes, actor) {
    const fields = mergedFields(changes);
    const playChanged = fields.play !== undefined && fields.play !== box.play;
    const dateChanged = fields.tourDate !== undefined && fields.tourDate !== box.tourDate;
    if (!playChanged && !dateChanged) return;
    if (!store.getActive(box.id)) return;
    const reasons = [playChanged ? '剧目' : null, dateChanged ? '巡演日期' : null].filter(Boolean);
    const fresh = loadBox(box.id);
    freezeLineup(fresh, {
      actor: actor || '',
      note: reasons.join('与') + '变化，旧名单失效，按当前有效物品重算',
      onlyUsable: true,
      action: '名单失效重算'
    });
  }

  // 偶头 / 配件档案变化：已发名单不改写，只把对应身位转待复核。
  function afterArchiveChange(collection, itemId, actor) {
    const itemType = collection === 'puppetHeads' ? 'head' : 'accessory';
    for (const lineup of store.findActiveByItem(itemType, itemId)) {
      const count = rules.flagItemSlots(lineup, itemType, itemId);
      if (count === 0) continue;
      store.save(lineup);
      syncBoxSummary(lineup.tourBoxId);
      insertEvent({
        recordId: lineup.tourBoxId,
        collection: 'tourBoxes',
        action: '档案变更待复核',
        status: '',
        actor: actor || '',
        note: count + ' 个身位因档案变化转待复核',
        data: { itemType, itemId, slotCount: count }
      });
    }
  }

  function afterBoxDelete(boxId) {
    store.deleteByBox(boxId);
  }

  return {
    router,
    beforeBoxUpdate,
    afterBoxUpdate,
    afterArchiveChange,
    afterBoxDelete
  };
};
