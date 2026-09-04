const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = { data: null, chartMode: 'requests', filter: '', vendor: '', refreshAvailableAt: 0 };
const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function number(value, compactMode = false) {
  const parsed = Number(value || 0);
  return compactMode && Math.abs(parsed) >= 10000 ? compact.format(parsed) : nf.format(parsed);
}

function dateTime(timestamp) {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp * 1000));
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(`./api/${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let payload = {};
  try { payload = await response.json(); } catch (_) { /* no-op */ }
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function loadDashboard(force = false) {
  const button = $('#refreshButton');
  button.classList.add('loading');
  button.disabled = true;
  try {
    state.data = await api(`dashboard${force ? '?refresh=1' : ''}`);
    state.refreshAvailableAt = Date.now() + 5000;
    render();
    if (force) toast('数据已更新');
  } catch (error) {
    toast(error.message);
  } finally {
    button.classList.remove('loading');
    button.disabled = false;
  }
}

function quotaUnit(value, unit) {
  if (!unit) return `${number(value, true)} 点`;
  return `${number(Number(value || 0) / unit)} 计费单位`;
}

function render() {
  const data = state.data;
  const usage = data.usage || {};
  const status = data.status || {};
  const unit = Number(status.quota_per_unit || 500000);
  const granted = Number(usage.total_granted || 0);
  const available = Number(usage.total_available || 0);
  const used = Number(usage.total_used || 0);
  const availablePct = usage.unlimited_quota ? 100 : (granted > 0 ? Math.max(0, Math.min(100, available / granted * 100)) : 0);
  const usedPct = usage.unlimited_quota ? 0 : (granted > 0 ? Math.max(0, Math.min(100, used / granted * 100)) : 0);

  $('#availableQuota').textContent = usage.unlimited_quota ? '无限' : number(available);
  $('#usedQuota').textContent = number(used);
  $('#grantedQuota').textContent = usage.unlimited_quota ? '无限' : number(granted);
  $('#availableUnit').textContent = usage.unlimited_quota ? '无限额度已启用' : quotaUnit(available, unit);
  $('#usedConverted').textContent = quotaUnit(used, unit);
  $('#grantedConverted').textContent = usage.unlimited_quota ? '无上限' : quotaUnit(granted, unit);
  $('#usedPercent').textContent = `${number(usedPct)}%`;
  $('#heroPercent').textContent = usage.unlimited_quota ? '∞' : `${number(availablePct)}%`;
  $('#quotaProgress').style.width = `${availablePct}%`;

  const expires = Number(usage.expires_at || 0);
  if (!expires) {
    $('#expiryDays').textContent = '长期';
    $('#expiryDate').textContent = '未设置到期时间';
    $('#expiryState').textContent = 'NO EXPIRY';
  } else {
    const days = Math.ceil((expires * 1000 - Date.now()) / 86400000);
    $('#expiryDays').textContent = days >= 0 ? `${days} 天` : '已到期';
    $('#expiryDate').textContent = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' }).format(new Date(expires * 1000));
    $('#expiryState').textContent = days >= 0 ? 'ACTIVE' : 'EXPIRED';
  }

  $('#tokenName').textContent = usage.name || '—';
  $('#modelLimit').textContent = usage.model_limits_enabled ? `${Object.keys(usage.model_limits || {}).length} 个指定模型` : '未限制';
  $('#quotaType').textContent = usage.unlimited_quota ? '无限额度' : '有限额度';
  $('#modelCount').textContent = `${data.models.length} 个`;
  const latencies = Object.values(data.health?.latencies_ms || {});
  $('#latency').textContent = latencies.length ? `${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)} ms 平均` : '不可用';
  $('#updatedAt').textContent = dateTime(data.generated_at);
  $('#heroMeta').textContent = `${usage.name || '个人 Token'} · ${data.models.length} 个可用模型 · ${Object.keys(data.groups || {}).join(' / ') || '默认分组'}`;
  $('#footerSystem').textContent = `${status.system_name || 'New API'} ${status.version || ''} · 只读 · 密钥仅存于服务器`;

  const health = $('#healthPill');
  const stale = Boolean(data.health?.stale && data.health?.ok);
  health.classList.toggle('online', data.health?.ok && !stale);
  health.classList.toggle('stale', stale);
  health.classList.toggle('error', !data.health?.ok);
  health.querySelector('span').textContent = !data.health?.ok ? '部分数据异常' : stale ? '缓存数据' : '服务正常';
  const errors = data.health?.errors || {};
  $('#noticeArea').innerHTML = Object.entries(errors).map(([source, message]) => `<div class="notice">${esc(source)}：${esc(message)}</div>`).join('');

  const totals = data.analytics?.totals || {};
  $('#requestCount').textContent = number(totals.requests, true);
  $('#promptTokens').textContent = number(totals.prompt_tokens, true);
  $('#completionTokens').textContent = number(totals.completion_tokens, true);
  $('#streamedCount').textContent = number(totals.streamed_requests, true);
  renderChart();
  renderModels();
  renderDistribution();
  renderEndpoints();
  renderLogs();
}

function renderChart() {
  const values = state.data.analytics.daily.map((day) => Number(day[state.chartMode] || 0));
  const svg = $('#usageChart');
  const empty = values.every((value) => value === 0);
  $('#chartEmpty').classList.toggle('hidden', !empty);
  svg.classList.toggle('hidden', empty);
  if (empty) return;
  const width = 760, height = 270, left = 8, right = 8, top = 20, bottom = 30;
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => ({
    x: left + index * ((width - left - right) / (values.length - 1)),
    y: top + (1 - value / max) * (height - top - bottom),
    value,
  }));
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const area = `${path} L ${points.at(-1).x} ${height - bottom} L ${points[0].x} ${height - bottom} Z`;
  const grids = [0, .25, .5, .75, 1].map((ratio) => {
    const y = top + ratio * (height - top - bottom);
    return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/>`;
  }).join('');
  const labels = state.data.analytics.daily.map((day, index) => index % 2 === 0 ? `<text class="chart-label" x="${points[index].x}" y="${height - 7}" text-anchor="middle">${day.date.slice(5).replace('-', '/')}</text>` : '').join('');
  svg.innerHTML = `<defs><linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3478f6" stop-opacity=".2"/><stop offset="1" stop-color="#3478f6" stop-opacity="0"/></linearGradient></defs>${grids}<path class="chart-area" d="${area}"/><path class="chart-line" d="${path}"/>${points.map((point) => `<circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="3"><title>${number(point.value)}</title></circle>`).join('')}${labels}`;
}

function renderModels() {
  const pricing = new Map(state.data.pricing.map((row) => [row.model_name, row]));
  const vendors = state.data.vendors || {};
  const select = $('#vendorFilter');
  const owners = [...new Set(state.data.models.map((model) => vendors[pricing.get(model.id)?.vendor_id] || model.owned_by || 'unknown'))].sort();
  const currentOptions = [...select.options].slice(1).map((option) => option.value).join('|');
  if (currentOptions !== owners.join('|')) select.innerHTML = '<option value="">全部供应商</option>' + owners.map((owner) => `<option value="${esc(owner)}">${esc(owner)}</option>`).join('');
  select.value = state.vendor;
  const query = state.filter.toLowerCase();
  const models = state.data.models.filter((model) => {
    const price = pricing.get(model.id);
    const vendor = vendors[price?.vendor_id] || model.owned_by || 'unknown';
    return (!query || model.id.toLowerCase().includes(query) || vendor.toLowerCase().includes(query)) && (!state.vendor || vendor === state.vendor);
  });
  $('#modelEmpty').classList.toggle('hidden', models.length > 0);
  $('#modelList').innerHTML = models.map((model) => {
    const row = pricing.get(model.id) || {};
    const vendor = vendors[row.vendor_id] || model.owned_by || 'unknown';
    const priceText = row.quota_type === 1 ? `${number(row.model_price)} / 次` : `${number(row.model_ratio)}×`;
    const completion = row.quota_type === 1 ? '固定计费' : `${number(row.completion_ratio || 1)}×`;
    const endpoints = (row.supported_endpoint_types || []).map((item) => item.replace('openai-', '')).slice(0, 3);
    return `<article class="model-item"><div class="model-title"><strong title="${esc(model.id)}">${esc(model.id)}</strong><span class="vendor-badge">${esc(vendor)}</span></div><div class="model-ratios"><div><span>${row.quota_type === 1 ? '固定价格' : '输入倍率'}</span><b>${esc(priceText)}</b></div><div><span>输出倍率</span><b>${esc(completion)}</b></div><div><span>缓存读取</span><b>${row.cache_ratio == null ? '—' : `${number(row.cache_ratio)}×`}</b></div></div><div class="chips">${endpoints.map((item) => `<span class="chip">${esc(item)}</span>`).join('') || '<span class="chip">兼容接口</span>'}</div></article>`;
  }).join('');
}

function renderDistribution() {
  const rows = state.data.analytics.models || [];
  $('#distributionEmpty').classList.toggle('hidden', rows.length > 0);
  if (!rows.length) { $('#distributionList').innerHTML = ''; return; }
  const max = Math.max(...rows.map((row) => Number(row.tokens || row.requests)), 1);
  $('#distributionList').innerHTML = rows.slice(0, 8).map((row) => {
    const value = Number(row.tokens || row.requests);
    return `<div class="distribution-row"><span title="${esc(row.model)}">${esc(row.model)}</span><div class="dist-bar"><i style="width:${Math.max(3, value / max * 100)}%"></i></div><small>${number(row.requests)} 次</small></div>`;
  }).join('');
}

function renderEndpoints() {
  const labels = { anthropic: 'Anthropic', openai: 'Chat', 'openai-response': 'Responses', 'openai-response-compact': 'Compact', 'openai-alpha-search': 'Search' };
  $('#endpointList').innerHTML = Object.entries(state.data.endpoints || {}).map(([key, value]) => `<div class="endpoint-item"><span class="method">${esc(value.method || 'POST')}</span><code>${esc(value.path || '')}</code><span>${esc(labels[key] || key)}</span></div>`).join('') || '<p class="empty-row">暂无端点信息</p>';
}

function renderLogs() {
  const rows = (state.data.logs || []).slice(0, 20);
  $('#logEmpty').classList.toggle('hidden', rows.length > 0);
  $('#logRows').innerHTML = rows.map((row) => `<tr><td>${esc(dateTime(row.created_at))}</td><td>${esc(row.model_name || '—')}</td><td>${number(row.prompt_tokens)}</td><td>${number(row.completion_tokens)}</td><td>${number(row.quota)}</td><td>${row.use_time == null ? '—' : `${number(row.use_time)} s`}</td></tr>`).join('');
}

$('#refreshButton').addEventListener('click', () => {
  const waitMs = state.refreshAvailableAt - Date.now();
  if (waitMs > 0) {
    toast(`请 ${Math.ceil(waitMs / 1000)} 秒后再刷新`);
    return;
  }
  loadDashboard(true);
});
$('#modelSearch').addEventListener('input', (event) => { state.filter = event.target.value.trim(); renderModels(); });
$('#vendorFilter').addEventListener('change', (event) => { state.vendor = event.target.value; renderModels(); });
$$('.chart-mode').forEach((button) => button.addEventListener('click', () => {
  $$('.chart-mode').forEach((item) => item.classList.toggle('active', item === button));
  state.chartMode = button.dataset.mode;
  renderChart();
}));

loadDashboard();
setInterval(() => loadDashboard(), 60000);
