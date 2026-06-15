@echo off
chcp 65001 >nul
echo ========================================
echo   引导垫片管理系统 - 接口调用示例
echo   服务端口: 8126
echo ========================================
echo.

set BASE_URL=http://localhost:8126/api

echo [1/10] 健康检查...
curl -s %BASE_URL%/health
echo.
echo.

echo [2/10] 查询垫片列表（分页 + 状态筛选）...
curl -s "%BASE_URL%/gaskets?status=使用中&page=1&page_size=5"
echo.
echo.

echo [3/10] 组合筛选：材质分组 + 点位 + 磨损等级...
curl -s "%BASE_URL%/gaskets?material_group=A组-橡胶&location=前端入料口-2号&wear_level=3"
echo.
echo.

echo [4/10] 领用登记（演示：使用中垫片再次领出会被拒绝）...
curl -s -X POST %BASE_URL%/borrows ^
  -H "Content-Type: application/json" ^
  -d "{\"gasket_id\":2,\"borrower\":\"测试员\",\"borrow_date\":\"2026-06-15 08:00:00\",\"borrow_location\":\"前端入料口-2号\",\"operator\":\"管理员\"}"
echo.
echo.

echo [5/10] 领用登记（正常领出 GSK-C002 id=8）...
curl -s -X POST %BASE_URL%/borrows ^
  -H "Content-Type: application/json" ^
  -d "{\"gasket_id\":8,\"borrower\":\"刘洋\",\"borrow_date\":\"2026-06-15 09:00:00\",\"borrow_location\":\"终检测试台-2号\",\"operator\":\"系统管理员\",\"remarks\":\"早班领用\"}"
echo.
echo.

echo [6/10] 清洁登记（自动计算下次清洁日期）...
curl -s -X POST %BASE_URL%/cleanings ^
  -H "Content-Type: application/json" ^
  -d "{\"gasket_id\":4,\"cleaning_date\":\"2026-06-15 10:00:00\",\"operator\":\"王强\",\"remarks\":\"常规清洁\"}"
echo.
echo.

echo [7/10] 磨损登记（级别4，触发待复查状态）...
curl -s -X POST %BASE_URL%/wears ^
  -H "Content-Type: application/json" ^
  -d "{\"gasket_id\":3,\"wear_level\":4,\"wear_position\":\"左后角\",\"wear_date\":\"2026-06-15 11:30:00\",\"reporter\":\"李娜\",\"remarks\":\"发现明显磨损\"}"
echo.
echo.

echo [8/10] 待复查列表...
curl -s %BASE_URL%/reviews/pending
echo.
echo.

echo [9/10] 自动识别分析（连续磨损/替换频繁/清洁超时/复查缺失）...
curl -s %BASE_URL%/stats/auto-detect
echo.
echo.

echo [10/10] 磨损高发点位统计...
curl -s "%BASE_URL%/stats/wear-hotspots?threshold=1"
echo.
echo.

echo ========================================
echo   示例调用完成
echo ========================================
pause
