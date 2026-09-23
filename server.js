const express = require('express');
const db = require('./lib/db');
const config = require('./project.config');
const tourRouter = require('./routes/tourBoxes');
const tourStore = require('./lib/tourStore');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

// 巡演装箱专用路由（接入层 routes/tourBoxes.js），须先于通用 /api/:collection 注册
app.use('/api/tourBoxes', tourRouter);

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

app.get('/api/:collection', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    let records = db.listRecords(req.params.collection);
    if (req.params.collection === tourStore.TOUR_COLLECTION) {
      records = records.map(tourStore.presentBox);
    }
    records = applyQuery(records, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? records.slice(0, limit) : records);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    if (req.params.collection === tourStore.TOUR_COLLECTION) {
      return next();
    }
    const collectionConfig = db.findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    db.validateRequired(collectionConfig, data);
    const record = db.transaction(() => db.insertRecord(req.params.collection, {
      status,
      data,
      action: req.body.action || '创建',
      actor: req.body.actor || '',
      note: req.body.note || ''
    }));
    res.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(req.params.collection === tourStore.TOUR_COLLECTION ? tourStore.presentBox(record) : record);
  } catch (error) {
    next(error);
  }
});

// 通用 PATCH：偶头/配件档案改动后，冻结中的箱单身位只能转待复核
app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    if (req.params.collection === tourStore.TOUR_COLLECTION) {
      return next();
    }
    db.findCollection(req.params.collection);
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;

    let touched = [];
    const saved = db.transaction(() => {
      const updated = db.updateRecord(req.params.collection, req.params.id, nextData, status, {
        action: req.body.action || '更新',
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
      if (req.params.collection === 'puppetHeads' || req.params.collection === 'accessories') {
        const itemType = req.params.collection === 'puppetHeads' ? 'head' : 'accessory';
        touched = tourStore.notifyArchiveChanged(itemType, req.params.id, req.body.actor || '');
      }
      return updated;
    });
    res.json({ record: saved, rosterReviews: touched });
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    if (req.params.collection === tourStore.TOUR_COLLECTION) {
      return next();
    }
    const collectionConfig = db.findCollection(req.params.collection);
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;

    let touched = [];
    const saved = db.transaction(() => {
      const updated = db.updateRecord(req.params.collection, req.params.id, nextData, status, {
        action: req.body.action || status || '记录',
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
      if (req.params.collection === 'puppetHeads' || req.params.collection === 'accessories') {
        const itemType = req.params.collection === 'puppetHeads' ? 'head' : 'accessory';
        touched = tourStore.notifyArchiveChanged(itemType, req.params.id, req.body.actor || '');
      }
      return updated;
    });
    res.json({ record: saved, rosterReviews: touched });
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = db.listEvents(req.params.id);
    res.json({
      record: req.params.collection === tourStore.TOUR_COLLECTION ? tourStore.presentBox(record) : record,
      events
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    if (req.params.collection === tourStore.TOUR_COLLECTION) {
      return next();
    }
    db.findCollection(req.params.collection);
    db.transaction(() => {
      db.run('DELETE FROM records WHERE collection = ? AND id = ?;', [req.params.collection, req.params.id]);
      db.run('DELETE FROM events WHERE record_id = ?;', [req.params.id]);
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error' });
});

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}).catch((error) => {
  console.error('failed to start database:', error);
  process.exit(1);
});
