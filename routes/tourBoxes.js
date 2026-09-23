// 巡演装箱接入层：参数校验、响应组装，业务判定与存取分别委托 replacements / tourStore。
const express = require('express');
const db = require('../lib/db');
const tourStore = require('../lib/tourStore');
const rules = require('../lib/replacements');

const router = express.Router();

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.frozen !== undefined) {
      const wanted = query.frozen === 'true' || query.frozen === '1';
      if (Boolean(record.roster.frozen) !== wanted) return false;
    }
    if (query.pendingReplacement === 'true' && record.roster.pendingReplacementCount === 0) return false;
    if (query.review === 'true' && record.roster.reviewSlotCount === 0) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit', 'frozen', 'pendingReplacement', 'review'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

// 列表：与详情/时间线共用 presentBox 汇总
router.get('/', (req, res, next) => {
  try {
    let records = tourStore.listBoxes().map(rules.presentBox);
    records = applyQuery(records, req.query);
    const limit = Number(req.query.limit || 0);
    if (limit > 0) records = records.slice(0, limit);
    res.json(records);
  } catch (error) {
    next(error);
  }
});

// 创建草稿装箱单
router.post('/', (req, res, next) => {
  try {
    const created = tourStore.createBox(req.body || {});
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

// 提交巡演：阵容冻结
router.post('/:id/submit', (req, res, next) => {
  try {
    const result = tourStore.freezeBox(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 临场替换申请
router.post('/:id/replacements', (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.slotId || !body.itemType || !body.candidateId) {
      return res.status(400).json({ error: 'slotId、itemType、candidateId 为必填' });
    }
    const result = tourStore.requestReplacement(req.params.id, body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// 替换确认（返场清点以此为据）
router.post('/:id/replacements/:replacementId/confirm', (req, res, next) => {
  try {
    const result = tourStore.confirmReplacement(req.params.id, req.params.replacementId, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 时间线：列表/详情一致的汇总随 record 一并返回
router.get('/:id/timeline', (req, res, next) => {
  try {
    const raw = tourStore.getBox(req.params.id);
    if (!raw) return res.status(404).json({ error: 'not found' });
    const record = rules.presentBox(raw);
    const events = db.listEvents(req.params.id);
    res.json({ record, events });
  } catch (error) {
    next(error);
  }
});

// 详情
router.get('/:id', (req, res, next) => {
  try {
    const raw = tourStore.getBox(req.params.id);
    if (!raw) return res.status(404).json({ error: 'not found' });
    res.json(rules.presentBox(raw));
  } catch (error) {
    next(error);
  }
});

// 草稿/冻结单更新；冻结后名单字段禁写，日期/剧目变更触发失效重算
router.patch('/:id', (req, res, next) => {
  try {
    res.json(tourStore.patchBox(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

// 状态流转事件（如 巡演中→返场清点中→已闭环），未确认替换阻断闭环
router.post('/:id/events', (req, res, next) => {
  try {
    if (!req.body || !req.body.status) {
      return res.status(400).json({ error: 'status 为必填' });
    }
    res.json(tourStore.transitionStatus(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const raw = tourStore.getBox(req.params.id);
    if (!raw) return res.status(404).json({ error: 'not found' });
    db.transaction(() => {
      db.run('DELETE FROM records WHERE collection = ? AND id = ?;', [tourStore.TOUR_COLLECTION, req.params.id]);
      db.run('DELETE FROM events WHERE record_id = ?;', [req.params.id]);
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
