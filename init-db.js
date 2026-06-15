const { initDatabase, db, DB_PATH } = require('./database');

(async function main() {
  console.log('========================================');
  console.log('  引导垫片管理系统 - 数据库初始化');
  console.log('========================================\n');

  await initDatabase();

  console.log('\n📋 检查并插入示例数据...');

  const gasketCount = (await db.getAsync('SELECT COUNT(*) as cnt FROM gaskets')).cnt;

  if (gasketCount === 0) {
    console.log('  → 检测到空数据库，插入演示数据...');

    const demoGaskets = [
      ['GSK-A001', 'A组-橡胶', '前端入料口-1号', 7, '张伟', '待领出'],
      ['GSK-A002', 'A组-橡胶', '前端入料口-2号', 7, '张伟', '使用中'],
      ['GSK-A003', 'A组-橡胶', '传送中段-3号', 7, '李娜', '使用中'],
      ['GSK-B001', 'B组-聚氨酯', '折弯工位-1号', 14, '王强', '待清洁'],
      ['GSK-B002', 'B组-聚氨酯', '折弯工位-2号', 14, '王强', '待复查'],
      ['GSK-B003', 'B组-聚氨酯', '压合工位-1号', 14, '赵敏', '恢复可用'],
      ['GSK-C001', 'C组-合金', '终检测试台-1号', 30, '刘洋', '磨损观察'],
      ['GSK-C002', 'C组-合金', '终检测试台-2号', 30, '刘洋', '待领出'],
      ['GSK-A004', 'A组-橡胶', '传送中段-4号', 7, '李娜', '使用中'],
      ['GSK-B004', 'B组-聚氨酯', '压合工位-2号', 14, '赵敏', '待领出'],
    ];

    const insertGasket = db.prepare('INSERT INTO gaskets (gasket_no, material_group, location, cleaning_cycle, responsible_person, status) VALUES (?, ?, ?, ?, ?, ?)');
    for (const g of demoGaskets) {
      await new Promise((resolve, reject) => {
        insertGasket.run(...g, function (err) {
          if (err) reject(err);
          else resolve(this);
        });
      });
    }
    console.log(`  → 已插入 ${demoGaskets.length} 条垫片基础数据`);

    const borrowGasket1 = (await db.getAsync('SELECT id FROM gaskets WHERE gasket_no = ?', 'GSK-A002')).id;
    const borrowGasket2 = (await db.getAsync('SELECT id FROM gaskets WHERE gasket_no = ?', 'GSK-A003')).id;
    const borrowGasket3 = (await db.getAsync('SELECT id FROM gaskets WHERE gasket_no = ?', 'GSK-A004')).id;

    await db.runAsync(
      `INSERT INTO borrow_records (gasket_id, gasket_no, borrower, borrow_date, borrow_location, operator, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [borrowGasket1, 'GSK-A002', '张伟', '2026-06-10 08:30:00', '前端入料口-2号', '系统管理员', '生产领用']
    );
    await db.runAsync(
      `INSERT INTO borrow_records (gasket_id, gasket_no, borrower, borrow_date, borrow_location, operator, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [borrowGasket2, 'GSK-A003', '李娜', '2026-06-11 09:15:00', '传送中段-3号', '系统管理员', '轮换领用']
    );
    await db.runAsync(
      `INSERT INTO borrow_records (gasket_id, gasket_no, borrower, borrow_date, borrow_location, operator, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [borrowGasket3, 'GSK-A004', '李娜', '2026-06-12 14:00:00', '传送中段-4号', '系统管理员', '新增领用']
    );
    console.log('  → 已插入演示领还记录');

    const cleanGasket = (await db.getAsync('SELECT id FROM gaskets WHERE gasket_no = ?', 'GSK-B001')).id;
    await db.runAsync(
      `INSERT INTO cleaning_records (gasket_id, gasket_no, cleaning_date, next_cleaning_date, operator, is_overdue, overdue_days, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [cleanGasket, 'GSK-B001', '2026-05-28 10:00:00', '2026-06-11 10:00:00', '王强', 1, 4, '清洁后入库']
    );
    await db.runAsync(
      `UPDATE gaskets SET last_cleaning_date = ?, next_cleaning_date = ? WHERE id = ?`,
      ['2026-05-28 10:00:00', '2026-06-11 10:00:00', cleanGasket]
    );
    console.log('  → 已插入清洁记录');

    const wearGasket1 = (await db.getAsync('SELECT id FROM gaskets WHERE gasket_no = ?', 'GSK-C001')).id;
    const wearGasket2 = (await db.getAsync('SELECT id FROM gaskets WHERE gasket_no = ?', 'GSK-B002')).id;

    const wear1 = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO wear_records (gasket_id, gasket_no, wear_level, wear_position, wear_date, reporter, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [wearGasket1, 'GSK-C001', 3, '左前角', '2026-06-08 16:20:00', '刘洋', '初步磨损登记'],
        function (err) { if (err) reject(err); else resolve(this.lastID); }
      );
    });
    const wear2 = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO wear_records (gasket_id, gasket_no, wear_level, wear_position, wear_date, reporter, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [wearGasket2, 'GSK-B002', 4, '右后角', '2026-06-13 11:45:00', '王强', '明显裂纹需复查'],
        function (err) { if (err) reject(err); else resolve(this.lastID); }
      );
    });

    await db.runAsync(
      `INSERT INTO review_records (gasket_id, gasket_no, wear_record_id, review_date, reviewer, conclusion, conclusion_details, next_review_date, is_closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [wearGasket2, 'GSK-B002', wear2, '2026-06-14 09:00:00', '质检组长', '需继续观察', '裂纹未扩展，建议3日后复查', '2026-06-17 09:00:00', 0]
    );
    await db.runAsync(
      `INSERT INTO review_records (gasket_id, gasket_no, wear_record_id, review_date, reviewer, conclusion, conclusion_details, next_review_date, is_closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [wearGasket1, 'GSK-C001', wear1, '2026-06-09 10:00:00', '质检组长', '转入观察期', '磨损程度中等，每周复查一次', '2026-06-16 10:00:00', 0]
    );
    console.log('  → 已插入磨损登记和复查记录');
    console.log('\n✅ 演示数据初始化完成！\n');
  } else {
    console.log(`  → 数据库已有 ${gasketCount} 条垫片记录，跳过演示数据插入`);
  }

  console.log('========================================');
  console.log(`  数据库文件: ${DB_PATH}`);
  console.log('  启动服务命令: npm start 或 node server.js');
  console.log('  服务端口: 8126');
  console.log('========================================');

  setTimeout(() => process.exit(0), 200);
})();
