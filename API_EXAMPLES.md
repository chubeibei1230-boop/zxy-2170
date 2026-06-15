# 引导垫片管理系统 - 接口调用示例

服务基础地址: `http://localhost:8126/api`

---

## 1. 垫片基础信息

### 1.1 创建垫片
```http
POST /api/gaskets
Content-Type: application/json

{
  "gasket_no": "GSK-D001",
  "material_group": "D组-陶瓷",
  "location": "焊接工位-1号",
  "cleaning_cycle": 21,
  "responsible_person": "孙强",
  "status": "待领出"
}
```

### 1.2 组合筛选查询（核心能力）
```http
GET /api/gaskets?
  material_group=A组-橡胶
  &location=前端入料口-1号
  &responsible_person=张伟
  &status=使用中
  &wear_level=3
  &start_date=2026-06-01
  &end_date=2026-06-15
  &page=1
  &page_size=20
```

### 1.3 查询单个垫片
```http
GET /api/gaskets/1
```

### 1.4 更新垫片
```http
PUT /api/gaskets/1
Content-Type: application/json

{
  "responsible_person": "新责任人",
  "cleaning_cycle": 10
}
```

### 1.5 删除垫片
```http
DELETE /api/gaskets/1
```

---

## 2. 领还管理

### 2.1 领用登记（自动校验使用中）
```http
POST /api/borrows
Content-Type: application/json

{
  "gasket_id": 8,
  "borrower": "刘洋",
  "borrow_date": "2026-06-15 08:00:00",
  "borrow_location": "终检测试台-2号",
  "operator": "系统管理员",
  "remarks": "早班生产领用"
}
```

**预期校验失败示例**（垫片已在使用中）:
```json
{
  "code": 409,
  "message": "校验失败: 垫片 GSK-A002 正在使用中，不可重复领出"
}
```

### 2.2 归还登记（流转状态）
```http
POST /api/borrows/1/return
Content-Type: application/json

{
  "return_date": "2026-06-15 17:30:00",
  "return_location": "备品仓库-入库区",
  "operator": "仓库管理员",
  "next_status": "待清洁",
  "remarks": "表面有污物，需清洁"
}
```

### 2.3 领用记录查询
```http
GET /api/borrows?status=active&borrower=张伟
```
- `status=active`: 未归还
- `status=returned`: 已归还

---

## 3. 清洁管理

### 3.1 清洁登记（自动计算下次清洁日 + 逾期检测）
```http
POST /api/cleanings
Content-Type: application/json

{
  "gasket_id": 4,
  "cleaning_date": "2026-06-15 10:00:00",
  "operator": "王强",
  "remarks": "超声波清洁 + 烘干"
}
```

**响应示例**:
```json
{
  "code": 0,
  "message": "清洁登记成功",
  "data": {
    "id": 2,
    "next_cleaning_date": "2026-06-29 10:00:00",
    "is_overdue": 1,
    "overdue_days": 4
  }
}
```

### 3.2 清洁逾期分布
```http
GET /api/cleanings/overdue-distribution
```
返回按「点位 + 材质分组」的逾期统计和逾期天数分段分布。

---

## 4. 磨损登记 & 临时替换

### 4.1 普通磨损登记（等级≥4 自动转「待复查」）
```http
POST /api/wears
Content-Type: application/json

{
  "gasket_id": 3,
  "wear_level": 4,
  "wear_position": "左后角",
  "wear_date": "2026-06-15 11:30:00",
  "reporter": "李娜",
  "borrow_record_id": 2,
  "remarks": "发现明显裂纹"
}
```

### 4.2 临时替换登记（必须关联原记录）
```http
POST /api/wears
Content-Type: application/json

{
  "gasket_id": 3,
  "wear_level": 5,
  "wear_position": "右前角",
  "wear_date": "2026-06-15 14:00:00",
  "reporter": "李娜",
  "is_replacement": 1,
  "original_record_id": 1,
  "replacement_gasket_id": 10,
  "remarks": "严重磨损，紧急替换"
}
```

**关键校验**:
- 必须传 `original_record_id`，否则返回 400
- 替换垫片状态必须为「待领出/恢复可用」
- 替换垫片与原垫片材质分组必须一致

### 4.3 组合筛选磨损记录
```http
GET /api/wears?
  wear_level=4
  &location=折弯工位-1号
  &is_replacement=0
  &start_date=2026-06-01
  &end_date=2026-06-15
```

---

## 5. 复查闭环

### 5.1 登记复查（未闭环 → 转「待复查」）
```http
POST /api/reviews
Content-Type: application/json

{
  "gasket_id": 6,
  "wear_record_id": 2,
  "review_date": "2026-06-15 15:00:00",
  "reviewer": "质检组长",
  "conclusion": "继续观察",
  "conclusion_details": "裂纹未明显扩展，建议3日后再次复查",
  "next_review_date": "2026-06-18 09:00:00",
  "is_closed": 0,
  "remarks": "每日巡检记录"
}
```

### 5.2 闭环复查（结论含「恢复」）
```http
POST /api/reviews
Content-Type: application/json

{
  "gasket_id": 6,
  "wear_record_id": 2,
  "review_date": "2026-06-18 10:00:00",
  "reviewer": "质检主管",
  "conclusion": "恢复使用",
  "conclusion_details": "磨损稳定，可恢复生产使用，使用前建议清洁",
  "is_closed": 1,
  "closed_date": "2026-06-18 10:00:00"
}
```

**预期校验失败**（垫片在磨损观察期直接恢复）:
```json
{
  "code": 409,
  "message": "校验失败: 处于磨损观察中的垫片不得直接恢复，请先完成清洁流程"
}
```

### 5.3 待复查列表（含逾期标识）
```http
GET /api/reviews/pending
```
返回所有未闭环且有 `next_review_date` 的复查，自动标注「已逾期/待复查」，按逾期时间排序。

---

## 6. 统计分析 & 自动识别

### 6.1 系统总览
```http
GET /api/stats/overview
```
返回垫片总数、按状态/材质/点位分布、领用和复查汇总。

### 6.2 磨损高发点位
```http
GET /api/stats/wear-hotspots?threshold=2&start_date=2026-06-01
```
- `threshold`: 最少磨损次数阈值，默认 2
- 返回: 按点位统计磨损次数、严重磨损(≥4)次数、替换次数，另按「材质+磨损位置」分组

### 6.3 自动识别（四大风险检测）
```http
GET /api/stats/auto-detect
```

返回四类自动识别结果:

| 识别项 | 说明 |
|--------|------|
| `same_material_consecutive_wear` | 同材质分组、同磨损位置，30天内连续出现≥3级磨损的垫片配对 |
| `frequent_replacement_locations` | 临时替换次数≥2的点位，提示该点位可能有工艺或环境问题 |
| `cleaning_timeout` | 已超过 `next_cleaning_date` 仍未清洁的垫片，按逾期天数排序 |
| `missing_review_conclusion` | 超过 `next_review_date` 仍未闭环的复查，提示复查结论缺失 |

---

## 7. 字典接口

```http
GET /api/dict/statuses        # 所有状态枚举
GET /api/dict/materials       # 所有材质分组
GET /api/dict/locations       # 所有点位
GET /api/dict/responsible-persons  # 所有责任人
```

---

## 快速验证（批处理）

Windows 下直接运行：
```cmd
test-api.bat
```
