const API_BASE = 'http://localhost:8126/api';

let currentTab = 'overview';
let exceptionList = { list: [], total: 0, page: 1, page_size: 20 };
let gasketList = { list: [], total: 0, page: 1, page_size: 20 };
let currentException = null;
let currentGasket = null;
let overviewData = null;
let exceptionStats = null;
let overdueReminders = null;

let dict = {
  exceptionTypes: [],
  exceptionStatuses: []
};

async function loadDict() {
  try {
    const [typesRes, statusesRes] = await Promise.all([
      fetch(`${API_BASE}/dict/exception-types`),
      fetch(`${API_BASE}/dict/exception-statuses`)
    ]);
    const typesData = await typesRes.json();
    const statusesData = await statusesRes.json();
    if (typesData.code === 0) dict.exceptionTypes = typesData.data;
    if (statusesData.code === 0) dict.exceptionStatuses = statusesData.data;
  } catch (e) {
    console.error('加载字典失败:', e);
  }
}

function getStatusBadge(status) {
  const map = {
    '待处理': 'badge-status-pending',
    '处理中': 'badge-status-processing',
    '已恢复': 'badge-status-recovered',
    '已报废': 'badge-status-scrapped',
    '已取消': 'badge-status-cancelled'
  };
  return `<span class="badge ${map[status] || ''}">${status}</span>`;
}

function getTypeBadge(type) {
  const map = {
    '高等级磨损': 'badge-type-wear',
    '清洁超期': 'badge-type-cleaning',
    '复查超期': 'badge-type-review',
    '其他异常': 'badge-type-other'
  };
  return `<span class="badge ${map[type] || ''}">${type}</span>`;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return dateStr;
}

function showAlert(message, type = 'success') {
  const alertEl = document.getElementById('alert');
  alertEl.className = `alert alert-${type}`;
  alertEl.textContent = message;
  alertEl.style.display = 'block';
  setTimeout(() => {
    alertEl.style.display = 'none';
  }, 3000);
}

function showModal(modalId) {
  document.getElementById(modalId).classList.add('active');
}

function hideModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

async function loadOverview() {
  try {
    const [overviewRes, statsRes, overdueRes] = await Promise.all([
      fetch(`${API_BASE}/stats/overview`),
      fetch(`${API_BASE}/stats/exceptions`),
      fetch(`${API_BASE}/exceptions/overdue/reminders`)
    ]);
    const overviewData = await overviewRes.json();
    const statsData = await statsRes.json();
    const overdueData = await overdueRes.json();

    if (overviewData.code === 0) {
      const d = overviewData.data.summary;
      document.getElementById('stat-total-gaskets').textContent = d.total_gaskets;
      document.getElementById('stat-active-borrow').textContent = d.active_borrow;
      document.getElementById('stat-scrapped').textContent = d.scrapped_gaskets || 0;
      document.getElementById('stat-deactivated').textContent = d.deactivated_gaskets;
      document.getElementById('stat-active-exceptions').textContent = d.active_exceptions;
      document.getElementById('stat-overdue-exceptions').textContent = d.overdue_exceptions;
    }

    if (statsData.code === 0) {
      const d = statsData.data;
      document.getElementById('stat-exception-total').textContent = d.summary.total;
      document.getElementById('stat-exception-active').textContent = d.summary.active;
      document.getElementById('stat-exception-overdue').textContent = d.summary.overdue;
      document.getElementById('stat-recovery-rate').textContent = d.summary.recovery_rate + '%';
      document.getElementById('stat-scrap-rate').textContent = d.summary.scrap_rate + '%';

      const byTypeEl = document.getElementById('stats-by-type');
      byTypeEl.innerHTML = d.by_exception_type.map(item => `
        <div class="summary-card">
          <div class="count">${item.count}</div>
          <div class="label">${item.exception_type}</div>
        </div>
      `).join('');

      const byStatusEl = document.getElementById('stats-by-status');
      byStatusEl.innerHTML = d.by_status.map(item => `
        <div class="summary-card">
          <div class="count">${item.count}</div>
          <div class="label">${item.status}</div>
        </div>
      `).join('');
    }

    if (overdueData.code === 0) {
      const list = overdueData.data.list;
      const summary = overdueData.data.summary;
      document.getElementById('overdue-count').textContent = summary.total_overdue;
      
      const listEl = document.getElementById('overdue-list');
      if (list.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><div class="icon">✓</div><p>暂无逾期异常</p></div>';
      } else {
        listEl.innerHTML = list.slice(0, 10).map(item => `
          <tr>
            <td>${item.exception_no}</td>
            <td>${item.gasket_no}</td>
            <td>${getTypeBadge(item.exception_type)}</td>
            <td>${item.location}</td>
            <td>${formatDate(item.processing_deadline)}</td>
            <td><span class="badge badge-overdue">逾期${item.overdue_days}天</span></td>
            <td>
              <button class="link-btn" onclick="viewException(${item.id})">查看</button>
            </td>
          </tr>
        `).join('');
      }
    }
  } catch (e) {
    console.error('加载总览失败:', e);
  }
}

async function loadExceptionList() {
  const params = new URLSearchParams({
    page: exceptionList.page,
    page_size: exceptionList.page_size,
    ...getFilterParams()
  });

  try {
    const res = await fetch(`${API_BASE}/exceptions?${params}`);
    const data = await res.json();
    if (data.code === 0) {
      exceptionList = data.data;
      renderExceptionList();
    }
  } catch (e) {
    console.error('加载异常单列表失败:', e);
  }
}

function getFilterParams() {
  const params = {};
  const status = document.getElementById('filter-status').value;
  const type = document.getElementById('filter-type').value;
  const keyword = document.getElementById('filter-keyword').value;
  const isOverdue = document.getElementById('filter-overdue').value;

  if (status) params.status = status;
  if (type) params.exception_type = type;
  if (keyword) params.gasket_no = keyword;
  if (isOverdue !== '') params.is_overdue = isOverdue;

  return params;
}

function renderExceptionList() {
  const list = exceptionList.list;
  const tbody = document.getElementById('exception-list');
  
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><div class="icon">📋</div><p>暂无异常单记录</p></div></td></tr>';
    return;
  }

  tbody.innerHTML = list.map(item => `
    <tr>
      <td><strong>${item.exception_no}</strong></td>
      <td>${item.gasket_no}</td>
      <td>${item.location}</td>
      <td>${getTypeBadge(item.exception_type)}</td>
      <td>${item.trigger_reason}</td>
      <td>${getStatusBadge(item.status)}</td>
      <td>${formatDate(item.processing_deadline)}</td>
      <td>
        ${item.is_overdue ? '<span class="badge badge-overdue">已逾期</span>' : ''}
        ${item.is_deactivated ? '<span class="badge badge-exception">已停用</span>' : ''}
      </td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-sm btn-secondary" onclick="viewException(${item.id})">详情</button>
          ${['待处理', '处理中'].includes(item.status) ? `
            <button class="btn btn-sm btn-primary" onclick="processException(${item.id})">处理</button>
          ` : ''}
        </div>
      </td>
    </tr>
  `).join('');

  renderPagination('exception-pagination', exceptionList, () => {
    exceptionList.page = 1;
    loadExceptionList();
  });
}

function renderPagination(elId, data, onSearch) {
  const el = document.getElementById(elId);
  const totalPages = Math.ceil(data.total / data.page_size);
  
  el.innerHTML = `
    <button onclick="${elId === 'exception-pagination' ? 'prevExceptionPage()' : 'prevGasketPage()'}" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="info">第 ${data.page} / ${totalPages || 1} 页，共 ${data.total} 条</span>
    <button onclick="${elId === 'exception-pagination' ? 'nextExceptionPage()' : 'nextGasketPage()'}" ${data.page >= totalPages ? 'disabled' : ''}>下一页</button>
  `;
}

function prevExceptionPage() {
  if (exceptionList.page > 1) {
    exceptionList.page--;
    loadExceptionList();
  }
}

function nextExceptionPage() {
  exceptionList.page++;
  loadExceptionList();
}

function prevGasketPage() {
  if (gasketList.page > 1) {
    gasketList.page--;
    loadGasketList();
  }
}

function nextGasketPage() {
  gasketList.page++;
  loadGasketList();
}

async function viewException(id) {
  try {
    const res = await fetch(`${API_BASE}/exceptions/${id}`);
    const data = await res.json();
    if (data.code === 0) {
      currentException = data.data;
      renderExceptionDetail();
      showModal('exception-detail-modal');
    }
  } catch (e) {
    console.error('加载异常单详情失败:', e);
  }
}

function renderExceptionDetail() {
  if (!currentException) return;
  
  const e = currentException.exception;
  const gasket = currentException.gasket;
  const logs = currentException.logs;
  const preCheck = currentException.precondition_check;

  document.getElementById('detail-no').textContent = e.exception_no;
  document.getElementById('detail-status').innerHTML = getStatusBadge(e.status);
  document.getElementById('detail-type').innerHTML = getTypeBadge(e.exception_type);
  document.getElementById('detail-gasket').textContent = e.gasket_no;
  document.getElementById('detail-location').textContent = gasket?.location || '-';
  document.getElementById('detail-initiator').textContent = e.initiator;
  document.getElementById('detail-operator').textContent = e.operator || '-';
  document.getElementById('detail-trigger').textContent = e.trigger_reason;
  document.getElementById('detail-description').textContent = e.exception_description || '-';
  document.getElementById('detail-suggested').textContent = e.suggested_disposal || '-';
  document.getElementById('detail-deadline').textContent = formatDate(e.processing_deadline);
  document.getElementById('detail-actual').textContent = e.actual_disposal || '-';
  document.getElementById('detail-result').textContent = e.disposal_result || '-';
  document.getElementById('detail-created').textContent = formatDate(e.created_at);
  document.getElementById('detail-completed').textContent = formatDate(e.completed_at);
  document.getElementById('detail-remarks').textContent = e.remarks || '-';

  if (e.is_overdue) {
    document.getElementById('detail-overdue').innerHTML = '<span class="badge badge-overdue">已逾期</span>';
  } else {
    document.getElementById('detail-overdue').innerHTML = '';
  }

  if (gasket?.is_deactivated) {
    document.getElementById('detail-deactivated').innerHTML = '<span class="badge badge-exception">垫片已停用</span>';
  } else {
    document.getElementById('detail-deactivated').innerHTML = '';
  }

  const preCheckEl = document.getElementById('precondition-check');
  if (preCheck) {
    preCheckEl.style.display = 'block';
    preCheckEl.innerHTML = `
      <h4>前置条件验证 ${preCheck.all_passed ? '<span class="badge badge-status-recovered">全部通过</span>' : '<span class="badge badge-status-pending">未通过</span>'}</h4>
      ${preCheck.validations.map(v => `
        <div class="precondition-item ${v.passed ? 'passed' : 'failed'}">
          <div class="icon">${v.passed ? '✓' : '✗'}</div>
          <div class="content">
            <div class="name">${v.name}</div>
            <div class="detail">${v.detail}</div>
          </div>
        </div>
      `).join('')}
    `;
  } else {
    preCheckEl.style.display = 'none';
  }

  const logsEl = document.getElementById('exception-logs');
  logsEl.innerHTML = logs.map(log => `
    <div class="log-item">
      <div class="time">${formatDate(log.created_at)}</div>
      <div>
        <span class="action">${log.action_type}</span>
        <span class="operator"> - ${log.operator}</span>
        ${log.old_status && log.new_status ? `
          <div class="status-change">
            ${getStatusBadge(log.old_status)}
            <span class="arrow">→</span>
            ${getStatusBadge(log.new_status)}
          </div>
        ` : ''}
      </div>
      ${log.content ? `<div class="content">${log.content}</div>` : ''}
    </div>
  `).join('');

  const actionBtnEl = document.getElementById('detail-action-buttons');
  if (['待处理', '处理中'].includes(e.status)) {
    actionBtnEl.innerHTML = `
      <button class="btn btn-secondary" onclick="hideModal('exception-detail-modal')">关闭</button>
      <button class="btn btn-primary" onclick="processException(${e.id})">处理异常</button>
      ${preCheck?.all_passed ? `<button class="btn btn-success" onclick="recoverException(${e.id})">恢复使用</button>` : ''}
      <button class="btn btn-danger" onclick="scrapException(${e.id})">报废垫片</button>
      <button class="btn btn-warning" onclick="cancelException(${e.id})">取消</button>
    `;
  } else {
    actionBtnEl.innerHTML = `
      <button class="btn btn-secondary" onclick="hideModal('exception-detail-modal')">关闭</button>
    `;
  }
}

function openCreateModal(gasketId = null) {
  document.getElementById('create-form').reset();
  document.getElementById('create-gasket-id').value = gasketId || '';
  
  const typeSelect = document.getElementById('create-exception-type');
  typeSelect.innerHTML = dict.exceptionTypes.map(t => 
    `<option value="${t.value}">${t.value}</option>`
  ).join('');

  if (gasketId) {
    loadGasketForSelect(gasketId);
  }

  showModal('create-modal');
}

async function loadGasketForSelect(gasketId) {
  try {
    const res = await fetch(`${API_BASE}/gaskets/${gasketId}`);
    const data = await res.json();
    if (data.code === 0) {
      document.getElementById('create-gasket-no').value = data.data.gasket_no;
    }
  } catch (e) {
    console.error('加载垫片信息失败:', e);
  }
}

async function searchGasket() {
  const keyword = document.getElementById('search-gasket').value.trim();
  if (!keyword) {
    showAlert('请输入垫片编号', 'danger');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/gaskets?gasket_no=${encodeURIComponent(keyword)}`);
    const data = await res.json();
    if (data.code === 0 && data.data.list.length > 0) {
      const exactMatch = data.data.list.find(g => g.gasket_no.toLowerCase() === keyword.toLowerCase());
      const gasket = exactMatch || data.data.list[0];
      
      if (gasket.is_scrapped) {
        document.getElementById('create-gasket-id').value = '';
        document.getElementById('create-gasket-no').value = '';
        showAlert(`该垫片「${gasket.gasket_no}」已报废，不可发起异常停用`, 'danger');
        return;
      }
      
      document.getElementById('create-gasket-id').value = gasket.id;
      document.getElementById('create-gasket-no').value = gasket.gasket_no;
      if (gasket.has_active_exception) {
        showAlert(`该垫片存在未完成异常: ${gasket.active_exception.exception_no}，不可重复发起`, 'warning');
      }
    } else {
      document.getElementById('create-gasket-id').value = '';
      document.getElementById('create-gasket-no').value = '';
      showAlert('未找到该垫片，请确认编号是否正确', 'danger');
    }
  } catch (e) {
    console.error('搜索垫片失败:', e);
    showAlert('搜索失败: ' + e.message, 'danger');
  }
}

async function submitCreate() {
  const form = document.getElementById('create-form');
  const formData = new FormData(form);
  
  const data = {
    gasket_id: Number(formData.get('gasket_id')),
    exception_type: formData.get('exception_type'),
    trigger_reason: formData.get('trigger_reason'),
    initiator: formData.get('initiator'),
    exception_description: formData.get('exception_description') || null,
    suggested_disposal: formData.get('suggested_disposal') || null,
    processing_deadline: formData.get('processing_deadline') || null,
    remarks: formData.get('remarks') || null
  };

  if (!data.gasket_id || !data.exception_type || !data.trigger_reason || !data.initiator) {
    showAlert('请填写必填字段', 'danger');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/exceptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json();
    
    if (result.code === 0) {
      showAlert('异常停用申请创建成功');
      hideModal('create-modal');
      refreshCurrentTab();
    } else {
      showAlert(result.message, 'danger');
    }
  } catch (e) {
    showAlert('创建失败: ' + e.message, 'danger');
  }
}

async function processException(id) {
  hideModal('exception-detail-modal');
  
  const res = await fetch(`${API_BASE}/exceptions/${id}`);
  const data = await res.json();
  if (data.code !== 0) return;
  
  currentException = data.data;
  const e = currentException.exception;
  const preCheck = currentException.precondition_check;

  document.getElementById('process-id').value = id;
  document.getElementById('process-no').textContent = e.exception_no;
  document.getElementById('process-gasket').textContent = e.gasket_no;
  document.getElementById('process-type').innerHTML = getTypeBadge(e.exception_type);
  document.getElementById('process-trigger').textContent = e.trigger_reason;

  const preCheckEl = document.getElementById('process-precondition');
  if (preCheck) {
    preCheckEl.style.display = 'block';
    preCheckEl.innerHTML = `
      <h4>前置条件验证 ${preCheck.all_passed ? '<span class="badge badge-status-recovered">全部通过</span>' : '<span class="badge badge-status-pending">未通过</span>'}</h4>
      ${preCheck.validations.map(v => `
        <div class="precondition-item ${v.passed ? 'passed' : 'failed'}">
          <div class="icon">${v.passed ? '✓' : '✗'}</div>
          <div class="content">
            <div class="name">${v.name}</div>
            <div class="detail">${v.detail}</div>
          </div>
        </div>
      `).join('')}
    `;
  } else {
    preCheckEl.style.display = 'none';
  }

  showModal('process-modal');
}

async function submitProcess() {
  const id = Number(document.getElementById('process-id').value);
  const actualDisposal = document.getElementById('process-actual').value;
  const disposalResult = document.getElementById('process-result').value;
  const preconditionDetails = document.getElementById('process-precondition-details').value;
  const operator = document.getElementById('process-operator').value;
  const remarks = document.getElementById('process-remarks').value;

  if (!operator) {
    showAlert('请填写处理人', 'danger');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/exceptions/${id}/process`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operator,
        actual_disposal: actualDisposal || null,
        disposal_result: disposalResult || null,
        precondition_details: preconditionDetails || null,
        remarks: remarks || null
      })
    });
    const result = await res.json();
    
    if (result.code === 0) {
      showAlert('处理信息更新成功');
      hideModal('process-modal');
      refreshCurrentTab();
    } else {
      showAlert(result.message, 'danger');
    }
  } catch (e) {
    showAlert('处理失败: ' + e.message, 'danger');
  }
}

async function updateExceptionStatus(id, status, confirmMsg) {
  if (!confirm(confirmMsg)) return;

  const operator = prompt('请输入操作人姓名:');
  if (!operator) return;

  try {
    const res = await fetch(`${API_BASE}/exceptions/${id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, operator })
    });
    const result = await res.json();
    
    if (result.code === 0) {
      showAlert(`状态更新为「${status}」成功`);
      hideModal('exception-detail-modal');
      refreshCurrentTab();
    } else {
      showAlert(result.message, 'danger');
    }
  } catch (e) {
    showAlert('操作失败: ' + e.message, 'danger');
  }
}

function recoverException(id) {
  updateExceptionStatus(id, '已恢复', '确认要恢复该垫片的使用吗？恢复后垫片将解除停用状态。');
}

function scrapException(id) {
  updateExceptionStatus(id, '已报废', '确认要报废该垫片吗？报废后该垫片将永久不可使用！');
}

function cancelException(id) {
  updateExceptionStatus(id, '已取消', '确认要取消该异常单吗？取消后垫片将解除停用状态。');
}

async function loadGasketList() {
  const params = new URLSearchParams({
    page: gasketList.page,
    page_size: gasketList.page_size
  });

  try {
    const res = await fetch(`${API_BASE}/gaskets?${params}`);
    const data = await res.json();
    if (data.code === 0) {
      gasketList = data.data;
      renderGasketList();
    }
  } catch (e) {
    console.error('加载垫片列表失败:', e);
  }
}

function renderGasketList() {
  const list = gasketList.list;
  const tbody = document.getElementById('gasket-list');
  
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="icon">🔧</div><p>暂无垫片记录</p></div></td></tr>';
    return;
  }

  tbody.innerHTML = list.map(item => `
    <tr>
      <td><strong>${item.gasket_no}</strong></td>
      <td>${item.material_group}</td>
      <td>${item.location}</td>
      <td>${getStatusBadge(item.status)}</td>
      <td>${item.responsible_person}</td>
      <td>
        ${item.is_scrapped ? '<span class="badge badge-status-scrapped">已报废</span>' : ''}
        ${item.is_deactivated && !item.is_scrapped ? '<span class="badge badge-exception">已停用</span>' : ''}
        ${item.has_active_exception ? `<span class="badge badge-overdue">存在异常</span>` : ''}
      </td>
      <td>${formatDate(item.updated_at)}</td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-sm btn-secondary" onclick="viewGasket(${item.id})">详情</button>
          ${item.is_scrapped ? '' : (item.has_active_exception ? `
            <button class="btn btn-sm btn-primary" onclick="viewException(${item.active_exception.exception_id})">查看异常</button>
          ` : `
            <button class="btn btn-sm btn-warning" onclick="openCreateModal(${item.id})">发起停用</button>
          `)}
        </div>
      </td>
    </tr>
  `).join('');

  renderPagination('gasket-pagination', gasketList, () => {
    gasketList.page = 1;
    loadGasketList();
  });
}

async function viewGasket(id) {
  try {
    const res = await fetch(`${API_BASE}/gaskets/${id}`);
    const data = await res.json();
    if (data.code === 0) {
      currentGasket = data.data;
      renderGasketDetail();
      showModal('gasket-detail-modal');
    }
  } catch (e) {
    console.error('加载垫片详情失败:', e);
  }
}

function renderGasketDetail() {
  if (!currentGasket) return;
  
  const g = currentGasket;

  document.getElementById('gasket-detail-no').textContent = g.gasket_no;
  document.getElementById('gasket-detail-material').textContent = g.material_group;
  document.getElementById('gasket-detail-location').textContent = g.location;
  document.getElementById('gasket-detail-status').innerHTML = getStatusBadge(g.status);
  document.getElementById('gasket-detail-responsible').textContent = g.responsible_person;
  document.getElementById('gasket-detail-cycle').textContent = g.cleaning_cycle + '天';
  document.getElementById('gasket-detail-last-clean').textContent = formatDate(g.last_cleaning_date);
  document.getElementById('gasket-detail-next-clean').textContent = formatDate(g.next_cleaning_date);
  document.getElementById('gasket-detail-created').textContent = formatDate(g.created_at);

  const exceptionBanner = document.getElementById('gasket-exception-banner');
  if (g.is_scrapped) {
    exceptionBanner.style.display = 'flex';
    exceptionBanner.innerHTML = `
      <div class="info">
        <span class="title">⚠️ 该垫片已报废</span>
        <span class="desc">报废时间: ${formatDate(g.scrapped_at)}，永久不可使用</span>
      </div>
    `;
  } else if (g.has_active_exception) {
    exceptionBanner.style.display = 'flex';
    exceptionBanner.innerHTML = `
      <div class="info">
        <span class="title">⚠️ 该垫片存在未处理异常</span>
        <span class="desc">异常单: ${g.exception_no}，类型: ${g.exception_type}，状态: ${g.status}</span>
      </div>
      <button class="btn btn-sm btn-primary" onclick="hideModal('gasket-detail-modal'); viewException(${g.exception_id})">查看异常</button>
    `;
  } else if (g.is_deactivated) {
    exceptionBanner.style.display = 'flex';
    exceptionBanner.innerHTML = `
      <div class="info">
        <span class="title">⚠️ 该垫片已停用</span>
        <span class="desc">停用时间: ${formatDate(g.deactivated_at)}</span>
      </div>
      <button class="btn btn-sm btn-warning" onclick="hideModal('gasket-detail-modal'); openCreateModal(${g.id})">发起停用申请</button>
    `;
  } else {
    exceptionBanner.style.display = 'none';
  }

  const actionBtnEl = document.getElementById('gasket-detail-actions');
  if (g.is_scrapped) {
    actionBtnEl.innerHTML = `
      <button class="btn btn-secondary" onclick="hideModal('gasket-detail-modal')">关闭</button>
    `;
  } else if (g.has_active_exception) {
    actionBtnEl.innerHTML = `
      <button class="btn btn-secondary" onclick="hideModal('gasket-detail-modal')">关闭</button>
      <button class="btn btn-primary" onclick="hideModal('gasket-detail-modal'); viewException(${g.exception_id})">查看异常</button>
    `;
  } else {
    actionBtnEl.innerHTML = `
      <button class="btn btn-secondary" onclick="hideModal('gasket-detail-modal')">关闭</button>
      <button class="btn btn-warning" onclick="hideModal('gasket-detail-modal'); openCreateModal(${g.id})">发起停用</button>
    `;
  }
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');
  
  refreshCurrentTab();
}

function refreshCurrentTab() {
  if (currentTab === 'overview') {
    loadOverview();
  } else if (currentTab === 'exceptions') {
    loadExceptionList();
  } else if (currentTab === 'gaskets') {
    loadGasketList();
  } else if (currentTab === 'stats') {
    loadExceptionStats();
  }
}

async function loadExceptionStats() {
  try {
    const res = await fetch(`${API_BASE}/stats/exceptions`);
    const data = await res.json();
    if (data.code === 0) {
      exceptionStats = data.data;
      renderExceptionStats();
    }
  } catch (e) {
    console.error('加载统计数据失败:', e);
  }
}

function renderExceptionStats() {
  if (!exceptionStats) return;
  
  const d = exceptionStats;
  
  document.getElementById('stat-s-total').textContent = d.summary.total;
  document.getElementById('stat-s-active').textContent = d.summary.active;
  document.getElementById('stat-s-overdue').textContent = d.summary.overdue;
  document.getElementById('stat-s-recovery').textContent = d.summary.recovery_rate + '%';
  document.getElementById('stat-s-scrap').textContent = d.summary.scrap_rate + '%';

  const byTypeEl = document.getElementById('stats-chart-type');
  byTypeEl.innerHTML = '<h4>按异常类型分布</h4>' + d.by_exception_type.map(item => `
    <div class="precondition-item passed">
      <div class="icon">${item.count}</div>
      <div class="content">
        <div class="name">${item.exception_type}</div>
        <div class="detail">占比: ${d.summary.total > 0 ? Math.round(item.count / d.summary.total * 100) : 0}%</div>
      </div>
    </div>
  `).join('');

  const byStatusEl = document.getElementById('stats-chart-status');
  byStatusEl.innerHTML = '<h4>按处理状态分布</h4>' + d.by_status.map(item => `
    <div class="precondition-item passed">
      <div class="icon">${item.count}</div>
      <div class="content">
        <div class="name">${item.status}</div>
        <div class="detail">占比: ${d.summary.total > 0 ? Math.round(item.count / d.summary.total * 100) : 0}%</div>
      </div>
    </div>
  `).join('');

  const byLocationEl = document.getElementById('stats-chart-location');
  byLocationEl.innerHTML = '<h4>按点位分布 (Top 10)</h4>' + d.by_location.slice(0, 10).map(item => `
    <div class="precondition-item passed">
      <div class="icon">${item.count}</div>
      <div class="content">
        <div class="name">${item.location}</div>
      </div>
    </div>
  `).join('');
}

function applyFilters() {
  exceptionList.page = 1;
  loadExceptionList();
}

function resetFilters() {
  document.getElementById('filter-status').value = '';
  document.getElementById('filter-type').value = '';
  document.getElementById('filter-keyword').value = '';
  document.getElementById('filter-overdue').value = '';
  exceptionList.page = 1;
  loadExceptionList();
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadDict();
  loadOverview();
});

document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', function() {
    const modal = this.closest('.modal-overlay');
    modal.classList.remove('active');
  });
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function(e) {
    if (e.target === this) {
      this.classList.remove('active');
    }
  });
});
