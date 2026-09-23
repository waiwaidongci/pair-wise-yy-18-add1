# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`。

## 阵容冻结与临场替换

- `POST /api/tourBoxes/:id/submit`：提交巡演，按身位（`head-n` / `accessory-n`）冻结偶头和配件快照，草稿单转为「已装箱」。
- `GET /api/tourBoxes/:id/lineup`：当前生效名单（含身位、冻结快照、替换记录）与历史版本。
- `POST /api/tourBoxes/:id/replacements`：临场替换，入参 `{ slotId, newItemId }`。替换件必须**同剧目、同角色且当前可演出**（偶头「可演出」、配件「在库」）；一个原占位只能替换一次，不得再次分配，替换件也不能与名单内其他物品重复。替换生成「待确认」记录。
- `POST /api/tourBoxes/:id/replacements/:replacementId/confirm`：确认替换。返场清点前若仍存在**未确认替换**，装箱单不能结束（不能流转到「已闭环」）。
- 已发名单的冻结快照不会被改写：偶头或配件档案发生变化时，占用该物品的身位只转为「待复核」，并写入装箱单时间线。
- 巡演日期（`tourDate`）或剧目（`play`）变化后，旧名单立即失效（历史版本保留），按当前有效物品重新计算新名单，失效物品记入 `dropped`。
- 装箱单记录上的 `lineupStatus` / `lineupVersion` / `pendingReplacementCount` 与名单、时间线保持一致。

代码分层：`tourAccess.js`（接入层）、`lineupRules.js`（替换判定与名单计算）、`lineupStore.js`（清单存取）。
