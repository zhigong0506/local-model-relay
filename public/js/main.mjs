const state = {
  config: null,
  runtime: null,
  editingProvider: null,
  editingRoute: null,
  testingProvider: null,
  draggingProviderId: null,
  providerDragSaved: false,
  draggingTargetRow: null,
  dragArmed: false,
  usageWindow: 'today',
  activeTab: 'providers',
  dashboardRange: '7d',
  dashboardGranularity: 'day',
  recordsFilter: {
    search: '',
    status: 'all',
    model: 'all',
    provider: 'all',
    range: 'all',
    sort: 'time',
  },
  charts: {
    trend: null,
    modelShare: null,
  },
}

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const formField = (form, name) => form.elements.namedItem(name)

document.addEventListener('DOMContentLoaded', async () => {
  bindTabs()
  bindActions()
  await refreshAll()
  setInterval(refreshState, 7000)
})

function bindTabs() {
  $$('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.tab').forEach((item) => item.classList.toggle('active', item === button))
      $$('.panel').forEach((panel) => panel.classList.remove('active'))
      $(`#${button.dataset.tab}Panel`).classList.add('active')
      state.activeTab = button.dataset.tab
      if (state.activeTab === 'dashboard') nextFrame().then(renderDashboard)
      if (state.activeTab === 'records') renderRecords()
    })
  })
}

function bindActions() {
  $('#refreshBtn').addEventListener('click', refreshAll)
  $('#copyBaseUrlBtn').addEventListener('click', copyBaseUrl)
  $('#serviceToggle').addEventListener('change', toggleService)
  $('#newProviderBtn').addEventListener('click', () => openProviderDialog())
  $('#quickProviderBtn').addEventListener('click', () => openProviderDialog())
  $('#routingStartMode').addEventListener('change', saveRoutingMode)
  $('#clearStartProviderBtn').addEventListener('click', clearStartProvider)
  formField($('#providerForm'), 'providerOutboundProxyMode').addEventListener('change', renderProviderProxyFields)
  $('#newRouteBtn').addEventListener('click', () => openRouteDialog())
  $('#providerForm').addEventListener('submit', saveProvider)
  $('#realTestForm').addEventListener('submit', runRealTest)
  $('#routeForm').addEventListener('submit', saveRoute)
  bindTargetDragSort()
  $('#settingsForm').addEventListener('submit', saveSettings)
  $$('[name="outboundProxyMode"]', $('#settingsForm')).forEach((input) => {
    input.addEventListener('change', renderOutboundProxyFields)
  })
  $('#addTargetBtn').addEventListener('click', () => addTargetRow())
  $('#addCredentialBtn').addEventListener('click', () => addCredentialRow())
  $('#exitBtn').addEventListener('click', exitProcess)
  $('#clearLogsBtn').addEventListener('click', clearLogs)
  $('#clearRecordsBtn').addEventListener('click', clearLogs)
  $('#clearUsageBtn').addEventListener('click', clearUsage)
  $('#usageWindowTabs').addEventListener('click', handleUsageWindowSwitch)
  $('#dashboardRange').addEventListener('change', handleDashboardControlChange)
  $('#dashboardGranularity').addEventListener('change', handleDashboardControlChange)
  $('#goRecordsBtn').addEventListener('click', () => switchTab('records'))
  $('#recordSearch').addEventListener('input', handleRecordFilterChange)
  $('#recordStatus').addEventListener('change', handleRecordFilterChange)
  $('#recordModel').addEventListener('change', handleRecordFilterChange)
  $('#recordProvider').addEventListener('change', handleRecordFilterChange)
  $('#recordRange').addEventListener('change', handleRecordFilterChange)
  $('#recordSort').addEventListener('change', handleRecordFilterChange)
  $('#exportRecordsCsvBtn').addEventListener('click', exportRecordsCsv)
  $('#exportConfigBtn').addEventListener('click', exportConfig)
  $('#importConfigBtn').addEventListener('click', () => $('#importConfigFile').click())
  $('#importConfigFile').addEventListener('change', importConfig)
  $('#toggleLocalKeyBtn').addEventListener('click', toggleLocalKeyVisibility)
  $$('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()))
}

async function refreshAll() {
  state.config = await api('/api/config')
  state.runtime = await api('/api/state')
  render()
}

async function refreshState() {
  try {
    state.runtime = await api('/api/state')
    renderStatus()
    renderOutboundStatus()
    renderRoutingBar()
    renderProviders()
    renderUsage()
    renderDashboard()
    renderRecords()
    renderLogs()
  } catch {
    // Server may be restarting.
  }
}

function render() {
  renderStatus()
  renderSettings()
  renderRoutingBar()
  renderProviders()
  renderRoutes()
  renderUsage()
  renderDashboard()
  renderRecords()
  renderLogs()
}

function renderStatus() {
  const { service, providers, routes } = state.config
  const base = `http://${service.listenHost}:${service.listenPort}`
  $('#baseUrl').textContent = `${base}/v1`
  $('#serviceState').textContent = service.enabled ? '已开启' : '已暂停'
  $('#serviceState').style.color = service.enabled ? 'var(--ok)' : 'var(--warn)'
  $('#providerCount').textContent = providers.length
  $('#routeCount').textContent = routes.length
  $('#serviceToggle').checked = service.enabled
  $('#successRate').textContent = calculateSuccessRate()
  $('#todayTokens').textContent = formatTokenCompact(todayUsage().totalTokens)
  $('#outboundState').textContent = outboundStatusLabel(state.runtime?.outbound)
}

function renderSettings() {
  const form = $('#settingsForm')
  const service = state.config.service
  formField(form, 'listenHost').value = service.listenHost
  formField(form, 'listenPort').value = service.listenPort
  formField(form, 'localApiKey').value = service.localApiKey
  formField(form, 'requestTimeoutMs').value = service.requestTimeoutMs
  formField(form, 'maxAttempts').value = service.maxAttempts
  formField(form, 'defaultCooldownSeconds').value = service.defaultCooldownSeconds
  formField(form, 'retryStatusCodes').value = service.retryStatusCodes.join(', ')
  formField(form, 'logRequests').checked = service.logRequests
  formField(form, 'collectUsage').checked = service.collectUsage
  formField(form, 'collectStreamUsage').checked = service.collectStreamUsage
  formField(form, 'quotaPerCny').value = service.quotaPerCny || 500000
  formField(form, 'requestLogLimit').value = service.requestLogLimit || 1500
  $$('[name="outboundProxyMode"]', form).forEach((input) => {
    input.checked = input.value === (service.outboundProxyMode || 'direct')
  })
  formField(form, 'outboundProxyUrl').value = service.outboundProxyUrl || ''
  renderOutboundProxyFields()
  renderOutboundStatus()
}

function renderOutboundProxyFields() {
  const form = $('#settingsForm')
  const mode = formField(form, 'outboundProxyMode').value || 'direct'
  $('#customProxyField').hidden = mode !== 'custom'
}

function renderOutboundStatus() {
  const outbound = state.runtime?.outbound
  $('#outboundEffective').textContent = `当前：${outboundStatusLabel(outbound)}`
  const notice = $('#outboundNotice')
  notice.textContent = outboundNoticeText(outbound)
  notice.classList.toggle('warn', Boolean(outbound?.needsRestart))
}

function renderRoutingBar() {
  const routing = state.runtime?.routing || {}
  const mode = routing.startMode === 'locked' ? 'locked' : 'auto'
  const provider = (state.config?.providers || []).find((item) => item.id === routing.startProviderId)
  const modeLabel = routingModeLabel(mode)

  $('#routingStartMode').value = mode
  $('#routingStartName').textContent = provider
    ? provider.name
    : routing.startProviderId
      ? '起点线路已失效'
      : '默认优先级'
  $('#routingStartHint').textContent = provider
    ? `${modeLabel} · 请求会从这条线路开始`
    : routing.startProviderId
      ? `${modeLabel} · 当前候选中找不到这条线路`
      : `${modeLabel} · 未指定起点时按优先级从头开始`
  $('#clearStartProviderBtn').disabled = !routing.startProviderId
}

function renderProviders() {
  if (state.draggingProviderId) return
  const rows = $('#providerRows')
  const providers = [...state.config.providers].sort((a, b) => a.priority - b.priority)
  const startProviderId = state.runtime?.routing?.startProviderId || ''
  $('#providerEmptyGuide').hidden = providers.length > 0
  rows.innerHTML = providers.length ? '' : `<tr><td colspan="9" class="empty">还没有线路，先新增一个中转站。</td></tr>`

  for (const provider of providers) {
    const entry = state.runtime.providerState[provider.id] || {}
    const isStartProvider = provider.id === startProviderId
    const tr = document.createElement('tr')
    tr.dataset.providerId = provider.id
    tr.draggable = true
    tr.className = 'draggable-row'
    tr.innerHTML = `
      <td><div class="status-cell"><span class="drag-handle" title="拖拽调整优先级" aria-label="拖拽调整优先级">↕</span>${providerBadge(provider, entry)}${isStartProvider ? '<span class="pill info">起点</span>' : ''}</div></td>
      <td><strong>${escapeHtml(provider.name)}</strong><br><small>${escapeHtml(provider.tags.join(', ') || provider.activeCredentialLabel || '未设置分组')}</small></td>
      <td>${escapeHtml(provider.baseUrl)}</td>
      <td>${credentialSelect(provider)}</td>
      <td>${escapeHtml(provider.models.slice(0, 4).join(', ') || '通配')}<br><small>${wireApiLabel(provider.wireApi)} · ${providerProxyLabel(provider)}</small></td>
      <td>${provider.priority}</td>
      <td>${providerStats(entry)}</td>
      <td>${lastProviderState(entry)}</td>
      <td>
        <div class="row-actions">
          <button data-action="set-start-provider" data-id="${provider.id}" ${isStartProvider ? 'disabled' : ''}>${isStartProvider ? '当前起点' : '设为起点'}</button>
          <button data-action="test" data-id="${provider.id}">测试</button>
          <button data-action="real-test" data-id="${provider.id}">真实测试</button>
          <button data-action="sync-usage" data-id="${provider.id}">同步扣账</button>
          <button data-action="toggle-provider" data-id="${provider.id}">${provider.enabled ? '停用' : '启用'}</button>
          <button data-action="edit-provider" data-id="${provider.id}">编辑</button>
          <button data-action="delete-provider" data-id="${provider.id}">删除</button>
        </div>
      </td>
    `
    rows.appendChild(tr)
  }

  rows.onclick = handleProviderAction
  rows.onchange = handleCredentialSwitch
  rows.onpointerdown = armDragFromHandle
  rows.ondragstart = handleProviderDragStart
  rows.ondragover = handleProviderDragOver
  rows.ondrop = handleProviderDrop
  rows.ondragend = handleProviderDragEnd
}

// dragstart 的 event.target 是设了 draggable 的 <tr> 本身，不是手柄子元素，
// 用 pointerdown 预置标志才能可靠地「仅从手柄发起拖拽」。
function armDragFromHandle(event) {
  state.dragArmed = Boolean(event.target.closest('.drag-handle'))
}

function renderRoutes() {
  const rows = $('#routeRows')
  const routes = [...state.config.routes].sort((a, b) => a.virtualModel.localeCompare(b.virtualModel))
  rows.innerHTML = routes.length ? '' : `<tr><td colspan="5" class="empty">还没有模型路由。没有路由时，会按线路支持模型直接转发同名模型。</td></tr>`

  for (const route of routes) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${route.enabled ? '<span class="pill ok">启用</span>' : '<span class="pill off">停用</span>'}</td>
      <td><strong>${escapeHtml(route.virtualModel)}</strong></td>
      <td>${[...route.targets].sort((a, b) => a.priority - b.priority || a.providerName.localeCompare(b.providerName)).map((target) => `${escapeHtml(target.providerName)} → ${escapeHtml(target.model)}`).join('<br>')}</td>
      <td>${escapeHtml(route.notes || '-')}</td>
      <td>
        <div class="row-actions">
          <button data-action="toggle-route" data-id="${route.id}">${route.enabled ? '停用' : '启用'}</button>
          <button data-action="edit-route" data-id="${route.id}">编辑</button>
          <button data-action="delete-route" data-id="${route.id}">删除</button>
        </div>
      </td>
    `
    rows.appendChild(tr)
  }

  rows.onclick = handleRouteAction
}

function renderLogs() {
  const logs = state.runtime.requestLog || []
  const list = $('#logList')
  list.innerHTML = logs.length ? '' : `<div class="empty">暂无请求记录。</div>`

  for (const log of logs.slice(0, 80)) {
    const item = document.createElement('div')
    item.className = 'log-item'
    item.innerHTML = `
      <div><strong>${new Date(log.time).toLocaleString()}</strong><br><small>${escapeHtml(log.method || '')} ${escapeHtml(log.path || '')}</small></div>
      <div><strong>${escapeHtml(log.model || '-')}</strong><br><small>${escapeHtml(log.providerName || log.error || '-')}</small></div>
      <div>${logStatusPill(log)}</div>
      <div>${usageMini(log.usage)}</div>
      <div><strong>${log.durationMs ?? '-'} ms</strong><br><small>${escapeHtml(logStatusText(log))}</small></div>
    `
    list.appendChild(item)
  }
}

function renderUsage() {
  const usage = state.runtime?.usage || {}
  const totals = usage.totals || {}
  $('#usageTotalTokens').textContent = formatTokenCompact(totals.totalTokens)
  $('#usageInOut').textContent = `${formatTokenCompact(totals.inputTokens)} / ${formatTokenCompact(totals.outputTokens)}`
  $('#usageCached').textContent = formatTokenCompact(totals.cachedTokens)
  $('#usageRequests').textContent = formatNumber(totals.requests)

  renderUsageWindowRows()
  renderUsageRows('#usageProviderRows', usage.byProvider, providerName)
  renderUsageRows('#usageModelRows', usage.byModel)
  renderCredentialUsageRows()
  renderUsageRows('#usageDailyRows', usage.daily, null, true)
}

function renderDashboard() {
  if (state.activeTab !== 'dashboard') return

  const usage = state.runtime?.usage || {}
  const totals = usage.totals || {}
  const today = aggregateLocalToday()
  const success = successStats()
  const avgLatency = averageProviderLatency()

  $('#dashTodayRequests').textContent = formatNumber(today.requests)
  $('#dashTodayTokens').textContent = `入 ${formatTokenCompact(today.inputTokens)} / 出 ${formatTokenCompact(today.outputTokens)} / 缓存 ${formatTokenCompact(today.cachedTokens)}`
  $('#dashTotalTokens').textContent = formatTokenCompact(totals.totalTokens)
  $('#dashTotalRequests').textContent = `${formatNumber(totals.requests)} 次请求`
  $('#dashSuccessRate').textContent = success.total ? `${Math.round((success.success / success.total) * 100)}%` : '-'
  $('#dashAttemptCount').textContent = success.total ? `${formatNumber(success.success)} 成功 / ${formatNumber(success.failure)} 失败` : '暂无尝试'
  $('#dashAvgLatency').textContent = avgLatency === null ? '-' : `${avgLatency} ms`
  $('#dashTodayCost').textContent = estimateWindowCost(today.byCredential)

  renderTrendChart(buildTrendSeries())
  renderModelShareChart(usage.byModel || {})
  renderDashboardRecent()
}

function handleDashboardControlChange(event) {
  if (event.currentTarget.id === 'dashboardRange') state.dashboardRange = event.currentTarget.value
  if (event.currentTarget.id === 'dashboardGranularity') state.dashboardGranularity = event.currentTarget.value
  renderDashboard()
}

function buildTrendSeries() {
  const hourly = aggregateGlobalHourly()
  const granularity = state.dashboardGranularity
  const range = state.dashboardRange
  const now = Date.now()
  const hourMs = 3600000
  const days = range === '30d' ? 30 : range === 'today' ? 1 : 7
  const buckets = new Map()

  if (granularity === 'hour') {
    const hours = range === 'today' ? new Date().getHours() + 1 : Math.min(days * 24, 240)
    const startHour = Math.floor((now - (hours - 1) * hourMs) / hourMs)
    for (let offset = 0; offset < hours; offset += 1) {
      const hourKey = String(startHour + offset)
      const date = new Date((startHour + offset) * hourMs)
      buckets.set(hourKey, { label: `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:00`, ...emptyBucket() })
    }
    for (const [hourKey, bucket] of Object.entries(hourly)) {
      if (buckets.has(hourKey)) addIntoBucket(buckets.get(hourKey), bucket)
    }
  } else {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - (days - 1))
    for (let offset = 0; offset < days; offset += 1) {
      const date = new Date(start)
      date.setDate(start.getDate() + offset)
      const key = localDateKey(date)
      buckets.set(key, { label: `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`, ...emptyBucket() })
    }
    for (const [hourKey, bucket] of Object.entries(hourly)) {
      const date = new Date(Number(hourKey) * hourMs)
      const key = localDateKey(date)
      if (buckets.has(key)) addIntoBucket(buckets.get(key), bucket)
    }
  }

  const rows = [...buckets.values()]
  $('#dashTrendHint').textContent = `${range === '30d' ? '近 30 天' : range === 'today' ? '今天' : '近 7 天'} · ${granularity === 'hour' ? '小时粒度' : '本地日粒度'}`
  return {
    labels: rows.map((item) => item.label),
    input: rows.map((item) => item.inputTokens),
    output: rows.map((item) => item.outputTokens),
    cached: rows.map((item) => item.cachedTokens),
    requests: rows.map((item) => item.requests),
  }
}

function renderTrendChart(series) {
  if (!window.Chart) return
  const node = $('#tokenTrendChart')
  const palette = cssPalette()
  const data = {
    labels: series.labels,
    datasets: [
      { label: '输入', data: series.input, borderColor: palette.accent, backgroundColor: withAlpha(palette.accent, 0.14), fill: true, tension: 0.28, stack: 'tokens' },
      { label: '输出', data: series.output, borderColor: palette.info, backgroundColor: withAlpha(palette.info, 0.12), fill: true, tension: 0.28, stack: 'tokens' },
      { label: '缓存读取', data: series.cached, borderColor: palette.warn, backgroundColor: withAlpha(palette.warn, 0.12), fill: true, tension: 0.28, stack: 'tokens' },
    ],
  }

  if (state.charts.trend) {
    state.charts.trend.data = data
    state.charts.trend.update()
    return
  }

  state.charts.trend = new Chart(node, {
    type: 'line',
    data,
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, stacked: true, ticks: { callback: (value) => formatTokenCompact(value) } },
      },
    },
  })
}

function renderModelShareChart(byModel = {}) {
  if (!window.Chart) return
  const node = $('#modelShareChart')
  const entries = Object.entries(byModel)
    .sort((a, b) => Number(b[1]?.totalTokens || 0) - Number(a[1]?.totalTokens || 0))
    .slice(0, 8)
  const labels = entries.map(([model]) => model)
  const values = entries.map(([, bucket]) => Number(bucket.totalTokens || 0))
  const data = {
    labels: labels.length ? labels : ['暂无数据'],
    datasets: [{
      data: values.length ? values : [1],
      backgroundColor: ['#6f66d8', '#0d7b73', '#d08b2f', '#3281c3', '#9c4f87', '#4c8f54', '#c85f5f', '#6d7480'],
      borderWidth: 0,
    }],
  }

  if (state.charts.modelShare) {
    state.charts.modelShare.data = data
    state.charts.modelShare.update()
    return
  }

  state.charts.modelShare = new Chart(node, {
    type: 'doughnut',
    data,
    options: {
      responsive: true,
      cutout: '64%',
      plugins: { legend: { position: 'bottom' } },
    },
  })
}

function renderDashboardRecent() {
  const rows = $('#dashRecentRows')
  const logs = (state.runtime?.requestLog || []).filter((log) => log.usage).slice(0, 8)
  rows.innerHTML = logs.length ? '' : '<div class="empty">暂无带 token 的请求记录。</div>'

  for (const log of logs) {
    const item = document.createElement('div')
    item.className = 'mini-record'
    item.innerHTML = `
      <div><strong>${escapeHtml(log.model || '-')}</strong><small>${new Date(log.time).toLocaleString()}</small></div>
      <div><strong>${formatTokenCompact(log.usage?.totalTokens)}</strong><small>${escapeHtml(log.providerName || '-')}</small></div>
      ${logStatusPill(log)}
    `
    rows.appendChild(item)
  }
}

function renderRecords() {
  if (state.activeTab !== 'records') return
  syncRecordFilterControls()
  const records = getFilteredRecords()
  const rows = $('#recordRows')
  $('#recordCount').textContent = `显示 ${formatNumber(records.length)} 条 / 共 ${formatNumber((state.runtime?.requestLog || []).length)} 条`
  rows.innerHTML = records.length ? '' : '<tr><td colspan="7" class="empty">没有匹配的请求记录。</td></tr>'

  for (const log of records.slice(0, 300)) {
    const usage = log.usage || {}
    const attemptLine = (log.attempts || [])
      .map((attempt) => `${attempt.providerName || '-'}${attempt.status ? `(${attempt.status})` : ''}`)
      .join(' → ')
    const credentialLabel = log.credentialLabel || (log.attempts || []).find((attempt) => attempt.credentialLabel)?.credentialLabel || '-'
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><strong>${new Date(log.time).toLocaleString()}</strong><br><small>${escapeHtml(log.method || '')} ${escapeHtml(log.path || '')}</small></td>
      <td><strong>${escapeHtml(log.model || '-')}</strong><br><small>${escapeHtml(log.routedModel || '-')}</small></td>
      <td><strong>${escapeHtml(log.providerName || '-')}</strong><br><small>${escapeHtml(credentialLabel)}</small></td>
      <td>${logStatusPill(log)}<br><small>${escapeHtml(logStatusText(log))}</small></td>
      <td><strong>${formatTokenCompact(usage.totalTokens)}</strong><br><small>入 ${formatTokenCompact(usage.inputTokens)} / 出 ${formatTokenCompact(usage.outputTokens)} / 缓存 ${formatTokenCompact(usage.cachedTokens)}${usage.estimated ? ' · 估算' : ''}</small></td>
      <td><strong>${log.durationMs ?? '-'} ms</strong></td>
      <td><small>${escapeHtml(attemptLine || log.error || '-')}</small></td>
    `
    rows.appendChild(tr)
  }
}

function handleRecordFilterChange(event) {
  const { id, value } = event.currentTarget
  if (id === 'recordSearch') state.recordsFilter.search = value
  if (id === 'recordStatus') state.recordsFilter.status = value
  if (id === 'recordModel') state.recordsFilter.model = value
  if (id === 'recordProvider') state.recordsFilter.provider = value
  if (id === 'recordRange') state.recordsFilter.range = value
  if (id === 'recordSort') state.recordsFilter.sort = value
  renderRecords()
}

function handleUsageWindowSwitch(event) {
  const tab = event.target.closest('.window-tab')
  if (!tab) return
  state.usageWindow = tab.dataset.window
  $$('#usageWindowTabs .window-tab').forEach((item) => item.classList.toggle('active', item === tab))
  renderUsageWindowRows()
}

// 按 epoch-hour 桶聚合每条线路在选定时间窗内的消耗。
function aggregateWindow(hourly = {}, windowKey) {
  const now = Date.now()
  const hourMs = 3600000
  let threshold
  if (windowKey === '24h') threshold = now - 24 * hourMs
  else if (windowKey === '7d') threshold = now - 7 * 24 * hourMs
  else if (windowKey === '30d') threshold = now - 30 * 24 * hourMs
  else {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    threshold = midnight.getTime()
  }

  const sum = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, requests: 0, latencySum: 0, latencyCount: 0, lastAt: 0 }
  for (const [hourKey, bucket] of Object.entries(hourly)) {
    const hourStart = Number(hourKey) * hourMs
    if (hourStart + hourMs <= threshold) continue
    sum.inputTokens += Number(bucket.inputTokens || 0)
    sum.outputTokens += Number(bucket.outputTokens || 0)
    sum.cachedTokens += Number(bucket.cachedTokens || 0)
    sum.totalTokens += Number(bucket.totalTokens || 0)
    sum.requests += Number(bucket.requests || 0)
    sum.latencySum += Number(bucket.latencySum || 0)
    sum.latencyCount += Number(bucket.latencyCount || 0)
    if (hourStart > sum.lastAt) sum.lastAt = hourStart
  }
  return sum
}

function renderUsageWindowRows() {
  const rows = $('#usageWindowRows')
  if (!rows) return
  const providerHourly = state.runtime?.usage?.providerHourly || {}
  const entries = []

  for (const provider of state.config?.providers || []) {
    const agg = aggregateWindow(providerHourly[provider.id] || {}, state.usageWindow)
    if (!agg.requests && !agg.totalTokens) continue
    entries.push({ provider, agg })
  }

  entries.sort((a, b) => b.agg.totalTokens - a.agg.totalTokens)
  rows.innerHTML = entries.length ? '' : '<div class="empty">该时间窗暂无消耗数据。</div>'

  for (const { provider, agg } of entries) {
    const avgLatency = agg.latencyCount ? Math.round(agg.latencySum / agg.latencyCount) : null
    const item = document.createElement('div')
    item.className = 'usage-row window'
    item.innerHTML = `
      <div><strong>${escapeHtml(provider.name)}</strong><small>${formatNumber(agg.requests)} 次请求</small></div>
      <div><strong>${formatTokenCompact(agg.totalTokens)}</strong><small>总量</small></div>
      <div><strong>${formatTokenCompact(agg.inputTokens)} / ${formatTokenCompact(agg.outputTokens)}</strong><small>输入 / 输出</small></div>
      <div><strong>${formatTokenCompact(agg.cachedTokens)}</strong><small>缓存</small></div>
      <div><strong>${avgLatency === null ? '-' : `${avgLatency} ms`}</strong><small>平均耗时</small></div>
      <div><strong>${agg.lastAt ? new Date(agg.lastAt).toLocaleString() : '-'}</strong><small>最近</small></div>
    `
    rows.appendChild(item)
  }
}

function renderUsageRows(selector, buckets = {}, labelResolver = null, reverseKeySort = false, includeCost = false) {
  const rows = $(selector)
  const entries = Object.entries(buckets || {})
    .sort((a, b) => reverseKeySort
      ? b[0].localeCompare(a[0])
      : Number(b[1]?.totalTokens || 0) - Number(a[1]?.totalTokens || 0))
    .slice(0, 20)

  rows.innerHTML = entries.length ? '' : '<div class="empty">暂无用量数据。</div>'

  for (const [key, bucket] of entries) {
    const item = document.createElement('div')
    item.className = 'usage-row'
    item.innerHTML = `
      <div><strong>${escapeHtml(labelResolver ? labelResolver(key) : key)}</strong><small>${formatNumber(bucket.requests)} 次请求${includeCost ? ` · ${escapeHtml(estimatedCostText(key, bucket))}` : ''}</small></div>
      <div><strong>${formatTokenCompact(bucket.totalTokens)}</strong><small>总量</small></div>
      <div><strong>${formatTokenCompact(bucket.inputTokens)} / ${formatTokenCompact(bucket.outputTokens)}</strong><small>输入 / 输出</small></div>
      <div><strong>${formatTokenCompact(bucket.cachedTokens)}</strong><small>缓存</small></div>
    `
    rows.appendChild(item)
  }
}

function renderCredentialUsageRows() {
  const rows = $('#usageCredentialRows')
  const localBuckets = state.runtime?.usage?.byCredential || {}
  const upstreamBuckets = state.runtime?.upstreamUsage || {}
  const entries = []

  for (const provider of state.config.providers || []) {
    for (const credential of provider.credentials || []) {
      const local = localBuckets[credential.id] || {}
      const upstream = upstreamBuckets[credential.id] || null
      if (!local.totalTokens && !upstream) continue
      entries.push({ provider, credential, local, upstream })
    }
  }

  entries.sort((a, b) => Number(b.local.totalTokens || 0) - Number(a.local.totalTokens || 0))
  rows.innerHTML = entries.length ? '' : '<div class="empty">暂无 Key 分组用量数据。</div>'

  for (const entry of entries.slice(0, 30)) {
    const item = document.createElement('div')
    item.className = 'usage-row'
    item.innerHTML = `
      <div><strong>${escapeHtml(entry.provider.name)} / ${escapeHtml(entry.credential.label || '默认')}</strong><small>${escapeHtml(credentialGroupLine(entry))}</small></div>
      <div><strong>${formatTokenCompact(entry.local.totalTokens)}</strong><small>${formatNumber(entry.local.requests)} 次请求</small></div>
      <div><strong>${escapeHtml(estimatedCostText(entry.credential.id, entry.local))}</strong><small>本地估算</small></div>
      <div><strong>${escapeHtml(upstreamQuotaText(entry.upstream))}</strong><small>${escapeHtml(upstreamSyncText(entry.upstream))}</small></div>
    `
    rows.appendChild(item)
  }
}

function switchTab(tabName) {
  const button = $(`.tab[data-tab="${cssEscape(tabName)}"]`)
  if (button) button.click()
}

function syncRecordFilterControls() {
  const filter = state.recordsFilter
  $('#recordSearch').value = filter.search
  setSelectValue($('#recordStatus'), filter.status)
  setSelectValue($('#recordRange'), filter.range)
  setSelectValue($('#recordSort'), filter.sort)

  const logs = state.runtime?.requestLog || []
  const models = uniqueSorted(logs.map((log) => log.model).filter(Boolean))
  const providers = uniqueSorted([
    ...logs.map((log) => log.providerName).filter(Boolean),
    ...(state.config?.providers || []).map((provider) => provider.name).filter(Boolean),
  ])

  fillSelect($('#recordModel'), 'all', '全部模型', models, filter.model)
  fillSelect($('#recordProvider'), 'all', '全部线路', providers, filter.provider)
}

function fillSelect(select, allValue, allLabel, values, selected) {
  const options = [
    `<option value="${escapeHtml(allValue)}">${escapeHtml(allLabel)}</option>`,
    ...values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`),
  ]
  select.innerHTML = options.join('')
  setSelectValue(select, selected)
}

function setSelectValue(select, value) {
  select.value = value
  if (select.value !== value) select.value = 'all'
}

function getFilteredRecords() {
  const filter = state.recordsFilter
  const query = filter.search.trim().toLowerCase()
  const threshold = recordRangeThreshold(filter.range)
  const records = (state.runtime?.requestLog || []).filter((log) => {
    const time = Date.parse(log.time || '')
    const credentialLabel = log.credentialLabel || (log.attempts || []).find((attempt) => attempt.credentialLabel)?.credentialLabel || ''
    const haystack = `${log.model || ''} ${log.routedModel || ''} ${log.providerName || ''} ${credentialLabel} ${log.error || ''}`.toLowerCase()
    if (query && !haystack.includes(query)) return false
    if (filter.status === 'ok' && !log.ok) return false
    if (filter.status === 'failed' && log.ok) return false
    if (filter.model !== 'all' && log.model !== filter.model) return false
    if (filter.provider !== 'all' && log.providerName !== filter.provider) return false
    if (threshold !== null && (!Number.isFinite(time) || time < threshold)) return false
    return true
  })

  records.sort((a, b) => {
    if (filter.sort === 'tokens') return Number(b.usage?.totalTokens || 0) - Number(a.usage?.totalTokens || 0)
    if (filter.sort === 'latency') return Number(b.durationMs || 0) - Number(a.durationMs || 0)
    return Date.parse(b.time || '') - Date.parse(a.time || '')
  })

  return records
}

function recordRangeThreshold(range) {
  const now = Date.now()
  if (range === '24h') return now - 24 * 3600000
  if (range === '7d') return now - 7 * 24 * 3600000
  if (range === '30d') return now - 30 * 24 * 3600000
  if (range === 'today') {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    return midnight.getTime()
  }
  return null
}

function exportRecordsCsv() {
  const rows = getFilteredRecords()
  const header = ['time', 'model', 'routedModel', 'provider', 'credential', 'ok', 'status', 'inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens', 'durationMs', 'attempts']
  const lines = [header.join(',')]
  for (const log of rows) {
    const credentialLabel = log.credentialLabel || (log.attempts || []).find((attempt) => attempt.credentialLabel)?.credentialLabel || ''
    const attempts = (log.attempts || []).map((attempt) => `${attempt.providerName || ''}:${attempt.status || ''}`).join(' > ')
    lines.push([
      log.time,
      log.model,
      log.routedModel,
      log.providerName,
      credentialLabel,
      log.ok ? 'success' : 'failed',
      log.status,
      log.usage?.inputTokens || 0,
      log.usage?.outputTokens || 0,
      log.usage?.cachedTokens || 0,
      log.usage?.totalTokens || 0,
      log.durationMs,
      attempts,
    ].map(csvCell).join(','))
  }
  downloadText(`local-model-relay-records-${localDateKey(new Date())}.csv`, `${lines.join('\n')}\n`, 'text/csv;charset=utf-8')
  toast(`已导出 ${rows.length} 条记录`)
}

function aggregateGlobalHourly() {
  const out = {}
  const providerHourly = state.runtime?.usage?.providerHourly || {}
  for (const hourly of Object.values(providerHourly)) {
    for (const [hourKey, bucket] of Object.entries(hourly || {})) {
      out[hourKey] = addIntoBucket(out[hourKey] || emptyBucket(), bucket)
    }
  }
  return out
}

function aggregateLocalToday() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const threshold = start.getTime()
  const hourMs = 3600000
  const sum = { ...emptyBucket(), byCredential: {} }
  for (const [hourKey, bucket] of Object.entries(aggregateGlobalHourly())) {
    if (Number(hourKey) * hourMs + hourMs > threshold) addIntoBucket(sum, bucket)
  }

  const logs = state.runtime?.requestLog || []
  for (const log of logs) {
    if (!log.usage || Date.parse(log.time || '') < threshold) continue
    const credentialId = log.credentialId || (log.attempts || []).find((attempt) => attempt.credentialId)?.credentialId || ''
    if (!credentialId) continue
    sum.byCredential[credentialId] = addIntoBucket(sum.byCredential[credentialId] || emptyBucket(), log.usage)
  }
  return sum
}

function emptyBucket() {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, requests: 0, latencySum: 0, latencyCount: 0 }
}

function addIntoBucket(target, bucket = {}) {
  target.inputTokens += Number(bucket.inputTokens || 0)
  target.outputTokens += Number(bucket.outputTokens || 0)
  target.cachedTokens += Number(bucket.cachedTokens || 0)
  target.cacheWriteTokens += Number(bucket.cacheWriteTokens || 0)
  target.totalTokens += Number(bucket.totalTokens || 0)
  target.requests += Number(bucket.requests || 0)
  target.latencySum += Number(bucket.latencySum || 0)
  target.latencyCount += Number(bucket.latencyCount || 0)
  return target
}

function estimateWindowCost(byCredential = {}) {
  let total = 0
  let hasTokens = false
  const quotaPerCny = Number(state.config?.service?.quotaPerCny || 500000)
  if (!quotaPerCny) return '-'
  for (const [credentialId, bucket] of Object.entries(byCredential)) {
    const found = findCredential(credentialId)
    const rate = Number(found?.credential?.rate || 1)
    const tokens = Number(bucket.totalTokens || 0)
    if (tokens) hasTokens = true
    total += (tokens * rate) / quotaPerCny
  }
  return hasTokens ? `¥${trimNumber(total)}` : '-'
}

function successStats() {
  const entries = Object.values(state.runtime?.providerState || {})
  const success = entries.reduce((sum, entry) => sum + Number(entry.successCount || 0), 0)
  const failure = entries.reduce((sum, entry) => sum + Number(entry.failureCount || 0), 0)
  return { success, failure, total: success + failure }
}

function averageProviderLatency() {
  const values = Object.values(state.runtime?.providerState || {})
    .map((entry) => Number(entry.averageLatencyMs))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (!values.length) return null
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function handleProviderDragStart(event) {
  if (!state.dragArmed) {
    event.preventDefault()
    return
  }
  const row = event.target.closest('tr[data-provider-id]')
  if (!row) return
  state.draggingProviderId = row.dataset.providerId
  state.providerDragSaved = false
  row.classList.add('dragging')
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', row.dataset.providerId)
}

function handleProviderDragOver(event) {
  if (!state.draggingProviderId) return
  // 必须无条件 preventDefault，否则最后一次 dragover 落在被拖行自身时 drop 不会触发。
  event.preventDefault()
  const target = event.target.closest('tr[data-provider-id]')
  if (!target || target.dataset.providerId === state.draggingProviderId) return
  const rows = $('#providerRows')
  const dragged = rows.querySelector(`tr[data-provider-id="${cssEscape(state.draggingProviderId)}"]`)
  if (!dragged) return
  const rect = target.getBoundingClientRect()
  const afterTarget = event.clientY > rect.top + rect.height / 2
  rows.insertBefore(dragged, afterTarget ? target.nextSibling : target)
}

async function handleProviderDrop(event) {
  if (!state.draggingProviderId) return
  event.preventDefault()
  const ids = $$('#providerRows tr[data-provider-id]').map((row) => row.dataset.providerId)
  state.providerDragSaved = true
  handleProviderDragEnd()
  await saveProviderOrderSafely(ids)
}

function handleProviderDragEnd() {
  const shouldSave = state.draggingProviderId && !state.providerDragSaved
  const ids = shouldSave ? $$('#providerRows tr[data-provider-id]').map((row) => row.dataset.providerId) : []
  state.draggingProviderId = null
  state.providerDragSaved = false
  state.dragArmed = false
  $$('#providerRows .dragging').forEach((row) => row.classList.remove('dragging'))
  if (shouldSave) saveProviderOrderSafely(ids)
}

async function saveProviderOrderSafely(ids) {
  try {
    await saveProviderOrder(ids)
  } catch (error) {
    toast(error instanceof Error ? error.message : '线路优先级保存失败')
    await refreshAll()
  }
}

async function saveProviderOrder(ids) {
  const orderedProviders = [...state.config.providers].sort((a, b) => a.priority - b.priority)
  if (orderedProviders.map((provider) => provider.id).join('|') === ids.join('|')) return

  for (const [index, id] of ids.entries()) {
    const provider = state.config.providers.find((item) => item.id === id)
    if (!provider) continue
    const priority = (index + 1) * 10
    if (provider.priority === priority) continue
    await api(`/api/providers/${id}`, {
      method: 'PATCH',
      body: providerPatch(provider, priority),
    })
  }
  toast('线路优先级已更新')
  await refreshAll()
}

async function handleProviderAction(event) {
  const button = event.target.closest('button')
  if (!button) return
  const provider = state.config.providers.find((item) => item.id === button.dataset.id)
  if (!provider) return

  if (button.dataset.action === 'edit-provider') openProviderDialog(provider)
  if (button.dataset.action === 'real-test') openRealTestDialog(provider, { autoRun: true })
  if (button.dataset.action === 'set-start-provider') {
    state.runtime = await api('/api/routing/start', {
      method: 'POST',
      body: {
        providerId: provider.id,
        mode: state.runtime?.routing?.startMode || 'auto',
      },
    })
    toast(`已设为路由起点：${provider.name}`)
    renderStatus()
    renderRoutingBar()
    renderProviders()
  }
  if (button.dataset.action === 'toggle-provider') {
    await api(`/api/providers/${provider.id}`, { method: 'PATCH', body: { enabled: !provider.enabled } })
    toast(provider.enabled ? '线路已停用' : '线路已启用')
    await refreshAll()
  }
  if (button.dataset.action === 'delete-provider') {
    if (!confirm(`删除线路「${provider.name}」？相关模型路由也会移除。`)) return
    await api(`/api/providers/${provider.id}`, { method: 'DELETE' })
    toast('线路已删除')
    await refreshAll()
  }
  if (button.dataset.action === 'test') {
    button.disabled = true
    button.textContent = '测试中'
    try {
      const result = await api(`/api/providers/${provider.id}/test`, { method: 'POST' })
      if (result.ok && result.models?.length) {
        const mergedModels = [...new Set([...(provider.models || []), ...result.models])].sort()
        const changed = mergedModels.join('\n') !== (provider.models || []).slice().sort().join('\n')
        if (changed && confirm(`测试成功，发现 ${result.models.length} 个模型。写入这条线路的支持模型吗？`)) {
          await api(`/api/providers/${provider.id}`, { method: 'PATCH', body: { models: mergedModels } })
          toast(`测试成功，已写入 ${mergedModels.length} 个模型`)
          await refreshAll()
          return
        }
      }
      toast(result.ok ? `测试成功：${result.latencyMs} ms` : `测试失败：${result.message}`)
    } finally {
      button.disabled = false
      button.textContent = '测试'
    }
  }
  if (button.dataset.action === 'sync-usage') {
    button.disabled = true
    button.textContent = '同步中'
    try {
      const result = await api(`/api/providers/${provider.id}/usage-sync`, {
        method: 'POST',
        body: { credentialId: provider.activeCredentialId },
      })
      toast(result.ok ? `同步成功：${result.snapshot?.group || result.credentialLabel || provider.name}` : `同步失败：${result.message}`)
      await refreshAll()
    } finally {
      button.disabled = false
      button.textContent = '同步扣账'
    }
  }
}

async function saveRoutingMode(event) {
  const mode = event.currentTarget.value === 'locked' ? 'locked' : 'auto'
  const providerId = state.runtime?.routing?.startProviderId || ''
  state.runtime = await api('/api/routing/start', {
    method: 'POST',
    body: { providerId, mode },
  })
  renderRoutingBar()
  renderProviders()
  toast(mode === 'locked' ? '路由起点已锁定' : '路由起点将随成功线路自动推进')
}

async function clearStartProvider() {
  state.runtime = await api('/api/routing/start', { method: 'DELETE' })
  renderRoutingBar()
  renderProviders()
  toast('已清除路由起点')
}

function openRealTestDialog(provider, options = {}) {
  state.testingProvider = provider
  const form = $('#realTestForm')
  form.reset()
  $('#realTestDialogTitle').textContent = `真实转发测试：${provider.name}`
  formField(form, 'providerId').value = provider.id
  formField(form, 'model').value = preferredRealTestModel(provider)
  formField(form, 'wireApi').value = 'provider'
  formField(form, 'prompt').value = 'Reply with exactly: OK'
  formField(form, 'maxTokens').value = 8

  $('#realTestModelList').innerHTML = provider.models
    .map((model) => `<option value="${escapeHtml(model)}"></option>`)
    .join('')

  const enabledCredentials = (provider.credentials || []).filter((credential) => credential.enabled)
  const credentials = enabledCredentials.length ? enabledCredentials : provider.credentials || []
  formField(form, 'credentialId').innerHTML = credentials
    .map((credential) => `
      <option value="${escapeHtml(credential.id)}" ${credential.id === provider.activeCredentialId ? 'selected' : ''}>
        ${escapeHtml(credential.label || '默认')}
      </option>
    `)
    .join('')

  renderRealTestResult()
  $('#realTestDialog').showModal()
  if (options.autoRun) runRealTestForForm(form)
}

async function runRealTest(event) {
  event.preventDefault()
  await runRealTestForForm(event.currentTarget)
}

async function runRealTestForForm(form) {
  const providerId = formField(form, 'providerId').value
  const button = $('#runRealTestBtn')
  button.disabled = true
  button.textContent = '测试中'
  renderRealTestResult({ pending: true })
  await nextFrame()

  try {
    const result = await api(`/api/providers/${providerId}/real-test`, {
      method: 'POST',
      body: {
        model: formField(form, 'model').value,
        credentialId: formField(form, 'credentialId').value,
        wireApi: formField(form, 'wireApi').value === 'provider' ? '' : formField(form, 'wireApi').value,
        prompt: formField(form, 'prompt').value,
        maxTokens: Number(formField(form, 'maxTokens').value),
      },
    })
    renderRealTestResult(result)
    toast(result.ok ? `真实转发成功：${result.latencyMs} ms` : `真实转发失败：HTTP ${result.status || 0}`)
  } catch (error) {
    renderRealTestResult({
      ok: false,
      status: 0,
      latencyMs: 0,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    button.disabled = false
    button.textContent = '运行测试'
    await refreshState()
  }
}

function renderRealTestResult(result = null) {
  const node = $('#realTestResult')
  if (!result) {
    node.className = 'real-test-result empty'
    node.textContent = '尚未运行真实转发测试。'
    return
  }

  node.className = `real-test-result ${result.pending ? 'pending' : result.ok ? 'ok' : 'warn'}`
  if (result.pending) {
    node.textContent = '正在向上游发起一次真实 chat/completions 请求...'
    return
  }

  const usage = result.usage
    ? `${formatTokenCompact(result.usage.totalTokens)} tokens，入 ${formatTokenCompact(result.usage.inputTokens)} / 出 ${formatTokenCompact(result.usage.outputTokens)} / 缓存 ${formatTokenCompact(result.usage.cachedTokens)}`
    : '-'
  node.innerHTML = `
    <div><span class="label">状态</span><strong>${result.ok ? '成功' : '失败'} · HTTP ${result.status || 0}</strong></div>
    <div><span class="label">耗时</span><strong>${result.latencyMs || '-'} ms</strong></div>
    <div><span class="label">模型</span><strong>${escapeHtml(result.model || '-')}</strong></div>
    <div><span class="label">Key 分组</span><strong>${escapeHtml(result.credentialLabel || '-')}</strong></div>
    <div class="wide"><span class="label">上游协议</span><strong>${wireApiLabel(result.wireApi)}</strong></div>
    <div class="wide"><span class="label">回复</span><pre>${escapeHtml(result.content || result.message || '-')}</pre></div>
    <div class="wide"><span class="label">用量</span><strong>${escapeHtml(usage)}</strong></div>
  `
}

async function handleCredentialSwitch(event) {
  const select = event.target.closest('[data-action="switch-credential"]')
  if (!select) return
  await api(`/api/providers/${select.dataset.id}/credential`, {
    method: 'POST',
    body: { credentialId: select.value },
  })
  toast('当前分组已切换')
  await refreshAll()
}

async function handleRouteAction(event) {
  const button = event.target.closest('button')
  if (!button) return
  const route = state.config.routes.find((item) => item.id === button.dataset.id)
  if (!route) return

  if (button.dataset.action === 'edit-route') openRouteDialog(route)
  if (button.dataset.action === 'toggle-route') {
    await api(`/api/routes/${route.id}`, { method: 'PATCH', body: { enabled: !route.enabled } })
    toast(route.enabled ? '路由已停用' : '路由已启用')
    await refreshAll()
  }
  if (button.dataset.action === 'delete-route') {
    if (!confirm(`删除模型路由「${route.virtualModel}」？`)) return
    await api(`/api/routes/${route.id}`, { method: 'DELETE' })
    toast('路由已删除')
    await refreshAll()
  }
}

function openProviderDialog(provider = null) {
  state.editingProvider = provider
  const form = $('#providerForm')
  form.reset()
  $('#providerDialogTitle').textContent = provider ? '编辑线路' : '新增线路'
  formField(form, 'id').value = provider?.id || ''
  formField(form, 'name').value = provider?.name || ''
  formField(form, 'baseUrl').value = provider?.baseUrl || ''
  formField(form, 'authMode').value = provider?.authMode || 'authorization'
  formField(form, 'wireApi').value = provider?.wireApi || 'chat'
  formField(form, 'providerOutboundProxyMode').value = provider?.outboundProxyMode || 'inherit'
  formField(form, 'providerOutboundProxyUrl').value = provider?.outboundProxyUrl || ''
  formField(form, 'priority').value = provider?.priority ?? nextProviderPriority()
  formField(form, 'timeoutMs').value = provider?.timeoutMs || state.config.service.requestTimeoutMs
  formField(form, 'cooldownSeconds').value = provider?.cooldownSeconds ?? state.config.service.defaultCooldownSeconds
  formField(form, 'models').value = provider?.models?.join(', ') || ''
  formField(form, 'tags').value = provider?.tags?.join(', ') || ''
  formField(form, 'notes').value = provider?.notes || ''
  formField(form, 'enabled').checked = provider ? provider.enabled : true
  $('#credentialRows').innerHTML = ''
  const credentials = provider?.credentials?.length
    ? provider.credentials
    : [{ id: '', label: '默认', apiKeySet: false, apiKeyMasked: '', enabled: true, note: '' }]
  credentials.forEach((credential) => addCredentialRow(credential, provider?.activeCredentialId))
  renderProviderProxyFields()
  $('#providerDialog').showModal()
}

function renderProviderProxyFields() {
  const form = $('#providerForm')
  const mode = formField(form, 'providerOutboundProxyMode').value || 'inherit'
  $('#providerCustomProxyField').hidden = mode !== 'custom'
}

async function saveProvider(event) {
  event.preventDefault()
  const form = event.currentTarget
  const body = {
    name: formField(form, 'name').value,
    baseUrl: formField(form, 'baseUrl').value,
    credentials: readCredentialRows(),
    activeCredentialId: $('.credential-row input[name="activeCredential"]:checked')?.value || '',
    authMode: formField(form, 'authMode').value,
    wireApi: formField(form, 'wireApi').value,
    outboundProxyMode: formField(form, 'providerOutboundProxyMode').value || 'inherit',
    outboundProxyUrl: formField(form, 'providerOutboundProxyUrl').value,
    priority: Number(formField(form, 'priority').value),
    timeoutMs: Number(formField(form, 'timeoutMs').value),
    cooldownSeconds: Number(formField(form, 'cooldownSeconds').value),
    models: splitList(formField(form, 'models').value),
    tags: splitList(formField(form, 'tags').value),
    notes: formField(form, 'notes').value,
    enabled: formField(form, 'enabled').checked,
  }

  const id = formField(form, 'id').value
  await api(id ? `/api/providers/${id}` : '/api/providers', {
    method: id ? 'PATCH' : 'POST',
    body,
  })
  $('#providerDialog').close()
  toast('线路已保存')
  await refreshAll()
}

function addCredentialRow(credential = {}, activeCredentialId = '') {
  const row = document.createElement('div')
  row.className = 'credential-row'
  const id = credential.id || `new-${Date.now()}-${Math.random().toString(16).slice(2)}`
  row.innerHTML = `
    <label class="radio-label" title="设为当前生效分组">
      <input name="activeCredential" type="radio" value="${escapeHtml(id)}">
      <span>当前</span>
    </label>
    <label>
      <span>分组名</span>
      <input name="credentialLabel" required autocomplete="off" placeholder="低倍率分组">
    </label>
    <label>
      <span>API Key</span>
      <input name="credentialApiKey" type="password" autocomplete="off">
    </label>
    <label>
      <span>倍率</span>
      <input name="credentialRate" type="number" min="0.01" step="0.01">
    </label>
    <label>
      <span>上游分组</span>
      <input name="credentialUpstreamGroup" autocomplete="off">
    </label>
    <label class="checkline compact-check">
      <input name="credentialEnabled" type="checkbox">
      <span>启用</span>
    </label>
    <button class="icon-btn" type="button" title="移除分组" aria-label="移除分组">×</button>
    <input name="credentialId" type="hidden" value="${escapeHtml(id)}">
  `
  row.querySelector('[name="credentialLabel"]').value = credential.label || '默认'
  row.querySelector('[name="credentialApiKey"]').value = ''
  row.querySelector('[name="credentialApiKey"]').placeholder = credential.apiKeySet ? '留空保持原值' : '请输入 API Key'
  row.querySelector('[name="credentialRate"]').value = credential.rate || 1
  row.querySelector('[name="credentialUpstreamGroup"]').value = credential.upstreamGroup || ''
  row.querySelector('[name="credentialEnabled"]').checked = credential.enabled !== false
  row.querySelector('[name="activeCredential"]').checked = credential.id
    ? credential.id === activeCredentialId
    : !$('#credentialRows .credential-row')
  row.querySelector('button').addEventListener('click', () => {
    if ($$('.credential-row').length <= 1) {
      toast('至少保留一个分组')
      return
    }
    const wasActive = row.querySelector('[name="activeCredential"]').checked
    row.remove()
    if (wasActive) $('.credential-row [name="activeCredential"]').checked = true
  })
  $('#credentialRows').appendChild(row)
  if (!$('.credential-row [name="activeCredential"]:checked')) {
    row.querySelector('[name="activeCredential"]').checked = true
  }
}

function readCredentialRows() {
  return $$('.credential-row').map((row) => ({
    id: row.querySelector('[name="credentialId"]').value,
    label: row.querySelector('[name="credentialLabel"]').value,
    apiKey: row.querySelector('[name="credentialApiKey"]').value,
    enabled: row.querySelector('[name="credentialEnabled"]').checked,
    rate: Number(row.querySelector('[name="credentialRate"]').value),
    upstreamGroup: row.querySelector('[name="credentialUpstreamGroup"]').value,
  }))
}

function bindTargetDragSort() {
  const rows = $('#targetRows')
  rows.onpointerdown = armDragFromHandle
  rows.ondragstart = (event) => {
    if (!state.dragArmed) {
      event.preventDefault()
      return
    }
    const row = event.target.closest('.target-row')
    if (!row) return
    state.draggingTargetRow = row
    row.classList.add('dragging')
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', 'target-row')
  }
  rows.ondragover = (event) => {
    if (!state.draggingTargetRow) return
    event.preventDefault()
    const target = event.target.closest('.target-row')
    if (!target || target === state.draggingTargetRow) return
    const rect = target.getBoundingClientRect()
    const afterTarget = event.clientY > rect.top + rect.height / 2
    rows.insertBefore(state.draggingTargetRow, afterTarget ? target.nextSibling : target)
  }
  rows.ondrop = (event) => {
    if (!state.draggingTargetRow) return
    event.preventDefault()
    clearTargetDrag()
    renumberTargetPriorities()
  }
  rows.ondragend = () => {
    clearTargetDrag()
    renumberTargetPriorities()
  }
}

function clearTargetDrag() {
  state.draggingTargetRow = null
  state.dragArmed = false
  $$('#targetRows .dragging').forEach((row) => row.classList.remove('dragging'))
}

function renumberTargetPriorities() {
  $$('#targetRows .target-row').forEach((row, index) => {
    const providerId = row.querySelector('[name="providerId"]').value
    const provider = state.config.providers.find((item) => item.id === providerId)
    row.querySelector('[name="priority"]').value = provider?.priority ?? index * 10
  })
}

function openRouteDialog(route = null) {
  state.editingRoute = route
  const form = $('#routeForm')
  form.reset()
  $('#routeDialogTitle').textContent = route ? '编辑模型路由' : '新增模型路由'
  formField(form, 'id').value = route?.id || ''
  formField(form, 'virtualModel').value = route?.virtualModel || ''
  formField(form, 'notes').value = route?.notes || ''
  formField(form, 'enabled').checked = route ? route.enabled : true
  $('#targetRows').innerHTML = ''
  const targets = route?.targets?.length
    ? [...route.targets].sort((a, b) => a.priority - b.priority)
    : [{ providerId: '', model: '', priority: 0 }]
  targets.forEach((target) => addTargetRow(target))
  $('#routeDialog').showModal()
}

function addTargetRow(target = {}) {
  const row = document.createElement('div')
  row.className = 'target-row'
  row.draggable = true
  row.innerHTML = `
    <span class="drag-handle" title="拖拽调整顺序" aria-label="拖拽调整顺序">↕</span>
    <label>
      <span>线路</span>
      <select name="providerId" required>
        <option value="">选择线路</option>
        ${state.config.providers.map((provider) => `<option value="${provider.id}">${escapeHtml(provider.name)}</option>`).join('')}
      </select>
    </label>
    <label>
      <span>真实模型</span>
      <input name="model" required autocomplete="off">
    </label>
    <label>
      <span>线路顺序</span>
      <input name="priority" type="number" min="0" readonly title="保存后会自动跟随线路优先级">
    </label>
    <button class="icon-btn" type="button" title="移除目标" aria-label="移除目标">×</button>
  `
  row.querySelector('[name="providerId"]').value = target.providerId || ''
  row.querySelector('[name="model"]').value = target.model || ''
  row.querySelector('[name="priority"]').value = target.priority ?? $('#targetRows').children.length * 10
  row.querySelector('[name="providerId"]').addEventListener('change', () => {
    const modelInput = row.querySelector('[name="model"]')
    const virtualModel = formField($('#routeForm'), 'virtualModel').value
    const provider = state.config.providers.find((item) => item.id === row.querySelector('[name="providerId"]').value)
    if (!modelInput.value && provider?.models?.includes(virtualModel)) modelInput.value = virtualModel
    renumberTargetPriorities()
  })
  row.querySelector('button').addEventListener('click', () => {
    row.remove()
    renumberTargetPriorities()
  })
  $('#targetRows').appendChild(row)
  renumberTargetPriorities()
}

async function saveRoute(event) {
  event.preventDefault()
  const form = event.currentTarget
  renumberTargetPriorities()
  const targets = $$('.target-row').map((row) => ({
    providerId: row.querySelector('[name="providerId"]').value,
    model: row.querySelector('[name="model"]').value,
    priority: Number(row.querySelector('[name="priority"]').value),
  }))

  const body = {
    virtualModel: formField(form, 'virtualModel').value,
    targets,
    notes: formField(form, 'notes').value,
    enabled: formField(form, 'enabled').checked,
  }

  const id = formField(form, 'id').value
  await api(id ? `/api/routes/${id}` : '/api/routes', {
    method: id ? 'PATCH' : 'POST',
    body,
  })
  $('#routeDialog').close()
  toast('模型路由已保存')
  await refreshAll()
}

async function saveSettings(event) {
  event.preventDefault()
  const form = event.currentTarget
  const previousService = state.config.service
  state.config = await api('/api/service', {
    method: 'PATCH',
    body: {
      listenHost: formField(form, 'listenHost').value,
      listenPort: Number(formField(form, 'listenPort').value),
      localApiKey: formField(form, 'localApiKey').value,
      requestTimeoutMs: Number(formField(form, 'requestTimeoutMs').value),
      maxAttempts: Number(formField(form, 'maxAttempts').value),
      defaultCooldownSeconds: Number(formField(form, 'defaultCooldownSeconds').value),
      retryStatusCodes: splitList(formField(form, 'retryStatusCodes').value).map(Number),
      logRequests: formField(form, 'logRequests').checked,
      collectUsage: formField(form, 'collectUsage').checked,
      collectStreamUsage: formField(form, 'collectStreamUsage').checked,
      quotaPerCny: Number(formField(form, 'quotaPerCny').value),
      requestLogLimit: Number(formField(form, 'requestLogLimit').value),
      outboundProxyMode: formField(form, 'outboundProxyMode').value || 'direct',
      outboundProxyUrl: formField(form, 'outboundProxyUrl').value,
    },
  })
  state.runtime = await api('/api/state')
  render()
  const portChanged =
    previousService.listenHost !== state.config.service.listenHost ||
    Number(previousService.listenPort) !== Number(state.config.service.listenPort)
  toast(portChanged ? '设置已保存；监听地址或端口变更需重启程序' : '设置已保存')
}

async function clearUsage() {
  if (!confirm('清空累计 Token 用量？最近请求记录不会被清空。')) return
  state.runtime = await api('/api/state/usage', { method: 'DELETE' })
  renderStatus()
  renderUsage()
  renderDashboard()
  renderLogs()
  toast('用量统计已清空')
}

async function toggleService(event) {
  await api('/api/service/enabled', {
    method: 'POST',
    body: { enabled: event.target.checked },
  })
  toast(event.target.checked ? '本地接口已开启' : '本地接口已暂停')
  await refreshAll()
}

async function exitProcess() {
  if (!confirm('退出后台程序？当前网页随后会失去连接。')) return
  await api('/api/process/exit', { method: 'POST' })
  toast('程序正在退出')
}

async function clearLogs() {
  if (!confirm('清空最近请求记录？线路配置不会受影响。')) return
  state.runtime = await api('/api/state/logs', { method: 'DELETE' })
  renderLogs()
  renderRecords()
  renderDashboard()
  renderStatus()
  toast('记录已清空')
}

async function exportConfig() {
  const includeSecrets = confirm('是否导出明文 API Key？\n\n取消则导出脱敏配置，适合备份结构或分享模板。')
  const payload = await api(`/api/config/export?secrets=${includeSecrets ? '1' : '0'}`)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const suffix = includeSecrets ? 'with-secrets' : 'masked'
  downloadJson(`local-model-relay-${suffix}-${stamp}.json`, payload)
  toast(includeSecrets ? '已导出完整配置' : '已导出脱敏配置')
}

async function importConfig(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!confirm('导入会覆盖当前线路和模型路由。脱敏或空白的密钥会尽量保留当前值。继续吗？')) return

  const text = await file.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    toast('导入失败：文件不是有效 JSON')
    return
  }

  await api('/api/config/import', { method: 'POST', body: payload })
  toast('配置已导入')
  await refreshAll()
}

function toggleLocalKeyVisibility() {
  const input = formField($('#settingsForm'), 'localApiKey')
  const button = $('#toggleLocalKeyBtn')
  const visible = input.type === 'text'
  input.type = visible ? 'password' : 'text'
  button.textContent = visible ? '显示' : '隐藏'
}

async function copyBaseUrl() {
  await navigator.clipboard.writeText($('#baseUrl').textContent)
  toast('本地接口地址已复制')
}

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {} }
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }

  const response = await fetch(path, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throwToast(data.error?.message || `请求失败：${response.status}`)
  }
  return data
}

function throwToast(message) {
  toast(message)
  throw new Error(message)
}

function providerBadge(provider, entry) {
  if (!provider.enabled) return '<span class="pill off">停用</span>'
  if (entry.cooldownUntil && entry.cooldownUntil > Date.now()) return '<span class="pill warn">冷却</span>'
  if (entry.consecutiveFailures > 0) return '<span class="pill warn">异常</span>'
  return '<span class="pill ok">启用</span>'
}

function lastProviderState(entry) {
  if (!entry || !entry.updatedAt) return '-'
  const bits = []
  if (entry.lastStatus) bits.push(`HTTP ${entry.lastStatus}`)
  if (entry.lastLatencyMs !== null && entry.lastLatencyMs !== undefined) bits.push(`${entry.lastLatencyMs} ms`)
  if (entry.lastError) bits.push(escapeHtml(String(entry.lastError).slice(0, 80)))
  return bits.join('<br>') || '-'
}

function providerStats(entry) {
  const success = Number(entry?.successCount || 0)
  const failure = Number(entry?.failureCount || 0)
  const total = success + failure
  if (!total) return '-'
  const rate = Math.round((success / total) * 100)
  const latency = entry.averageLatencyMs ?? entry.lastLatencyMs
  const latencyText = latency === null || latency === undefined ? '无延迟数据' : `均值 ${latency} ms`
  return `<strong>${rate}%</strong><br><small>${success}/${total} 成功，${latencyText}</small>`
}

function credentialSelect(provider) {
  const credentials = provider.credentials || []
  if (!credentials.length) return '<span class="pill warn">未配置</span>'
  const enabledCredentials = credentials.filter((credential) => credential.enabled)
  const options = (enabledCredentials.length ? enabledCredentials : credentials)
    .map((credential) => `
      <option value="${escapeHtml(credential.id)}" ${credential.id === provider.activeCredentialId ? 'selected' : ''}>
        ${escapeHtml(credential.label || '默认')}
      </option>
    `)
    .join('')
  return `
    <select class="inline-select" data-action="switch-credential" data-id="${provider.id}" ${enabledCredentials.length ? '' : 'disabled'}>
      ${options}
    </select>
    <small>${escapeHtml(credentialMeta(provider))}</small>
  `
}

function credentialMeta(provider) {
  const credential = (provider.credentials || []).find((item) => item.id === provider.activeCredentialId)
  const bits = []
  if (credential?.upstreamGroup) bits.push(credential.upstreamGroup)
  if (credential?.rate) bits.push(`x${trimNumber(credential.rate)}`)
  return bits.join(' · ') || provider.activeCredentialLabel || provider.apiKeyMasked || ''
}

function credentialGroupLine(entry) {
  const bits = []
  if (entry.credential.upstreamGroup) bits.push(`分组 ${entry.credential.upstreamGroup}`)
  if (entry.upstream?.group && entry.upstream.group !== entry.credential.upstreamGroup) bits.push(`同步 ${entry.upstream.group}`)
  bits.push(`x${trimNumber(entry.credential.rate || 1)}`)
  return bits.join(' · ')
}

function upstreamQuotaText(upstream) {
  if (!upstream) return '-'
  const quotaPerCny = Number(state.config?.service?.quotaPerCny || 500000)
  const usedQuota = Number(upstream.usedQuota || 0)
  if (!usedQuota) return '已同步'
  const yuan = quotaPerCny ? usedQuota / quotaPerCny : 0
  return `${formatTokenCompact(usedQuota)} quota${yuan ? ` / ¥${trimNumber(yuan)}` : ''}`
}

function upstreamSyncText(upstream) {
  if (!upstream?.updatedAt) return '服务商扣账'
  return new Date(upstream.updatedAt).toLocaleString()
}

function providerName(providerId) {
  return state.config.providers.find((provider) => provider.id === providerId)?.name || providerId
}

function credentialName(credentialId) {
  const found = findCredential(credentialId)
  if (!found) return credentialId
  return `${found.provider.name} / ${found.credential.label || '默认'}`
}

function findCredential(credentialId) {
  for (const provider of state.config.providers || []) {
    const credential = (provider.credentials || []).find((item) => item.id === credentialId)
    if (credential) return { provider, credential }
  }
  return null
}

function estimatedCostText(credentialId, bucket = {}) {
  const found = findCredential(credentialId)
  const rate = Number(found?.credential?.rate || 1)
  const quotaPerCny = Number(state.config?.service?.quotaPerCny || 500000)
  const totalTokens = Number(bucket.totalTokens || 0)
  if (!totalTokens || !quotaPerCny) return `x${trimNumber(rate)} 预估 -`
  const yuan = (totalTokens * rate) / quotaPerCny
  return `x${trimNumber(rate)} 预估 ¥${trimNumber(yuan)}`
}

function todayUsage() {
  return aggregateLocalToday()
}

function outboundStatusLabel(outbound) {
  if (!outbound) return '-'
  const labels = {
    direct: '直连',
    system: '系统代理',
    custom: '自定义代理',
  }
  const label = labels[outbound.effectiveMode] || outbound.effectiveMode || '未知'
  const proxy = outbound.effectiveProxyUrl ? `（${outbound.effectiveProxyUrl}）` : ''
  return `${label}${proxy}${outbound.needsRestart ? ' / 待重启' : ''}`
}

function outboundNoticeText(outbound) {
  if (!outbound) return ''
  const parts = [outbound.message].filter(Boolean)
  if (outbound.systemProxyUrl) {
    parts.push(`检测到系统代理：${outbound.systemProxyUrl}`)
  }
  return parts.join(' ')
}

function usageMini(usage) {
  if (!usage) return '<small>-</small>'
  return `<strong>${formatTokenCompact(usage.totalTokens)}</strong><br><small>入 ${formatTokenCompact(usage.inputTokens)} / 出 ${formatTokenCompact(usage.outputTokens)}${usage.estimated ? ' · 估算' : ''}</small>`
}

function logStatusPill(log) {
  if (isClientDisconnected(log)) return '<span class="pill warn">中断</span>'
  return log.ok ? '<span class="pill ok">成功</span>' : '<span class="pill warn">失败</span>'
}

function logStatusText(log) {
  if (isClientDisconnected(log)) return `${log.status ?? '-'} / 客户端中断`
  return log.status ?? '-'
}

function isClientDisconnected(log) {
  return String(log?.error || '').includes('Client disconnected')
}

function formatTokenCompact(value) {
  const number = Number(value || 0)
  if (!number) return '-'
  if (number >= 1000000) return `${trimNumber(number / 1000000)}M`
  if (number >= 1000) return `${trimNumber(number / 1000)}K`
  return String(number)
}

function formatNumber(value) {
  const number = Number(value || 0)
  return number ? number.toLocaleString() : '-'
}

function trimNumber(value) {
  return value >= 10 ? value.toFixed(1).replace(/\.0$/, '') : value.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')
}

function calculateSuccessRate() {
  const entries = Object.values(state.runtime?.providerState || {})
  const success = entries.reduce((sum, entry) => sum + Number(entry.successCount || 0), 0)
  const failure = entries.reduce((sum, entry) => sum + Number(entry.failureCount || 0), 0)
  const total = success + failure
  if (!total) return '-'
  return `${Math.round((success / total) * 100)}%`
}

function nextProviderPriority() {
  const priorities = state.config.providers.map((provider) => Number(provider.priority) || 0)
  return priorities.length ? Math.max(...priorities) + 10 : 10
}

function providerPatch(provider, priority = provider.priority) {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    credentials: (provider.credentials || []).map((credential) => ({
      id: credential.id,
      label: credential.label,
      enabled: credential.enabled,
      note: credential.note || '',
      rate: credential.rate || 1,
      upstreamGroup: credential.upstreamGroup || '',
    })),
    activeCredentialId: provider.activeCredentialId,
    authMode: provider.authMode,
    wireApi: provider.wireApi || 'chat',
    outboundProxyMode: provider.outboundProxyMode || 'inherit',
    outboundProxyUrl: provider.outboundProxyUrl || '',
    priority,
    timeoutMs: provider.timeoutMs,
    cooldownSeconds: provider.cooldownSeconds,
    models: provider.models || [],
    tags: provider.tags || [],
    notes: provider.notes || '',
    enabled: provider.enabled,
  }
}

function preferredRealTestModel(provider) {
  const models = provider.models || []
  return models.find((model) => /mini|flash|lite|small/i.test(model)) || models[0] || 'gpt-4o-mini'
}

function wireApiLabel(value) {
  if (value === 'responses') return 'Responses'
  if (value === 'auto') return '自动跟随请求'
  return 'Chat Completions'
}

function providerProxyLabel(provider) {
  const mode = provider.outboundProxyMode || 'inherit'
  if (mode === 'direct') return '直连'
  if (mode === 'system') return '系统代理'
  if (mode === 'custom') return `自定义代理${provider.outboundProxyUrl ? ` ${provider.outboundProxyUrl}` : ''}`
  return '跟随全局'
}

function routingModeLabel(mode) {
  return mode === 'locked' ? '锁定起点' : '自动推进'
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&')
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

function splitList(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function localDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function cssPalette() {
  const styles = getComputedStyle(document.documentElement)
  return {
    accent: styles.getPropertyValue('--accent').trim() || '#0d7b73',
    info: styles.getPropertyValue('--info').trim() || '#3281c3',
    warn: styles.getPropertyValue('--warn').trim() || '#ad5c00',
  }
}

function withAlpha(color, alpha) {
  if (!color.startsWith('#') || (color.length !== 7 && color.length !== 4)) return color
  const expanded = color.length === 4
    ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
    : color
  const r = parseInt(expanded.slice(1, 3), 16)
  const g = parseInt(expanded.slice(3, 5), 16)
  const b = parseInt(expanded.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function csvCell(value) {
  let text = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function downloadJson(filename, payload) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function downloadText(filename, text, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

let toastTimer = null
function toast(message) {
  const node = $('#toast')
  node.textContent = message
  node.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('show'), 2800)
}
