// 阵容名单存取层：lineups 表的增删改查，只负责持久化，不做业务判定。
// 名单按版本保存：同一装箱单每次冻结/重算生成一条新版本，旧版本保留并标记「已失效」。

module.exports = function createLineupStore({ runSql, select, sqlValue, now, randomUUID }) {
  function init() {
    runSql(`
CREATE TABLE IF NOT EXISTS lineups (
  id TEXT PRIMARY KEY,
  tour_box_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  slots TEXT NOT NULL,
  replacements TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lineups_box ON lineups(tour_box_id);
CREATE INDEX IF NOT EXISTS idx_lineups_status ON lineups(status);
`);
  }

  function toLineup(row) {
    return {
      id: row.id,
      tourBoxId: row.tour_box_id,
      version: Number(row.version),
      status: row.status,
      slots: JSON.parse(row.slots || '[]'),
      replacements: JSON.parse(row.replacements || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function listByBox(tourBoxId) {
    return select(
      'SELECT * FROM lineups WHERE tour_box_id = ' + sqlValue(tourBoxId) + ' ORDER BY version DESC;'
    ).map(toLineup);
  }

  function getActive(tourBoxId) {
    const rows = select(
      'SELECT * FROM lineups WHERE tour_box_id = ' + sqlValue(tourBoxId) +
      " AND status = '生效中' ORDER BY version DESC LIMIT 1;"
    );
    return rows[0] ? toLineup(rows[0]) : null;
  }

  function create(tourBoxId, slots) {
    const versions = listByBox(tourBoxId);
    const version = versions.length > 0 ? versions[0].version + 1 : 1;
    const id = randomUUID();
    const timestamp = now();
    const lineup = {
      id,
      tourBoxId,
      version,
      status: '生效中',
      slots,
      replacements: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    runSql(
      'INSERT INTO lineups (id, tour_box_id, version, status, slots, replacements, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue(tourBoxId),
        sqlValue(version),
        sqlValue('生效中'),
        sqlValue(JSON.stringify(slots)),
        sqlValue('[]'),
        sqlValue(timestamp),
        sqlValue(timestamp)
      ].join(', ') +
      ');'
    );
    return lineup;
  }

  function save(lineup) {
    runSql(
      'UPDATE lineups SET status = ' + sqlValue(lineup.status) +
      ', slots = ' + sqlValue(JSON.stringify(lineup.slots)) +
      ', replacements = ' + sqlValue(JSON.stringify(lineup.replacements)) +
      ', updated_at = ' + sqlValue(now()) +
      ' WHERE id = ' + sqlValue(lineup.id) + ';'
    );
  }

  function invalidate(lineup) {
    lineup.status = '已失效';
    save(lineup);
  }

  // 供档案变更钩子使用：找出所有生效名单中占用了某件物品的身位。
  function findActiveByItem(itemType, itemId) {
    return select("SELECT * FROM lineups WHERE status = '生效中';")
      .map(toLineup)
      .filter((lineup) =>
        lineup.slots.some(
          (slot) => slot.itemType === itemType && String(slot.itemId) === String(itemId)
        )
      );
  }

  function deleteByBox(tourBoxId) {
    runSql('DELETE FROM lineups WHERE tour_box_id = ' + sqlValue(tourBoxId) + ';');
  }

  return {
    init,
    listByBox,
    getActive,
    create,
    save,
    invalidate,
    findActiveByItem,
    deleteByBox
  };
};
