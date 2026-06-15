const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');

const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'gaskets.db');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('❌ 数据库连接失败:', err.message);
  else {
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');
  }
});

db.runAsync = function (sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};
db.getAsync = promisify(db.get).bind(db);
db.allAsync = promisify(db.all).bind(db);
db.execAsync = promisify(db.exec).bind(db);

async function initDatabase() {
  const initSql = `
    CREATE TABLE IF NOT EXISTS gaskets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gasket_no TEXT UNIQUE NOT NULL,
      material_group TEXT NOT NULL,
      location TEXT NOT NULL,
      cleaning_cycle INTEGER NOT NULL DEFAULT 7,
      responsible_person TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '待领出',
      is_deactivated INTEGER NOT NULL DEFAULT 0,
      deactivated_at TEXT,
      is_scrapped INTEGER NOT NULL DEFAULT 0,
      scrapped_at TEXT,
      last_cleaning_date TEXT,
      next_cleaning_date TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS borrow_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gasket_id INTEGER NOT NULL,
      gasket_no TEXT NOT NULL,
      borrower TEXT NOT NULL,
      borrow_date TEXT NOT NULL,
      borrow_location TEXT NOT NULL,
      return_date TEXT,
      return_location TEXT,
      operator TEXT NOT NULL,
      remarks TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (gasket_id) REFERENCES gaskets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cleaning_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gasket_id INTEGER NOT NULL,
      gasket_no TEXT NOT NULL,
      cleaning_date TEXT NOT NULL,
      next_cleaning_date TEXT NOT NULL,
      operator TEXT NOT NULL,
      is_overdue INTEGER DEFAULT 0,
      overdue_days INTEGER DEFAULT 0,
      remarks TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (gasket_id) REFERENCES gaskets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wear_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gasket_id INTEGER NOT NULL,
      gasket_no TEXT NOT NULL,
      wear_level INTEGER NOT NULL CHECK (wear_level BETWEEN 1 AND 5),
      wear_position TEXT NOT NULL,
      wear_date TEXT NOT NULL,
      reporter TEXT NOT NULL,
      is_replacement INTEGER DEFAULT 0,
      replacement_gasket_id INTEGER,
      replacement_gasket_no TEXT,
      original_record_id INTEGER,
      borrow_record_id INTEGER,
      remarks TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (gasket_id) REFERENCES gaskets(id) ON DELETE CASCADE,
      FOREIGN KEY (replacement_gasket_id) REFERENCES gaskets(id),
      FOREIGN KEY (original_record_id) REFERENCES wear_records(id),
      FOREIGN KEY (borrow_record_id) REFERENCES borrow_records(id)
    );

    CREATE TABLE IF NOT EXISTS review_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gasket_id INTEGER NOT NULL,
      gasket_no TEXT NOT NULL,
      wear_record_id INTEGER NOT NULL,
      review_date TEXT NOT NULL,
      reviewer TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      conclusion_details TEXT,
      next_review_date TEXT,
      is_closed INTEGER DEFAULT 0,
      closed_date TEXT,
      remarks TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (gasket_id) REFERENCES gaskets(id) ON DELETE CASCADE,
      FOREIGN KEY (wear_record_id) REFERENCES wear_records(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS risk_work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      risk_type TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      risk_source TEXT,
      gasket_id INTEGER NOT NULL,
      gasket_no TEXT NOT NULL,
      related_record_type TEXT,
      related_record_id INTEGER,
      responsible_person TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '待处理',
      description TEXT,
      handling_notes TEXT,
      conclusion TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (gasket_id) REFERENCES gaskets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS risk_work_order_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      operator TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      old_responsible TEXT,
      new_responsible TEXT,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (order_id) REFERENCES risk_work_orders(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_gaskets_status ON gaskets(status);
    CREATE INDEX IF NOT EXISTS idx_gaskets_material ON gaskets(material_group);
    CREATE INDEX IF NOT EXISTS idx_gaskets_location ON gaskets(location);
    CREATE INDEX IF NOT EXISTS idx_gaskets_responsible ON gaskets(responsible_person);
    CREATE INDEX IF NOT EXISTS idx_borrow_gasket ON borrow_records(gasket_id);
    CREATE INDEX IF NOT EXISTS idx_wear_gasket ON wear_records(gasket_id);
    CREATE INDEX IF NOT EXISTS idx_wear_level ON wear_records(wear_level);
    CREATE INDEX IF NOT EXISTS idx_review_wear ON review_records(wear_record_id);
    CREATE INDEX IF NOT EXISTS idx_review_closed ON review_records(is_closed);
    CREATE INDEX IF NOT EXISTS idx_work_order_status ON risk_work_orders(status);
    CREATE INDEX IF NOT EXISTS idx_work_order_risk_type ON risk_work_orders(risk_type);
    CREATE INDEX IF NOT EXISTS idx_work_order_risk_level ON risk_work_orders(risk_level);
    CREATE INDEX IF NOT EXISTS idx_work_order_responsible ON risk_work_orders(responsible_person);
    CREATE INDEX IF NOT EXISTS idx_work_order_gasket ON risk_work_orders(gasket_id);
    CREATE INDEX IF NOT EXISTS idx_work_order_log_order ON risk_work_order_logs(order_id);

    CREATE TABLE IF NOT EXISTS exception_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exception_no TEXT UNIQUE NOT NULL,
      gasket_id INTEGER NOT NULL,
      gasket_no TEXT NOT NULL,
      exception_type TEXT NOT NULL,
      trigger_reason TEXT NOT NULL,
      initiator TEXT NOT NULL,
      exception_description TEXT,
      suggested_disposal TEXT,
      processing_deadline TEXT,
      status TEXT NOT NULL DEFAULT '待处理',
      actual_disposal TEXT,
      disposal_result TEXT,
      preconditions_met INTEGER DEFAULT 0,
      precondition_details TEXT,
      operator TEXT,
      completed_at TEXT,
      related_record_type TEXT,
      related_record_id INTEGER,
      remarks TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (gasket_id) REFERENCES gaskets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS exception_order_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exception_order_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      operator TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (exception_order_id) REFERENCES exception_orders(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_exception_order_status ON exception_orders(status);
    CREATE INDEX IF NOT EXISTS idx_exception_order_type ON exception_orders(exception_type);
    CREATE INDEX IF NOT EXISTS idx_exception_order_gasket ON exception_orders(gasket_id);
    CREATE INDEX IF NOT EXISTS idx_exception_order_deadline ON exception_orders(processing_deadline);
    CREATE INDEX IF NOT EXISTS idx_exception_order_log_order ON exception_order_logs(exception_order_id);
  `;

  await db.execAsync(initSql);
  console.log('✅ 数据库初始化完成');
  console.log(`📁 数据库文件位置: ${DB_PATH}`);
}

async function runTx(queries) {
  await db.runAsync('BEGIN');
  try {
    for (const q of queries) {
      if (typeof q === 'string') await db.runAsync(q);
      else await db.runAsync(q.sql, q.params);
    }
    await db.runAsync('COMMIT');
  } catch (e) {
    await db.runAsync('ROLLBACK');
    throw e;
  }
}

module.exports = { db, initDatabase, DB_PATH, runTx };
