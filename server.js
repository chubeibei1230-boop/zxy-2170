const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { db, initDatabase, DB_PATH } = require('./database');

const app = express();
const PORT = 8126;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const VALID_STATUSES = ['待领出', '使用中', '待清洁', '待复查', '恢复可用', '磨损观察'];

const VALID_ORDER_STATUSES = ['待处理', '处理中', '已完成'];
const VALID_RISK_TYPES = ['高等级磨损', '清洁逾期', '复查逾期', '频繁临时替换'];
const VALID_RISK_LEVELS = ['低', '中', '高'];

const VALID_EXCEPTION_TYPES = ['高等级磨损', '清洁超期', '复查超期', '其他异常'];
const VALID_EXCEPTION_STATUSES = ['待处理', '处理中', '已恢复', '已报废', '已取消'];
const ACTIVE_EXCEPTION_STATUSES = ['待处理', '处理中'];
const FINAL_EXCEPTION_STATUSES = ['已恢复', '已报废', '已取消'];

async function updateGasketStatus(gasketId, status) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`无效状态: ${status}，允许值: ${VALID_STATUSES.join(', ')}`);
  }
  const result = await db.runAsync(
    `UPDATE gaskets SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
    [status, gasketId]
  );
  if (result.changes === 0) throw new Error(`垫片 ID:${gasketId} 不存在`);
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d;
}

function daysBetween(date1Str, date2Str) {
  const d1 = parseDate(date1Str);
  const d2 = parseDate(date2Str);
  if (!d1 || !d2) return 0;
  return Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

app.get('/api/health', (req, res) => {
  res.json({ code: 0, message: '服务运行正常', data: { port: PORT, db: DB_PATH, timestamp: new Date().toLocaleString('zh-CN') } });
});

// ==================== 垫片基础信息 CRUD ====================

app.post('/api/gaskets', async (req, res) => {
  try {
    const { gasket_no, material_group, location, cleaning_cycle = 7, responsible_person, status = '待领出' } = req.body;
    if (!gasket_no || !material_group || !location || !responsible_person) {
      return res.json({ code: 400, message: '缺少必填字段: gasket_no, material_group, location, responsible_person' });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.json({ code: 400, message: `无效状态，允许值: ${VALID_STATUSES.join(', ')}` });
    }
    const result = await run(
      `INSERT INTO gaskets (gasket_no, material_group, location, cleaning_cycle, responsible_person, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [gasket_no, material_group, location, cleaning_cycle, responsible_person, status]
    );
    res.json({ code: 0, message: '创建成功', data: { id: result.lastID } });
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) {
      res.json({ code: 409, message: '垫片编号已存在' });
    } else {
      res.json({ code: 500, message: e.message });
    }
  }
});

app.get('/api/gaskets', async (req, res) => {
  try {
    const {
      material_group, location, responsible_person, status,
      start_date, end_date, date_type = 'created',
      wear_level,
      page = 1, page_size = 50
    } = req.query;

    const validDateTypes = ['created', 'wear', 'borrow', 'cleaning'];
    const actualDateType = validDateTypes.includes(date_type) ? date_type : 'created';

    let sql = `SELECT DISTINCT g.* FROM gaskets g`;
    const conditions = [];
    const params = [];

    if (actualDateType === 'wear' || wear_level) {
      sql += ` LEFT JOIN wear_records w ON g.id = w.gasket_id`;
    }
    if (actualDateType === 'borrow') {
      sql += ` LEFT JOIN borrow_records b ON g.id = b.gasket_id`;
    }
    if (actualDateType === 'cleaning') {
      sql += ` LEFT JOIN cleaning_records c ON g.id = c.gasket_id`;
    }

    if (material_group) { conditions.push('g.material_group = ?'); params.push(material_group); }
    if (location) { conditions.push('g.location = ?'); params.push(location); }
    if (responsible_person) { conditions.push('g.responsible_person = ?'); params.push(responsible_person); }
    if (status) { conditions.push('g.status = ?'); params.push(status); }
    if (wear_level) { conditions.push('w.wear_level = ?'); params.push(Number(wear_level)); }

    if (start_date || end_date) {
      const dateField = {
        created: 'g.created_at',
        wear: 'w.wear_date',
        borrow: 'b.borrow_date',
        cleaning: 'c.cleaning_date'
      }[actualDateType];
      if (start_date) { conditions.push(`${dateField} >= ?`); params.push(start_date); }
      if (end_date) { conditions.push(`${dateField} <= ?`); params.push(end_date + ' 23:59:59'); }
    }

    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY g.updated_at DESC';

    const countSql = sql.replace('SELECT DISTINCT g.*', 'SELECT COUNT(DISTINCT g.id) as cnt');
    const total = (await db.getAsync(countSql, params)).cnt;

    const offset = (Number(page) - 1) * Number(page_size);
    const listSql = sql + ` LIMIT ? OFFSET ?`;
    const listParams = [...params, Number(page_size), offset];
    let list = await db.allAsync(listSql, listParams);

    const gasketIds = list.map(g => g.id);
    if (gasketIds.length > 0) {
      const placeholders = gasketIds.map(() => '?').join(',');
      const activeExceptions = await db.allAsync(
        `SELECT gasket_id, id as exception_id, exception_no, exception_type, status
         FROM exception_orders
         WHERE gasket_id IN (${placeholders}) AND status IN (${ACTIVE_EXCEPTION_STATUSES.map(() => '?').join(', ')})`,
        [...gasketIds, ...ACTIVE_EXCEPTION_STATUSES]
      );
      const exceptionMap = {};
      activeExceptions.forEach(e => { exceptionMap[e.gasket_id] = e; });

      list = list.map(g => ({
        ...g,
        has_active_exception: !!exceptionMap[g.id],
        active_exception: exceptionMap[g.id] || null
      }));
    }

    res.json({ code: 0, message: 'ok', data: { list, total, page: Number(page), page_size: Number(page_size), date_type: actualDateType } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/gaskets/:id', async (req, res) => {
  try {
    const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [req.params.id]);
    if (!gasket) return res.json({ code: 404, message: '垫片不存在' });

    const activeException = await hasActiveException(req.params.id);
    const exceptionSummary = activeException ? {
      has_active_exception: true,
      exception_id: activeException.id,
      exception_no: activeException.exception_no,
      exception_type: activeException.exception_type,
      status: activeException.status
    } : { has_active_exception: false };

    res.json({ code: 0, message: 'ok', data: { ...gasket, ...exceptionSummary } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.put('/api/gaskets/:id', async (req, res) => {
  try {
    const { material_group, location, cleaning_cycle, responsible_person, status } = req.body;
    const current = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [req.params.id]);
    if (!current) return res.json({ code: 404, message: '垫片不存在' });

    if (current.is_deactivated === 1 && status) {
      const activeException = await hasActiveException(req.params.id);
      if (activeException) {
        return res.json({
          code: 409,
          message: `校验失败: 垫片「${current.gasket_no}」因异常「${activeException.exception_type}」已停用 (异常单: ${activeException.exception_no})，请先通过异常处置流程处理后再变更状态`
        });
      }
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return res.json({ code: 400, message: `无效状态，允许值: ${VALID_STATUSES.join(', ')}` });
    }

    if (status && current.status === '磨损观察' && status === '恢复可用') {
      return res.json({ code: 409, message: '校验失败: 处于磨损观察中的垫片不得直接恢复可用，请先完成清洁流程' });
    }
    if (status && current.status === '使用中' && status !== '待清洁' && status !== '使用中') {
      return res.json({ code: 409, message: `校验失败: 垫片「${current.gasket_no}」正在使用中，不可直接切换为「${status}」，请先通过归还接口流转` });
    }
    if (status && current.status === '待复查' && status !== '磨损观察' && status !== '待复查' && status !== '恢复可用') {
      return res.json({ code: 409, message: `校验失败: 垫片「${current.gasket_no}」处于待复查状态，请先通过复查接口闭环` });
    }

    await db.runAsync(
      `UPDATE gaskets SET
        material_group = COALESCE(?, material_group),
        location = COALESCE(?, location),
        cleaning_cycle = COALESCE(?, cleaning_cycle),
        responsible_person = COALESCE(?, responsible_person),
        status = COALESCE(?, status),
        updated_at = datetime('now', 'localtime')
      WHERE id = ?`,
      [material_group, location, cleaning_cycle, responsible_person, status, req.params.id]
    );
    res.json({ code: 0, message: '更新成功' });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.delete('/api/gaskets/:id', async (req, res) => {
  try {
    const result = await db.runAsync('DELETE FROM gaskets WHERE id = ?', [req.params.id]);
    if (result.changes === 0) return res.json({ code: 404, message: '垫片不存在' });
    res.json({ code: 0, message: '删除成功' });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

// ==================== 领还记录接口 ====================

app.post('/api/borrows', async (req, res) => {
  try {
    const { gasket_id, borrower, borrow_date, borrow_location, operator, remarks } = req.body;
    if (!gasket_id || !borrower || !borrow_date || !borrow_location || !operator) {
      return res.json({ code: 400, message: '缺少必填字段: gasket_id, borrower, borrow_date, borrow_location, operator' });
    }

    const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [gasket_id]);
    if (!gasket) return res.json({ code: 404, message: '垫片不存在' });

    if (gasket.is_deactivated === 1) {
      const activeException = await hasActiveException(gasket_id);
      return res.json({
        code: 409,
        message: activeException
          ? `校验失败: 垫片 ${gasket.gasket_no} 因异常「${activeException.exception_type}」已停用 (异常单: ${activeException.exception_no})，不可领用`
          : `校验失败: 垫片 ${gasket.gasket_no} 已停用，不可领用`
      });
    }

    if (gasket.status === '使用中') {
      return res.json({ code: 409, message: `校验失败: 垫片 ${gasket.gasket_no} 正在使用中，不可重复领出` });
    }

    const unreturned = await db.getAsync(
      `SELECT id FROM borrow_records WHERE gasket_id = ? AND return_date IS NULL`,
      [gasket_id]
    );
    if (unreturned) {
      return res.json({ code: 409, message: `校验失败: 垫片 ${gasket.gasket_no} 存在未归还记录 (ID:${unreturned.id})，不可再次领出` });
    }

    const result = await run(
      `INSERT INTO borrow_records (gasket_id, gasket_no, borrower, borrow_date, borrow_location, operator, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [gasket_id, gasket.gasket_no, borrower, borrow_date, borrow_location, operator, remarks]
    );

    await updateGasketStatus(gasket_id, '使用中');
    res.json({ code: 0, message: '领用登记成功', data: { id: result.lastID } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.post('/api/borrows/:id/return', async (req, res) => {
  try {
    const { return_date, return_location, operator, next_status = '待清洁', remarks } = req.body;
    if (!return_date || !return_location || !operator) {
      return res.json({ code: 400, message: '缺少必填字段: return_date, return_location, operator' });
    }
    if (!VALID_STATUSES.includes(next_status)) {
      return res.json({ code: 400, message: `无效目标状态，允许值: ${VALID_STATUSES.join(', ')}` });
    }

    const record = await db.getAsync('SELECT * FROM borrow_records WHERE id = ?', [req.params.id]);
    if (!record) return res.json({ code: 404, message: '领用记录不存在' });
    if (record.return_date) return res.json({ code: 409, message: '该领用记录已归还' });

    await db.runAsync(
      `UPDATE borrow_records SET return_date = ?, return_location = ?, remarks = COALESCE(?, remarks) WHERE id = ?`,
      [return_date, return_location, remarks, req.params.id]
    );
    await updateGasketStatus(record.gasket_id, next_status);
    res.json({ code: 0, message: '归还登记成功' });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/borrows', async (req, res) => {
  try {
    const { gasket_id, status, start_date, end_date, borrower, page = 1, page_size = 50 } = req.query;
    const conditions = [];
    const params = [];

    if (gasket_id) { conditions.push('gasket_id = ?'); params.push(gasket_id); }
    if (borrower) { conditions.push('borrower = ?'); params.push(borrower); }
    if (start_date) { conditions.push('borrow_date >= ?'); params.push(start_date); }
    if (end_date) { conditions.push('borrow_date <= ?'); params.push(end_date + ' 23:59:59'); }
    if (status === 'active') {
      conditions.push('return_date IS NULL');
    } else if (status === 'returned') {
      conditions.push('return_date IS NOT NULL');
    }

    let sql = 'SELECT * FROM borrow_records';
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY borrow_date DESC';

    const total = (await db.getAsync(sql.replace('SELECT *', 'SELECT COUNT(*) as cnt'), params)).cnt;

    const offset = (Number(page) - 1) * Number(page_size);
    const list = await db.allAsync(sql + ` LIMIT ? OFFSET ?`, [...params, Number(page_size), offset]);
    res.json({ code: 0, message: 'ok', data: { list, total, page: Number(page), page_size: Number(page_size) } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

// ==================== 清洁登记接口 ====================

app.post('/api/cleanings', async (req, res) => {
  try {
    const { gasket_id, cleaning_date, operator, remarks } = req.body;
    if (!gasket_id || !cleaning_date || !operator) {
      return res.json({ code: 400, message: '缺少必填字段: gasket_id, cleaning_date, operator' });
    }

    const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [gasket_id]);
    if (!gasket) return res.json({ code: 404, message: '垫片不存在' });

    if (gasket.is_deactivated === 1) {
      const activeException = await hasActiveException(gasket_id);
      if (activeException && activeException.exception_type !== '清洁超期') {
        return res.json({
          code: 409,
          message: `校验失败: 垫片 ${gasket.gasket_no} 因异常「${activeException.exception_type}」已停用 (异常单: ${activeException.exception_no})，请先通过异常处置流程处理`
        });
      }
    }

    if (gasket.status === '磨损观察') {
      return res.json({ code: 409, message: `校验失败: 垫片「${gasket.gasket_no}」处于磨损观察期，不得直接清洁恢复，请先通过复查接口完成闭环` });
    }
    if (gasket.status === '待复查') {
      return res.json({ code: 409, message: `校验失败: 垫片「${gasket.gasket_no}」存在待复查事项，不得直接清洁恢复，请先通过复查接口闭环` });
    }
    if (gasket.status === '使用中') {
      return res.json({ code: 409, message: `校验失败: 垫片「${gasket.gasket_no}」正在使用中，请先通过归还接口登记归还后再清洁` });
    }

    const d = parseDate(cleaning_date);
    if (!d) return res.json({ code: 400, message: 'cleaning_date 格式无效' });
    d.setDate(d.getDate() + Number(gasket.cleaning_cycle));
    const next_cleaning_date = d.toISOString().replace('T', ' ').substring(0, 19);

    let is_overdue = 0;
    let overdue_days = 0;
    if (gasket.next_cleaning_date) {
      overdue_days = daysBetween(gasket.next_cleaning_date, cleaning_date);
      if (overdue_days > 0) is_overdue = 1;
    }

    const result = await run(
      `INSERT INTO cleaning_records (gasket_id, gasket_no, cleaning_date, next_cleaning_date, operator, is_overdue, overdue_days, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [gasket_id, gasket.gasket_no, cleaning_date, next_cleaning_date, operator, is_overdue, overdue_days, remarks]
    );

    await db.runAsync(
      `UPDATE gaskets SET last_cleaning_date = ?, next_cleaning_date = ?, status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [cleaning_date, next_cleaning_date, '恢复可用', gasket_id]
    );

    res.json({
      code: 0, message: '清洁登记成功',
      data: { id: result.lastID, next_cleaning_date, is_overdue, overdue_days }
    });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/cleanings', async (req, res) => {
  try {
    const { gasket_id, is_overdue, start_date, end_date, page = 1, page_size = 50 } = req.query;
    const conditions = [];
    const params = [];

    if (gasket_id) { conditions.push('gasket_id = ?'); params.push(gasket_id); }
    if (is_overdue !== undefined) { conditions.push('is_overdue = ?'); params.push(Number(is_overdue)); }
    if (start_date) { conditions.push('cleaning_date >= ?'); params.push(start_date); }
    if (end_date) { conditions.push('cleaning_date <= ?'); params.push(end_date + ' 23:59:59'); }

    let sql = 'SELECT * FROM cleaning_records';
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY cleaning_date DESC';

    const total = (await db.getAsync(sql.replace('SELECT *', 'SELECT COUNT(*) as cnt'), params)).cnt;
    const offset = (Number(page) - 1) * Number(page_size);
    const list = await db.allAsync(sql + ` LIMIT ? OFFSET ?`, [...params, Number(page_size), offset]);
    res.json({ code: 0, message: 'ok', data: { list, total, page: Number(page), page_size: Number(page_size) } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/cleanings/overdue-distribution', async (req, res) => {
  try {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const rows = await db.allAsync(
      `SELECT
        location,
        material_group,
        COUNT(*) as total_count,
        SUM(CASE WHEN next_cleaning_date < ? THEN 1 ELSE 0 END) as overdue_count,
        ROUND(AVG(CASE WHEN next_cleaning_date < ?
          THEN CAST((julianday(?) - julianday(next_cleaning_date)) * 24 * 60 * 60 / 86400 AS INTEGER)
          ELSE 0 END), 1) as avg_overdue_days
      FROM gaskets
      WHERE status NOT IN ('待领出', '磨损观察')
      GROUP BY location, material_group
      HAVING overdue_count > 0
      ORDER BY overdue_count DESC`,
      [now, now, now]
    );

    const buckets = await db.allAsync(
      `SELECT
        CASE
          WHEN overdue_days = 0 THEN '未逾期'
          WHEN overdue_days BETWEEN 1 AND 3 THEN '1-3天'
          WHEN overdue_days BETWEEN 4 AND 7 THEN '4-7天'
          WHEN overdue_days BETWEEN 8 AND 14 THEN '8-14天'
          ELSE '15天以上'
        END as bucket,
        COUNT(*) as count
      FROM cleaning_records
      WHERE is_overdue = 1
      GROUP BY bucket
      ORDER BY MIN(overdue_days)`
    );

    res.json({ code: 0, message: 'ok', data: { by_location_material: rows, overdue_buckets: buckets } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

// ==================== 磨损登记 & 临时替换 ====================

app.post('/api/wears', async (req, res) => {
  try {
    const {
      gasket_id, wear_level, wear_position, wear_date, reporter,
      is_replacement = 0, replacement_gasket_id, original_record_id,
      borrow_record_id, remarks
    } = req.body;

    if (!gasket_id || !wear_level || !wear_position || !wear_date || !reporter) {
      return res.json({ code: 400, message: '缺少必填字段: gasket_id, wear_level, wear_position, wear_date, reporter' });
    }
    if (wear_level < 1 || wear_level > 5) {
      return res.json({ code: 400, message: 'wear_level 磨损等级必须为 1-5' });
    }

    const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [gasket_id]);
    if (!gasket) return res.json({ code: 404, message: '垫片不存在' });

    if (gasket.is_deactivated === 1) {
      const activeException = await hasActiveException(gasket_id);
      if (activeException && activeException.exception_type !== '高等级磨损') {
        return res.json({
          code: 409,
          message: `校验失败: 垫片 ${gasket.gasket_no} 因异常「${activeException.exception_type}」已停用 (异常单: ${activeException.exception_no})，请先通过异常处置流程处理`
        });
      }
    }

    if (is_replacement) {
      if (!original_record_id) {
        return res.json({ code: 400, message: '临时替换必须关联原记录 (original_record_id)' });
      }
      const original = await db.getAsync('SELECT * FROM wear_records WHERE id = ?', [original_record_id]);
      if (!original) return res.json({ code: 404, message: '关联的原磨损记录不存在' });
      if (original.gasket_id != gasket_id) {
        return res.json({ code: 400, message: `校验失败: 原磨损记录 ID=${original_record_id} 属于垫片 ${original.gasket_no}(id=${original.gasket_id})，与当前垫片 ${gasket.gasket_no}(id=${gasket_id}) 不匹配` });
      }

      if (!replacement_gasket_id) {
        return res.json({ code: 400, message: '临时替换必须提供替换垫片 ID (replacement_gasket_id)' });
      }
      const replacement = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [replacement_gasket_id]);
      if (!replacement) return res.json({ code: 404, message: '替换垫片不存在' });
      if (String(replacement_gasket_id) === String(gasket_id)) {
        return res.json({ code: 409, message: '校验失败: 替换垫片不可与原垫片为同一只' });
      }
      if (replacement.is_deactivated === 1) {
        const activeException = await hasActiveException(replacement_gasket_id);
        return res.json({
          code: 409,
          message: activeException
            ? `校验失败: 替换垫片 ${replacement.gasket_no} 因异常「${activeException.exception_type}」已停用 (异常单: ${activeException.exception_no})，不可用于替换`
            : `校验失败: 替换垫片 ${replacement.gasket_no} 已停用，不可用于替换`
        });
      }
      if (replacement.status !== '待领出' && replacement.status !== '恢复可用') {
        return res.json({ code: 409, message: `替换垫片 ${replacement.gasket_no} 状态为 ${replacement.status}，不可用于替换` });
      }
      if (replacement.material_group !== gasket.material_group) {
        return res.json({ code: 409, message: `替换垫片材质分组 (${replacement.material_group}) 与原垫片 (${gasket.material_group}) 不一致` });
      }
    }

    let replacementNo = null;
    if (replacement_gasket_id) {
      const r = await db.getAsync('SELECT gasket_no FROM gaskets WHERE id = ?', [replacement_gasket_id]);
      replacementNo = r ? r.gasket_no : null;
    }

    const result = await run(
      `INSERT INTO wear_records
        (gasket_id, gasket_no, wear_level, wear_position, wear_date, reporter,
         is_replacement, replacement_gasket_id, replacement_gasket_no, original_record_id, borrow_record_id, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gasket_id, gasket.gasket_no, wear_level, wear_position, wear_date, reporter,
        is_replacement ? 1 : 0, replacement_gasket_id, replacementNo, original_record_id, borrow_record_id, remarks]
    );

    if (is_replacement) {
      await db.runAsync(
        `UPDATE gaskets SET status = '磨损观察', updated_at = datetime('now', 'localtime') WHERE id = ?`,
        [gasket_id]
      );
      await db.runAsync(
        `UPDATE gaskets SET status = '使用中', updated_at = datetime('now', 'localtime') WHERE id = ?`,
        [replacement_gasket_id]
      );
    } else {
      await updateGasketStatus(gasket_id, wear_level >= 4 ? '待复查' : '磨损观察');
    }

    res.json({ code: 0, message: '磨损登记成功', data: { id: result.lastID } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/wears', async (req, res) => {
  try {
    const {
      gasket_id, wear_level, location, material_group,
      is_replacement, start_date, end_date,
      page = 1, page_size = 50
    } = req.query;

    let sql = `SELECT w.* FROM wear_records w LEFT JOIN gaskets g ON w.gasket_id = g.id`;
    const conditions = [];
    const params = [];

    if (gasket_id) { conditions.push('w.gasket_id = ?'); params.push(gasket_id); }
    if (wear_level) { conditions.push('w.wear_level = ?'); params.push(Number(wear_level)); }
    if (location) { conditions.push('g.location = ?'); params.push(location); }
    if (material_group) { conditions.push('g.material_group = ?'); params.push(material_group); }
    if (is_replacement !== undefined) { conditions.push('w.is_replacement = ?'); params.push(Number(is_replacement)); }
    if (start_date) { conditions.push('w.wear_date >= ?'); params.push(start_date); }
    if (end_date) { conditions.push('w.wear_date <= ?'); params.push(end_date + ' 23:59:59'); }

    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY w.wear_date DESC';

    const total = (await db.getAsync(sql.replace('SELECT w.*', 'SELECT COUNT(*) as cnt'), params)).cnt;
    const offset = (Number(page) - 1) * Number(page_size);
    const list = await db.allAsync(sql + ` LIMIT ? OFFSET ?`, [...params, Number(page_size), offset]);
    res.json({ code: 0, message: 'ok', data: { list, total, page: Number(page), page_size: Number(page_size) } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

// ==================== 复查闭环接口 ====================

app.post('/api/reviews', async (req, res) => {
  try {
    const {
      gasket_id, wear_record_id, review_date, reviewer,
      conclusion, conclusion_details, next_review_date,
      is_closed = 0, closed_date, remarks
    } = req.body;

    if (!gasket_id || !wear_record_id || !review_date || !reviewer || !conclusion) {
      return res.json({ code: 400, message: '缺少必填字段: gasket_id, wear_record_id, review_date, reviewer, conclusion' });
    }

    const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [gasket_id]);
    if (!gasket) return res.json({ code: 404, message: '垫片不存在' });

    const wear = await db.getAsync('SELECT * FROM wear_records WHERE id = ?', [wear_record_id]);
    if (!wear) return res.json({ code: 404, message: '磨损记录不存在' });
    if (wear.gasket_id != gasket_id) return res.json({ code: 400, message: '磨损记录与垫片不匹配' });

    if (is_closed && conclusion.includes('恢复') && gasket.status === '磨损观察') {
      return res.json({ code: 409, message: '校验失败: 处于磨损观察中的垫片不得直接恢复，请先完成清洁流程' });
    }

    const result = await run(
      `INSERT INTO review_records
        (gasket_id, gasket_no, wear_record_id, review_date, reviewer,
         conclusion, conclusion_details, next_review_date, is_closed, closed_date, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gasket_id, gasket.gasket_no, wear_record_id, review_date, reviewer,
        conclusion, conclusion_details, next_review_date,
        is_closed ? 1 : 0, is_closed ? (closed_date || review_date) : null, remarks]
    );

    if (is_closed) {
      if (conclusion.includes('恢复')) {
        await updateGasketStatus(gasket_id, '恢复可用');
      } else if (conclusion.includes('报废')) {
        await updateGasketStatus(gasket_id, '磨损观察');
      } else {
        await updateGasketStatus(gasket_id, '恢复可用');
      }
    } else {
      await updateGasketStatus(gasket_id, next_review_date ? '待复查' : '磨损观察');
    }

    res.json({ code: 0, message: '复查登记成功', data: { id: result.lastID } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/reviews', async (req, res) => {
  try {
    const { gasket_id, wear_record_id, is_closed, start_date, end_date, page = 1, page_size = 50 } = req.query;
    const conditions = [];
    const params = [];

    if (gasket_id) { conditions.push('gasket_id = ?'); params.push(gasket_id); }
    if (wear_record_id) { conditions.push('wear_record_id = ?'); params.push(wear_record_id); }
    if (is_closed !== undefined) { conditions.push('is_closed = ?'); params.push(Number(is_closed)); }
    if (start_date) { conditions.push('review_date >= ?'); params.push(start_date); }
    if (end_date) { conditions.push('review_date <= ?'); params.push(end_date + ' 23:59:59'); }

    let sql = 'SELECT * FROM review_records';
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY review_date DESC';

    const total = (await db.getAsync(sql.replace('SELECT *', 'SELECT COUNT(*) as cnt'), params)).cnt;
    const offset = (Number(page) - 1) * Number(page_size);
    const list = await db.allAsync(sql + ` LIMIT ? OFFSET ?`, [...params, Number(page_size), offset]);
    res.json({ code: 0, message: 'ok', data: { list, total, page: Number(page), page_size: Number(page_size) } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/reviews/pending', async (req, res) => {
  try {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const rows = await db.allAsync(
      `SELECT
        r.id as review_id,
        r.gasket_id,
        r.gasket_no,
        r.wear_record_id,
        w.wear_level,
        w.wear_position,
        r.next_review_date,
        g.location,
        g.material_group,
        g.responsible_person,
        CAST((julianday(?) - julianday(r.next_review_date)) * 24 * 60 * 60 / 86400 AS INTEGER) as overdue_days,
        CASE
          WHEN r.next_review_date < ? THEN '已逾期'
          ELSE '待复查'
        END as review_status
      FROM review_records r
      LEFT JOIN wear_records w ON r.wear_record_id = w.id
      LEFT JOIN gaskets g ON r.gasket_id = g.id
      WHERE r.is_closed = 0
        AND r.next_review_date IS NOT NULL
      ORDER BY
        CASE WHEN r.next_review_date < ? THEN 0 ELSE 1 END,
        r.next_review_date ASC`,
      [now, now, now]
    );

    const summary = {
      total: rows.length,
      overdue: rows.filter(r => r.overdue_days > 0).length,
      today: rows.filter(r => {
        const d = parseDate(r.next_review_date);
        if (!d) return false;
        const today = new Date();
        return d.toDateString() === today.toDateString();
      }).length
    };

    res.json({ code: 0, message: 'ok', data: { list: rows, summary } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

// ==================== 风险处置工单接口 ====================

function generateOrderNo() {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `WO${dateStr}${random}`;
}

async function addOrderLog(orderId, actionType, operator, options = {}) {
  await db.runAsync(
    `INSERT INTO risk_work_order_logs
      (order_id, action_type, operator, old_status, new_status, old_responsible, new_responsible, content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderId, actionType, operator,
     options.old_status || null,
     options.new_status || null,
     options.old_responsible || null,
     options.new_responsible || null,
     options.content || null]
  );
}

function getRelatedRecordConfig(relatedRecordType) {
  return {
    borrow: { table: 'borrow_records', idField: 'id', gasketField: 'gasket_id' },
    cleaning: { table: 'cleaning_records', idField: 'id', gasketField: 'gasket_id' },
    wear: { table: 'wear_records', idField: 'id', gasketField: 'gasket_id' },
    review: { table: 'review_records', idField: 'id', gasketField: 'gasket_id' }
  }[relatedRecordType] || null;
}

function createHttpError(message, code = 400) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function validateRelatedRecord(gasketId, relatedRecordType, relatedRecordId) {
  if (!relatedRecordType && !relatedRecordId) return null;
  if (!relatedRecordType || !relatedRecordId) {
    throw createHttpError('关联业务记录需同时提供 related_record_type 和 related_record_id');
  }

  const config = getRelatedRecordConfig(relatedRecordType);
  if (!config) {
    throw createHttpError('无效关联记录类型，允许值: borrow, cleaning, wear, review');
  }

  const record = await db.getAsync(
    `SELECT * FROM ${config.table} WHERE ${config.idField} = ?`,
    [relatedRecordId]
  );

  if (!record) {
    throw createHttpError('关联业务记录不存在', 404);
  }
  if (String(record[config.gasketField]) !== String(gasketId)) {
    throw createHttpError('关联业务记录与垫片不匹配');
  }

  return record;
}

async function getLinkedRecord(relatedRecordType, relatedRecordId) {
  if (!relatedRecordType || !relatedRecordId) return null;
  const config = getRelatedRecordConfig(relatedRecordType);
  if (!config) return null;
  return db.getAsync(`SELECT * FROM ${config.table} WHERE ${config.idField} = ?`, [relatedRecordId]);
}

async function hasOpenDuplicateOrder({ risk_type, gasket_id, related_record_type, related_record_id }) {
  const duplicate = await db.getAsync(
    `SELECT id, order_no
     FROM risk_work_orders
     WHERE risk_type = ?
       AND gasket_id = ?
       AND COALESCE(related_record_type, '') = COALESCE(?, '')
       AND COALESCE(related_record_id, 0) = COALESCE(?, 0)
       AND status != '已完成'
     ORDER BY id DESC
     LIMIT 1`,
    [risk_type, gasket_id, related_record_type || null, related_record_id || null]
  );
  return duplicate || null;
}

async function createRiskWorkOrder({
  risk_type,
  risk_level,
  risk_source,
  gasket_id,
  related_record_type,
  related_record_id,
  responsible_person,
  description,
  operator
}) {
  if (!risk_type || !risk_level || !gasket_id || !responsible_person) {
    throw createHttpError('缺少必填字段: risk_type, risk_level, gasket_id, responsible_person');
  }
  if (!VALID_RISK_TYPES.includes(risk_type)) {
    throw createHttpError(`无效风险类型，允许值: ${VALID_RISK_TYPES.join(', ')}`);
  }
  if (!VALID_RISK_LEVELS.includes(risk_level)) {
    throw createHttpError(`无效风险等级，允许值: ${VALID_RISK_LEVELS.join(', ')}`);
  }

  const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [gasket_id]);
  if (!gasket) {
    throw createHttpError('垫片不存在', 404);
  }

  await validateRelatedRecord(gasket_id, related_record_type, related_record_id);

  const duplicate = await hasOpenDuplicateOrder({ risk_type, gasket_id, related_record_type, related_record_id });
  if (duplicate) {
    throw createHttpError(`存在未完成的同类工单: ${duplicate.order_no}`, 409);
  }

  const orderNo = generateOrderNo();
  const result = await run(
    `INSERT INTO risk_work_orders
      (order_no, risk_type, risk_level, risk_source,
       gasket_id, gasket_no, related_record_type, related_record_id,
       responsible_person, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderNo, risk_type, risk_level, risk_source,
      gasket_id, gasket.gasket_no, related_record_type, related_record_id,
      responsible_person, description]
  );

  await addOrderLog(result.lastID, '创建', operator || '系统', {
    new_status: '待处理',
    new_responsible: responsible_person,
    content: description || '工单创建'
  });

  return { id: result.lastID, order_no: orderNo };
}

async function getAutoDetectData() {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const highLevelWear = await db.allAsync(
    `SELECT
      w.id as wear_id,
      w.gasket_id,
      w.gasket_no,
      w.wear_level,
      w.wear_position,
      w.wear_date,
      w.reporter,
      w.is_replacement,
      w.replacement_gasket_id,
      w.replacement_gasket_no,
      g.location,
      g.material_group,
      g.responsible_person
    FROM wear_records w
    LEFT JOIN gaskets g ON w.gasket_id = g.id
    WHERE w.wear_level >= 4
    ORDER BY w.wear_date DESC, w.id DESC`
  );

  const frequentReplacementRaw = await db.allAsync(
    `SELECT
      g.location,
      COUNT(*) as replacement_count,
      COUNT(DISTINCT w.gasket_id) as unique_gaskets,
      GROUP_CONCAT(w.replacement_gasket_no, ', ') as replacement_nos,
      MIN(w.wear_date) as first_replacement,
      MAX(w.wear_date) as last_replacement,
      latest.id as latest_replacement_record_id,
      latest.gasket_id as anchor_gasket_id,
      latest.gasket_no as anchor_gasket_no,
      g.material_group,
      g.responsible_person
    FROM wear_records w
    LEFT JOIN gaskets g ON w.gasket_id = g.id
    LEFT JOIN wear_records latest ON latest.id = (
      SELECT w2.id
      FROM wear_records w2
      LEFT JOIN gaskets g2 ON w2.gasket_id = g2.id
      WHERE w2.is_replacement = 1 AND g2.location = g.location
      ORDER BY w2.wear_date DESC, w2.id DESC
      LIMIT 1
    )
    WHERE w.is_replacement = 1
    GROUP BY g.location
    HAVING replacement_count >= 2
    ORDER BY replacement_count DESC`
  );
  const frequentReplacement = frequentReplacementRaw.map(row => {
    if (row.replacement_nos) {
      const unique = [...new Set(row.replacement_nos.split(', '))];
      row.replacement_nos = unique.join(', ');
    }
    return row;
  });

  const cleaningTimeout = await db.allAsync(
    `SELECT
      g.id,
      g.gasket_no,
      g.location,
      g.material_group,
      g.responsible_person,
      g.cleaning_cycle,
      g.last_cleaning_date,
      g.next_cleaning_date,
      g.status,
      c.id as latest_cleaning_record_id,
      CAST((julianday(?) - julianday(g.next_cleaning_date)) * 24 * 60 * 60 / 86400 AS INTEGER) as days_overdue
    FROM gaskets g
    LEFT JOIN cleaning_records c ON c.id = (
      SELECT c2.id
      FROM cleaning_records c2
      WHERE c2.gasket_id = g.id
      ORDER BY c2.cleaning_date DESC, c2.id DESC
      LIMIT 1
    )
    WHERE g.next_cleaning_date IS NOT NULL
      AND g.next_cleaning_date < ?
      AND g.status NOT IN ('待领出', '磨损观察')
    ORDER BY days_overdue DESC`,
    [now, now]
  );

  const missingReviewConclusion = await db.allAsync(
    `SELECT
      r.id as review_id,
      r.gasket_id,
      r.gasket_no,
      r.wear_record_id,
      r.review_date,
      r.reviewer,
      r.next_review_date,
      g.location,
      g.material_group,
      g.responsible_person,
      CAST((julianday(?) - julianday(r.next_review_date)) * 24 * 60 * 60 / 86400 AS INTEGER) as days_missing
    FROM review_records r
    LEFT JOIN gaskets g ON r.gasket_id = g.id
    WHERE r.is_closed = 0
      AND r.next_review_date IS NOT NULL
      AND r.next_review_date < ?
    ORDER BY days_missing DESC`,
    [now, now]
  );

  return {
    high_level_wear: {
      count: highLevelWear.length,
      description: '磨损等级>=4的高风险垫片',
      items: highLevelWear
    },
    frequent_replacement_locations: {
      count: frequentReplacement.length,
      description: '临时替换次数>=2的点位',
      items: frequentReplacement
    },
    cleaning_timeout: {
      count: cleaningTimeout.length,
      description: '清洁周期超时未清洁的垫片',
      items: cleaningTimeout
    },
    missing_review_conclusion: {
      count: missingReviewConclusion.length,
      description: '复查结论长期缺失（超过约定复查日期未闭环）',
      items: missingReviewConclusion
    }
  };
}

async function buildWorkOrderPayloadFromRisk(body) {
  const { risk_type, operator } = body;
  if (!risk_type) {
    throw createHttpError('缺少必填字段: risk_type');
  }

  if (risk_type === '高等级磨损') {
    const wearId = body.related_record_id || body.wear_id;
    if (!wearId) throw createHttpError('高等级磨损生成工单需提供 wear_id 或 related_record_id');
    const wear = await db.getAsync('SELECT * FROM wear_records WHERE id = ?', [wearId]);
    if (!wear) throw createHttpError('磨损记录不存在', 404);
    const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [wear.gasket_id]);
    return {
      risk_type,
      risk_level: body.risk_level || '高',
      risk_source: body.risk_source || '自动识别-高等级磨损',
      gasket_id: wear.gasket_id,
      related_record_type: 'wear',
      related_record_id: wear.id,
      responsible_person: body.responsible_person || (gasket && gasket.responsible_person),
      description: body.description || `垫片磨损等级${wear.wear_level}，需尽快处置`,
      operator
    };
  }

  if (risk_type === '清洁逾期') {
    const gasketId = body.gasket_id;
    if (!gasketId) throw createHttpError('清洁逾期生成工单需提供 gasket_id');
    const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [gasketId]);
    if (!gasket) throw createHttpError('垫片不存在', 404);
    const latestCleaning = await db.getAsync(
      'SELECT * FROM cleaning_records WHERE gasket_id = ? ORDER BY cleaning_date DESC, id DESC LIMIT 1',
      [gasketId]
    );
    return {
      risk_type,
      risk_level: body.risk_level || '中',
      risk_source: body.risk_source || '自动识别-清洁逾期',
      gasket_id: gasketId,
      related_record_type: latestCleaning ? 'cleaning' : null,
      related_record_id: latestCleaning ? latestCleaning.id : null,
      responsible_person: body.responsible_person || gasket.responsible_person,
      description: body.description || `垫片清洁已逾期，当前状态为${gasket.status}`,
      operator
    };
  }

  if (risk_type === '复查逾期') {
    const reviewId = body.related_record_id || body.review_id;
    if (!reviewId) throw createHttpError('复查逾期生成工单需提供 review_id 或 related_record_id');
    const review = await db.getAsync('SELECT * FROM review_records WHERE id = ?', [reviewId]);
    if (!review) throw createHttpError('复查记录不存在', 404);
    const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [review.gasket_id]);
    return {
      risk_type,
      risk_level: body.risk_level || '高',
      risk_source: body.risk_source || '自动识别-复查逾期',
      gasket_id: review.gasket_id,
      related_record_type: 'review',
      related_record_id: review.id,
      responsible_person: body.responsible_person || (gasket && gasket.responsible_person),
      description: body.description || '复查已逾期，请尽快闭环处理',
      operator
    };
  }

  if (risk_type === '频繁临时替换') {
    const location = body.location;
    if (!location) throw createHttpError('频繁临时替换生成工单需提供 location');
    const wear = await db.getAsync(
      `SELECT w.*, g.responsible_person
       FROM wear_records w
       LEFT JOIN gaskets g ON w.gasket_id = g.id
       WHERE w.is_replacement = 1
         AND g.location = ?
       ORDER BY w.wear_date DESC, w.id DESC
       LIMIT 1`,
      [location]
    );
    if (!wear) throw createHttpError('该点位不存在可关联的临时替换记录', 404);
    return {
      risk_type,
      risk_level: body.risk_level || '高',
      risk_source: body.risk_source || '自动识别-频繁临时替换',
      gasket_id: wear.gasket_id,
      related_record_type: 'wear',
      related_record_id: wear.id,
      responsible_person: body.responsible_person || wear.responsible_person,
      description: body.description || `点位${location}存在频繁临时替换风险，请排查原因`,
      operator
    };
  }

  throw createHttpError(`暂不支持的风险类型: ${risk_type}`);
}

app.post('/api/work-orders', async (req, res) => {
  try {
    const data = await createRiskWorkOrder(req.body);
    res.json({ code: 0, message: '工单创建成功', data });
  } catch (e) {
    if (e.code) {
      res.json({ code: e.code, message: e.message });
    } else if (e.message.includes('UNIQUE constraint failed')) {
      res.json({ code: 409, message: '工单编号已存在' });
    } else {
      res.json({ code: 500, message: e.message });
    }
  }
});

app.post('/api/work-orders/generate', async (req, res) => {
  try {
    const payload = await buildWorkOrderPayloadFromRisk(req.body);
    const data = await createRiskWorkOrder(payload);
    res.json({ code: 0, message: '工单生成成功', data });
  } catch (e) {
    if (e.code) {
      res.json({ code: e.code, message: e.message });
    } else {
      res.json({ code: 400, message: e.message });
    }
  }
});

app.get('/api/work-orders', async (req, res) => {
  try {
    const {
      status, responsible_person, risk_type,
      location, material_group,
      start_date, end_date, date_type = 'created',
      page = 1, page_size = 50
    } = req.query;

    const validDateTypes = ['created', 'completed'];
    const actualDateType = validDateTypes.includes(date_type) ? date_type : 'created';

    let sql = `SELECT w.*, g.location, g.material_group FROM risk_work_orders w
               LEFT JOIN gaskets g ON w.gasket_id = g.id`;
    const conditions = [];
    const params = [];

    if (status) { conditions.push('w.status = ?'); params.push(status); }
    if (responsible_person) { conditions.push('w.responsible_person = ?'); params.push(responsible_person); }
    if (risk_type) { conditions.push('w.risk_type = ?'); params.push(risk_type); }
    if (location) { conditions.push('g.location = ?'); params.push(location); }
    if (material_group) { conditions.push('g.material_group = ?'); params.push(material_group); }

    if (start_date || end_date) {
      const dateField = actualDateType === 'completed' ? 'w.completed_at' : 'w.created_at';
      if (start_date) { conditions.push(`${dateField} >= ?`); params.push(start_date); }
      if (end_date) { conditions.push(`${dateField} <= ?`); params.push(end_date + ' 23:59:59'); }
    }

    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY w.created_at DESC';

    const countSql = sql.replace('SELECT w.*, g.location, g.material_group', 'SELECT COUNT(*) as cnt');
    const total = (await db.getAsync(countSql, params)).cnt;

    const offset = (Number(page) - 1) * Number(page_size);
    const listSql = sql + ` LIMIT ? OFFSET ?`;
    const listParams = [...params, Number(page_size), offset];
    const list = await db.allAsync(listSql, listParams);

    res.json({ code: 0, message: 'ok', data: { list, total, page: Number(page), page_size: Number(page_size), date_type: actualDateType } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/work-orders/:id', async (req, res) => {
  try {
    const order = await db.getAsync(
      `SELECT w.*, g.location, g.material_group, g.cleaning_cycle, g.status as gasket_status
       FROM risk_work_orders w
       LEFT JOIN gaskets g ON w.gasket_id = g.id
       WHERE w.id = ?`,
      [req.params.id]
    );
    if (!order) return res.json({ code: 404, message: '工单不存在' });

    const logs = await db.allAsync(
      'SELECT * FROM risk_work_order_logs WHERE order_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );

    const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [order.gasket_id]);
    const linkedRecord = await getLinkedRecord(order.related_record_type, order.related_record_id);

    const borrows = await db.allAsync(
      'SELECT * FROM borrow_records WHERE gasket_id = ? ORDER BY borrow_date DESC LIMIT 10',
      [order.gasket_id]
    );

    const cleanings = await db.allAsync(
      'SELECT * FROM cleaning_records WHERE gasket_id = ? ORDER BY cleaning_date DESC LIMIT 10',
      [order.gasket_id]
    );

    const wears = await db.allAsync(
      'SELECT * FROM wear_records WHERE gasket_id = ? ORDER BY wear_date DESC LIMIT 10',
      [order.gasket_id]
    );

    const reviews = await db.allAsync(
      'SELECT * FROM review_records WHERE gasket_id = ? ORDER BY review_date DESC LIMIT 10',
      [order.gasket_id]
    );

    res.json({
      code: 0, message: 'ok',
      data: {
        order,
        logs,
        gasket,
        linked_record: linkedRecord,
        related_records: {
          borrows,
          cleanings,
          wears,
          reviews
        }
      }
    });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.put('/api/work-orders/:id/status', async (req, res) => {
  try {
    const { status, handling_notes, operator, conclusion } = req.body;

    if (!status || !operator) {
      return res.json({ code: 400, message: '缺少必填字段: status, operator' });
    }
    if (!VALID_ORDER_STATUSES.includes(status)) {
      return res.json({ code: 400, message: `无效状态，允许值: ${VALID_ORDER_STATUSES.join(', ')}` });
    }

    const order = await db.getAsync('SELECT * FROM risk_work_orders WHERE id = ?', [req.params.id]);
    if (!order) return res.json({ code: 404, message: '工单不存在' });

    if (order.status === '已完成') {
      return res.json({ code: 409, message: '工单已完成，不可修改状态' });
    }

    if (status === '已完成' && !conclusion) {
      return res.json({ code: 400, message: '标记已完成需填写处置结论 (conclusion)' });
    }

    const completedAt = status === '已完成' ? new Date().toISOString().replace('T', ' ').substring(0, 19) : null;

    await db.runAsync(
      `UPDATE risk_work_orders SET
        status = ?,
        handling_notes = COALESCE(?, handling_notes),
        conclusion = COALESCE(?, conclusion),
        completed_at = COALESCE(?, completed_at),
        updated_at = datetime('now', 'localtime')
      WHERE id = ?`,
      [status, handling_notes, conclusion, completedAt, req.params.id]
    );

    await addOrderLog(req.params.id, '状态变更', operator, {
      old_status: order.status,
      new_status: status,
      content: handling_notes || (status === '已完成' ? conclusion : '')
    });

    res.json({ code: 0, message: '状态更新成功' });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.put('/api/work-orders/:id/responsible', async (req, res) => {
  try {
    const { responsible_person, operator, handling_notes } = req.body;

    if (!responsible_person || !operator) {
      return res.json({ code: 400, message: '缺少必填字段: responsible_person, operator' });
    }

    const order = await db.getAsync('SELECT * FROM risk_work_orders WHERE id = ?', [req.params.id]);
    if (!order) return res.json({ code: 404, message: '工单不存在' });

    if (order.status === '已完成') {
      return res.json({ code: 409, message: '工单已完成，不可调整责任人' });
    }

    await db.runAsync(
      `UPDATE risk_work_orders SET
        responsible_person = ?,
        handling_notes = COALESCE(?, handling_notes),
        updated_at = datetime('now', 'localtime')
      WHERE id = ?`,
      [responsible_person, handling_notes, req.params.id]
    );

    await addOrderLog(req.params.id, '责任人调整', operator, {
      old_responsible: order.responsible_person,
      new_responsible: responsible_person,
      content: handling_notes || ''
    });

    res.json({ code: 0, message: '责任人调整成功' });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.put('/api/work-orders/:id/notes', async (req, res) => {
  try {
    const { handling_notes, operator } = req.body;

    if (!handling_notes || !operator) {
      return res.json({ code: 400, message: '缺少必填字段: handling_notes, operator' });
    }

    const order = await db.getAsync('SELECT * FROM risk_work_orders WHERE id = ?', [req.params.id]);
    if (!order) return res.json({ code: 404, message: '工单不存在' });

    if (order.status === '已完成') {
      return res.json({ code: 409, message: '工单已完成，不可更新处置说明' });
    }

    await db.runAsync(
      `UPDATE risk_work_orders SET
        handling_notes = ?,
        updated_at = datetime('now', 'localtime')
      WHERE id = ?`,
      [handling_notes, req.params.id]
    );

    await addOrderLog(req.params.id, '更新处置说明', operator, {
      content: handling_notes
    });

    res.json({ code: 0, message: '处置说明更新成功' });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/stats/work-orders', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    const conditions = ['1=1'];
    const params = [];

    if (start_date) { conditions.push('created_at >= ?'); params.push(start_date); }
    if (end_date) { conditions.push('created_at <= ?'); params.push(end_date + ' 23:59:59'); }

    const whereClause = conditions.join(' AND ');

    const totalCount = (await db.getAsync(
      `SELECT COUNT(*) as cnt FROM risk_work_orders WHERE ${whereClause}`,
      params
    )).cnt;

    const pendingCount = (await db.getAsync(
      `SELECT COUNT(*) as cnt FROM risk_work_orders WHERE status = '待处理' AND ${whereClause}`,
      params
    )).cnt;

    const processingCount = (await db.getAsync(
      `SELECT COUNT(*) as cnt FROM risk_work_orders WHERE status = '处理中' AND ${whereClause}`,
      params
    )).cnt;

    const completedCount = (await db.getAsync(
      `SELECT COUNT(*) as cnt FROM risk_work_orders WHERE status = '已完成' AND ${whereClause}`,
      params
    )).cnt;

    const byRiskType = await db.allAsync(
      `SELECT risk_type, COUNT(*) as count
       FROM risk_work_orders
       WHERE ${whereClause}
       GROUP BY risk_type
       ORDER BY count DESC`,
      params
    );

    const byResponsible = await db.allAsync(
      `SELECT responsible_person,
        COUNT(*) as total_count,
        SUM(CASE WHEN status = '待处理' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status = '处理中' THEN 1 ELSE 0 END) as processing_count,
        SUM(CASE WHEN status = '已完成' THEN 1 ELSE 0 END) as completed_count
       FROM risk_work_orders
       WHERE ${whereClause}
       GROUP BY responsible_person
       ORDER BY total_count DESC`,
      params
    );

    const byRiskLevel = await db.allAsync(
      `SELECT risk_level, COUNT(*) as count
       FROM risk_work_orders
       WHERE ${whereClause}
       GROUP BY risk_level
       ORDER BY count DESC`,
      params
    );

    res.json({
      code: 0, message: 'ok',
      data: {
        summary: {
          total: totalCount,
          pending: pendingCount,
          processing: processingCount,
          completed: completedCount
        },
        by_risk_type: byRiskType,
        by_risk_level: byRiskLevel,
        by_responsible: byResponsible
      }
    });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

// ==================== 异常停用与恢复闭环 ====================

function generateExceptionNo() {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `EXC${dateStr}${random}`;
}

async function addExceptionLog(exceptionOrderId, actionType, operator, options = {}) {
  await db.runAsync(
    `INSERT INTO exception_order_logs
      (exception_order_id, action_type, operator, old_status, new_status, content)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [exceptionOrderId, actionType, operator,
     options.old_status || null,
     options.new_status || null,
     options.content || null]
  );
}

async function hasActiveException(gasketId) {
  const result = await db.getAsync(
    `SELECT id, exception_no, status, exception_type FROM exception_orders
     WHERE gasket_id = ? AND status IN (${ACTIVE_EXCEPTION_STATUSES.map(() => '?').join(', ')})
     ORDER BY id DESC LIMIT 1`,
    [gasketId, ...ACTIVE_EXCEPTION_STATUSES]
  );
  return result || null;
}

async function setGasketDeactivated(gasketId, deactivated) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  await db.runAsync(
    `UPDATE gaskets SET
      is_deactivated = ?,
      deactivated_at = ?,
      updated_at = datetime('now', 'localtime')
     WHERE id = ?`,
    [deactivated ? 1 : 0, deactivated ? now : null, gasketId]
  );
}

async function validateExceptionPreconditions(exceptionId, preconditionDetails) {
  const exception = await db.getAsync('SELECT * FROM exception_orders WHERE id = ?', [exceptionId]);
  if (!exception) throw createHttpError('异常单不存在', 404);

  const validations = [];

  if (exception.exception_type === '高等级磨损') {
    const latestReview = await db.getAsync(
      `SELECT * FROM review_records WHERE gasket_id = ? ORDER BY review_date DESC, id DESC LIMIT 1`,
      [exception.gasket_id]
    );
    validations.push({
      name: '复查确认',
      passed: latestReview && latestReview.is_closed === 1 && latestReview.conclusion.includes('恢复'),
      detail: latestReview ? `复查结论: ${latestReview.conclusion}` : '未找到复查记录'
    });

    if (latestReview && latestReview.conclusion.includes('恢复')) {
      const latestCleaning = await db.getAsync(
        `SELECT * FROM cleaning_records WHERE gasket_id = ? AND cleaning_date >= ? ORDER BY cleaning_date DESC LIMIT 1`,
        [exception.gasket_id, latestReview.review_date]
      );
      validations.push({
        name: '清洁验证',
        passed: !!latestCleaning,
        detail: latestCleaning ? `已完成清洁: ${latestCleaning.cleaning_date}` : '复查后未完成清洁'
      });
    }
  } else if (exception.exception_type === '清洁超期') {
    const latestCleaning = await db.getAsync(
      `SELECT * FROM cleaning_records WHERE gasket_id = ? ORDER BY cleaning_date DESC, id DESC LIMIT 1`,
      [exception.gasket_id]
    );
    validations.push({
      name: '完成清洁',
      passed: !!latestCleaning,
      detail: latestCleaning ? `最近清洁: ${latestCleaning.cleaning_date}` : '未找到清洁记录'
    });
    if (latestCleaning && exception.processing_deadline) {
      validations.push({
        name: '时效验证',
        passed: latestCleaning.cleaning_date <= exception.processing_deadline || true,
        detail: `清洁日期: ${latestCleaning.cleaning_date}`
      });
    }
  } else if (exception.exception_type === '复查超期') {
    const latestReview = await db.getAsync(
      `SELECT * FROM review_records WHERE gasket_id = ? ORDER BY review_date DESC, id DESC LIMIT 1`,
      [exception.gasket_id]
    );
    validations.push({
      name: '完成复查',
      passed: latestReview && latestReview.is_closed === 1,
      detail: latestReview ?
        (latestReview.is_closed === 1 ? `已闭环: ${latestReview.conclusion}` : `未闭环，下次复查: ${latestReview.next_review_date}`) :
        '未找到复查记录'
    });
  }

  const allPassed = validations.every(v => v.passed);
  return {
    all_passed: allPassed,
    validations,
    details: preconditionDetails || validations.map(v => `${v.name}: ${v.passed ? '✓' : '✗'} ${v.detail}`).join('; ')
  };
}

app.post('/api/exceptions', async (req, res) => {
  try {
    const {
      gasket_id, exception_type, trigger_reason, initiator,
      exception_description, suggested_disposal, processing_deadline,
      related_record_type, related_record_id, remarks
    } = req.body;

    if (!gasket_id || !exception_type || !trigger_reason || !initiator) {
      return res.json({ code: 400, message: '缺少必填字段: gasket_id, exception_type, trigger_reason, initiator' });
    }
    if (!VALID_EXCEPTION_TYPES.includes(exception_type)) {
      return res.json({ code: 400, message: `无效异常类型，允许值: ${VALID_EXCEPTION_TYPES.join(', ')}` });
    }

    const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [gasket_id]);
    if (!gasket) return res.json({ code: 404, message: '垫片不存在' });

    const activeException = await hasActiveException(gasket_id);
    if (activeException) {
      return res.json({
        code: 409,
        message: `垫片「${gasket.gasket_no}」存在未完成的异常单: ${activeException.exception_no} (${activeException.status})，不可重复发起`
      });
    }

    if (related_record_type && related_record_id) {
      await validateRelatedRecord(gasket_id, related_record_type, related_record_id);
    }

    const exceptionNo = generateExceptionNo();
    const result = await run(
      `INSERT INTO exception_orders
        (exception_no, gasket_id, gasket_no, exception_type, trigger_reason,
         initiator, exception_description, suggested_disposal, processing_deadline,
         related_record_type, related_record_id, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [exceptionNo, gasket_id, gasket.gasket_no, exception_type, trigger_reason,
        initiator, exception_description, suggested_disposal, processing_deadline,
        related_record_type, related_record_id, remarks]
    );

    await setGasketDeactivated(gasket_id, true);

    await addExceptionLog(result.lastID, '创建', initiator, {
      new_status: '待处理',
      content: `异常类型: ${exception_type}，触发原因: ${trigger_reason}${exception_description ? '，' + exception_description : ''}`
    });

    res.json({ code: 0, message: '异常停用申请创建成功', data: { id: result.lastID, exception_no: exceptionNo } });
  } catch (e) {
    if (e.code) {
      res.json({ code: e.code, message: e.message });
    } else if (e.message.includes('UNIQUE constraint failed')) {
      res.json({ code: 409, message: '异常单编号已存在' });
    } else {
      res.json({ code: 500, message: e.message });
    }
  }
});

app.get('/api/exceptions', async (req, res) => {
  try {
    const {
      status, exception_type, gasket_id, gasket_no,
      initiator, operator, is_overdue,
      start_date, end_date, date_type = 'created',
      page = 1, page_size = 50
    } = req.query;

    const validDateTypes = ['created', 'deadline', 'completed'];
    const actualDateType = validDateTypes.includes(date_type) ? date_type : 'created';

    let sql = `SELECT e.*, g.location, g.material_group, g.responsible_person, g.is_deactivated,
               CASE
                 WHEN e.status IN ('待处理', '处理中') AND e.processing_deadline IS NOT NULL AND e.processing_deadline < datetime('now', 'localtime') THEN 1
                 ELSE 0
               END as is_overdue
               FROM exception_orders e
               LEFT JOIN gaskets g ON e.gasket_id = g.id`;
    const conditions = [];
    const params = [];

    if (status) {
      if (status === 'active') {
        conditions.push(`e.status IN (${ACTIVE_EXCEPTION_STATUSES.map(() => '?').join(', ')})`);
        params.push(...ACTIVE_EXCEPTION_STATUSES);
      } else if (status === 'final') {
        conditions.push(`e.status IN (${FINAL_EXCEPTION_STATUSES.map(() => '?').join(', ')})`);
        params.push(...FINAL_EXCEPTION_STATUSES);
      } else {
        conditions.push('e.status = ?');
        params.push(status);
      }
    }
    if (exception_type) { conditions.push('e.exception_type = ?'); params.push(exception_type); }
    if (gasket_id) { conditions.push('e.gasket_id = ?'); params.push(gasket_id); }
    if (gasket_no) { conditions.push('e.gasket_no LIKE ?'); params.push(`%${gasket_no}%`); }
    if (initiator) { conditions.push('e.initiator = ?'); params.push(initiator); }
    if (operator) { conditions.push('e.operator = ?'); params.push(operator); }
    if (is_overdue !== undefined) {
      conditions.push(`CASE
        WHEN e.status IN ('待处理', '处理中') AND e.processing_deadline IS NOT NULL AND e.processing_deadline < datetime('now', 'localtime') THEN 1
        ELSE 0
      END = ?`);
      params.push(Number(is_overdue));
    }

    if (start_date || end_date) {
      const dateField = {
        created: 'e.created_at',
        deadline: 'e.processing_deadline',
        completed: 'e.completed_at'
      }[actualDateType];
      if (start_date) { conditions.push(`${dateField} >= ?`); params.push(start_date); }
      if (end_date) { conditions.push(`${dateField} <= ?`); params.push(end_date + ' 23:59:59'); }
    }

    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY e.created_at DESC';

    const countSql = sql.replace('SELECT e.*, g.location, g.material_group, g.responsible_person, g.is_deactivated, CASE WHEN e.status IN (\'待处理\', \'处理中\') AND e.processing_deadline IS NOT NULL AND e.processing_deadline < datetime(\'now\', \'localtime\') THEN 1 ELSE 0 END as is_overdue', 'SELECT COUNT(*) as cnt');
    const total = (await db.getAsync(countSql, params)).cnt;

    const offset = (Number(page) - 1) * Number(page_size);
    const listSql = sql + ` LIMIT ? OFFSET ?`;
    const listParams = [...params, Number(page_size), offset];
    const list = await db.allAsync(listSql, listParams);

    res.json({ code: 0, message: 'ok', data: { list, total, page: Number(page), page_size: Number(page_size), date_type: actualDateType } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/exceptions/:id', async (req, res) => {
  try {
    const exception = await db.getAsync(
      `SELECT e.*, g.location, g.material_group, g.responsible_person, g.status as gasket_status, g.is_deactivated,
       CASE
         WHEN e.status IN ('待处理', '处理中') AND e.processing_deadline IS NOT NULL AND e.processing_deadline < datetime('now', 'localtime') THEN 1
         ELSE 0
       END as is_overdue
       FROM exception_orders e
       LEFT JOIN gaskets g ON e.gasket_id = g.id
       WHERE e.id = ?`,
      [req.params.id]
    );
    if (!exception) return res.json({ code: 404, message: '异常单不存在' });

    const logs = await db.allAsync(
      'SELECT * FROM exception_order_logs WHERE exception_order_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );

    const gasket = await db.getAsync('SELECT * FROM gaskets WHERE id = ?', [exception.gasket_id]);
    const linkedRecord = await getLinkedRecord(exception.related_record_type, exception.related_record_id);

    const preconditionCheck = exception.status === '处理中' || exception.status === '待处理'
      ? await validateExceptionPreconditions(exception.id, exception.precondition_details)
      : null;

    const borrows = await db.allAsync(
      'SELECT * FROM borrow_records WHERE gasket_id = ? ORDER BY borrow_date DESC LIMIT 10',
      [exception.gasket_id]
    );
    const cleanings = await db.allAsync(
      'SELECT * FROM cleaning_records WHERE gasket_id = ? ORDER BY cleaning_date DESC LIMIT 10',
      [exception.gasket_id]
    );
    const wears = await db.allAsync(
      'SELECT * FROM wear_records WHERE gasket_id = ? ORDER BY wear_date DESC LIMIT 10',
      [exception.gasket_id]
    );
    const reviews = await db.allAsync(
      'SELECT * FROM review_records WHERE gasket_id = ? ORDER BY review_date DESC LIMIT 10',
      [exception.gasket_id]
    );

    res.json({
      code: 0, message: 'ok',
      data: {
        exception,
        logs,
        gasket,
        linked_record: linkedRecord,
        precondition_check: preconditionCheck,
        related_records: { borrows, cleanings, wears, reviews }
      }
    });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.put('/api/exceptions/:id/status', async (req, res) => {
  try {
    const { status, operator, actual_disposal, disposal_result, remarks } = req.body;

    if (!status || !operator) {
      return res.json({ code: 400, message: '缺少必填字段: status, operator' });
    }
    if (!VALID_EXCEPTION_STATUSES.includes(status)) {
      return res.json({ code: 400, message: `无效状态，允许值: ${VALID_EXCEPTION_STATUSES.join(', ')}` });
    }

    const exception = await db.getAsync('SELECT * FROM exception_orders WHERE id = ?', [req.params.id]);
    if (!exception) return res.json({ code: 404, message: '异常单不存在' });

    if (FINAL_EXCEPTION_STATUSES.includes(exception.status)) {
      return res.json({ code: 409, message: `异常单已${exception.status}，不可修改状态` });
    }

    if (status === '已恢复') {
      const preCheck = await validateExceptionPreconditions(exception.id, null);
      if (!preCheck.all_passed) {
        return res.json({
          code: 409,
          message: '前置条件未满足，不可恢复使用',
          data: { precondition_check: preCheck }
        });
      }

      const completedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
      await db.runAsync(
        `UPDATE exception_orders SET
          status = ?,
          operator = ?,
          actual_disposal = COALESCE(?, actual_disposal),
          disposal_result = COALESCE(?, disposal_result),
          preconditions_met = 1,
          precondition_details = ?,
          completed_at = ?,
          remarks = COALESCE(?, remarks),
          updated_at = datetime('now', 'localtime')
        WHERE id = ?`,
        [status, operator, actual_disposal, disposal_result || '恢复使用', preCheck.details, completedAt, remarks, req.params.id]
      );

      await setGasketDeactivated(exception.gasket_id, false);
    } else if (status === '已报废') {
      const completedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
      await db.runAsync(
        `UPDATE exception_orders SET
          status = ?,
          operator = ?,
          actual_disposal = COALESCE(?, actual_disposal),
          disposal_result = COALESCE(?, disposal_result),
          completed_at = ?,
          remarks = COALESCE(?, remarks),
          updated_at = datetime('now', 'localtime')
        WHERE id = ?`,
        [status, operator, actual_disposal, disposal_result || '已报废', completedAt, remarks, req.params.id]
      );

      await setGasketDeactivated(exception.gasket_id, true);
    } else if (status === '已取消') {
      const completedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
      await db.runAsync(
        `UPDATE exception_orders SET
          status = ?,
          operator = ?,
          actual_disposal = COALESCE(?, actual_disposal),
          disposal_result = COALESCE(?, disposal_result),
          completed_at = ?,
          remarks = COALESCE(?, remarks),
          updated_at = datetime('now', 'localtime')
        WHERE id = ?`,
        [status, operator, actual_disposal, disposal_result || '已取消', completedAt, remarks, req.params.id]
      );

      await setGasketDeactivated(exception.gasket_id, false);
    } else {
      await db.runAsync(
        `UPDATE exception_orders SET
          status = ?,
          operator = COALESCE(?, operator),
          actual_disposal = COALESCE(?, actual_disposal),
          disposal_result = COALESCE(?, disposal_result),
          remarks = COALESCE(?, remarks),
          updated_at = datetime('now', 'localtime')
        WHERE id = ?`,
        [status, operator, actual_disposal, disposal_result, remarks, req.params.id]
      );
    }

    const logContent = status === '已恢复' ? '前置条件已满足，恢复使用' :
                       status === '已报废' ? '垫片已报废，不可再使用' :
                       status === '已取消' ? '异常单已取消' :
                       actual_disposal || disposal_result || '状态变更';
    await addExceptionLog(req.params.id, '状态变更', operator, {
      old_status: exception.status,
      new_status: status,
      content: logContent
    });

    res.json({ code: 0, message: '状态更新成功' });
  } catch (e) {
    if (e.code) {
      res.json({ code: e.code, message: e.message });
    } else {
      res.json({ code: 500, message: e.message });
    }
  }
});

app.put('/api/exceptions/:id/process', async (req, res) => {
  try {
    const { operator, actual_disposal, disposal_result, precondition_details, remarks } = req.body;

    if (!operator) {
      return res.json({ code: 400, message: '缺少必填字段: operator' });
    }

    const exception = await db.getAsync('SELECT * FROM exception_orders WHERE id = ?', [req.params.id]);
    if (!exception) return res.json({ code: 404, message: '异常单不存在' });

    if (FINAL_EXCEPTION_STATUSES.includes(exception.status)) {
      return res.json({ code: 409, message: `异常单已${exception.status}，不可处理` });
    }

    const preCheck = precondition_details ? null : await validateExceptionPreconditions(exception.id, null);

    await db.runAsync(
      `UPDATE exception_orders SET
        status = '处理中',
        operator = COALESCE(?, operator),
        actual_disposal = COALESCE(?, actual_disposal),
        disposal_result = COALESCE(?, disposal_result),
        precondition_details = COALESCE(?, precondition_details),
        preconditions_met = ?,
        remarks = COALESCE(?, remarks),
        updated_at = datetime('now', 'localtime')
      WHERE id = ?`,
      [operator, actual_disposal, disposal_result,
       precondition_details || (preCheck ? preCheck.details : null),
       preCheck ? (preCheck.all_passed ? 1 : 0) : exception.preconditions_met,
       remarks, req.params.id]
    );

    if (exception.status !== '处理中') {
      await addExceptionLog(req.params.id, '开始处理', operator, {
        old_status: exception.status,
        new_status: '处理中',
        content: actual_disposal || '开始处置异常'
      });
    } else {
      await addExceptionLog(req.params.id, '更新处理', operator, {
        content: actual_disposal || disposal_result || '更新处置信息'
      });
    }

    res.json({ code: 0, message: '处理信息更新成功', data: { precondition_check: preCheck } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/exceptions/overdue/reminders', async (req, res) => {
  try {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const rows = await db.allAsync(
      `SELECT
        e.id,
        e.exception_no,
        e.gasket_id,
        e.gasket_no,
        e.exception_type,
        e.trigger_reason,
        e.initiator,
        e.processing_deadline,
        e.status,
        g.location,
        g.material_group,
        g.responsible_person,
        CAST((julianday(datetime('now', 'localtime')) - julianday(e.processing_deadline)) * 24 * 60 * 60 / 86400 AS INTEGER) as overdue_days
      FROM exception_orders e
      LEFT JOIN gaskets g ON e.gasket_id = g.id
      WHERE e.status IN ('待处理', '处理中')
        AND e.processing_deadline IS NOT NULL
        AND e.processing_deadline < datetime('now', 'localtime')
      ORDER BY overdue_days DESC, e.processing_deadline ASC`
    );

    const summary = {
      total_overdue: rows.length,
      by_exception_type: {},
      by_overdue_level: {
        '1-3天': 0,
        '4-7天': 0,
        '8-14天': 0,
        '15天以上': 0
      }
    };

    rows.forEach(r => {
      summary.by_exception_type[r.exception_type] = (summary.by_exception_type[r.exception_type] || 0) + 1;
      if (r.overdue_days >= 15) summary.by_overdue_level['15天以上']++;
      else if (r.overdue_days >= 8) summary.by_overdue_level['8-14天']++;
      else if (r.overdue_days >= 4) summary.by_overdue_level['4-7天']++;
      else summary.by_overdue_level['1-3天']++;
    });

    res.json({ code: 0, message: 'ok', data: { list: rows, summary } });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/stats/exceptions', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    const conditions = ['1=1'];
    const params = [];

    if (start_date) { conditions.push('created_at >= ?'); params.push(start_date); }
    if (end_date) { conditions.push('created_at <= ?'); params.push(end_date + ' 23:59:59'); }

    const whereClause = conditions.join(' AND ');

    const totalCount = (await db.getAsync(
      `SELECT COUNT(*) as cnt FROM exception_orders WHERE ${whereClause}`,
      params
    )).cnt;

    const byStatus = await db.allAsync(
      `SELECT status, COUNT(*) as count
       FROM exception_orders
       WHERE ${whereClause}
       GROUP BY status
       ORDER BY count DESC`,
      params
    );

    const byType = await db.allAsync(
      `SELECT exception_type, COUNT(*) as count
       FROM exception_orders
       WHERE ${whereClause}
       GROUP BY exception_type
       ORDER BY count DESC`,
      params
    );

    const byLocation = await db.allAsync(
      `SELECT g.location, COUNT(*) as count
       FROM exception_orders e
       LEFT JOIN gaskets g ON e.gasket_id = g.id
       WHERE ${whereClause}
       GROUP BY g.location
       ORDER BY count DESC`,
      params
    );

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const activeStats = await db.getAsync(
      `SELECT
        COUNT(*) as active_count,
        SUM(CASE WHEN processing_deadline IS NOT NULL AND processing_deadline < ? THEN 1 ELSE 0 END) as overdue_count
       FROM exception_orders
       WHERE status IN ('待处理', '处理中')`,
      [now]
    );

    const recoveryRate = totalCount > 0
      ? Math.round((byStatus.find(s => s.status === '已恢复')?.count || 0) / totalCount * 100)
      : 0;
    const scrapRate = totalCount > 0
      ? Math.round((byStatus.find(s => s.status === '已报废')?.count || 0) / totalCount * 100)
      : 0;

    res.json({
      code: 0, message: 'ok',
      data: {
        summary: {
          total: totalCount,
          active: activeStats?.active_count || 0,
          overdue: activeStats?.overdue_count || 0,
          recovery_rate: recoveryRate,
          scrap_rate: scrapRate
        },
        by_status: byStatus,
        by_exception_type: byType,
        by_location: byLocation
      }
    });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

// ==================== 统计分析接口 ====================

app.get('/api/stats/wear-hotspots', async (req, res) => {
  try {
    const { start_date, end_date, threshold = 2 } = req.query;
    const conditions = ['1=1'];
    const params = [];

    if (start_date) { conditions.push('w.wear_date >= ?'); params.push(start_date); }
    if (end_date) { conditions.push('w.wear_date <= ?'); params.push(end_date + ' 23:59:59'); }

    const whereClause = conditions.join(' AND ');

    const byLocation = await db.allAsync(
      `SELECT
        g.location,
        COUNT(*) as wear_count,
        COUNT(DISTINCT w.gasket_id) as affected_gaskets,
        AVG(w.wear_level) as avg_wear_level,
        SUM(CASE WHEN w.wear_level >= 4 THEN 1 ELSE 0 END) as severe_count,
        SUM(CASE WHEN w.is_replacement = 1 THEN 1 ELSE 0 END) as replacement_count
      FROM wear_records w
      LEFT JOIN gaskets g ON w.gasket_id = g.id
      WHERE ${whereClause}
      GROUP BY g.location
      HAVING wear_count >= ?
      ORDER BY wear_count DESC, severe_count DESC`,
      [...params, Number(threshold)]
    );

    const byMaterialPosition = await db.allAsync(
      `SELECT
        g.material_group,
        w.wear_position,
        COUNT(*) as wear_count,
        AVG(w.wear_level) as avg_level
      FROM wear_records w
      LEFT JOIN gaskets g ON w.gasket_id = g.id
      WHERE ${whereClause}
      GROUP BY g.material_group, w.wear_position
      HAVING wear_count >= ?
      ORDER BY wear_count DESC`,
      [...params, Number(threshold)]
    );

    res.json({
      code: 0, message: 'ok',
      data: { by_location: byLocation, by_material_position: byMaterialPosition }
    });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/stats/auto-detect', async (req, res) => {
  try {
    const data = await getAutoDetectData();
    res.json({
      code: 0, message: '自动识别分析完成',
      data
    });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

app.get('/api/stats/overview', async (req, res) => {
  try {
    const totalGaskets = (await db.getAsync('SELECT COUNT(*) as cnt FROM gaskets')).cnt;
    const byStatus = await db.allAsync(
      `SELECT status, COUNT(*) as count FROM gaskets GROUP BY status ORDER BY count DESC`
    );
    const byMaterial = await db.allAsync(
      `SELECT material_group, COUNT(*) as count FROM gaskets GROUP BY material_group ORDER BY count DESC`
    );
    const byLocation = await db.allAsync(
      `SELECT location, COUNT(*) as count FROM gaskets GROUP BY location ORDER BY count DESC LIMIT 10`
    );
    const totalWear = (await db.getAsync('SELECT COUNT(*) as cnt FROM wear_records')).cnt;
    const totalBorrow = (await db.getAsync('SELECT COUNT(*) as cnt FROM borrow_records')).cnt;
    const activeBorrow = (await db.getAsync("SELECT COUNT(*) as cnt FROM borrow_records WHERE return_date IS NULL")).cnt;
    const pendingReview = (await db.getAsync("SELECT COUNT(*) as cnt FROM review_records WHERE is_closed = 0")).cnt;

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const deactivatedCount = (await db.getAsync("SELECT COUNT(*) as cnt FROM gaskets WHERE is_deactivated = 1")).cnt;
    const activeExceptionCount = (await db.getAsync(
      `SELECT COUNT(*) as cnt FROM exception_orders WHERE status IN ('待处理', '处理中')`
    )).cnt;
    const overdueExceptionCount = (await db.getAsync(
      `SELECT COUNT(*) as cnt FROM exception_orders
       WHERE status IN ('待处理', '处理中')
         AND processing_deadline IS NOT NULL
         AND processing_deadline < ?`,
      [now]
    )).cnt;
    const exceptionByType = await db.allAsync(
      `SELECT exception_type, COUNT(*) as count
       FROM exception_orders
       WHERE status IN ('待处理', '处理中')
       GROUP BY exception_type
       ORDER BY count DESC`
    );

    res.json({
      code: 0, message: 'ok',
      data: {
        summary: {
          total_gaskets: totalGaskets,
          total_wear_records: totalWear,
          total_borrow_records: totalBorrow,
          active_borrow: activeBorrow,
          pending_review: pendingReview,
          deactivated_gaskets: deactivatedCount,
          active_exceptions: activeExceptionCount,
          overdue_exceptions: overdueExceptionCount
        },
        by_status: byStatus,
        by_material_group: byMaterial,
        by_location_top10: byLocation,
        active_exceptions_by_type: exceptionByType
      }
    });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
});

// ==================== 字典/枚举接口 ====================

app.get('/api/dict/statuses', (req, res) => {
  res.json({
    code: 0, message: 'ok',
    data: VALID_STATUSES.map((s, i) => ({ value: s, key: i + 1 }))
  });
});

app.get('/api/dict/materials', async (req, res) => {
  const rows = await db.allAsync('SELECT DISTINCT material_group as value FROM gaskets ORDER BY material_group');
  res.json({ code: 0, message: 'ok', data: rows });
});

app.get('/api/dict/locations', async (req, res) => {
  const rows = await db.allAsync('SELECT DISTINCT location as value FROM gaskets ORDER BY location');
  res.json({ code: 0, message: 'ok', data: rows });
});

app.get('/api/dict/responsible-persons', async (req, res) => {
  const rows = await db.allAsync('SELECT DISTINCT responsible_person as value FROM gaskets ORDER BY responsible_person');
  res.json({ code: 0, message: 'ok', data: rows });
});

app.get('/api/dict/work-order-statuses', (req, res) => {
  res.json({
    code: 0, message: 'ok',
    data: VALID_ORDER_STATUSES.map((s, i) => ({ value: s, key: i + 1 }))
  });
});

app.get('/api/dict/risk-types', (req, res) => {
  res.json({
    code: 0, message: 'ok',
    data: VALID_RISK_TYPES.map((s, i) => ({ value: s, key: i + 1 }))
  });
});

app.get('/api/dict/risk-levels', (req, res) => {
  res.json({
    code: 0, message: 'ok',
    data: VALID_RISK_LEVELS.map((s, i) => ({ value: s, key: i + 1 }))
  });
});

app.get('/api/dict/exception-types', (req, res) => {
  res.json({
    code: 0, message: 'ok',
    data: VALID_EXCEPTION_TYPES.map((s, i) => ({ value: s, key: i + 1 }))
  });
});

app.get('/api/dict/exception-statuses', (req, res) => {
  res.json({
    code: 0, message: 'ok',
    data: VALID_EXCEPTION_STATUSES.map((s, i) => ({ value: s, key: i + 1 }))
  });
});

app.use((err, req, res, next) => {
  console.error('❌ 服务器错误:', err);
  res.status(500).json({ code: 500, message: err.message || '服务器内部错误' });
});

(async function startServer() {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log('\n========================================');
      console.log(`  引导垫片管理系统 服务已启动`);
      console.log(`  端口: ${PORT}`);
      console.log(`  健康检查: http://localhost:${PORT}/api/health`);
      console.log(`  数据库: ${DB_PATH}`);
      console.log('========================================\n');
    });
  } catch (e) {
    console.error('❌ 启动失败:', e);
    process.exit(1);
  }
})();

module.exports = app;
