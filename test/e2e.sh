#!/usr/bin/env bash
set -u
BASE=http://localhost:3914/api
PASS=0; FAIL=0
check() { # desc expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1";
  else FAIL=$((FAIL+1)); echo "FAIL: $1 (expected=$2 actual=$3)"; fi
}
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);const f=new Function('v','return ('+process.argv[1]+')');console.log(f(v))})" "$1"; }

echo "== 1. 创建草稿（显式身位 lineup） =="
RESP=$(curl -s -X POST $BASE/tourBoxes -H 'Content-Type: application/json' -d '{
  "showName":"泉州秋晚","venue":"梨园剧院","play":"火焰山","tourDate":"2026-10-01",
  "lineup":[
    {"slotId":"s1","role":"武生","head":{"itemId":"head-fire-wusheng-a"},"accessories":[{"itemId":"accessory-seed-1"},{"itemId":"accessory-fire-duankao"}]},
    {"slotId":"s2","role":"猴王","head":{"itemId":"head-fire-houwang"},"accessories":[{"itemId":"accessory-fire-zijin"}]}
  ],"actor":"班主"}')
BOX=$(echo "$RESP" | jget "v.id")
echo "box=$BOX"
check "草稿未冻结" false "$(echo "$RESP" | jget "v.roster.frozen")"
check "身位数" 2 "$(echo "$RESP" | jget "v.roster.slotCount")"

echo "== 2. 冻结前直接改名单字段 -> 400 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $BASE/tourBoxes/$BOX -H 'Content-Type: application/json' -d '{"blockedItemIds":["x"]}')
check "托管字段禁写" 400 "$CODE"

echo "== 3. 提交冻结 =="
RESP=$(curl -s -X POST $BASE/tourBoxes/$BOX/submit -H 'Content-Type: application/json' -d '{"actor":"箱头"}')
check "冻结状态" 已装箱 "$(echo "$RESP" | jget "v.status")"
check "已冻结" true "$(echo "$RESP" | jget "v.roster.frozen")"
check "版本号" 1 "$(echo "$RESP" | jget "v.rosterVersion")"
SNAP_PAINT=$(echo "$RESP" | jget "v.roster.slots[0].head.paintStatus")
check "快照含档案字段" 完好 "$SNAP_PAINT"
check "偶头同步已装箱" 已装箱 "$(curl -s $BASE/puppetHeads/head-fire-wusheng-a | jget "v.status")"
check "配件同步已装箱" 已装箱 "$(curl -s $BASE/accessories/accessory-seed-1 | jget "v.status")"

echo "== 4. 重复冻结 -> 409 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/tourBoxes/$BOX/submit -d '{}')
check "重复冻结拒绝" 409 "$CODE"

echo "== 5. 冻结后 PATCH lineup -> 409 且名单不变 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $BASE/tourBoxes/$BOX -H 'Content-Type: application/json' -d '{"lineup":[]}')
check "冻结名单不可改写" 409 "$CODE"
check "名单仍是2身位" 2 "$(curl -s $BASE/tourBoxes/$BOX | jget "v.roster.slotCount")"

echo "== 6. 档案变化 -> 身位转待复核，快照不变 =="
curl -s -X PATCH $BASE/puppetHeads/head-fire-houwang -H 'Content-Type: application/json' -d '{"paintStatus":"额间金漆开裂","status":"待修补","currentUsable":false,"actor":"检场"}' > /dev/null
RESP=$(curl -s $BASE/tourBoxes/$BOX)
check "待复核身位数" 1 "$(echo "$RESP" | jget "v.roster.reviewSlotCount")"
check "待复核身位" s2 "$(echo "$RESP" | jget "v.roster.reviewSlots.join(',')")"
check "快照未被改写" 完好 "$(echo "$RESP" | jget "v.roster.slots[1].head.paintStatus")"

echo "== 7. 替换判定：不同剧目/不同角色/不可演出/已装箱 均拒绝 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/tourBoxes/$BOX/replacements -H 'Content-Type: application/json' -d '{"slotId":"s1","itemType":"head","candidateId":"head-skeleton-bai"}')
check "不同剧目拒绝" 409 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/tourBoxes/$BOX/replacements -H 'Content-Type: application/json' -d '{"slotId":"s1","itemType":"head","candidateId":"head-fire-houwang"}')
check "不同角色拒绝" 409 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/tourBoxes/$BOX/replacements -H 'Content-Type: application/json' -d '{"slotId":"s1","itemType":"head","candidateId":"head-seed-1"}')
check "不可演出拒绝" 409 "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/tourBoxes/$BOX/replacements -H 'Content-Type: application/json' -d '{"slotId":"s1","itemType":"accessory","candidateId":"accessory-fire-duankao"}')
check "本单已占用拒绝" 409 "$CODE"

echo "== 8. 合法替换：武生 B 替武生 A，待确认期间不能闭环 =="
RESP=$(curl -s -X POST $BASE/tourBoxes/$BOX/replacements -H 'Content-Type: application/json' -d '{"slotId":"s1","itemType":"head","candidateId":"head-fire-wusheng-b","reason":"临场掉彩","actor":"箱头"}')
REPID=$(echo "$RESP" | jget "v.replacement.id")
check "替换待确认数" 1 "$(echo "$RESP" | jget "v.box.roster.pendingReplacementCount")"
check "待确认仍展示原占位" head-fire-wusheng-a "$(echo "$RESP" | jget "v.box.roster.slots[0].head.itemId")"
check "候选已锁定装箱" 已装箱 "$(curl -s $BASE/puppetHeads/head-fire-wusheng-b | jget "v.status")"
check "原占位仍占用" 已装箱 "$(curl -s $BASE/puppetHeads/head-fire-wusheng-a | jget "v.status")"
# 推进到返场清点中
curl -s -X POST $BASE/tourBoxes/$BOX/events -H 'Content-Type: application/json' -d '{"status":"巡演中","actor":"箱头"}' > /dev/null
curl -s -X POST $BASE/tourBoxes/$BOX/events -H 'Content-Type: application/json' -d '{"status":"返场清点中","actor":"箱头"}' > /dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/tourBoxes/$BOX/events -H 'Content-Type: application/json' -d '{"status":"已闭环"}')
check "未确认替换阻断闭环" 409 "$CODE"

echo "== 9. 原占位不得再次分配（试图把 A 再用作替换件） =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/tourBoxes/$BOX/replacements -H 'Content-Type: application/json' -d '{"slotId":"s1","itemType":"head","candidateId":"head-fire-wusheng-a"}')
check "原占位再分配拒绝(待确认期)" 409 "$CODE"

echo "== 10. 确认替换后上位、原占位释放且永久拉黑 =="
RESP=$(curl -s -X POST $BASE/tourBoxes/$BOX/replacements/$REPID/confirm -H 'Content-Type: application/json' -d '{"actor":"班主"}')
check "确认后占位为B" head-fire-wusheng-b "$(echo "$RESP" | jget "v.box.roster.slots[0].head.itemId")"
check "待确认清零" 0 "$(echo "$RESP" | jget "v.box.roster.pendingReplacementCount")"
check "已确认替换数" 1 "$(echo "$RESP" | jget "v.box.roster.confirmedReplacementCount")"
check "原占位释放可演出" 可演出 "$(curl -s $BASE/puppetHeads/head-fire-wusheng-a | jget "v.status")"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/tourBoxes/$BOX/replacements -H 'Content-Type: application/json' -d '{"slotId":"s1","itemType":"head","candidateId":"head-fire-wusheng-a"}')
check "换下原占位永久拉黑" 409 "$CODE"

echo "== 11. 全部确认后允许闭环 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/tourBoxes/$BOX/events -H 'Content-Type: application/json' -d '{"status":"已闭环","actor":"班主"}')
check "闭环成功" 200 "$CODE"

echo "== 12. 时间线与列表一致 =="
TL=$(curl -s $BASE/tourBoxes/$BOX/timeline)
LS=$(curl -s -G $BASE/tourBoxes --data-urlencode "search=泉州秋晚")
check "时间线冻结状态一致" true "$(echo "$TL" | jget "v.record.roster.frozen")"
check "时间线版本一致" 1 "$(echo "$TL" | jget "v.record.roster.rosterVersion")"
check "列表待复核数一致" 1 "$(echo "$LS" | jget "v[0].roster.reviewSlotCount")"
check "时间线事件含冻结" true "$(echo "$TL" | jget "v.events.some(e=>e.action==='提交巡演·阵容冻结')")"

echo
echo "========== 第二单：日期/剧目变更失效重算 =========="
RESP=$(curl -s -X POST $BASE/tourBoxes -H 'Content-Type: application/json' -d '{
  "showName":"漳州夜场","venue":"人民会场","play":"火焰山","tourDate":"2026-11-05",
  "lineup":[{"slotId":"s1","role":"武生","head":{"itemId":"head-fire-wusheng-a"},"accessories":[{"itemId":"accessory-seed-1"}]}],"actor":"班主"}')
BOX2=$(echo "$RESP" | jget "v.id")
curl -s -X POST $BASE/tourBoxes/$BOX2/submit -H 'Content-Type: application/json' -d '{"actor":"箱头"}' > /dev/null
check "第二单已冻结" true "$(curl -s $BASE/tourBoxes/$BOX2 | jget "v.roster.frozen")"

echo "== 13. 剧目变更：旧名单失效、按新剧有效物品重算 =="
RESP=$(curl -s -X PATCH $BASE/tourBoxes/$BOX2 -H 'Content-Type: application/json' -d '{"play":"三打白骨精","actor":"班主"}')
check "冻结解除" false "$(echo "$RESP" | jget "v.roster.frozen")"
check "版本递增" 2 "$(echo "$RESP" | jget "v.rosterVersion")"
check "重算选到白骨偶头" head-skeleton-bai "$(echo "$RESP" | jget "v.roster.slots[0].head.itemId")"
check "旧物品释放" 可演出 "$(curl -s $BASE/puppetHeads/head-fire-wusheng-a | jget "v.status")"
check "旧黑名单清空可再分配" 0 "$(echo "$RESP" | jget "v.blockedItemIds.length")"

echo "== 14. 仅日期变更同样失效 =="
REFREEZE=$(curl -s -X POST $BASE/tourBoxes/$BOX2/submit -H 'Content-Type: application/json' -d '{"actor":"箱头"}')
check "重算后可重新冻结" 已装箱 "$(echo "$REFREEZE" | jget "v.status")"
RESP=$(curl -s -X PATCH $BASE/tourBoxes/$BOX2 -H 'Content-Type: application/json' -d '{"tourDate":"2026-12-20","actor":"班主"}')
check "日期变更后冻结解除" false "$(echo "$RESP" | jget "v.roster.frozen")"
check "日期重算保留原偶头" head-skeleton-bai "$(echo "$RESP" | jget "v.roster.slots[0].head.itemId")"
check "日期重算身位非空可再冻结" 1 "$(echo "$RESP" | jget "v.roster.slotCount")"
check "版本再递增" 4 "$(echo "$RESP" | jget "v.rosterVersion")"
check "失效记录数" 2 "$(echo "$RESP" | jget "v.invalidations.length")"
check "时间线记录失效" true "$(curl -s $BASE/tourBoxes/$BOX2/timeline | jget "v.events.some(e=>e.action==='日期/剧目变更·旧名单失效')")"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
