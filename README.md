# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱（阵容冻结/临场替换）和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

SQLite数据库（sql.js 落盘）首次启动时创建到 `data/app.db`。

## 巡演装箱：阵容冻结与临场替换

箱单按**身位（slot，对应行当 role）**组织，每个身位挂 1 个偶头与若干配件。

流程：`草稿 --提交--> 已装箱(阵容冻结) --> 巡演中 --> 返场清点中 --> 已闭环`

- `POST /api/tourBoxes` 创建草稿，body 可给显式 `lineup`（`[{slotId, role, head:{itemId}, accessories:[{itemId}]}]`），也兼容旧的 `headIds/accessoryIds`。
- `POST /api/tourBoxes/:id/submit` 提交巡演：按身位保存偶头与配件快照（`frozenAt`、`rosterVersion`），物品同步置为「已装箱」。
- 冻结后名单只读：直接 PATCH `lineup/blockedItemIds/replacements` 等名单字段返回 409；偶头/配件档案变化不会改写已发名单，只把对应身位转为「待复核」（PATCH `/api/puppetHeads/:id` 或 `/api/accessories/:id` 自动触发，响应中带 `rosterReviews`）。
- `POST /api/tourBoxes/:id/replacements` 临场替换：body `{slotId, itemType: head|accessory, candidateId, occupyItemId?, reason}`。候选须**同剧目、同角色、当前可演出**，且未被其他巡演占用；原占位立即进入 `blockedItemIds`，不得再次分配。替换件先锁定为已装箱，名单仍展示原占位，替换单状态为「待确认」。
- `POST /api/tourBoxes/:id/replacements/:rid/confirm` 确认替换：候选上位、原占位释放归库并永久拉黑；替换历史保留在 `replacements`。
- 返场清点闸门：存在「待确认」替换时，箱单不能流转到「已闭环」（409）；闭环时随身物品全部归库。
- `PATCH /api/tourBoxes/:id` 修改 `play` 或 `tourDate`：已冻结名单立即失效（`frozenAt` 清空、版本号递增、写入 `invalidations` 与时间线事件），并按当前有效物品重算身位（改剧目按新剧可演出行当重建，改日期沿用原身位），重算后为草稿，需重新 submit。

列表与详情/时间线统一通过同一份 `roster` 汇总输出：`frozen、frozenAt、rosterVersion、slotCount、pendingReplacementCount、reviewSlotCount、reviewSlots、canClose、slots[]`，保证刷新后一致。列表支持 `frozen=true`、`pendingReplacement=true`、`review=true`、`status`、`search` 过滤。

## 其他常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

## 代码分层

- `routes/tourBoxes.js`：接入层（参数校验、响应、过滤）
- `lib/replacements.js`：替换判定、冻结/重算/闭环闸门等纯逻辑
- `lib/tourStore.js`：清单存取、事务与偶头/配件档案状态联动
- `lib/db.js`：sql.js 持久化与通用记录/事件存取

## 端到端验证

```bash
bash test/e2e.sh
```

覆盖冻结快照、禁写名单、档案变化转待复核、替换四条拒绝规则、未确认替换阻断闭环、原占位拉黑、日期/剧目失效重算、列表与时间线一致性（48 项断言）。
