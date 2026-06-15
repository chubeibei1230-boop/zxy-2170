# 引导垫片管理系统 - 数据库初始化说明

## 环境要求
- Node.js >= 16.0.0
- Windows / Linux / macOS

## 安装步骤

### 1. 安装项目依赖
```bash
cd e:\solocode\0615\zxy-2170-1
npm install
```

### 2. 初始化数据库（自动建表 + 插入演示数据）
```bash
npm run init-db
```
或
```bash
node init-db.js
```

### 3. 启动服务
```bash
npm start
```
或
```bash
node server.js
```

服务启动后访问: `http://localhost:8126/api/health`

## 数据库结构

### 表1: gaskets（垫片基础信息）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 主键 |
| gasket_no | TEXT UNIQUE | 垫片编号 |
| material_group | TEXT | 材质分组 |
| location | TEXT | 所属点位 |
| cleaning_cycle | INTEGER | 清洁周期（天） |
| responsible_person | TEXT | 责任人 |
| status | TEXT | 状态 |
| last_cleaning_date | TEXT | 上次清洁日期 |
| next_cleaning_date | TEXT | 下次清洁日期 |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

**状态枚举**: 待领出、使用中、待清洁、待复查、恢复可用、磨损观察

### 表2: borrow_records（领还记录）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 主键 |
| gasket_id | INTEGER FK | 垫片ID |
| gasket_no | TEXT | 垫片编号（冗余） |
| borrower | TEXT | 领用人 |
| borrow_date | TEXT | 领用日期 |
| borrow_location | TEXT | 领用点位 |
| return_date | TEXT | 归还日期 |
| return_location | TEXT | 归还点位 |
| operator | TEXT | 操作人 |
| remarks | TEXT | 备注 |

### 表3: cleaning_records（清洁记录）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 主键 |
| gasket_id | INTEGER FK | 垫片ID |
| gasket_no | TEXT | 垫片编号 |
| cleaning_date | TEXT | 清洁日期 |
| next_cleaning_date | TEXT | 自动计算的下次清洁日期 |
| operator | TEXT | 操作人 |
| is_overdue | INTEGER | 是否逾期清洁 |
| overdue_days | INTEGER | 逾期天数 |
| remarks | TEXT | 备注 |

### 表4: wear_records（磨损登记）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 主键 |
| gasket_id | INTEGER FK | 垫片ID |
| wear_level | INTEGER (1-5) | 磨损等级 |
| wear_position | TEXT | 磨损边角位置 |
| wear_date | TEXT | 登记日期 |
| reporter | TEXT | 登记人 |
| is_replacement | INTEGER | 是否临时替换 |
| replacement_gasket_id | INTEGER FK | 替换垫片ID |
| replacement_gasket_no | TEXT | 替换垫片编号 |
| original_record_id | INTEGER FK | 关联原磨损记录ID |
| borrow_record_id | INTEGER FK | 关联领用记录ID |
| remarks | TEXT | 备注 |

### 表5: review_records（复查记录）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 主键 |
| gasket_id | INTEGER FK | 垫片ID |
| wear_record_id | INTEGER FK | 关联磨损记录ID |
| review_date | TEXT | 复查日期 |
| reviewer | TEXT | 复查人 |
| conclusion | TEXT | 复查结论 |
| conclusion_details | TEXT | 详细说明 |
| next_review_date | TEXT | 下次复查日期 |
| is_closed | INTEGER | 是否已闭环 |
| closed_date | TEXT | 闭环日期 |
| remarks | TEXT | 备注 |

## 业务校验规则

1. **领用校验**: 垫片状态为「使用中」或存在未归还领用记录时，禁止再次领出
2. **临时替换校验**: 必须提供 `original_record_id` 关联原磨损记录；替换垫片状态必须为「待领出/恢复可用」且材质分组一致
3. **观察期恢复校验**: 处于「磨损观察」状态的垫片，复查结论含「恢复」时不得直接恢复，需先完成清洁流程
4. **清洁逾期**: 登记清洁时自动对比上次 `next_cleaning_date` 计算逾期状态

## 数据库文件位置
```
e:\solocode\0615\zxy-2170-1\data\gaskets.db
```

重置数据库只需删除 `data` 文件夹后重新执行 `npm run init-db`。
