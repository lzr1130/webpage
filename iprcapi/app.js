const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = { data: null, chartMode: 'requests', range: '14d', rangeOffset: 0, selectedModel: '', filter: '', vendor: '' };
const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const rmbInteger = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const modelColors = ['#3478f6', '#7657e8', '#18a780', '#f09a3e', '#e3587a', '#35a7c7', '#7c8da6', '#9a6b4a', '#5b7cfa', '#8f63d8'];
const rangeLabels = { hour: '近 1 小时', day: '近 1 天', '7d': '近 7 天', '14d': '近 14 天', '30d': '近 1 个月', year: '近 1 年' };
const BEIJING_OFFSET = 8 * 3600;

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function number(value, compactMode = false) {
  const parsed = Number(value || 0);
  return compactMode && Math.abs(parsed) >= 10000 ? compact.format(parsed) : nf.format(parsed);
}

function dateTime(timestamp) {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(timestamp * 1000));
}

function relativeDays(timestamp) {
  if (!timestamp) return '';
  const days = Math.ceil((Number(timestamp) * 1000 - Date.now()) / 86400000);
  if (days < 0) return '已到期';
  if (days === 0) return '今天';
  return `${days} 天后`;
}

function colorForModel(model) {
  const names = (state.data?.analytics?.models || []).map((row) => row.model).sort();
  const index = Math.max(0, names.indexOf(model));
  return modelColors[index % modelColors.length];
}

function beijingDate(timestamp) {
  return new Date((timestamp + BEIJING_OFFSET) * 1000);
}

function bucketLabel(timestamp, format) {
  const date = beijingDate(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  if (format === 'minute') return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  if (format === 'hour') return `${pad(date.getUTCHours())}:00`;
  if (format === 'month') return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}`;
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
}

function makeStats() {
  return { requests: 0, prompt_tokens: 0, completion_tokens: 0, tokens: 0, quota: 0, streamed_requests: 0 };
}

function buildRangeData() {
  const now = Math.floor(Date.now() / 1000);
  const dayStart = Math.floor((now + BEIJING_OFFSET) / 86400) * 86400 - BEIJING_OFFSET;
  let boundaries = [];
  let labelFormat = 'day';
  if (state.range === 'hour') {
    const step = 300;
    const count = 12;
    const end = Math.ceil(now / step) * step - state.rangeOffset * 3600;
    const start = end - count * step;
    boundaries = Array.from({ length: count + 1 }, (_, index) => start + index * step);
    labelFormat = 'minute';
  } else if (state.range === 'day') {
    const start = dayStart - state.rangeOffset * 86400;
    boundaries = Array.from({ length: 25 }, (_, index) => start + index * 3600);
    labelFormat = 'hour';
  } else if (state.range === '30d') {
    const shifted = beijingDate(now);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth() - state.rangeOffset;
    const start = Date.UTC(year, month, 1) / 1000 - BEIJING_OFFSET;
    const end = Date.UTC(year, month + 1, 1) / 1000 - BEIJING_OFFSET;
    const count = Math.round((end - start) / 86400);
    boundaries = Array.from({ length: count + 1 }, (_, index) => start + index * 86400);
  } else if (state.range === 'year') {
    const shifted = beijingDate(now);
    const selectedYear = shifted.getUTCFullYear() - state.rangeOffset;
    boundaries = Array.from({ length: 13 }, (_, index) =>
      Date.UTC(selectedYear, index, 1) / 1000 - BEIJING_OFFSET
    );
    labelFormat = 'month';
  } else {
    const days = state.range === '7d' ? 7 : 14;
    const count = days;
    const end = dayStart + 86400 - state.rangeOffset * days * 86400;
    const start = end - days * 86400;
    boundaries = Array.from({ length: count + 1 }, (_, index) => start + index * 86400);
  }

  const buckets = boundaries.slice(0, -1).map((start, index) => ({
    start,
    end: boundaries[index + 1],
    label: bucketLabel(start, labelFormat),
    fullLabel: `${dateTime(start)} – ${dateTime(boundaries[index + 1] - 1)}`,
    ...makeStats(),
    models: new Map(),
  }));
  const totals = makeStats();
  const models = new Map();
  for (const log of state.data.logs || []) {
    const timestamp = Number(log.created_at || 0);
    const bucket = buckets.find((item) => timestamp >= item.start && timestamp < item.end);
    if (!bucket) continue;
    const model = String(log.model_name || '未知模型');
    const prompt = Number(log.prompt_tokens || 0);
    const completion = Number(log.completion_tokens || 0);
    const values = {
      requests: 1,
      prompt_tokens: prompt,
      completion_tokens: completion,
      tokens: prompt + completion,
      quota: Number(log.quota || 0),
      streamed_requests: log.is_streamed ? 1 : 0,
    };
    for (const [key, value] of Object.entries(values)) {
      bucket[key] += value;
      totals[key] += value;
    }
    if (!bucket.models.has(model)) bucket.models.set(model, { model, ...makeStats() });
    if (!models.has(model)) models.set(model, { model, ...makeStats() });
    for (const [key, value] of Object.entries(values)) {
      bucket.models.get(model)[key] += value;
      models.get(model)[key] += value;
    }
  }
  return {
    buckets: buckets.map((bucket) => ({ ...bucket, models: [...bucket.models.values()] })),
    totals,
    models: [...models.values()].sort((a, b) => b.requests - a.requests),
    periodLabel: `${dateTime(boundaries[0])} – ${dateTime(boundaries.at(-1) - 1)}`,
  };
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

async function loadDashboard(showToast = false) {
  const button = $('#refreshButton');
  button.classList.add('loading');
  button.disabled = true;
  try {
    state.data = await api('dashboard');
    render();
    if (showToast) toast('已读取服务器缓存');
  } catch (error) {
    toast(error.message);
  } finally {
    button.classList.remove('loading');
    button.disabled = false;
  }
}

function quotaRmb(value, status) {
  const unit = Number(status.quota_per_unit || 500000);
  const exchangeRate = Number(status.usd_exchange_rate || 6);
  const amount = unit > 0 ? Number(value || 0) / unit * exchangeRate : 0;
  return `¥${rmbInteger.format(Math.round(amount))}`;
}

function render() {
  const data = state.data;
  const usage = data.usage || {};
  const status = data.status || {};
  const granted = Number(usage.total_granted || 0);
  const available = Number(usage.total_available || 0);
  const used = Number(usage.total_used || 0);
  const availablePct = usage.unlimited_quota ? 100 : (granted > 0 ? Math.max(0, Math.min(100, available / granted * 100)) : 0);

  $('#availableQuota').textContent = usage.unlimited_quota ? '无限' : quotaRmb(available, status);
  $('#remainingQuota').textContent = usage.unlimited_quota ? '无限' : quotaRmb(available, status);
  $('#usedQuota').textContent = quotaRmb(used, status);
  $('#grantedQuota').textContent = usage.unlimited_quota ? '无限' : number(granted);
  $('#availableUnit').textContent = usage.unlimited_quota ? '无限' : number(available);
  $('#grantedConverted').textContent = usage.unlimited_quota ? '无上限' : quotaRmb(granted, status);
  $('#heroPercent').textContent = usage.unlimited_quota ? '∞' : `${availablePct.toFixed(1)}%`;
  $('#quotaProgress').style.width = `${availablePct}%`;
  $('#quotaTrack').setAttribute('aria-valuenow', String(availablePct.toFixed(1)));
  $('#quotaTrack').setAttribute('aria-valuetext', usage.unlimited_quota ? '无限额度' : `剩余 ${availablePct.toFixed(1)}%`);
  $('#quotaResetTime').textContent = usage.expires_at ? dateTime(usage.expires_at) : '未设置';
  $('#quotaResetCountdown').textContent = usage.expires_at ? relativeDays(usage.expires_at) : '';
  $('#refreshTime').textContent = dateTime(data.data_updated_at);
  $('#refreshTimezone').textContent = '北京时间';

  $('#tokenName').textContent = usage.name || '—';
  $('#modelLimit').textContent = usage.model_limits_enabled ? `${Object.keys(usage.model_limits || {}).length} 个指定模型` : '未限制';
  $('#quotaType').textContent = usage.unlimited_quota ? '无限额度' : '有限额度';
  $('#modelCount').textContent = `${data.models.length} 个`;
  $('#heroMeta').textContent = `${usage.name || '个人 Token'} · ${data.models.length} 个可用模型 · ${Object.keys(data.groups || {}).join(' / ') || '默认分组'}`;
  $('#footerSystem').textContent = `${status.system_name || 'New API'} ${status.version || ''} · 只读 · 密钥仅存于服务器`;

  const health = $('#healthPill');
  const stale = Boolean(data.health?.stale && data.health?.ok);
  health.classList.toggle('online', data.health?.ok && !stale);
  health.classList.toggle('stale', stale);
  health.classList.toggle('error', !data.health?.ok);
  health.querySelector('span').textContent = !data.health?.ok
    ? '部分数据异常'
    : stale ? '缓存数据' : '服务器缓存';
  const errors = data.health?.errors || {};
  $('#noticeArea').innerHTML = Object.entries(errors).map(([source, message]) => `<div class="notice">${esc(source)}：${esc(message)}</div>`).join('');

  renderAnalytics();
  renderModels();
  renderEndpoints();
  renderLogs();
}

function renderAnalytics() {
  const rangeData = buildRangeData();
  const selected = rangeData.models.find((row) => row.model === state.selectedModel);
  if (state.selectedModel && !selected) state.selectedModel = '';
  const totals = selected || rangeData.totals;
  $('#requestCount').textContent = number(totals.requests, true);
  $('#promptTokens').textContent = number(totals.prompt_tokens, true);
  $('#completionTokens').textContent = number(totals.completion_tokens, true);
  $('#streamedCount').textContent = number(totals.streamed_requests, true);
  $('#chartTitle').textContent = `${rangeLabels[state.range]}调用`;
  $('#chartSubtitle').textContent = state.selectedModel
    ? `${rangeData.periodLabel} · 仅显示 ${state.selectedModel}（再次点击取消）`
    : `${rangeData.periodLabel} · 点击模型可筛选`;
  $('#distributionSubtitle').textContent = `${rangeData.periodLabel} · 点击模型可筛选`;
  $('#nextPeriod').disabled = state.rangeOffset === 0;
  renderChart(rangeData);
  renderDistribution(rangeData);
}

function renderChart(rangeData) {
  $('#chartTooltip').classList.remove('show');
  const buckets = rangeData.buckets;
  const values = buckets.map((bucket) => state.selectedModel
    ? Number(bucket.models.find((row) => row.model === state.selectedModel)?.[state.chartMode] || 0)
    : Number(bucket[state.chartMode] || 0));
  const svg = $('#usageChart');
  const empty = values.every((value) => value === 0);
  $('#chartEmpty').classList.toggle('hidden', !empty);
  svg.classList.toggle('hidden', empty);
  $('#chartLegend').classList.toggle('hidden', empty);
  if (empty) { $('#chartLegend').innerHTML = ''; return; }
  const width = Math.max(360, Math.round(svg.clientWidth || 760));
  const height = 270, left = width < 500 ? 34 : 42, right = 8, top = 24, bottom = 38;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-label', `${rangeLabels[state.range]}调用趋势`);
  const baseline = height - bottom;
  const plotHeight = baseline - top;
  const max = Math.max(...values, 1);
  const slot = (width - left - right) / buckets.length;
  const barWidth = Math.min(30, slot * .62);
  const grids = [0, .25, .5, .75, 1].map((ratio) => {
    const y = baseline - ratio * plotHeight;
    const value = max * ratio;
    return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="chart-axis" x="${left - 7}" y="${y + 3}" text-anchor="end">${esc(number(value, true))}</text>`;
  }).join('');
  const bars = buckets.map((bucket, index) => {
    const x = left + index * slot + (slot - barWidth) / 2;
    let usedHeight = 0;
    const segments = [...(bucket.models || [])]
      .filter((row) => !state.selectedModel || row.model === state.selectedModel)
      .filter((row) => Number(row[state.chartMode] || 0) > 0)
      .sort((a, b) => Number(b[state.chartMode] || 0) - Number(a[state.chartMode] || 0));
    const rects = segments.map((row) => {
      const value = Number(row[state.chartMode] || 0);
      const segmentHeight = value / max * plotHeight;
      const y = baseline - usedHeight - segmentHeight;
      usedHeight += segmentHeight;
      return `<rect class="chart-segment" tabindex="0" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(segmentHeight, 1).toFixed(1)}" rx="3" fill="${colorForModel(row.model)}" data-date="${esc(bucket.fullLabel)}" data-model="${esc(row.model)}" data-requests="${number(row.requests)}" data-tokens="${number(row.tokens)}" data-quota="${number(row.quota)}"><title>${esc(bucket.fullLabel)} · ${esc(row.model)} · ${number(row.requests)} 次 · ${number(row.tokens)} Tokens · ${number(row.quota)} 额度</title></rect>`;
    }).join('');
    const bucketValue = values[index];
    const totalY = Math.max(13, baseline - bucketValue / max * plotHeight - 7);
    const total = bucketValue > 0
      ? `<text class="chart-value" x="${x + barWidth / 2}" y="${totalY}" text-anchor="middle">${esc(number(bucketValue, true))}</text>`
      : '';
    const showLabel = buckets.length <= 14 || index % Math.ceil(buckets.length / 12) === 0 || index === buckets.length - 1;
    const label = showLabel ? `<text class="chart-label" x="${x + barWidth / 2}" y="${height - 12}" text-anchor="middle">${esc(bucket.label)}</text>` : '';
    return `${rects}${total}${label}`;
  }).join('');
  svg.innerHTML = `${grids}${bars}`;

  const usedModels = rangeData.models.filter((model) => Number(model[state.chartMode] || 0) > 0);
  $('#chartLegend').innerHTML = usedModels.map((row) => `<button type="button" class="${state.selectedModel === row.model ? 'active' : state.selectedModel ? 'muted' : ''}" data-model="${esc(row.model)}" aria-pressed="${state.selectedModel === row.model}"><i style="background:${colorForModel(row.model)}"></i>${esc(row.model)}</button>`).join('');
  $$('#chartLegend button').forEach((button) => button.addEventListener('click', () => {
    state.selectedModel = state.selectedModel === button.dataset.model ? '' : button.dataset.model;
    renderAnalytics();
  }));
  bindChartTooltips();
}

function bindChartTooltips() {
  const tooltip = $('#chartTooltip');
  const show = (node, event) => {
    tooltip.innerHTML = `<strong>${esc(node.dataset.model)}</strong><span>${esc(node.dataset.date)}</span><div><b>${esc(node.dataset.requests)}</b> 次调用 · <b>${esc(node.dataset.tokens)}</b> Tokens · <b>${esc(node.dataset.quota)}</b> 额度</div>`;
    tooltip.classList.add('show');
    const anchor = node.getBoundingClientRect();
    const x = event?.clientX || anchor.right;
    const y = event?.clientY || anchor.top;
    let left = x + 22;
    if (left + tooltip.offsetWidth > window.innerWidth - 8) left = x - tooltip.offsetWidth - 22;
    let top = y - tooltip.offsetHeight - 22;
    if (top < 8) top = y + 22;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.min(window.innerHeight - tooltip.offsetHeight - 8, top)}px`;
  };
  $$('.chart-segment').forEach((node) => {
    node.addEventListener('pointerenter', (event) => show(node, event));
    node.addEventListener('pointermove', (event) => show(node, event));
    node.addEventListener('pointerleave', () => tooltip.classList.remove('show'));
    node.addEventListener('focus', () => show(node));
    node.addEventListener('blur', () => tooltip.classList.remove('show'));
  });
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

function renderDistribution(rangeData) {
  const sourceRows = [...rangeData.models]
    .sort((a, b) => Number(b.requests || 0) - Number(a.requests || 0));
  const rows = sourceRows.slice(0, 7);
  if (sourceRows.length > 7) {
    rows.push(sourceRows.slice(7).reduce((result, row) => ({
      model: '其他模型',
      requests: result.requests + Number(row.requests || 0),
      tokens: result.tokens + Number(row.tokens || 0),
      quota: result.quota + Number(row.quota || 0),
    }), { model: '其他模型', requests: 0, tokens: 0, quota: 0 }));
  }
  $('#distributionEmpty').classList.toggle('hidden', rows.length > 0);
  if (!rows.length) { $('#distributionList').innerHTML = ''; return; }
  const total = rows.reduce((sum, row) => sum + Number(row.requests || 0), 0);
  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const rings = rows.map((row) => {
    const ratio = Number(row.requests || 0) / Math.max(total, 1);
    const length = ratio * circumference;
    const color = row.model === '其他模型' ? '#c5cbd6' : colorForModel(row.model);
    const stateClass = state.selectedModel === row.model ? ' active' : state.selectedModel ? ' muted' : '';
    const ring = `<circle class="donut-segment${stateClass}" data-model="${esc(row.model)}" cx="62" cy="62" r="${radius}" fill="none" stroke="${color}" stroke-width="15" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 62 62)"><title>${esc(row.model)} · ${number(row.requests)} 次 · ${(ratio * 100).toFixed(1)}%</title></circle>`;
    offset += length;
    return ring;
  }).join('');
  const legend = rows.map((row) => {
    const ratio = Number(row.requests || 0) / Math.max(total, 1);
    const color = row.model === '其他模型' ? '#c5cbd6' : colorForModel(row.model);
    const stateClass = state.selectedModel === row.model ? ' active' : state.selectedModel ? ' muted' : '';
    return `<button type="button" class="donut-legend-row${stateClass}" data-model="${esc(row.model)}"${row.model === '其他模型' ? ' disabled' : ''}><i style="background:${color}"></i><span title="${esc(row.model)}">${esc(row.model)}</span><b>${(ratio * 100).toFixed(1)}%</b><small>${number(row.requests)} 次 · ${number(row.tokens, true)} Tokens</small></button>`;
  }).join('');
  $('#distributionList').innerHTML = `<div class="donut-chart"><svg viewBox="0 0 124 124" role="img" aria-label="模型调用占比"><circle cx="62" cy="62" r="${radius}" fill="none" stroke="#edf1f6" stroke-width="15"/>${rings}</svg><div><strong>${number(total, true)}</strong><span>总调用</span></div></div><div class="donut-legend">${legend}</div>`;
  $$('.donut-legend-row:not(:disabled), .donut-segment:not([data-model="其他模型"])').forEach((node) => node.addEventListener('click', () => {
    state.selectedModel = state.selectedModel === node.dataset.model ? '' : node.dataset.model;
    renderAnalytics();
  }));
}

function renderEndpoints() {
  const labels = { anthropic: 'Anthropic', openai: 'Chat', 'openai-response': 'Responses', 'openai-response-compact': 'Compact', 'openai-alpha-search': 'Search' };
  $('#endpointList').innerHTML = Object.entries(state.data.endpoints || {}).map(([key, value]) => `<div class="endpoint-item"><span class="method">${esc(value.method || 'POST')}</span><code>${esc(value.path || '')}</code><span>${esc(labels[key] || key)}</span></div>`).join('') || '<p class="empty-row">暂无端点信息</p>';
}

function renderLogs() {
  const rows = [...(state.data.logs || [])]
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
    .slice(0, 20);
  $('#logEmpty').classList.toggle('hidden', rows.length > 0);
  $('#logRows').innerHTML = rows.map((row) => {
    const prompt = Number(row.prompt_tokens || 0);
    const completion = Number(row.completion_tokens || 0);
    const total = prompt + completion;
    const promptPct = total > 0 ? prompt / total * 100 : 50;
    const model = row.model_name || '未知模型';
    return `<article class="call-card"><div class="call-card-head"><span class="call-model"><i style="background:${colorForModel(model)}"></i><b title="${esc(model)}">${esc(model)}</b></span><time>${esc(dateTime(row.created_at))}</time></div><div class="token-visual" title="输入 ${number(prompt)} · 输出 ${number(completion)}"><i style="width:${promptPct}%"></i><b style="width:${100 - promptPct}%"></b></div><div class="call-metrics"><div><span>输入</span><strong>${number(prompt, true)}</strong></div><div><span>输出</span><strong>${number(completion, true)}</strong></div><div><span>额度</span><strong>${number(row.quota, true)}</strong></div><div><span>耗时</span><strong>${row.use_time == null ? '—' : `${number(row.use_time)}s`}</strong></div></div></article>`;
  }).join('');
}

$('#refreshButton').addEventListener('click', () => {
  loadDashboard(true);
});
$('#modelSearch').addEventListener('input', (event) => { state.filter = event.target.value.trim(); renderModels(); });
$('#vendorFilter').addEventListener('change', (event) => { state.vendor = event.target.value; renderModels(); });
$$('.chart-mode').forEach((button) => button.addEventListener('click', () => {
  $$('.chart-mode').forEach((item) => item.classList.toggle('active', item === button));
  state.chartMode = button.dataset.mode;
  renderAnalytics();
}));
$('#rangeSelect').addEventListener('change', (event) => {
  state.range = event.target.value;
  state.rangeOffset = 0;
  state.selectedModel = '';
  renderAnalytics();
});
$('#previousPeriod').addEventListener('click', () => {
  state.rangeOffset += 1;
  state.selectedModel = '';
  renderAnalytics();
});
$('#nextPeriod').addEventListener('click', () => {
  if (state.rangeOffset === 0) return;
  state.rangeOffset -= 1;
  state.selectedModel = '';
  renderAnalytics();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.data) renderChart(buildRangeData()); }, 120);
});

loadDashboard();
setInterval(() => {
  if (document.visibilityState === 'visible') loadDashboard();
}, 60000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadDashboard();
});
