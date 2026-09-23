// 阵容冻结与临场替换端到端冒烟测试：
//   node scripts/smoke-lineup.js
// 需要 sqlite3 CLI 在 PATH 中（或 SMOKE_SQLITE_DIR 指定目录）。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 3927);
const BASE = 'http://localhost:' + PORT + '/api';
const DATA_DIR = path.join(ROOT, 'data');

let failures = 0;
let passes = 0;
function check(name, cond, extra) {
  if (cond) {
    passes += 1;
    console.log('  PASS  ' + name);
  } else {
    failures += 1;
    console.error('  FAIL  ' + name + (extra !== undefined ? '  => ' + JSON.stringify(extra) : ''));
  }
}

async function call(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
const get = (p) => call('GET', p);
const post = (p, b = {}) => call('POST', p, b);
const patch = (p, b = {}) => call('PATCH', p, b);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const sqliteDir = process.env.SMOKE_SQLITE_DIR || '/tmp/bin';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PATH: sqliteDir + ':' + process.env.PATH, PORT: String(PORT) }
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    const deadline = Date.now() + 15000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch('http://localhost:' + PORT + '/health');
        if (res.status === 200) { healthy = true; break; }
      } catch { /* server not up yet */ }
      await sleep(200);
    }
    check('server starts and /health responds', healthy, serverLog.slice(-500));
    if (!healthy) throw new Error('server failed to start');

    // ---- 档案：4 个偶头 + 3 个配件 ----
    const mk = async (collection, data) => (await post('/' + collection, data)).json;
    const h1 = await mk('puppetHeads', { role: '武生', play: '火焰山', paintStatus: '完好', mechanism: '开口灵活', boxNo: '木箱甲-01' });
    const h2 = await mk('puppetHeads', { role: '武生', play: '火焰山', paintStatus: '完好', mechanism: '开口灵活', boxNo: '木箱甲-02' });
    const h3 = await mk('puppetHeads', { role: '武生', play: '火焰山', paintStatus: '完好', mechanism: '正常', boxNo: '木箱甲-03', status: '待修补', currentUsable: false });
    const h4 = await mk('puppetHeads', { role: '旦角', play: '火焰山', paintStatus: '完好', mechanism: '正常', boxNo: '木箱乙-01' });
    const a1 = await mk('accessories', { name: '红缨冠', role: '武生', play: '火焰山', boxNo: '配件箱-01' });
    const a2 = await mk('accessories', { name: '红缨冠（备）', role: '武生', play: '火焰山', boxNo: '配件箱-02' });
    const a3 = await mk('accessories', { name: '红缨冠（损）', role: '武生', play: '火焰山', boxNo: '配件箱-03', status: '缺损' });
    check('seed heads usable: h1/h2/h4 可演出, h3 待修补',
      h1.status === '可演出' && h2.status === '可演出' && h4.status === '可演出' && h3.status === '待修补');

    // ---- 创建装箱单 ----
    const box = (await post('/tourBoxes', {
      showName: '省城巡演',
      venue: '人民剧场',
      play: '火焰山',
      tourDate: '2026-10-01',
      headIds: [h1.id],
      accessoryIds: [a1.id]
    })).json;
    check('tourBox created as 草稿', box.status === '草稿');

    // ---- 提交巡演：按身位冻结快照 ----
    const submitted = await post('/tourBoxes/' + box.id + '/submit', { actor: '箱头' });
    check('submit -> 201', submitted.status === 201, submitted);
    check('submit moves box 草稿 -> 已装箱', submitted.json.box.status === '已装箱');
    const lineup1 = submitted.json.lineup;
    check('lineup v1 生效中 with 2 slots', lineup1.version === 1 && lineup1.status === '生效中' && lineup1.slots.length === 2, lineup1);
    const slotHead = lineup1.slots.find((s) => s.slotId === 'head-1');
    const slotAcc = lineup1.slots.find((s) => s.slotId === 'accessory-1');
    check('slots per 身位 with frozen snapshots',
      slotHead && slotHead.itemId === h1.id && slotHead.state === '有效' &&
      slotHead.snapshot.paintStatus === '完好' && slotHead.play === '火焰山' && slotHead.role === '武生' &&
      slotAcc && slotAcc.snapshot.name === '红缨冠', slotHead && slotHead.snapshot);

    // ---- 档案变化：只转待复核，不改写已发名单 ----
    await patch('/puppetHeads/' + h1.id, { paintStatus: '鼻尖掉彩' });
    const afterChange = await get('/tourBoxes/' + box.id + '/lineup');
    const headSlotAfter = afterChange.json.lineup.slots.find((s) => s.slotId === 'head-1');
    check('archive change flags slot 待复核', headSlotAfter.state === '待复核', headSlotAfter);
    check('frozen snapshot NOT rewritten', headSlotAfter.snapshot.paintStatus === '完好', headSlotAfter.snapshot);

    // ---- 替换判定：非法替换全部拒绝 ----
    let r;
    r = await post('/tourBoxes/' + box.id + '/replacements', { slotId: 'head-1', newItemId: h3.id });
    check('replacement must be performable (h3 待修补 -> 409)', r.status === 409, r.json);
    r = await post('/tourBoxes/' + box.id + '/replacements', { slotId: 'head-1', newItemId: h4.id });
    check('replacement must same role (h4 旦角 -> 409)', r.status === 409, r.json);
    r = await post('/tourBoxes/' + box.id + '/replacements', { slotId: 'head-1', newItemId: a2.id });
    check('cross-type replacement -> 404', r.status === 404, r.json);
    r = await post('/tourBoxes/' + box.id + '/replacements', { slotId: 'head-1', newItemId: h1.id });
    check('replacement identical to original -> 409', r.status === 409, r.json);
    r = await post('/tourBoxes/' + box.id + '/replacements', { slotId: 'head-9', newItemId: h2.id });
    check('unknown slot -> 404', r.status === 404, r.json);
    r = await post('/tourBoxes/' + box.id + '/replacements', { slotId: 'head-1' });
    check('missing newItemId -> 400', r.status === 400, r.json);

    // ---- 合法临场替换 ----
    r = await post('/tourBoxes/' + box.id + '/replacements', { slotId: 'head-1', newItemId: h2.id, actor: '箱头', note: '临场换头' });
    check('valid replacement head-1 -> h2 (201)', r.status === 201, r.json);
    let active = r.json.lineup;
    let rep1 = active.replacements.find((x) => x.slotId === 'head-1');
    check('replacement starts 待确认, slot 已替换, snapshot captured',
      rep1.status === '待确认' && rep1.newSnapshot.paintStatus === '完好' &&
      active.slots.find((s) => s.slotId === 'head-1').state === '已替换', rep1);
    check('box summary pendingReplacementCount = 1', r.json.box.pendingReplacementCount === 1, r.json.box);

    r = await post('/tourBoxes/' + box.id + '/replacements', { slotId: 'head-1', newItemId: h2.id });
    check('原占位不得再次分配 (second replace -> 409)', r.status === 409, r.json);

    r = await post('/tourBoxes/' + box.id + '/replacements', { slotId: 'accessory-1', newItemId: a3.id });
    check('accessory replacement must 在库 (a3 缺损 -> 409)', r.status === 409, r.json);
    r = await post('/tourBoxes/' + box.id + '/replacements', { slotId: 'accessory-1', newItemId: a2.id, actor: '箱头' });
    check('valid replacement accessory-1 -> a2 (201)', r.status === 201, r.json);
    check('pendingReplacementCount = 2', r.json.box.pendingReplacementCount === 2, r.json.box);
    const rep2 = r.json.lineup.replacements.find((x) => x.slotId === 'accessory-1');

    // ---- 未确认替换：不能结束 ----
    const eventsBefore = (await get('/tourBoxes/' + box.id + '/timeline')).json.events.length;
    r = await post('/tourBoxes/' + box.id + '/events', { status: '已闭环', actor: '箱头' });
    check('events close blocked by pending replacements -> 409', r.status === 409, r.json);
    r = await patch('/tourBoxes/' + box.id, { status: '已闭环' });
    check('PATCH close blocked by pending replacements -> 409', r.status === 409, r.json);
    const eventsAfterBlocked = (await get('/tourBoxes/' + box.id + '/timeline')).json.events.length;
    check('blocked close writes no event and keeps status', eventsBefore === eventsAfterBlocked &&
      (await get('/tourBoxes/' + box.id)).json.status === '已装箱');

    // ---- 确认替换后可结案（先走日期变更重算，再结案）----
    r = await post('/tourBoxes/' + box.id + '/replacements/' + rep1.id + '/confirm', { actor: '班主' });
    check('confirm rep1 -> 200', r.status === 200, r.json);
    r = await post('/tourBoxes/' + box.id + '/replacements/' + rep1.id + '/confirm', { actor: '班主' });
    check('double confirm -> 409', r.status === 409, r.json);
    r = await post('/tourBoxes/' + box.id + '/replacements/' + rep2.id + '/confirm', { actor: '班主' });
    check('confirm rep2 -> 200, pending = 0', r.status === 200 && r.json.box.pendingReplacementCount === 0, r.json);

    // ---- 日期/剧目变化：旧名单失效，按当前有效物品重算 ----
    await patch('/accessories/' + a1.id, { status: '缺损' });
    r = await patch('/tourBoxes/' + box.id, { tourDate: '2026-11-03' });
    check('tourDate patch -> 200', r.status === 200, r.json);
    let lineupDoc = await get('/tourBoxes/' + box.id + '/lineup');
    const v1 = lineupDoc.json.history.find((x) => x.version === 1);
    const v2 = lineupDoc.json.history.find((x) => x.version === 2);
    check('old lineup invalidated, v2 active',
      v1.status === '已失效' && v2.status === '生效中' && lineupDoc.json.lineup.version === 2, lineupDoc.json.history.map((x) => [x.version, x.status]));
    check('v2 recalculated from valid items: h1 kept, a1 dropped',
      v2.slots.length === 1 && v2.slots[0].slotId === 'head-1' && v2.slots[0].itemId === h1.id, v2.slots);
    const tl1 = (await get('/tourBoxes/' + box.id + '/timeline')).json.events;
    const recalcEvent1 = tl1.find((e) => e.action === '名单失效重算');
    check('dropped a1 recorded in recalc event',
      recalcEvent1 && recalcEvent1.data.dropped.some((d) => d.itemId === a1.id), recalcEvent1);
    check('v1 frozen snapshot still intact (paintStatus 完好)',
      v1.slots.find((s) => s.slotId === 'head-1').snapshot.paintStatus === '完好');
    check('v2 snapshot reflects current archive (paintStatus 鼻尖掉彩)',
      v2.slots[0].snapshot.paintStatus === '鼻尖掉彩');

    // 剧目变化（走 events + fields 通道）
    r = await post('/tourBoxes/' + box.id + '/events', { fields: { play: '借扇' }, actor: '班主' });
    check('play change via events -> 200', r.status === 200, r.json);
    lineupDoc = await get('/tourBoxes/' + box.id + '/lineup');
    const v3 = lineupDoc.json.history.find((x) => x.version === 3);
    check('play change invalidates v2 and builds v3',
      v3.status === '生效中' && lineupDoc.json.history.find((x) => x.version === 2).status === '已失效', lineupDoc.json.history.map((x) => [x.version, x.status]));
    check('v3 carries no pending replacements', v3.replacements.length === 0);

    // ---- 状态流转结案 ----
    r = await post('/tourBoxes/' + box.id + '/events', { status: '巡演中' });
    check('move to 巡演中 -> 200', r.status === 200, r.json);
    r = await post('/tourBoxes/' + box.id + '/events', { status: '返场清点中' });
    check('move to 返场清点中 -> 200', r.status === 200, r.json);
    r = await post('/tourBoxes/' + box.id + '/events', { status: '已闭环' });
    check('no pending replacements -> close 已闭环 200', r.status === 200 && r.json.status === '已闭环', r.json);
    r = await post('/tourBoxes/' + box.id + '/replacements', { slotId: 'head-1', newItemId: h2.id });
    check('replacement on closed box -> 409', r.status === 409, r.json);
    r = await post('/tourBoxes/' + box.id + '/submit', {});
    check('resubmit on closed box -> 409', r.status === 409, r.json);

    // ---- 列表与时间线刷新后一致 ----
    const listed = (await get('/tourBoxes')).json.find((x) => x.id === box.id);
    const timelineDoc = (await get('/tourBoxes/' + box.id + '/timeline')).json;
    check('list record status/summary equals timeline record',
      listed.status === timelineDoc.record.status &&
      listed.updatedAt === timelineDoc.record.updatedAt &&
      listed.lineupVersion === timelineDoc.record.lineupVersion &&
      listed.lineupStatus === timelineDoc.record.lineupStatus &&
      listed.pendingReplacementCount === timelineDoc.record.pendingReplacementCount,
      { listed, record: timelineDoc.record });
    const actions = timelineDoc.events.map((e) => e.action);
    for (const expected of ['提交巡演', '阵容冻结', '档案变更待复核', '临场替换', '替换确认', '名单失效重算']) {
      check('timeline contains action: ' + expected, actions.includes(expected), actions);
    }
    check('list summary: v3 生效中, pending 0, 已闭环',
      listed.lineupVersion === 3 && listed.lineupStatus === '生效中' &&
      listed.pendingReplacementCount === 0 && listed.status === '已闭环', listed);
  } catch (error) {
    failures += 1;
    console.error('  FAIL  smoke test crashed:', error);
    console.error(serverLog.slice(-2000));
  } finally {
    server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exitCode = failures ? 1 : 0;
}

main();
