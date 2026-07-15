const CLIENT_RUNTIME_PROTOCOL = 1
const FULL_STATE_TABS = new Set(['dashboard', 'records', 'logs'])
const DRAG_REORDER_DURATION_MS = 190
const dragReorderAnimations = new WeakMap()

const state = {
  config: null,
  runtime: null,
  editingProvider: null,
  editingProviderGroup: null,
  activeProviderGroupId: localStorage.getItem('local-model-relay-provider-group') || 'openai',
  editingRoute: null,
  testingProvider: null,
  testingRoute: null,
  draggingProviderId: null,
  providerDragSaved: false,
  draggingTargetRow: null,
  dragArmed: false,
  usageRange: '24h',
  usageCustomStart: '',
  usageCustomEnd: '',
  activeTab: 'providers',
  logsPage: 1,
  logsPageSize: 20,
  recordsPage: 1,
  recordsPageSize: 20,
  modelPickers: {},
  dashboardRange: '7d',
  dashboardGranularity: 'day',
  themeMode: document.documentElement.dataset.themeMode || 'system',
  selectedErrorDetail: '',
  selectedErrorLog: null,
  aiDiagnosis: null,
  clearDiagnosticsLlmKey: false,
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
    usageModelShare: null,
    usageProviderShare: null,
  },
}

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const formField = (form, name) => form.elements.namedItem(name)

document.addEventListener('DOMContentLoaded', async () => {
  bindThemeControls()
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
      if (FULL_STATE_TABS.has(state.activeTab)) {
        void refreshState({ forceFull: true })
        return
      }
      if (state.activeTab === 'dashboard') nextFrame().then(renderDashboard)
      if (state.activeTab === 'speed') renderSpeedTestIdle()
      if (state.activeTab === 'records') renderRecords()
      if (state.activeTab === 'logs') renderLogs()
      if (state.activeTab === 'usage') nextFrame().then(renderUsage)
    })
  })
}

function bindActions() {
  $('#refreshBtn').addEventListener('click', refreshAll)
  $('#runtimeCheckBtn').addEventListener('click', refreshAll)
  $('#copyBaseUrlBtn').addEventListener('click', copyBaseUrl)
  $('#serviceToggle').addEventListener('change', toggleService)
  $('#newProviderBtn').addEventListener('click', () => openProviderDialog(null, preferredNewProviderGroupId()))
  $('#quickProviderBtn').addEventListener('click', () => openProviderDialog(null, preferredNewProviderGroupId()))
  $('#manageProviderGroupsBtn').addEventListener('click', openProviderGroupsDialog)
  $('#providerGroupTabs').addEventListener('click', handleProviderGroupTabClick)
  $('#providerGroupRows').addEventListener('click', handleProviderGroupAction)
  $('#providerGroupForm').addEventListener('submit', saveProviderGroup)
  $('#resetProviderGroupFormBtn').addEventListener('click', resetProviderGroupForm)
  $('#deleteProviderBtn').addEventListener('click', deleteProviderFromEditor)
  $('#routingStartMode').addEventListener('change', saveRoutingMode)
  $('#clearStartProviderBtn').addEventListener('click', clearStartProvider)
  formField($('#providerForm'), 'providerOutboundProxyMode').addEventListener('change', renderProviderProxyFields)
  formField($('#providerForm'), 'timeoutSeconds').addEventListener('input', renderProviderTimeoutHint)
  $('#newRouteBtn').addEventListener('click', () => openRouteDialog())
  $('#providerForm').addEventListener('submit', saveProvider)
  $('#realTestForm').addEventListener('submit', runRealTest)
  $('#runCodexTestBtn').addEventListener('click', () => runCodexCompatibilityTestForForm($('#realTestForm')))
  $('#routeTestForm').addEventListener('submit', runRouteTest)
  $('#routeForm').addEventListener('submit', saveRoute)
  bindTargetDragSort()
  $('#settingsForm').addEventListener('submit', saveSettings)
  $('#speedTestForm').addEventListener('submit', runSpeedTest)
  $('#fetchSpeedModelsBtn').addEventListener('click', fetchSpeedModels)
  $('#clearSpeedTestBtn').addEventListener('click', clearSpeedTestResult)
  formField($('#speedTestForm'), 'proxyMode').addEventListener('change', renderSpeedProxyField)
  bindModelPicker('speed', { allowCustom: true, emptyText: '先点击“获取模型”，或直接粘贴模型名。' })
  bindModelPicker('real-test', { allowCustom: false, emptyText: '当前线路没有已保存的支持模型。' })
  $$('[name="outboundProxyMode"]', $('#settingsForm')).forEach((input) => {
    input.addEventListener('change', renderOutboundProxyFields)
  })
  formField($('#settingsForm'), 'sessionAffinity').addEventListener('change', renderSessionAffinityFields)
  $('#addTargetBtn').addEventListener('click', () => addTargetRow())
  $('#addCredentialBtn').addEventListener('click', () => addCredentialRow())
  $('#exitBtn').addEventListener('click', exitProcess)
  $('#clearLogsBtn').addEventListener('click', clearLogs)
  $('#clearRecordsBtn').addEventListener('click', clearLogs)
  $('#clearUsageBtn').addEventListener('click', clearUsage)
  $('#usageRangeButton').addEventListener('click', toggleUsageRangeMenu)
  $('#usageRangeMenu').addEventListener('click', handleUsageRangeShortcut)
  $('#usageRangeStart').addEventListener('change', handleUsageCustomDateChange)
  $('#usageRangeEnd').addEventListener('change', handleUsageCustomDateChange)
  $('#usageRangeApply').addEventListener('click', applyUsageCustomRange)
  document.addEventListener('click', closeUsageRangeMenuOnOutsideClick)
  document.addEventListener('keydown', closeUsageRangeMenuOnEscape)
  $('#dashboardRange').addEventListener('change', handleDashboardControlChange)
  $('#dashboardGranularity').addEventListener('change', handleDashboardControlChange)
  $('#goRecordsBtn').addEventListener('click', () => switchTab('records'))
  $('#recordSearch').addEventListener('input', handleRecordFilterChange)
  $('#recordStatus').addEventListener('change', handleRecordFilterChange)
  $('#recordModel').addEventListener('change', handleRecordFilterChange)
  $('#recordProvider').addEventListener('change', handleRecordFilterChange)
  $('#recordRange').addEventListener('change', handleRecordFilterChange)
  $('#recordSort').addEventListener('change', handleRecordFilterChange)
  $('#recordPageSize').addEventListener('change', handleRecordPageSizeChange)
  $('#recordPrevPage').addEventListener('click', () => changeRecordsPage(-1))
  $('#recordNextPage').addEventListener('click', () => changeRecordsPage(1))
  $('#logPageSize').addEventListener('change', handleLogPageSizeChange)
  $('#logPrevPage').addEventListener('click', () => changeLogsPage(-1))
  $('#logNextPage').addEventListener('click', () => changeLogsPage(1))
  $('#copyErrorDetailBtn').addEventListener('click', copyErrorDetail)
  $('#runAiDiagnosisBtn').addEventListener('click', runAiDiagnosis)
  $('#copyAiDiagnosisBtn').addEventListener('click', copyAiDiagnosis)
  $('#exportRecordsCsvBtn').addEventListener('click', exportRecordsCsv)
  $('#exportConfigBtn').addEventListener('click', exportConfig)
  $('#importConfigBtn').addEventListener('click', () => $('#importConfigFile').click())
  $('#importConfigFile').addEventListener('change', importConfig)
  $('#toggleLocalKeyBtn').addEventListener('click', toggleLocalKeyVisibility)
  $('#toggleDiagnosticsKeyBtn').addEventListener('click', toggleDiagnosticsKeyVisibility)
  $('#clearDiagnosticsKeyBtn').addEventListener('click', clearDiagnosticsKey)
  $('#testDiagnosticsLlmBtn').addEventListener('click', testDiagnosticsLlm)
  formField($('#settingsForm'), 'diagnosticsLlmApiKey').addEventListener('input', () => {
    state.clearDiagnosticsLlmKey = false
    updateDiagnosticsKeyStatus()
  })
  $$('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()))
  document.addEventListener('click', handleErrorDetailAction)
  document.addEventListener('click', closeModelPickersOnOutsideClick)
  document.addEventListener('keydown', closeModelPickersOnEscape)
}

function bindThemeControls() {
  const button = $('#themeToggleBtn')
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
  button.addEventListener('click', () => {
    const modes = ['system', 'light', 'dark']
    applyThemeMode(modes[(modes.indexOf(state.themeMode) + 1) % modes.length])
  })
  systemTheme.addEventListener('change', () => {
    if (state.themeMode === 'system') applyThemeMode('system', false)
  })
  updateThemeButton()
  syncChartTheme()
}

function applyThemeMode(mode, persist = true) {
  state.themeMode = ['system', 'light', 'dark'].includes(mode) ? mode : 'system'
  const theme = state.themeMode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : state.themeMode
  document.documentElement.dataset.themeMode = state.themeMode
  document.documentElement.dataset.theme = theme
  if (persist) localStorage.setItem('local-model-relay-theme', state.themeMode)
  updateThemeButton()
  syncChartTheme()
}

function updateThemeButton() {
  const button = $('#themeToggleBtn')
  if (!button) return
  const details = {
    system: { icon: '◐', label: '跟随系统' },
    light: { icon: '☀', label: '日间模式' },
    dark: { icon: '☾', label: '夜间模式' },
  }
  const current = details[state.themeMode] || details.system
  $('#themeToggleIcon').textContent = current.icon
  button.title = `主题：${current.label}（点击切换）`
  button.setAttribute('aria-label', button.title)
}

function syncChartTheme() {
  if (!window.Chart) return
  const styles = getComputedStyle(document.documentElement)
  const textColor = styles.getPropertyValue('--muted').trim()
  const lineColor = styles.getPropertyValue('--chart-grid').trim()
  Chart.defaults.color = textColor
  Chart.defaults.borderColor = lineColor
  Object.values(state.charts).filter(Boolean).forEach((chart) => {
    if (chart.options.scales) {
      Object.values(chart.options.scales).forEach((scale) => {
        scale.ticks = { ...(scale.ticks || {}), color: textColor }
        scale.grid = { ...(scale.grid || {}), color: lineColor }
      })
    }
    chart.update('none')
  })
}

async function refreshAll() {
  const [config, runtime] = await Promise.all([
    api('/api/config'),
    api('/api/state'),
  ])
  state.config = config
  state.runtime = runtime
  render()
}

async function refreshState(options = {}) {
  try {
    const forceFull = Boolean(options.forceFull) || FULL_STATE_TABS.has(state.activeTab)
    state.runtime = forceFull
      ? await api('/api/state', { silent: Boolean(options.silent) })
      : await fetchRuntimeSummary()
    renderStatus()
    renderOutboundStatus()
    renderRoutingBar()
    renderProviders()
    renderUsage()
    renderDashboard()
    renderRecords()
    renderLogs()
    renderRuntimeNotice()
  } catch {
    // Server may be restarting.
  }
}

async function fetchRuntimeSummary() {
  try {
    const summary = await api('/api/state/summary', { silent: true })
    return {
      ...(state.runtime || {}),
      ...summary,
      requestLog: state.runtime?.requestLog || [],
      sessionBindings: state.runtime?.sessionBindings || {},
    }
  } catch (error) {
    if (error?.status !== 404) throw error
    return api('/api/state', { silent: true })
  }
}

function render() {
  renderRuntimeNotice()
  renderStatus()
  renderSettings()
  renderSpeedProxyField()
  renderRoutingBar()
  renderProviders()
  renderRoutes()
  renderUsage()
  renderDashboard()
  renderRecords()
  renderLogs()
}

function renderRuntimeNotice() {
  const notice = $('#runtimeNotice')
  if (!notice) return

  const meta = state.runtime?.runtimeMeta
  let title = ''
  let message = ''
  if (!meta || Number(meta.protocolVersion) !== CLIENT_RUNTIME_PROTOCOL) {
    title = '页面与后台版本不一致'
    message = '当前后台进程仍是旧版本，请关闭并重新启动 Local Model Relay。'
  } else if (meta.restartRequired) {
    title = '后台代码已更新'
    message = '请重新启动 Local Model Relay，让本次修改完整生效。'
  }

  notice.hidden = !title
  if (!title) return
  $('#runtimeNoticeTitle').textContent = title
  $('#runtimeNoticeText').textContent = message
}

function renderSpeedProxyField() {
  const form = $('#speedTestForm')
  if (!form) return
  $('#speedProxyUrlField').hidden = formField(form, 'proxyMode').value !== 'custom'
}

async function fetchSpeedModels() {
  const form = $('#speedTestForm')
  const button = $('#fetchSpeedModelsBtn')
  button.disabled = true
  button.textContent = '获取中'
  $('#speedTestStatus').textContent = '正在获取模型列表'
  try {
    const result = await api('/api/speed-test/models', {
      method: 'POST',
      body: speedTestPayload(form, { includeModel: false }),
    })
    setModelPickerOptions('speed', result.models || [])
    if (result.models?.length && !formField(form, 'model').value) {
      formField(form, 'model').value = preferredSpeedModel(result.models)
    }
    renderModelPicker('speed', true)
    $('#speedTestStatus').textContent = result.ok ? result.message : `获取失败：HTTP ${result.status || 0}`
    toast(result.ok ? `发现 ${result.models.length} 个模型` : `获取模型失败：${result.message}`)
  } catch (error) {
    $('#speedTestStatus').textContent = '获取模型失败'
    toast(error instanceof Error ? error.message : String(error))
  } finally {
    button.disabled = false
    button.textContent = '获取模型'
  }
}

async function runSpeedTest(event) {
  event.preventDefault()
  const form = event.currentTarget
  const button = $('#runSpeedTestBtn')
  button.disabled = true
  button.textContent = '测速中'
  renderSpeedTestPending()
  await nextFrame()

  try {
    const result = await api('/api/speed-test/run', {
      method: 'POST',
      body: speedTestPayload(form),
    })
    renderSpeedTestResult(result)
    toast(result.partialOk || result.ok ? result.message : `测速失败：${result.message}`)
  } catch (error) {
    renderSpeedTestResult({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      rounds: [],
    })
  } finally {
    button.disabled = false
    button.textContent = '开始测速'
  }
}

function speedTestPayload(form, options = {}) {
  return {
    baseUrl: formField(form, 'baseUrl').value,
    apiKey: formField(form, 'apiKey').value,
    model: options.includeModel === false ? '' : formField(form, 'model').value,
    wireApi: formField(form, 'wireApi').value,
    proxyMode: formField(form, 'proxyMode').value,
    proxyUrl: formField(form, 'proxyUrl').value,
    rounds: Number(formField(form, 'rounds').value),
    maxTokens: Number(formField(form, 'maxTokens').value),
    timeoutMs: Number(formField(form, 'timeoutMs').value),
    prompt: formField(form, 'prompt').value,
  }
}

function renderSpeedTestIdle() {
  if (!$('#speedResultRows .speed-result-row')) $('#speedTestStatus').textContent = '等待测试'
}

function renderSpeedTestPending() {
  $('#speedTestStatus').textContent = '正在测速'
  $('#speedSummary').innerHTML = speedSummaryHtml()
  $('#speedResultRows').innerHTML = '<div class="empty">正在发起流式请求并测量首字延迟...</div>'
}

function clearSpeedTestResult() {
  $('#speedTestStatus').textContent = '等待测试'
  $('#speedSummary').innerHTML = speedSummaryHtml()
  $('#speedResultRows').innerHTML = '<div class="empty">还没有测速结果。</div>'
}

function renderSpeedTestResult(result) {
  const summary = result.summary || null
  $('#speedTestStatus').textContent = result.message || (result.ok ? '测速完成' : '测速失败')
  $('#speedSummary').innerHTML = speedSummaryHtml(summary, result.rounds?.length || 0)
  const rows = $('#speedResultRows')
  rows.innerHTML = result.rounds?.length ? '' : `<div class="empty">${escapeHtml(result.message || '没有结果。')}</div>`
  for (const round of result.rounds || []) {
    const item = document.createElement('div')
    item.className = `speed-result-row ${round.ok ? 'ok' : 'warn'}`
    item.innerHTML = `
      <div><strong>第 ${formatNumber(round.round)} 轮</strong><small>${round.ok ? 'HTTP ' + round.status : escapeHtml(round.message || '失败')}</small></div>
      <div><strong>${round.firstTokenMs == null ? '-' : `${round.firstTokenMs} ms`}</strong><small>首字</small></div>
      <div><strong>${round.totalMs ?? round.latencyMs ?? '-'} ms</strong><small>总耗时</small></div>
      <div><strong>${round.tokensPerSecond ? `${round.tokensPerSecond} tok/s` : '-'}</strong><small>速度</small></div>
      <div><strong>${formatTokenCompact(round.outputTokens || 0)}</strong><small>输出 Token</small></div>
      <div class="wide"><span class="label">回复预览</span><pre>${escapeHtml(round.content || round.message || '-')}</pre></div>
    `
    rows.appendChild(item)
  }
}

function speedSummaryHtml(summary = null, totalRounds = 0) {
  return `
    <div><span class="label">首字延迟</span><strong>${summary?.avgFirstTokenMs == null ? '-' : `${summary.avgFirstTokenMs} ms`}</strong></div>
    <div><span class="label">总耗时</span><strong>${summary?.avgTotalMs == null ? '-' : `${summary.avgTotalMs} ms`}</strong></div>
    <div><span class="label">输出速度</span><strong>${summary?.avgTokensPerSecond == null ? '-' : `${summary.avgTokensPerSecond} tok/s`}</strong></div>
    <div><span class="label">成功轮次</span><strong>${summary ? `${summary.successCount}/${totalRounds}` : '-'}</strong></div>
  `
}

function preferredSpeedModel(models = []) {
  return preferredTestModel(models)
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
  formField(form, 'providerTestTimeoutSeconds').value = Math.round((service.providerTestTimeoutMs || 30000) / 1000)
  formField(form, 'providerRealTestTimeoutSeconds').value = Math.round((service.providerRealTestTimeoutMs || 90000) / 1000)
  formField(form, 'maxAttempts').value = service.maxAttempts
  formField(form, 'defaultCooldownSeconds').value = service.defaultCooldownSeconds
  formField(form, 'reconnectFailureThreshold').value = service.reconnectFailureThreshold || 4
  formField(form, 'reconnectCooldownSeconds').value = service.reconnectCooldownSeconds || 600
  formField(form, 'sessionAffinity').checked = service.sessionAffinity !== false
  formField(form, 'sessionTtlSeconds').value = service.sessionTtlSeconds || 86400
  formField(form, 'sessionLimit').value = service.sessionLimit || 800
  const diagnosticsLlm = service.diagnosticsLlm || {}
  formField(form, 'diagnosticsLlmEnabled').checked = diagnosticsLlm.enabled === true
  formField(form, 'diagnosticsLlmBaseUrl').value = diagnosticsLlm.baseUrl || ''
  formField(form, 'diagnosticsLlmModel').value = diagnosticsLlm.model || ''
  formField(form, 'diagnosticsLlmApiKey').value = ''
  formField(form, 'diagnosticsLlmTimeoutSeconds').value = Math.round((diagnosticsLlm.timeoutMs || 30000) / 1000)
  state.clearDiagnosticsLlmKey = false
  updateDiagnosticsKeyStatus()
  $('#diagnosticsLlmStatus').textContent = diagnosticsLlm.enabled
    ? '已启用；错误详情中可以按需调用。'
    : '已关闭；保存后才会启用。'
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
  renderSessionAffinityFields()
  renderOutboundStatus()
}

function renderOutboundProxyFields() {
  const form = $('#settingsForm')
  const mode = formField(form, 'outboundProxyMode').value || 'direct'
  $('#customProxyField').hidden = mode !== 'custom'
}

function renderSessionAffinityFields() {
  const form = $('#settingsForm')
  const enabled = formField(form, 'sessionAffinity').checked
  formField(form, 'sessionTtlSeconds').disabled = !enabled
  formField(form, 'sessionLimit').disabled = !enabled
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
  const mode = ['auto', 'locked', 'pinned'].includes(routing.startMode) ? routing.startMode : 'auto'
  const provider = (state.config?.providers || []).find((item) => item.id === routing.startProviderId)
  const modeLabel = routingModeLabel(mode)

  $('#routingStartMode').value = mode
  $('#routingBar').classList.toggle('pinned', mode === 'pinned')
  $('#routingStartName').textContent = provider
    ? provider.name
    : routing.startProviderId
      ? '起点线路已失效'
      : '默认优先级'
  $('#routingStartHint').textContent = provider
    ? mode === 'pinned'
      ? `${modeLabel} · 只会使用这条线路，失败直接返回`
      : mode === 'locked'
        ? `${modeLabel} · 请求从这条线路开始，失败仍会故障转移`
        : `${modeLabel} · 请求从这条线路开始，成功后自动推进起点`
    : routing.startProviderId
      ? `${modeLabel} · 当前候选中找不到这条线路`
      : mode === 'pinned'
        ? `${modeLabel} · 请先在线路列表中设定起点`
        : `${modeLabel} · 未指定起点时按优先级从头开始`
  $('#clearStartProviderBtn').disabled = !routing.startProviderId
}

function renderProviders() {
  if (state.draggingProviderId) return
  const rows = $('#providerRows')
  const groups = providerGroups()
  const allProviders = [...state.config.providers].sort((a, b) => a.priority - b.priority)
  const validGroupIds = new Set(['all', ...groups.map((group) => group.id)])
  if (!validGroupIds.has(state.activeProviderGroupId)) {
    state.activeProviderGroupId = groups.find((group) => group.id === 'openai')?.id || groups[0]?.id || 'all'
    localStorage.setItem('local-model-relay-provider-group', state.activeProviderGroupId)
  }
  const providers = state.activeProviderGroupId === 'all'
    ? allProviders
    : allProviders.filter((provider) => providerGroupId(provider) === state.activeProviderGroupId)
  const startProviderId = state.runtime?.routing?.startProviderId || ''
  renderProviderGroupTabs(groups, allProviders)
  $('#providerEmptyGuide').hidden = allProviders.length > 0
  if (providers.length) {
    rows.innerHTML = ''
  } else {
    const group = groups.find((item) => item.id === state.activeProviderGroupId)
    const message = allProviders.length === 0
      ? '还没有线路，先新增一个中转站。'
      : `「${group?.name || '当前'}」分组还没有线路。`
    rows.innerHTML = `
      <tr>
        <td colspan="9" class="empty provider-group-empty">
          <span>${escapeHtml(message)}</span>
          <button class="ghost" type="button" data-action="new-provider">在此分组新增线路</button>
        </td>
      </tr>
    `
  }

  for (const provider of providers) {
    const entry = state.runtime.providerState[provider.id] || {}
    const isStartProvider = provider.id === startProviderId
    const group = groups.find((item) => item.id === providerGroupId(provider))
    const tr = document.createElement('tr')
    tr.dataset.providerId = provider.id
    tr.dataset.groupId = providerGroupId(provider)
    tr.draggable = true
    tr.className = 'draggable-row'
    tr.innerHTML = `
      <td class="provider-status-cell">
        <div class="status-cell">
          <span class="drag-handle" title="拖拽调整优先级" aria-label="拖拽调整优先级">↕</span>
          <div class="status-stack">
            <div class="status-badges">${providerBadge(provider, entry)}${isStartProvider ? '<span class="pill info">起点</span>' : ''}</div>
            <div class="status-capability">${codexCapabilityBadge(provider)}</div>
          </div>
        </div>
      </td>
      <td>
        <div class="provider-name-stack">
          <strong>${escapeHtml(provider.name)}</strong>
          ${providerGroupBadge(group)}
          <small>${escapeHtml(provider.tags.join(', ') || provider.activeCredentialLabel || '未设置标签')}</small>
        </div>
      </td>
      <td>${providerWebsiteLink(provider.baseUrl)}</td>
      <td>${credentialSelect(provider)}</td>
      <td>${escapeHtml(provider.models.slice(0, 4).join(', ') || '通配')}<br><small>${wireApiLabel(provider.wireApi)} · ${providerProxyLabel(provider)}</small></td>
      <td>${provider.priority}</td>
      <td>${providerStats(entry)}</td>
      <td>${lastProviderState(entry)}</td>
      <td>
        <div class="row-actions">
          <button data-action="set-start-provider" data-id="${escapeHtml(provider.id)}" ${isStartProvider ? 'disabled' : ''}>${isStartProvider ? '当前起点' : '设为起点'}</button>
          <button data-action="test" data-id="${escapeHtml(provider.id)}">测试</button>
          <button data-action="real-test" data-id="${escapeHtml(provider.id)}">真实测试</button>
          <button data-action="toggle-provider" data-id="${escapeHtml(provider.id)}">${provider.enabled ? '停用' : '启用'}</button>
          <button data-action="edit-provider" data-id="${escapeHtml(provider.id)}">编辑</button>
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

function providerGroups() {
  const configured = Array.isArray(state.config?.providerGroups) ? state.config.providerGroups : []
  const groups = configured.length ? configured : [
    { id: 'openai', name: 'OpenAI', description: 'OpenAI 与 OpenAI-compatible 中转线路', color: '#7567d8', priority: 10 },
    { id: 'deepseek', name: 'DeepSeek', description: 'DeepSeek 模型与兼容中转线路', color: '#159a80', priority: 20 },
  ]
  return [...groups].sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0) || a.name.localeCompare(b.name))
}

function providerGroupId(provider) {
  const id = String(provider?.groupId || '').trim()
  return providerGroups().some((group) => group.id === id)
    ? id
    : providerGroups().find((group) => group.id === 'openai')?.id || providerGroups()[0]?.id || 'openai'
}

function preferredNewProviderGroupId() {
  const groups = providerGroups()
  if (state.activeProviderGroupId !== 'all' && groups.some((group) => group.id === state.activeProviderGroupId)) {
    return state.activeProviderGroupId
  }
  return groups.find((group) => group.id === 'openai')?.id || groups[0]?.id || 'openai'
}

function renderProviderGroupTabs(groups, providers) {
  const tabs = $('#providerGroupTabs')
  const allTab = `
    <button class="provider-group-tab ${state.activeProviderGroupId === 'all' ? 'active' : ''}" type="button" role="tab" aria-selected="${state.activeProviderGroupId === 'all'}" data-group-id="all">
      <span>全部线路</span><b>${providers.length}</b>
    </button>
  `
  tabs.innerHTML = allTab + groups.map((group) => {
    const count = providers.filter((provider) => providerGroupId(provider) === group.id).length
    const active = state.activeProviderGroupId === group.id
    return `
      <button class="provider-group-tab ${active ? 'active' : ''}" style="--group-color:${safeProviderGroupColor(group.color)}" type="button" role="tab" aria-selected="${active}" data-group-id="${escapeHtml(group.id)}">
        <i aria-hidden="true"></i><span>${escapeHtml(group.name)}</span><b>${count}</b>
      </button>
    `
  }).join('')

  const activeGroup = groups.find((group) => group.id === state.activeProviderGroupId)
  $('#providerGroupSummary').innerHTML = activeGroup
    ? `<span class="provider-group-summary-swatch" style="--group-color:${safeProviderGroupColor(activeGroup.color)}"></span><strong>${escapeHtml(activeGroup.name)}</strong><span>${escapeHtml(activeGroup.description || '未填写分组说明')}</span>`
    : '<strong>全部线路</strong><span>分组只影响界面整理；故障转移仍由线路优先级决定。</span>'
}

function providerGroupBadge(group) {
  if (!group) return ''
  return `<span class="provider-group-badge" style="--group-color:${safeProviderGroupColor(group.color)}"><i aria-hidden="true"></i>${escapeHtml(group.name)}</span>`
}

function safeProviderGroupColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#667085'
}

function handleProviderGroupTabClick(event) {
  const button = event.target.closest('[data-group-id]')
  if (!button) return
  state.activeProviderGroupId = button.dataset.groupId || 'all'
  localStorage.setItem('local-model-relay-provider-group', state.activeProviderGroupId)
  renderProviders()
}

function openProviderGroupsDialog() {
  resetProviderGroupForm()
  renderProviderGroupRows()
  $('#providerGroupsDialog').showModal()
}

function renderProviderGroupRows() {
  const groups = providerGroups()
  const providers = state.config?.providers || []
  const rows = $('#providerGroupRows')

  rows.innerHTML = groups.map((group) => {
    const providerCount = providers.filter((provider) => providerGroupId(provider) === group.id).length
    const isLastGroup = groups.length <= 1
    const deleteDisabled = providerCount > 0 || isLastGroup
    const deleteHint = providerCount > 0
      ? `请先把组内 ${providerCount} 条线路移动到其他分组`
      : isLastGroup
        ? '至少需要保留一个线路分组'
        : `删除分组「${group.name}」`

    return `
      <article class="provider-group-row" style="--group-color:${safeProviderGroupColor(group.color)}">
        <span class="provider-group-row-swatch" aria-hidden="true"></span>
        <div class="provider-group-row-copy">
          <div class="provider-group-row-title">
            <strong>${escapeHtml(group.name)}</strong>
            <span>${providerCount} 条线路</span>
          </div>
          <p>${escapeHtml(group.description || '未填写分组说明')}</p>
        </div>
        <div class="provider-group-row-actions">
          <button class="ghost" type="button" data-action="edit-provider-group" data-id="${escapeHtml(group.id)}">编辑</button>
          <button class="danger" type="button" data-action="delete-provider-group" data-id="${escapeHtml(group.id)}" ${deleteDisabled ? 'disabled' : ''} title="${escapeHtml(deleteHint)}">删除</button>
        </div>
      </article>
    `
  }).join('')
}

async function handleProviderGroupAction(event) {
  const button = event.target.closest('button[data-action]')
  if (!button) return
  const group = providerGroups().find((item) => item.id === button.dataset.id)
  if (!group) return

  if (button.dataset.action === 'edit-provider-group') {
    state.editingProviderGroup = group
    const form = $('#providerGroupForm')
    formField(form, 'id').value = group.id
    formField(form, 'name').value = group.name
    formField(form, 'color').value = safeProviderGroupColor(group.color)
    formField(form, 'description').value = group.description || ''
    $('#providerGroupEditorTitle').textContent = `编辑分组：${group.name}`
    formField(form, 'name').focus()
    return
  }

  if (button.dataset.action === 'delete-provider-group') {
    const providerCount = (state.config?.providers || []).filter((provider) => providerGroupId(provider) === group.id).length
    if (providerCount > 0) {
      toast(`请先把组内 ${providerCount} 条线路移动到其他分组`)
      return
    }
    if (!confirm(`删除线路分组「${group.name}」？`)) return

    button.disabled = true
    try {
      await api(`/api/provider-groups/${group.id}`, { method: 'DELETE' })
      if (state.activeProviderGroupId === group.id) {
        state.activeProviderGroupId = 'all'
        localStorage.setItem('local-model-relay-provider-group', 'all')
      }
      if (state.editingProviderGroup?.id === group.id) resetProviderGroupForm()
      await refreshAll()
      renderProviderGroupRows()
      toast('线路分组已删除')
    } finally {
      button.disabled = false
    }
  }
}

async function saveProviderGroup(event) {
  event.preventDefault()
  const form = event.currentTarget
  const id = formField(form, 'id').value
  const body = {
    name: formField(form, 'name').value.trim(),
    color: safeProviderGroupColor(formField(form, 'color').value),
    description: formField(form, 'description').value.trim(),
  }
  const submit = form.querySelector('button[type="submit"]')

  submit.disabled = true
  try {
    const saved = await api(id ? `/api/provider-groups/${id}` : '/api/provider-groups', {
      method: id ? 'PATCH' : 'POST',
      body,
    })
    if (!id && saved?.id) {
      state.activeProviderGroupId = saved.id
      localStorage.setItem('local-model-relay-provider-group', saved.id)
    }
    await refreshAll()
    resetProviderGroupForm()
    renderProviderGroupRows()
    toast(id ? '线路分组已更新' : '线路分组已创建')
  } finally {
    submit.disabled = false
  }
}

function resetProviderGroupForm() {
  state.editingProviderGroup = null
  const form = $('#providerGroupForm')
  form.reset()
  formField(form, 'id').value = ''
  formField(form, 'color').value = '#667085'
  $('#providerGroupEditorTitle').textContent = '新增分组'
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
          <button data-action="route-test" data-id="${escapeHtml(route.id)}" ${route.enabled ? '' : 'disabled title="请先启用该模型路由"'}>测试路由</button>
          <button data-action="toggle-route" data-id="${escapeHtml(route.id)}">${route.enabled ? '停用' : '启用'}</button>
          <button data-action="edit-route" data-id="${escapeHtml(route.id)}">编辑</button>
          <button data-action="delete-route" data-id="${escapeHtml(route.id)}">删除</button>
        </div>
      </td>
    `
    rows.appendChild(tr)
  }

  rows.onclick = handleRouteAction
}

function renderLogs() {
  if (state.activeTab !== 'logs') return
  const logs = state.runtime.requestLog || []
  const list = $('#logList')
  const page = getPageSlice(logs.length, state.logsPage, state.logsPageSize)
  state.logsPage = page.page
  renderPager({
    total: logs.length,
    page,
    infoNode: $('#logPagerInfo'),
    pageTextNode: $('#logPageText'),
    prevNode: $('#logPrevPage'),
    nextNode: $('#logNextPage'),
    sizeNode: $('#logPageSize'),
    emptyText: '暂无请求记录',
  })
  list.innerHTML = logs.length ? '' : `<div class="empty">暂无请求记录。</div>`

  for (let index = page.start; index < page.end; index += 1) {
    const log = logs[index]
    const compactSummary = compactLogErrorSummary(log)
    const errorSummary = logErrorSummaryMarkup(log, index)
    const item = document.createElement('div')
    item.className = 'log-item'
    item.innerHTML = `
      <div><strong>${new Date(log.time).toLocaleString()}</strong><br><small>${escapeHtml(log.method || '')} ${escapeHtml(log.path || '')}</small></div>
      <div><strong>${escapeHtml(log.model || '-')}</strong><br><small>${escapeHtml(log.providerName || compactSummary?.title || '-')}</small></div>
      <div class="log-status-cell">${logStatusPill(log)}${errorSummary}</div>
      <div>${usageMini(log.usage)}</div>
      <div><strong>${log.durationMs ?? '-'} ms</strong><br><small>${escapeHtml(logStatusText(log))}</small></div>
    `
    list.appendChild(item)
  }
}

function renderUsage() {
  const usage = state.runtime?.usage || {}
  const totals = usage.totals || {}
  const rangedUsage = aggregateUsageRange()
  const rangeLabel = usageRangeBounds().label
  $('#usageTotalTokens').textContent = formatTokenCompact(totals.totalTokens)
  $('#usageInOut').textContent = `${formatTokenCompact(totals.inputTokens)} / ${formatTokenCompact(totals.outputTokens)}`
  $('#usageCached').textContent = `${formatTokenCompact(totals.cachedTokens)} · ${cacheHitRateText(totals)}`
  $('#usageCacheCoverage').textContent = cacheCoverageText(totals)
  $('#usageRequests').textContent = formatNumber(totals.requests)
  $('#usageRangeLabel').textContent = rangeLabel
  $('#usageModelShareRange').textContent = `${rangeLabel} · Top 8`
  $('#usageProviderShareRange').textContent = `${rangeLabel} · Top 8`
  $('#usageWindowRange').textContent = rangeLabel

  renderUsageWindowRows(rangedUsage.byProvider)
  if (state.activeTab === 'usage') {
    renderUsageShareChart('usageModelShare', '#usageModelShareChart', '#usageModelShareLegend', rangedUsage.byModel, null)
    renderUsageShareChart('usageProviderShare', '#usageProviderShareChart', '#usageProviderShareLegend', rangedUsage.byProvider, providerName)
  }
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
  const data = buildShareChartData(byModel)
  renderShareLegend('#modelShareLegend', data)
  if (!window.Chart) return
  const node = $('#modelShareChart')

  if (state.charts.modelShare) {
    state.charts.modelShare.data = data
    state.charts.modelShare.options.plugins.tooltip = shareTooltipOptions(data)
    state.charts.modelShare.update()
    return
  }

  state.charts.modelShare = new Chart(node, {
    type: 'doughnut',
    data,
    options: shareChartOptions(data),
  })
}

function renderUsageShareChart(chartKey, selector, legendSelector, buckets = {}, labelMapper = null) {
  const data = buildShareChartData(buckets, labelMapper)
  renderShareLegend(legendSelector, data)
  if (!window.Chart) return
  const node = $(selector)
  if (!node) return

  if (state.charts[chartKey]) {
    state.charts[chartKey].data = data
    state.charts[chartKey].options.plugins.tooltip = shareTooltipOptions(data)
    state.charts[chartKey].update()
    return
  }

  state.charts[chartKey] = new Chart(node, {
    type: 'doughnut',
    data,
    options: shareChartOptions(data),
  })
}

function buildShareChartData(buckets = {}, labelMapper = null) {
  const entries = Object.entries(buckets)
    .map(([key, bucket]) => ({
      key,
      label: labelMapper ? labelMapper(key) : key,
      value: Number(bucket?.totalTokens || 0),
    }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)

  const top = entries.slice(0, 8)
  const rest = entries.slice(8).reduce((sum, entry) => sum + entry.value, 0)
  if (rest > 0) top.push({ key: '__other__', label: '其他', value: rest })

  const hasData = top.length > 0
  return {
    labels: hasData ? top.map((entry) => entry.label) : ['暂无数据'],
    datasets: [{
      data: hasData ? top.map((entry) => entry.value) : [1],
      backgroundColor: ['#109887', '#5575de', '#c78116', '#8b68c7', '#218b5c', '#438eaa', '#cf4f5a', '#74838d', '#a8b2b8'],
      borderWidth: 0,
    }],
    _hasData: hasData,
  }
}

function shareChartOptions(data) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '63%',
    plugins: {
      legend: { display: false },
      tooltip: shareTooltipOptions(data),
    },
  }
}

function renderShareLegend(selector, data) {
  const node = $(selector)
  if (!node) return
  if (!data._hasData) {
    node.innerHTML = '<div class="share-legend-empty">暂无 Token 数据</div>'
    return
  }

  const values = data.datasets[0].data
  const colors = data.datasets[0].backgroundColor
  const total = sumValues(values)
  node.innerHTML = data.labels.map((label, index) => {
    const value = Number(values[index] || 0)
    return `
      <div class="share-legend-item" title="${escapeHtml(label)}：${formatTokenCompact(value)} Token，${percentText(value, total)}">
        <span class="share-legend-swatch" style="--swatch:${colors[index]}"></span>
        <span class="share-legend-label">${escapeHtml(label)}</span>
        <strong>${percentText(value, total)}</strong>
        <small>${formatTokenCompact(value)}</small>
      </div>
    `
  }).join('')
}

function shareTooltipOptions(data) {
  return {
    callbacks: {
      label(context) {
        if (!data._hasData) return '暂无数据'
        const values = context.dataset.data || []
        const value = Number(context.parsed || 0)
        return `${context.label}: ${formatTokenCompact(value)} Token · ${percentText(value, sumValues(values))}`
      },
    },
  }
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
  const page = getPageSlice(records.length, state.recordsPage, state.recordsPageSize)
  state.recordsPage = page.page
  renderPager({
    total: records.length,
    allTotal: (state.runtime?.requestLog || []).length,
    page,
    infoNode: $('#recordCount'),
    pageTextNode: $('#recordPageText'),
    prevNode: $('#recordPrevPage'),
    nextNode: $('#recordNextPage'),
    sizeNode: $('#recordPageSize'),
    emptyText: '没有匹配记录',
  })
  rows.innerHTML = records.length ? '' : '<tr><td colspan="7" class="empty">没有匹配的请求记录。</td></tr>'

  const allLogs = state.runtime?.requestLog || []
  for (const log of records.slice(page.start, page.end)) {
    const usage = log.usage || {}
    const logIndex = allLogs.indexOf(log)
    const errorSummary = logErrorSummaryMarkup(log, logIndex)
    const statusSummary = errorSummary || `<small>${escapeHtml(logStatusText(log))}</small>`
    const attemptLine = compactAttemptLine(log)
    const credentialLabel = log.credentialLabel || (log.attempts || []).find((attempt) => attempt.credentialLabel)?.credentialLabel || '-'
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><strong>${new Date(log.time).toLocaleString()}</strong><br><small>${escapeHtml(log.method || '')} ${escapeHtml(log.path || '')}</small></td>
      <td><strong>${escapeHtml(log.model || '-')}</strong><br><small>${escapeHtml(log.routedModel || '-')}</small></td>
      <td><strong>${escapeHtml(log.providerName || '-')}</strong><br><small>${escapeHtml(credentialLabel)}</small></td>
      <td><div class="record-status-cell">${logStatusPill(log)}${statusSummary}</div></td>
      <td><strong>${formatTokenCompact(usage.totalTokens)}</strong><br><small>入 ${formatTokenCompact(usage.inputTokens)} / 出 ${formatTokenCompact(usage.outputTokens)} / 缓存 ${cacheUsageText(usage)}${usage.estimated ? ' · 估算' : ''}</small></td>
      <td><strong>${log.durationMs ?? '-'} ms</strong></td>
      <td><small>${escapeHtml(attemptLine)}</small></td>
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
  state.recordsPage = 1
  renderRecords()
}

function handleRecordPageSizeChange(event) {
  state.recordsPageSize = normalizePageSize(event.currentTarget.value)
  state.recordsPage = 1
  renderRecords()
}

function changeRecordsPage(delta) {
  state.recordsPage += delta
  renderRecords()
}

function handleLogPageSizeChange(event) {
  state.logsPageSize = normalizePageSize(event.currentTarget.value)
  state.logsPage = 1
  renderLogs()
}

function changeLogsPage(delta) {
  state.logsPage += delta
  renderLogs()
}

function toggleUsageRangeMenu(event) {
  event.stopPropagation()
  const menu = $('#usageRangeMenu')
  const willOpen = menu.hidden
  menu.hidden = !willOpen
  $('#usageRangeButton').setAttribute('aria-expanded', String(willOpen))
  $('#usageRangePicker').classList.toggle('open', willOpen)
  if (willOpen) syncUsageRangeControls()
}

function closeUsageRangeMenu() {
  $('#usageRangeMenu').hidden = true
  $('#usageRangeButton').setAttribute('aria-expanded', 'false')
  $('#usageRangePicker').classList.remove('open')
}

function closeUsageRangeMenuOnOutsideClick(event) {
  if (!$('#usageRangePicker').contains(event.target)) closeUsageRangeMenu()
}

function closeUsageRangeMenuOnEscape(event) {
  if (event.key === 'Escape') closeUsageRangeMenu()
}

function handleUsageRangeShortcut(event) {
  const button = event.target.closest('[data-usage-range]')
  if (!button) return
  const range = button.dataset.usageRange
  if (range === 'custom') {
    const currentBounds = usageRangeBounds()
    state.usageCustomStart = finiteDateKey(currentBounds.start) || localDateKey(new Date())
    state.usageCustomEnd = finiteDateKey(currentBounds.end - 1) || localDateKey(new Date())
    state.usageRange = 'custom'
    syncUsageRangeControls()
    $('#usageRangeStart').focus()
    return
  }
  state.usageRange = range
  syncUsageRangeControls()
  closeUsageRangeMenu()
  renderUsage()
}

function handleUsageCustomDateChange() {
  state.usageRange = 'custom'
  syncUsageRangeShortcutState()
}

function applyUsageCustomRange() {
  let start = $('#usageRangeStart').value
  let end = $('#usageRangeEnd').value
  if (!start || !end) {
    toast('请选择开始日期和结束日期')
    return
  }
  if (start > end) [start, end] = [end, start]
  state.usageRange = 'custom'
  state.usageCustomStart = start
  state.usageCustomEnd = end
  $('#usageRangeStart').value = start
  $('#usageRangeEnd').value = end
  closeUsageRangeMenu()
  renderUsage()
}

function syncUsageRangeControls() {
  const bounds = usageRangeBounds()
  const fallbackEnd = localDateKey(new Date())
  const fallbackStart = localDateKey(new Date(Date.now() - 6 * 86400000))
  $('#usageRangeStart').value = state.usageCustomStart || finiteDateKey(bounds.start) || fallbackStart
  $('#usageRangeEnd').value = state.usageCustomEnd || finiteDateKey(bounds.end - 1) || fallbackEnd
  syncUsageRangeShortcutState()
}

function syncUsageRangeShortcutState() {
  $$('[data-usage-range]', $('#usageRangeMenu')).forEach((button) => {
    button.classList.toggle('active', button.dataset.usageRange === state.usageRange)
  })
}

function usageRangeBounds(range = state.usageRange) {
  const now = new Date()
  const nowMs = now.getTime()
  const dayMs = 86400000
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()

  if (range === 'today') return { start: todayStart, end: tomorrowStart, label: '今天' }
  if (range === 'yesterday') return { start: todayStart - dayMs, end: todayStart, label: '昨天' }
  if (range === '24h') return { start: nowMs - dayMs, end: nowMs + 1, label: '近 24 小时' }
  if (range === '7d') return { start: nowMs - 7 * dayMs, end: nowMs + 1, label: '近 7 天' }
  if (range === '14d') return { start: nowMs - 14 * dayMs, end: nowMs + 1, label: '近 14 天' }
  if (range === '30d') return { start: nowMs - 30 * dayMs, end: nowMs + 1, label: '近 30 天' }
  if (range === 'thisMonth') {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
      label: '本月',
    }
  }
  if (range === 'lastMonth') {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
      end: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      label: '上月',
    }
  }
  if (range === 'all') return { start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY, label: '全部记录' }

  const startKey = state.usageCustomStart || localDateKey(now)
  const endKey = state.usageCustomEnd || startKey
  let start = localDateStart(startKey)
  let end = localDateStart(endKey) + dayMs
  if (start > end) [start, end] = [end - dayMs, start + dayMs]
  return { start, end, label: `${formatDateLabel(start)} 至 ${formatDateLabel(end - 1)}` }
}

function aggregateUsageRange() {
  const { start, end } = usageRangeBounds()
  const usage = state.runtime?.usage || {}
  const useHourly = ['24h', '7d', '14d', '30d'].includes(state.usageRange)
  const byModel = aggregateDimensionRange(
    useHourly ? usage.modelHourly : usage.dailyByModel,
    start,
    end,
    useHourly,
  )
  const rawByProvider = aggregateDimensionRange(
    useHourly ? usage.providerHourly : usage.dailyByProvider,
    start,
    end,
    useHourly,
  )
  const byProvider = {}
  for (const [key, bucket] of Object.entries(rawByProvider)) {
    const canonicalKey = canonicalProviderId(key)
    byProvider[canonicalKey] = addIntoBucket(byProvider[canonicalKey] || emptyBucket(), bucket)
    byProvider[canonicalKey].lastAt = Math.max(
      Number(byProvider[canonicalKey].lastAt || 0),
      Number(bucket.lastAt || 0),
    )
  }
  const totals = Object.values(byModel).reduce((sum, bucket) => addIntoBucket(sum, bucket), emptyBucket())
  const result = { totals, byModel, byProvider }
  return result
}

function aggregateDimensionRange(dimensions = {}, start, end, hourly) {
  const result = {}
  const hourMs = 3600000
  for (const [dimension, buckets] of Object.entries(dimensions || {})) {
    const sum = emptyBucket()
    for (const [timeKey, bucket] of Object.entries(buckets || {})) {
      const timestamp = hourly ? Number(timeKey) * hourMs : localDateStart(timeKey)
      if (!Number.isFinite(timestamp)) continue
      const bucketEnd = hourly ? timestamp + hourMs : timestamp + 86400000
      if (bucketEnd <= start || timestamp >= end) continue
      addIntoBucket(sum, bucket)
      sum.lastAt = Math.max(Number(sum.lastAt || 0), timestamp)
    }
    if (sum.requests || sum.totalTokens) result[dimension] = sum
  }
  return result
}

function canonicalProviderId(key) {
  const providers = state.config?.providers || []
  return providers.find((provider) => provider.id === key || provider.name === key)?.id || key
}

function renderUsageWindowRows(byProvider = {}) {
  const rows = $('#usageWindowRows')
  if (!rows) return
  const entries = Object.entries(byProvider)
    .filter(([, agg]) => agg.requests || agg.totalTokens)
    .map(([providerId, agg]) => ({
      provider: state.config?.providers?.find((item) => item.id === providerId) || { id: providerId, name: providerName(providerId) },
      agg,
    }))

  entries.sort((a, b) => b.agg.totalTokens - a.agg.totalTokens)
  rows.innerHTML = entries.length ? '' : '<div class="empty">所选日期范围暂无消耗数据。</div>'

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
      <div><strong>${escapeHtml(upstreamQuotaText(entry.upstream))}</strong><small>${escapeHtml(upstreamRecordText(entry.upstream))}</small></div>
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

function getPageSlice(total, requestedPage, requestedPageSize) {
  const pageSize = normalizePageSize(requestedPageSize)
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(1, Number(requestedPage) || 1), pageCount)
  const start = total ? (page - 1) * pageSize : 0
  const end = Math.min(start + pageSize, total)
  return { page, pageSize, pageCount, start, end }
}

function normalizePageSize(value) {
  const number = Number(value)
  return [20, 50, 100].includes(number) ? number : 20
}

function renderPager({ total, allTotal = null, page, infoNode, pageTextNode, prevNode, nextNode, sizeNode, emptyText }) {
  const showing = total ? `${formatNumber(page.start + 1)}-${formatNumber(page.end)}` : '0'
  const totalText = allTotal === null
    ? `共 ${formatNumber(total)} 条`
    : `共 ${formatNumber(total)} 条 / 全部 ${formatNumber(allTotal)} 条`
  infoNode.textContent = total ? `显示 ${showing}，${totalText}` : `${emptyText}，${totalText}`
  pageTextNode.textContent = `${page.page} / ${page.pageCount}`
  prevNode.disabled = page.page <= 1
  nextNode.disabled = page.page >= page.pageCount
  setSelectValue(sizeNode, String(page.pageSize))
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
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    requests: 0,
    cacheReportedRequests: 0,
    cacheUnreportedRequests: 0,
    estimatedRequests: 0,
    latencySum: 0,
    latencyCount: 0,
    lastAt: 0,
  }
}

function addIntoBucket(target, bucket = {}) {
  target.inputTokens += Number(bucket.inputTokens || 0)
  target.outputTokens += Number(bucket.outputTokens || 0)
  target.cachedTokens += Number(bucket.cachedTokens || 0)
  target.cacheWriteTokens += Number(bucket.cacheWriteTokens || 0)
  target.totalTokens += Number(bucket.totalTokens || 0)
  target.requests += Number(bucket.requests || 0)
  target.cacheReportedRequests += Number(bucket.cacheReportedRequests || 0)
  target.cacheUnreportedRequests += Number(bucket.cacheUnreportedRequests || 0)
  target.estimatedRequests += Number(bucket.estimatedRequests || 0)
  target.latencySum += Number(bucket.latencySum || 0)
  target.latencyCount += Number(bucket.latencyCount || 0)
  target.lastAt = Math.max(Number(target.lastAt || 0), Number(bucket.lastAt || 0))
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

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function clearDragDropIndicators(container) {
  container.querySelectorAll('.drag-drop-before, .drag-drop-after').forEach((row) => {
    row.classList.remove('drag-drop-before', 'drag-drop-after')
  })
}

function markDragDropTarget(container, target, afterTarget) {
  clearDragDropIndicators(container)
  target.classList.add(afterTarget ? 'drag-drop-after' : 'drag-drop-before')
}

function animateRowReorder(rows, previousTops) {
  if (prefersReducedMotion()) return

  for (const row of rows) {
    if (typeof row.animate !== 'function') continue
    const previousTop = previousTops.get(row)
    if (!Number.isFinite(previousTop)) continue
    const deltaY = previousTop - row.getBoundingClientRect().top
    if (Math.abs(deltaY) < 1) continue

    dragReorderAnimations.get(row)?.cancel()
    const animation = row.animate(
      [
        { transform: `translateY(${deltaY}px)` },
        { transform: 'translateY(0)' },
      ],
      {
        duration: DRAG_REORDER_DURATION_MS,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    )
    dragReorderAnimations.set(row, animation)
    animation.onfinish = () => {
      if (dragReorderAnimations.get(row) === animation) dragReorderAnimations.delete(row)
    }
    animation.oncancel = animation.onfinish
  }
}

function moveDraggedRow(container, dragged, target, afterTarget) {
  const alreadyPlaced = afterTarget
    ? target.nextElementSibling === dragged
    : target.previousElementSibling === dragged
  if (alreadyPlaced) return false

  const animatedRows = [...container.children].filter((row) => row !== dragged)
  const previousTops = new Map(animatedRows.map((row) => [row, row.getBoundingClientRect().top]))
  container.insertBefore(dragged, afterTarget ? target.nextSibling : target)
  animateRowReorder(animatedRows, previousTops)
  return true
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
  event.dataTransfer.dropEffect = 'move'
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
  const midpoint = rect.top + rect.height / 2
  if (Math.abs(event.clientY - midpoint) < 4) return
  const afterTarget = event.clientY > rect.top + rect.height / 2
  markDragDropTarget(rows, target, afterTarget)
  moveDraggedRow(rows, dragged, target, afterTarget)
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
  clearDragDropIndicators($('#providerRows'))
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
  const scopedProviders = state.activeProviderGroupId === 'all'
    ? [...state.config.providers]
    : state.config.providers.filter((provider) => providerGroupId(provider) === state.activeProviderGroupId)
  const orderedProviders = scopedProviders.sort((a, b) => a.priority - b.priority)
  if (orderedProviders.map((provider) => provider.id).join('|') === ids.join('|')) return
  const prioritySlots = orderedProviders.map((provider) => Number(provider.priority) || 0).sort((a, b) => a - b)

  for (const [index, id] of ids.entries()) {
    const provider = state.config.providers.find((item) => item.id === id)
    if (!provider) continue
    const priority = state.activeProviderGroupId === 'all'
      ? (index + 1) * 10
      : prioritySlots[index]
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
  if (button.dataset.action === 'new-provider') {
    openProviderDialog(null, preferredNewProviderGroupId())
    return
  }
  const provider = state.config.providers.find((item) => item.id === button.dataset.id)
  if (!provider) return

  if (button.dataset.action === 'edit-provider') openProviderDialog(provider)
  if (button.dataset.action === 'real-test') openRealTestDialog(provider)
  if (button.dataset.action === 'set-start-provider') {
    const requestedMode = ['auto', 'locked', 'pinned'].includes(state.runtime?.routing?.startMode)
      ? state.runtime.routing.startMode
      : 'auto'
    state.runtime = await api('/api/routing/start', {
      method: 'POST',
      body: {
        providerId: provider.id,
        mode: requestedMode,
      },
    })
    renderStatus()
    renderRoutingBar()
    renderProviders()
    renderRuntimeNotice()
    const actualProviderId = state.runtime?.routing?.startProviderId || ''
    const actualMode = state.runtime?.routing?.startMode || 'auto'
    if (actualProviderId !== provider.id || actualMode !== requestedMode) {
      toast(`起点未生效：后台仍为“${routingModeLabel(actualMode)}”，请重启 Local Model Relay`)
      return
    }
    toast(`已设为路由起点：${provider.name}`)
  }
  if (button.dataset.action === 'toggle-provider') {
    await api(`/api/providers/${provider.id}`, { method: 'PATCH', body: { enabled: !provider.enabled } })
    toast(provider.enabled ? '线路已停用' : '线路已启用')
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
}

async function saveRoutingMode(event) {
  const mode = ['auto', 'locked', 'pinned'].includes(event.currentTarget.value)
    ? event.currentTarget.value
    : 'auto'
  const providerId = state.runtime?.routing?.startProviderId || ''
  if (mode === 'pinned' && !providerId) {
    toast('请先在线路列表中把一条线路设为起点')
    renderRoutingBar()
    return
  }
  const nextRuntime = await api('/api/routing/start', {
    method: 'POST',
    body: { providerId, mode },
  })
  state.runtime = nextRuntime
  renderRoutingBar()
  renderProviders()
  const actualMode = state.runtime?.routing?.startMode || 'auto'
  if (actualMode !== mode) {
    toast(`模式未生效：后台仍为“${routingModeLabel(actualMode)}”，请重启 Local Model Relay`)
    return
  }
  toast(mode === 'pinned'
    ? '已启用单线锁定：线路失败时不会故障转移'
    : mode === 'locked'
      ? '路由起点已锁定，失败时仍会故障转移'
      : '路由起点将随成功线路自动推进')
}

async function clearStartProvider() {
  const wasPinned = state.runtime?.routing?.startMode === 'pinned'
  state.runtime = await api('/api/routing/start', { method: 'DELETE' })
  renderRoutingBar()
  renderProviders()
  toast(wasPinned ? '已清除起点并退出单线锁定' : '已清除路由起点')
}

function openRealTestDialog(provider) {
  state.testingProvider = provider
  const form = $('#realTestForm')
  form.reset()
  $('#realTestDialogTitle').textContent = `真实转发测试：${provider.name}`
  formField(form, 'providerId').value = provider.id
  formField(form, 'wireApi').value = 'provider'
  formField(form, 'prompt').value = 'Reply with exactly: OK'
  formField(form, 'maxTokens').value = 8
  $('#realTestTimeoutHint').textContent = `本次最多等待 ${formatSeconds(state.config.service.providerRealTestTimeoutMs || 90000)}；不会套用该线路的日常转发超时。`

  const models = availableProviderModels(provider)
  const modelInput = formField(form, 'model')
  setModelPickerOptions('real-test', models)
  modelInput.disabled = models.length === 0
  modelInput.value = preferredRealTestModel(provider)

  const enabledCredentials = (provider.credentials || []).filter((credential) => credential.enabled)
  const credentials = enabledCredentials.length ? enabledCredentials : provider.credentials || []
  formField(form, 'credentialId').innerHTML = credentials
    .map((credential) => `
      <option value="${escapeHtml(credential.id)}" ${credential.id === provider.activeCredentialId ? 'selected' : ''}>
        ${escapeHtml(credential.label || '默认')}
      </option>
    `)
    .join('')

  const runButton = $('#runRealTestBtn')
  runButton.disabled = models.length === 0
  $('#runCodexTestBtn').disabled = models.length === 0
  renderCodexTestResult(null)
  renderRealTestResult(models.length ? null : {
    skipped: true,
    message: '当前线路没有已保存的支持模型，请先在线路列表中运行“测试”并写入模型。',
  })
  $('#realTestDialog').showModal()
}

async function runCodexCompatibilityTestForForm(form) {
  const providerId = formField(form, 'providerId').value
  const model = formField(form, 'model').value.trim()
  const button = $('#runCodexTestBtn')
  if (!providerId || !model) {
    toast('请先选择要验证的模型')
    return
  }

  button.disabled = true
  button.textContent = '验证中'
  renderCodexTestResult({ pending: true })
  await nextFrame()

  try {
    const result = await api(`/api/providers/${providerId}/codex-test`, {
      method: 'POST',
      body: {
        model,
        credentialId: formField(form, 'credentialId').value,
      },
    })
    renderCodexTestResult(result)
    toast(result.ok ? 'Codex 请求头验证通过' : `Codex 请求头验证失败：${result.message || `HTTP ${result.status || 0}`}`)
    await refreshAll()
  } catch (error) {
    renderCodexTestResult({
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : String(error),
      checks: {},
    })
  } finally {
    button.disabled = !formField(form, 'model').value.trim()
    button.textContent = '验证 Codex 请求头'
  }
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
    button.disabled = !formField(form, 'model').value
    button.textContent = '运行测试'
    await refreshState()
  }
}

function bindModelPicker(name, options = {}) {
  const root = $(`.model-picker[data-picker="${cssEscape(name)}"]`)
  if (!root) return
  const input = $('input', root)
  const list = $('.model-picker-list', root)
  state.modelPickers[name] = {
    root,
    input,
    list,
    models: [],
    allowCustom: options.allowCustom !== false,
    emptyText: options.emptyText || '没有可选模型。',
  }
  input.addEventListener('input', () => renderModelPicker(name, true))
  input.addEventListener('focus', () => renderModelPicker(name, true))
  input.addEventListener('keydown', (event) => handleModelPickerKeydown(event, name))
  list.addEventListener('mousedown', (event) => event.preventDefault())
  list.addEventListener('click', (event) => {
    const item = event.target.closest('[data-model]')
    if (!item) return
    input.value = item.dataset.model || ''
    hideModelPicker(name)
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function setModelPickerOptions(name, models = []) {
  const picker = state.modelPickers[name]
  if (!picker) return
  picker.models = uniqueSorted(models)
  renderModelPicker(name, false)
}

function renderModelPicker(name, open = true) {
  const picker = state.modelPickers[name]
  if (!picker) return
  const query = picker.input.value.trim().toLowerCase()
  const matches = picker.models.filter((model) => model.toLowerCase().includes(query))
  const visible = query ? matches : picker.models
  const limited = visible.slice(0, 300)
  const hiddenCount = Math.max(0, visible.length - limited.length)
  picker.list.innerHTML = ''

  const meta = document.createElement('div')
  meta.className = 'model-picker-meta'
  meta.textContent = picker.models.length
    ? query
      ? `匹配 ${visible.length} / ${picker.models.length} 个模型`
      : `共 ${picker.models.length} 个模型，输入可筛选`
    : picker.emptyText
  picker.list.appendChild(meta)

  for (const model of limited) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'model-picker-option'
    item.dataset.model = model
    item.textContent = model
    if (model === picker.input.value) item.classList.add('selected')
    picker.list.appendChild(item)
  }

  if (hiddenCount > 0) {
    const more = document.createElement('div')
    more.className = 'model-picker-meta'
    more.textContent = `还有 ${hiddenCount} 个结果，请继续输入缩小范围。`
    picker.list.appendChild(more)
  }

  if (picker.allowCustom && query && !picker.models.includes(picker.input.value)) {
    const custom = document.createElement('div')
    custom.className = 'model-picker-meta'
    custom.textContent = '未匹配到也可以直接使用当前输入。'
    picker.list.appendChild(custom)
  }

  picker.list.hidden = !open
}

function handleModelPickerKeydown(event, name) {
  const picker = state.modelPickers[name]
  if (!picker) return
  if (event.key === 'Escape') {
    hideModelPicker(name)
    return
  }
  if (event.key !== 'Enter' || picker.list.hidden) return
  const selected = $('.model-picker-option.selected, .model-picker-option', picker.list)
  if (!selected) return
  event.preventDefault()
  picker.input.value = selected.dataset.model || ''
  hideModelPicker(name)
}

function hideModelPicker(name) {
  const picker = state.modelPickers[name]
  if (picker) picker.list.hidden = true
}

function closeModelPickersOnOutsideClick(event) {
  for (const [name, picker] of Object.entries(state.modelPickers)) {
    if (!picker.root.contains(event.target)) hideModelPicker(name)
  }
}

function closeModelPickersOnEscape(event) {
  if (event.key !== 'Escape') return
  Object.keys(state.modelPickers).forEach(hideModelPicker)
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
    node.textContent = '正在向上游发起一次真实模型请求...'
    return
  }

  if (result.skipped) {
    node.textContent = result.message || '没有可用于真实测试的模型。'
    return
  }

  const usage = result.usage
    ? `${formatTokenCompact(result.usage.totalTokens)} tokens，入 ${formatTokenCompact(result.usage.inputTokens)} / 出 ${formatTokenCompact(result.usage.outputTokens)} / 缓存 ${cacheUsageText(result.usage)}`
    : '-'
  node.innerHTML = `
    <div><span class="label">状态</span><strong>${result.ok ? '成功' : '失败'} · HTTP ${result.status || 0}</strong></div>
    <div><span class="label">耗时</span><strong>${result.latencyMs || '-'} ms</strong></div>
    <div><span class="label">测试时限</span><strong>${formatSeconds(result.timeoutMs || state.config.service.providerRealTestTimeoutMs || 90000)}</strong></div>
    <div><span class="label">模型</span><strong>${escapeHtml(result.model || '-')}</strong></div>
    <div><span class="label">Key 分组</span><strong>${escapeHtml(result.credentialLabel || '-')}</strong></div>
    <div class="wide"><span class="label">上游协议</span><strong>${wireApiLabel(result.wireApi)}</strong></div>
    <div class="wide"><span class="label">回复</span><pre>${escapeHtml(result.content || result.message || '-')}</pre></div>
    <div class="wide"><span class="label">用量</span><strong>${escapeHtml(usage)}</strong></div>
  `
}

function renderCodexTestResult(result = null) {
  const node = $('#codexTestResult')
  if (!result) {
    node.className = 'codex-test-result empty'
    node.textContent = '尚未运行 Codex 请求头验证。'
    return
  }

  node.className = `codex-test-result ${result.pending ? 'pending' : result.ok ? 'ok' : 'warn'}`
  if (result.pending) {
    node.textContent = '正在携带 Codex 客户端请求头检查线路...'
    return
  }
  if (result.skipped) {
    node.textContent = result.message || '当前配置无法进行 Codex 验证。'
    return
  }

  const headerCheck = result.checks?.requestHeaders || {}
  const responseCheck = result.checks?.response || {}
  node.innerHTML = `
    <div><span class="label">状态</span><strong>${result.ok ? '通过' : '失败'} · HTTP ${result.status || 0}</strong></div>
    <div><span class="label">耗时</span><strong>${result.latencyMs || '-'} ms</strong></div>
    <div><span class="label">客户端</span><strong>${escapeHtml(headerCheck.originator || 'codex_cli_rs')}</strong></div>
    <div><span class="label">版本</span><strong>${escapeHtml(headerCheck.version || '-')}</strong></div>
    <div class="wide"><span class="label">响应</span><strong>${escapeHtml(codexCheckLabel(responseCheck))}</strong></div>
    <div class="wide"><span class="label">说明</span><strong>${escapeHtml(result.message || '-')}</strong></div>
  `
}

function codexCheckLabel(check = {}) {
  const bits = []
  if (check.ok) bits.push('通过')
  if (check.status) bits.push(`HTTP ${check.status}`)
  if (check.hasText) bits.push('收到文本')
  if (check.hasToolCall) bits.push('收到函数调用')
  return bits.join(' · ') || check.message || '未返回有效检查结果'
}

function openRouteTestDialog(route) {
  if (!route?.enabled) {
    toast('请先启用该模型路由')
    return
  }

  state.testingRoute = route
  const form = $('#routeTestForm')
  form.reset()
  formField(form, 'routeId').value = route.id
  formField(form, 'prompt').value = 'Reply with exactly: OK'
  formField(form, 'maxTokens').value = 8
  $('#routeTestDialogTitle').textContent = `模型路由测试：${route.virtualModel}`
  $('#routeTestVirtualModel').textContent = route.virtualModel

  const targets = [...(route.targets || [])]
    .sort((left, right) => left.priority - right.priority || left.providerName.localeCompare(right.providerName))
  $('#routeTestCandidates').innerHTML = targets.length
    ? targets.map((target, index) => `
        <span class="route-test-candidate">
          <b>${index + 1}</b>${escapeHtml(target.providerName)}<small>${escapeHtml(target.model)}</small>
        </span>
      `).join('')
    : '<span class="muted">没有已配置的候选线路。</span>'

  $('#runRouteTestBtn').disabled = targets.length === 0
  renderRouteTestResult(null)
  $('#routeTestDialog').showModal()
}

async function runRouteTest(event) {
  event.preventDefault()
  const form = event.currentTarget
  const routeId = formField(form, 'routeId').value
  const button = $('#runRouteTestBtn')
  button.disabled = true
  button.textContent = '测试中'
  renderRouteTestResult({ pending: true })
  await nextFrame()

  try {
    const result = await api(`/api/routes/${routeId}/real-test`, {
      method: 'POST',
      body: {
        prompt: formField(form, 'prompt').value,
        maxTokens: Number(formField(form, 'maxTokens').value),
      },
    })
    renderRouteTestResult(result)
    toast(result.ok
      ? `路由测试成功：${result.providerName} · ${result.latencyMs} ms`
      : `路由测试失败：HTTP ${result.status || 0}`)
  } catch (error) {
    renderRouteTestResult({
      ok: false,
      status: 0,
      latencyMs: 0,
      attempts: [],
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    button.disabled = false
    button.textContent = '运行路由测试'
    await refreshState()
  }
}

function renderRouteTestResult(result = null) {
  const node = $('#routeTestResult')
  if (!result) {
    node.className = 'route-test-result empty'
    node.textContent = '尚未运行模型路由测试。'
    return
  }

  node.className = `route-test-result ${result.pending ? 'pending' : result.ok ? 'ok' : 'warn'}`
  if (result.pending) {
    node.textContent = '正在按当前模型路由顺序向上游发起真实请求...'
    return
  }

  const attempts = Array.isArray(result.attempts) ? result.attempts : []
  const finalProvider = result.providerName || (attempts.at(-1)?.providerName || '-')
  const routedModel = result.routedModel || result.model || '-'
  const attemptMarkup = attempts.length
    ? attempts.map((attempt, index) => {
      const status = attempt.skipped ? '跳过' : attempt.ok ? '成功' : '失败'
      const style = attempt.skipped ? 'skip' : attempt.ok ? 'ok' : 'warn'
      const detail = attempt.message || attempt.reason || ''
      return `
        <li class="route-test-attempt ${style}">
          <div class="route-test-attempt-main">
            <span class="route-test-index">${index + 1}</span>
            <div><strong>${escapeHtml(attempt.providerName || '未命名线路')}</strong><small>${escapeHtml(attempt.model || '-')} · ${escapeHtml(wireApiLabel(attempt.wireApi || 'chat'))}</small></div>
          </div>
          <div class="route-test-attempt-meta"><span class="pill ${style === 'ok' ? 'ok' : style === 'skip' ? 'off' : 'warn'}">${status}${attempt.status ? ` · HTTP ${attempt.status}` : ''}</span><strong>${Number(attempt.latencyMs) || 0} ms</strong></div>
          ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
        </li>
      `
    }).join('')
    : '<li class="route-test-empty">本次没有可尝试的线路。请检查模型路由、线路开关、Key 和冷却状态。</li>'

  node.innerHTML = `
    <section class="route-test-summary">
      <div><span class="label">结果</span><strong>${result.ok ? '成功' : '失败'} · HTTP ${result.status || 0}</strong></div>
      <div><span class="label">总耗时</span><strong>${Number(result.latencyMs) || 0} ms</strong></div>
      <div><span class="label">最终线路</span><strong>${escapeHtml(finalProvider)}</strong></div>
      <div><span class="label">真实模型</span><strong>${escapeHtml(routedModel)}</strong></div>
    </section>
    <section class="route-test-attempts"><h3>逐条尝试</h3><ol>${attemptMarkup}</ol></section>
    <section class="route-test-response"><span class="label">回复摘要</span><pre>${escapeHtml(result.content || result.message || '-')}</pre></section>
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
  if (button.dataset.action === 'route-test') openRouteTestDialog(route)
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

function openProviderDialog(provider = null, preferredGroupId = '') {
  state.editingProvider = provider
  const form = $('#providerForm')
  form.reset()
  const groups = providerGroups()
  const groupSelect = formField(form, 'groupId')
  groupSelect.innerHTML = groups.map((group) => (
    `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`
  )).join('')
  const fallbackGroupId = groups.find((group) => group.id === 'openai')?.id || groups[0]?.id || 'openai'
  const requestedGroupId = provider
    ? providerGroupId(provider)
    : groups.some((group) => group.id === preferredGroupId)
      ? preferredGroupId
      : fallbackGroupId
  $('#providerDialogTitle').textContent = provider ? '编辑线路' : '新增线路'
  formField(form, 'id').value = provider?.id || ''
  formField(form, 'name').value = provider?.name || ''
  groupSelect.value = requestedGroupId
  formField(form, 'baseUrl').value = provider?.baseUrl || ''
  formField(form, 'authMode').value = provider?.authMode || 'authorization'
  formField(form, 'wireApi').value = provider?.wireApi || 'chat'
  formField(form, 'providerOutboundProxyMode').value = provider?.outboundProxyMode || 'inherit'
  formField(form, 'providerOutboundProxyUrl').value = provider?.outboundProxyUrl || ''
  formField(form, 'priority').value = provider?.priority ?? nextProviderPriority()
  formField(form, 'timeoutSeconds').value = Math.round((provider?.timeoutMs || state.config.service.requestTimeoutMs) / 1000)
  formField(form, 'cooldownSeconds').value = provider?.cooldownSeconds ?? state.config.service.defaultCooldownSeconds
  formField(form, 'models').value = provider?.models?.join(', ') || ''
  formField(form, 'tags').value = provider?.tags?.join(', ') || ''
  formField(form, 'notes').value = provider?.notes || ''
  formField(form, 'enabled').checked = provider ? provider.enabled : true
  $('#providerDangerZone').hidden = !provider
  $('#credentialRows').innerHTML = ''
  const credentials = provider?.credentials?.length
    ? provider.credentials
    : [{ id: '', label: '默认', apiKeySet: false, apiKeyMasked: '', enabled: true, note: '' }]
  credentials.forEach((credential) => addCredentialRow(credential, provider?.activeCredentialId))
  renderProviderProxyFields()
  renderProviderTimeoutHint()
  $('#providerDialog').showModal()
}

async function deleteProviderFromEditor() {
  const provider = state.editingProvider
  if (!provider?.id) return
  if (!confirm(`删除线路「${provider.name}」？相关模型路由也会移除。`)) return

  const button = $('#deleteProviderBtn')
  button.disabled = true
  try {
    await api(`/api/providers/${provider.id}`, { method: 'DELETE' })
    $('#providerDialog').close()
    state.editingProvider = null
    toast('线路已删除')
    await refreshAll()
  } finally {
    button.disabled = false
  }
}

function renderProviderTimeoutHint() {
  const seconds = Number(formField($('#providerForm'), 'timeoutSeconds').value)
  const hint = $('#providerTimeoutHint')
  hint.classList.toggle('warn', Number.isFinite(seconds) && seconds < 30)
  hint.textContent = Number.isFinite(seconds) && seconds < 30
    ? '低于 30 秒容易把慢线路误判为故障；建议 90 秒。线路测试仍使用全局测试时限。'
    : '仅影响正常转发和故障切线，不影响线路测试；建议 90 秒。'
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
    groupId: formField(form, 'groupId').value,
    baseUrl: formField(form, 'baseUrl').value,
    credentials: readCredentialRows(),
    activeCredentialId: $('.credential-row input[name="activeCredential"]:checked')?.value || '',
    authMode: formField(form, 'authMode').value,
    wireApi: formField(form, 'wireApi').value,
    outboundProxyMode: formField(form, 'providerOutboundProxyMode').value || 'inherit',
    outboundProxyUrl: formField(form, 'providerOutboundProxyUrl').value,
    priority: Number(formField(form, 'priority').value),
    timeoutMs: Number(formField(form, 'timeoutSeconds').value) * 1000,
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
    event.dataTransfer.dropEffect = 'move'
    event.dataTransfer.setData('text/plain', 'target-row')
  }
  rows.ondragover = (event) => {
    if (!state.draggingTargetRow) return
    event.preventDefault()
    const target = event.target.closest('.target-row')
    if (!target || target === state.draggingTargetRow) return
    const rect = target.getBoundingClientRect()
    const midpoint = rect.top + rect.height / 2
    if (Math.abs(event.clientY - midpoint) < 4) return
    const afterTarget = event.clientY > rect.top + rect.height / 2
    markDragDropTarget(rows, target, afterTarget)
    moveDraggedRow(rows, state.draggingTargetRow, target, afterTarget)
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
  clearDragDropIndicators($('#targetRows'))
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
        ${state.config.providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join('')}
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
      providerTestTimeoutMs: Number(formField(form, 'providerTestTimeoutSeconds').value) * 1000,
      providerRealTestTimeoutMs: Number(formField(form, 'providerRealTestTimeoutSeconds').value) * 1000,
      maxAttempts: Number(formField(form, 'maxAttempts').value),
      defaultCooldownSeconds: Number(formField(form, 'defaultCooldownSeconds').value),
      reconnectFailureThreshold: Number(formField(form, 'reconnectFailureThreshold').value),
      reconnectCooldownSeconds: Number(formField(form, 'reconnectCooldownSeconds').value),
      sessionAffinity: formField(form, 'sessionAffinity').checked,
      sessionTtlSeconds: Number(formField(form, 'sessionTtlSeconds').value),
      sessionLimit: Number(formField(form, 'sessionLimit').value),
      diagnosticsLlm: {
        enabled: formField(form, 'diagnosticsLlmEnabled').checked,
        baseUrl: formField(form, 'diagnosticsLlmBaseUrl').value,
        model: formField(form, 'diagnosticsLlmModel').value,
        apiKey: formField(form, 'diagnosticsLlmApiKey').value,
        timeoutMs: Number(formField(form, 'diagnosticsLlmTimeoutSeconds').value) * 1000,
        clearApiKey: state.clearDiagnosticsLlmKey,
      },
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

function toggleDiagnosticsKeyVisibility() {
  const input = formField($('#settingsForm'), 'diagnosticsLlmApiKey')
  const button = $('#toggleDiagnosticsKeyBtn')
  const visible = input.type === 'text'
  input.type = visible ? 'password' : 'text'
  button.textContent = visible ? '显示' : '隐藏'
}

function clearDiagnosticsKey() {
  const input = formField($('#settingsForm'), 'diagnosticsLlmApiKey')
  input.value = ''
  state.clearDiagnosticsLlmKey = true
  updateDiagnosticsKeyStatus()
  toast('保存设置后将清除诊断 Key')
}

function updateDiagnosticsKeyStatus() {
  const status = $('#diagnosticsKeyStatus')
  if (!status) return
  if (state.clearDiagnosticsLlmKey) {
    status.textContent = '保存后清除当前 Key'
    status.classList.add('warn')
    return
  }
  const diagnosticsLlm = state.config?.service?.diagnosticsLlm || {}
  status.textContent = diagnosticsLlm.apiKeySet
    ? `已配置：${diagnosticsLlm.apiKeyMasked || '已隐藏'}`
    : '尚未配置 Key；本地无鉴权接口也可以留空。'
  status.classList.remove('warn')
}

async function testDiagnosticsLlm() {
  const button = $('#testDiagnosticsLlmBtn')
  const status = $('#diagnosticsLlmStatus')
  button.disabled = true
  status.textContent = '正在请求诊断模型……'
  try {
    const response = await api('/api/diagnostics/ai/test', { method: 'POST' })
    const result = response.result || {}
    status.textContent = `测试成功 · ${response.latencyMs || 0} ms · ${result.summary || '已收到返回'}`
    toast('AI 诊断接口测试成功')
  } catch (error) {
    status.textContent = `测试失败：${error.message || '请检查配置'}`
  } finally {
    button.disabled = false
  }
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
    const message = data.error?.message || `请求失败：${response.status}`
    if (options.silent) {
      const error = new Error(message)
      error.status = response.status
      error.code = data.error?.type || ''
      throw error
    }
    throwToast(message)
  }
  return data
}

function throwToast(message) {
  toast(message)
  throw new Error(message)
}

function codexCapabilityBadge(provider) {
  const results = Object.values(provider?.capabilities?.codex?.models || {})
  if (results.some((item) => item?.status === 'failed')) return '<span class="pill warn" title="至少一个模型未通过 Codex 请求头验证">Codex 失败</span>'
  if (results.some((item) => item?.status === 'verified')) return '<span class="pill ok" title="至少一个模型已通过 Codex 请求头验证">Codex 已验</span>'
  return '<span class="pill off" title="尚未运行 Codex 请求头验证">Codex 未验</span>'
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
  if (entry.reconnectFailureCount) {
    bits.push(`重连失败 ${entry.reconnectFailureCount}/${state.config?.service?.reconnectFailureThreshold || 4}`)
  }
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
    <select class="inline-select" data-action="switch-credential" data-id="${escapeHtml(provider.id)}" ${enabledCredentials.length ? '' : 'disabled'}>
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
  if (entry.upstream?.group && entry.upstream.group !== entry.credential.upstreamGroup) bits.push(`上游 ${entry.upstream.group}`)
  bits.push(`x${trimNumber(entry.credential.rate || 1)}`)
  return bits.join(' · ')
}

function upstreamQuotaText(upstream) {
  if (!upstream) return '-'
  const quotaPerCny = Number(state.config?.service?.quotaPerCny || 500000)
  const usedQuota = Number(upstream.usedQuota || 0)
  if (!usedQuota) return '上游已记录'
  const yuan = quotaPerCny ? usedQuota / quotaPerCny : 0
  return `${formatTokenCompact(usedQuota)} quota${yuan ? ` / ¥${trimNumber(yuan)}` : ''}`
}

function upstreamRecordText(upstream) {
  if (!upstream?.updatedAt) return '历史上游记录'
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
  return `<strong>${formatTokenCompact(usage.totalTokens)}</strong><br><small>入 ${formatTokenCompact(usage.inputTokens)} / 出 ${formatTokenCompact(usage.outputTokens)} / 缓存 ${cacheUsageText(usage)}${usage.estimated ? ' · 估算' : ''}</small>`
}

function cacheUsageText(usage = {}) {
  const cachedTokens = Number(usage.cachedTokens || 0)
  if (cachedTokens > 0) return formatTokenCompact(cachedTokens)
  if (usage.estimated) return '未知'
  if (usage.cachedTokensReported === true) return '0'
  if (usage.cachedTokensReported === false) return '上游未上报'
  return '历史未记录'
}

function cacheHitRateText(usage = {}) {
  const inputTokens = Number(usage.inputTokens || 0)
  const cachedTokens = Number(usage.cachedTokens || 0)
  if (inputTokens <= 0) return '命中率 -'
  return `命中率 ${Math.min(100, (cachedTokens / inputTokens) * 100).toFixed(1)}%`
}

function cacheCoverageText(usage = {}) {
  const requests = Number(usage.requests || 0)
  const reported = Number(usage.cacheReportedRequests || 0)
  const unreported = Number(usage.cacheUnreportedRequests || 0)
  const estimated = Number(usage.estimatedRequests || 0)
  const classified = reported + unreported
  if (!requests || !classified) return '历史累计未保存上报状态'
  const unknown = Math.max(0, requests - classified)
  const bits = [`可判断 ${classified}/${requests}`, `已上报 ${reported}`]
  if (unreported) bits.push(`未上报 ${unreported}`)
  if (unknown) bits.push(`历史未知 ${unknown}`)
  if (estimated) bits.push(`估算 ${estimated}`)
  return bits.join(' · ')
}

const COMPACT_ERROR_TITLES = new Map([
  [400, '请求参数被拒绝'],
  [401, '上游鉴权失败'],
  [402, '上游额度或余额不足'],
  [403, '上游权限或模型受限'],
  [404, '接口或模型不存在'],
  [408, '上游请求超时'],
  [409, '上游请求冲突'],
  [425, '上游暂时过载'],
  [429, '上游频率限制'],
  [500, '上游内部错误'],
  [502, '上游网关或线路异常'],
  [503, '上游服务暂不可用'],
  [504, '上游网关超时'],
])

function logStatusPill(log) {
  if (log?.outcome === 'real_test_success') return '<span class="pill info">测试成功</span>'
  if (log?.outcome === 'real_test_failed') return '<span class="pill warn">测试失败</span>'
  if (log?.outcome === 'tool_call_handoff') return '<span class="pill ok">工具调用</span>'
  if (log?.outcome === 'response_complete') return '<span class="pill ok">成功</span>'
  if (isClientDisconnected(log)) return '<span class="pill warn">中断</span>'
  return log.ok ? '<span class="pill ok">成功</span>' : '<span class="pill warn">失败</span>'
}

function logStatusText(log) {
  if (log?.outcome === 'real_test_success') return `${log.status ?? '-'} / 真实测试成功`
  if (log?.outcome === 'real_test_failed') return `${log.status ?? '-'} / 真实测试失败`
  if (log?.outcome === 'tool_call_handoff') return `${log.status ?? '-'} / 工具调用完成`
  if (log?.outcome === 'response_complete') return `${log.status ?? '-'} / 响应已完成`
  if (isClientDisconnected(log)) {
    const attempt = (log.attempts || []).at(-1) || {}
    if (attempt.failoverArmed) return `${log.status ?? '-'} / 重连 ${attempt.reconnectFailureThreshold || 4} 次，已切线`
    if (attempt.reconnectFailureCount) {
      return `${log.status ?? '-'} / 重连失败 ${attempt.reconnectFailureCount}/${attempt.reconnectFailureThreshold || 4}`
    }
    return `${log.status ?? '-'} / 客户端中断`
  }
  const diagnostic = firstLogDiagnostic(log)
  if (diagnostic) return `${log.status ?? '-'} / ${diagnostic.title || diagnostic.code || '上游错误'}`
  return log.status ?? '-'
}

function firstLogDiagnostic(log) {
  if (!Array.isArray(log?.diagnostics)) return null
  return log.diagnostics.find((item) => item?.type === 'upstream_error') ||
    log.diagnostics.find((item) => item && typeof item === 'object') ||
    null
}

function logErrorSummaryMarkup(log, logIndex) {
  const summary = compactLogErrorSummary(log)
  if (!summary || !Number.isInteger(logIndex) || logIndex < 0) return ''
  const tone = log?.ok && !isClientDisconnected(log) ? 'neutral' : 'warn'
  return `
    <button class="error-summary-button ${tone}" type="button" data-action="show-error-detail" data-log-index="${escapeHtml(logIndex)}" title="查看并复制完整失败原因">
      <span class="error-summary-code">${escapeHtml(summary.code)}</span>
      <span class="error-summary-title">${escapeHtml(summary.title)}</span>
      <span class="error-summary-more">详情</span>
    </button>
  `
}

function compactAttemptLine(log) {
  const attempts = Array.isArray(log?.attempts) ? log.attempts : []
  if (attempts.length) {
    return attempts
      .map((attempt) => `${attempt.providerName || '-'}${attempt.status ? `(${attempt.status})` : ''}`)
      .join(' → ')
  }
  const summary = compactLogErrorSummary(log)
  if (summary) return `${summary.code} · ${summary.title}`
  if (log?.error) return truncateInline(redactSensitiveText(log.error), 80)
  return '-'
}

function compactLogErrorSummary(log) {
  const failedAttempt = firstFailedAttempt(log)
  const diagnostic = firstLogDiagnostic(log) || failedAttempt?.diagnostic || null
  const hasDetail = diagnostic || failedAttempt || log?.error || isClientDisconnected(log)
  if (!hasDetail) return null

  const status = normalizeStatus(diagnostic?.status) ||
    normalizeStatus(log?.ok ? 0 : log?.status) ||
    normalizeStatus(failedAttempt?.status)
  const code = status ? String(status) : (isClientDisconnected(log) ? '中断' : (log?.ok ? '切线' : '错误'))
  let title = statusTitle(status) || compactErrorTitle(diagnostic?.title || failedAttempt?.message || log?.error)

  if (log?.ok && !isClientDisconnected(log) && (failedAttempt || diagnostic)) {
    title = status ? '已故障转移' : (title || '路由详情')
  }
  if (!title) title = log?.ok ? '路由详情' : '请求失败'
  return { code, title: truncateInline(title, 24), status }
}

function firstFailedAttempt(log) {
  const attempts = Array.isArray(log?.attempts) ? log.attempts : []
  return attempts.find((attempt) => attempt && !attempt.ok && !attempt.skipped && (
    attempt.status || attempt.error || attempt.message || attempt.reason || attempt.diagnostic
  )) || attempts.find((attempt) => attempt && (attempt.diagnostic || attempt.error || attempt.message || attempt.reason)) || null
}

function normalizeStatus(value) {
  const status = Number(value)
  return Number.isFinite(status) && status > 0 ? status : 0
}

function statusTitle(status) {
  if (!status) return ''
  return COMPACT_ERROR_TITLES.get(status) || `HTTP ${status}`
}

function compactErrorTitle(value) {
  const text = truncateInline(redactSensitiveText(value || ''), 80)
  return text
    .replace(/^上游返回 HTTP \d+[：:]?\s{0,}/, '上游错误')
    .replace(/^请求失败[：:]?\s{0,}/, '')
}

function truncateInline(value, limit = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function handleErrorDetailAction(event) {
  const trigger = event.target.closest('[data-action="show-error-detail"]')
  if (!trigger) return
  event.preventDefault()
  const index = Number(trigger.dataset.logIndex)
  const log = Number.isInteger(index) ? state.runtime?.requestLog?.[index] : null
  if (!log) {
    toast('这条记录刚刚刷新了，请重新打开详情')
    return
  }
  openErrorDetailDialog(log)
}

function openErrorDetailDialog(log) {
  const summary = compactLogErrorSummary(log) || { code: '详情', title: '请求详情' }
  $('#errorDetailTitle').textContent = `${summary.code} · ${summary.title}`
  $('#errorDetailSummary').innerHTML = errorDetailSummaryMarkup(log, summary)
  state.selectedErrorLog = log
  state.aiDiagnosis = null
  state.selectedErrorDetail = formatLogErrorDetail(log)
  $('#errorDetailText').textContent = state.selectedErrorDetail
  renderAiDiagnosis()
  $('#errorDetailDialog').showModal()
}

function errorDetailSummaryMarkup(log, summary) {
  const credentialLabel = log?.credentialLabel || (log?.attempts || []).find((attempt) => attempt.credentialLabel)?.credentialLabel || '-'
  const attemptCount = Array.isArray(log?.attempts) ? log.attempts.length : 0
  return `
    <div><span>状态</span><strong>${escapeHtml(summary.code)} · ${escapeHtml(summary.title)}</strong></div>
    <div><span>线路 / Key</span><strong>${escapeHtml(log?.providerName || '-')} / ${escapeHtml(credentialLabel)}</strong></div>
    <div><span>模型</span><strong>${escapeHtml(log?.model || '-')}</strong></div>
    <div><span>耗时</span><strong>${escapeHtml(log?.durationMs ?? '-')} ms</strong></div>
    <div><span>尝试次数</span><strong>${attemptCount || '-'}</strong></div>
    <div><span>时间</span><strong>${escapeHtml(log?.time ? new Date(log.time).toLocaleString() : '-')}</strong></div>
  `
}

async function copyErrorDetail() {
  const text = state.selectedErrorDetail || $('#errorDetailText')?.textContent || ''
  if (!text) {
    toast('没有可复制的失败详情')
    return
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const range = document.createRange()
      range.selectNodeContents($('#errorDetailText'))
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.execCommand('copy')
      selection.removeAllRanges()
    }
    toast('失败原因已复制')
  } catch {
    toast('复制失败，请手动选中详情')
  }
}

async function runAiDiagnosis() {
  const log = state.selectedErrorLog
  if (!log) {
    toast('请先打开一条请求失败详情')
    return
  }
  const configured = state.config?.service?.diagnosticsLlm
  if (!configured?.enabled || !configured?.baseUrl || !configured?.model || !configured?.apiKeySet) {
    toast('请先在设置中配置并启用 AI 诊断模型')
    return
  }

  const button = $('#runAiDiagnosisBtn')
  button.disabled = true
  state.aiDiagnosis = { loading: true }
  renderAiDiagnosis()
  try {
    state.aiDiagnosis = await api('/api/diagnostics/ai', {
      method: 'POST',
      body: { log },
    })
    toast('AI 错误诊断已完成')
  } catch (error) {
    state.aiDiagnosis = { error: error.message || 'AI 诊断失败' }
  } finally {
    button.disabled = false
    renderAiDiagnosis()
  }
}

async function copyAiDiagnosis() {
  const result = state.aiDiagnosis?.result
  if (!result) {
    toast('暂时没有可复制的 AI 诊断')
    return
  }
  const text = formatAiDiagnosisForCopy(result)
  try {
    await navigator.clipboard.writeText(text)
    toast('AI 诊断已复制')
  } catch {
    toast('复制失败，请手动选中诊断内容')
  }
}

function renderAiDiagnosis() {
  const panel = $('#aiDiagnosisPanel')
  const resultNode = $('#aiDiagnosisResult')
  const statusNode = $('#aiDiagnosisStatus')
  const copyButton = $('#copyAiDiagnosisBtn')
  if (!panel || !resultNode || !statusNode || !copyButton) return

  const diagnosis = state.aiDiagnosis
  panel.hidden = !diagnosis
  copyButton.hidden = !diagnosis?.result
  if (!diagnosis) {
    resultNode.innerHTML = ''
    statusNode.textContent = '等待诊断'
    return
  }
  if (diagnosis.loading) {
    statusNode.textContent = '正在分析'
    resultNode.innerHTML = '<div class="ai-diagnosis-loading">正在整理请求日志并等待诊断模型返回……</div>'
    return
  }
  if (diagnosis.error) {
    statusNode.textContent = '诊断失败'
    resultNode.innerHTML = `<div class="ai-diagnosis-error">${escapeHtml(diagnosis.error)}</div>`
    return
  }

  const result = diagnosis.result || {}
  statusNode.textContent = `${diagnosis.model || '诊断模型'} · ${diagnosis.latencyMs || 0} ms`
  resultNode.innerHTML = aiDiagnosisMarkup(result)
}

function aiDiagnosisMarkup(result) {
  if (result.format === 'text') {
    return `
      <div class="ai-diagnosis-summary">
        <strong>${escapeHtml(result.summary || '模型返回了文本诊断')}</strong>
        <span>未按结构化 JSON 返回</span>
      </div>
      <pre class="ai-diagnosis-raw">${escapeHtml(result.answer || '')}</pre>
    `
  }

  const evidence = Array.isArray(result.evidence) ? result.evidence : []
  const actions = Array.isArray(result.actions) ? result.actions : []
  return `
    <div class="ai-diagnosis-summary">
      <strong>${escapeHtml(result.summary || '无法确定')}</strong>
      <span>${escapeHtml(result.category || '未知')} · 置信度 ${escapeHtml(percentText(Number(result.confidence || 0) * 100, 100))}</span>
    </div>
    <div class="ai-diagnosis-grid">
      <div><span>最可能原因</span><strong>${escapeHtml(result.rootCause || '无法确定')}</strong></div>
      <div><span>故障转移判断</span><strong>${escapeHtml(result.failoverAssessment || '无法判断')}</strong></div>
      <div class="wide"><span>证据</span>${evidence.length ? `<ul>${evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<strong>没有提供额外证据</strong>'}</div>
      <div class="wide"><span>建议操作</span>${actions.length ? `<ol>${actions.map((item) => `<li><b>${escapeHtml(item.priority || '中')}</b>${escapeHtml(item.action || '')}</li>`).join('')}</ol>` : '<strong>暂无具体操作建议</strong>'}</div>
      <div class="wide"><span>重试建议</span><strong>${escapeHtml(result.retryAdvice || '无法确定')}</strong></div>
    </div>
  `
}

function formatAiDiagnosisForCopy(result) {
  if (result.format === 'text') return result.answer || result.summary || ''
  const lines = [
    `结论：${result.summary || '无法确定'}`,
    `分类：${result.category || '未知'}`,
    `置信度：${percentText(Number(result.confidence || 0) * 100, 100)}`,
    `最可能原因：${result.rootCause || '无法确定'}`,
    `故障转移判断：${result.failoverAssessment || '无法判断'}`,
    '',
    '证据：',
    ...(result.evidence || []).map((item) => `- ${item}`),
    '',
    '建议操作：',
    ...(result.actions || []).map((item) => `- [${item.priority || '中'}] ${item.action || ''}`),
    '',
    `重试建议：${result.retryAdvice || '无法确定'}`,
  ]
  return lines.join('\n')
}

function formatLogErrorDetail(log) {
  const lines = []
  const summary = compactLogErrorSummary(log)
  appendDetailLine(lines, '状态摘要', summary ? `${summary.code} · ${summary.title}` : logStatusText(log))
  appendDetailLine(lines, '时间', log?.time ? new Date(log.time).toLocaleString() : '')
  appendDetailLine(lines, '请求', `${log?.method || ''} ${log?.path || ''}`.trim())
  appendDetailLine(lines, '模型', log?.model)
  appendDetailLine(lines, '路由模型', log?.routedModel)
  appendDetailLine(lines, '线路', log?.providerName)
  appendDetailLine(lines, 'Key 分组', log?.credentialLabel)
  appendDetailLine(lines, 'HTTP 状态', log?.status ? `HTTP ${log.status}` : '')
  appendDetailLine(lines, '结果', log?.outcome || (log?.ok ? 'success' : 'failed'))
  appendDetailLine(lines, '耗时', log?.durationMs !== undefined ? `${log.durationMs} ms` : '')
  appendDetailLine(lines, '错误', log?.error)

  const diagnostics = prioritizeDiagnostics(Array.isArray(log?.diagnostics)
    ? log.diagnostics.filter((item) => item && typeof item === 'object')
    : [])
  if (diagnostics.length) {
    lines.push('', '诊断')
    diagnostics.forEach((diagnostic, index) => appendDiagnosticLines(lines, diagnostic, index + 1))
  }

  const attempts = Array.isArray(log?.attempts) ? log.attempts : []
  if (attempts.length) {
    lines.push('', '尝试链')
    attempts.forEach((attempt, index) => appendAttemptLines(lines, attempt, index + 1))
  }

  return redactSensitiveText(lines.join('\n').trim() || '没有记录到更多失败详情。')
}

function appendDiagnosticLines(lines, diagnostic, index) {
  lines.push(`#${index} ${diagnostic.providerName ? `${diagnostic.providerName} · ` : ''}${diagnostic.title || diagnostic.code || '诊断'}`)
  appendDetailLine(lines, '  状态', diagnostic.status ? `HTTP ${diagnostic.status}` : '')
  appendDetailLine(lines, '  代码', diagnostic.code)
  appendDetailLine(lines, '  内容', diagnostic.message)
  appendDetailLine(lines, '  建议', diagnostic.suggestion)
}

function appendAttemptLines(lines, attempt, index) {
  const status = attempt.status ? `HTTP ${attempt.status}` : (attempt.skipped ? '跳过' : attempt.ok ? '成功' : '失败')
  lines.push(`#${index} ${attempt.providerName || '未命名线路'} · ${status}`)
  appendDetailLine(lines, '  Key 分组', attempt.credentialLabel)
  appendDetailLine(lines, '  模型', attempt.model)
  appendDetailLine(lines, '  协议', attempt.wireApi)
  appendDetailLine(lines, '  结果', attempt.outcome || attempt.reason || attempt.message)
  appendDetailLine(lines, '  耗时', attempt.latencyMs !== undefined ? `${attempt.latencyMs} ms` : '')
  appendDetailLine(lines, '  错误', attempt.error)
  if (attempt.diagnostic && typeof attempt.diagnostic === 'object') appendDiagnosticLines(lines, attempt.diagnostic, `${index}.诊断`)
}

function appendDetailLine(lines, label, value) {
  if (value === null || value === undefined || value === '') return
  const text = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
  if (!text.trim()) return
  lines.push(`${label}: ${text}`)
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization)["'\s:=]+)[^\s"',}]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)([^:\s/@]+):([^@\s/]+)@/gi, '$1[REDACTED]@')
}

function logDiagnosticsMarkup(log, limit = 3) {
  const diagnostics = prioritizeDiagnostics(Array.isArray(log?.diagnostics)
    ? log.diagnostics.filter((item) => item && typeof item === 'object')
    : [])
  if (!diagnostics.length) return ''

  const visible = diagnostics.slice(0, limit)
  const hiddenCount = diagnostics.length - visible.length
  return `
    <div class="log-diagnostics">
      ${visible.map((diagnostic) => {
        const provider = diagnostic.providerName ? `${diagnostic.providerName} · ` : ''
        const title = diagnostic.title || diagnostic.code || '诊断'
        const message = diagnostic.message || ''
        const suggestion = diagnostic.suggestion ? `建议：${diagnostic.suggestion}` : ''
        return `
          <div class="log-diagnostic">
            <strong>${escapeHtml(provider + title)}</strong>
            ${message ? `<span>${escapeHtml(message)}</span>` : ''}
            ${suggestion ? `<small>${escapeHtml(suggestion)}</small>` : ''}
          </div>
        `
      }).join('')}
      ${hiddenCount > 0 ? `<small class="log-diagnostic-more">还有 ${hiddenCount} 条诊断</small>` : ''}
    </div>
  `
}

function prioritizeDiagnostics(diagnostics) {
  const upstream = diagnostics.filter((item) => item.type === 'upstream_error')
  const skippedKey = diagnostics.filter((item) => item.code === 'no_enabled_key')
  const other = diagnostics.filter((item) => item.type !== 'upstream_error' && item.code !== 'no_enabled_key')
  return [
    ...upstream.slice(0, 2),
    ...skippedKey.slice(0, 1),
    ...upstream.slice(2),
    ...skippedKey.slice(1),
    ...other,
  ]
}

function isClientDisconnected(log) {
  return log?.outcome === 'client_disconnected' ||
    String(log?.error || '').includes('Client disconnected')
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

function formatSeconds(milliseconds) {
  const seconds = Number(milliseconds || 0) / 1000
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`
}

function trimNumber(value) {
  return value >= 10 ? value.toFixed(1).replace(/\.0$/, '') : value.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')
}

function sumValues(values = []) {
  return values.reduce((sum, value) => sum + Number(value || 0), 0)
}

function percentText(value, total) {
  if (!total) return '0%'
  const percent = (Number(value || 0) / total) * 100
  return percent >= 10 ? `${percent.toFixed(1)}%` : `${percent.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}%`
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
    groupId: providerGroupId(provider),
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
    capabilities: provider.capabilities || {},
    enabled: provider.enabled,
  }
}

function providerWebsiteLink(baseUrl) {
  const displayUrl = String(baseUrl || '').trim()
  const websiteUrl = providerWebsiteUrl(displayUrl)
  if (!websiteUrl) return escapeHtml(displayUrl || '-')

  return `
    <a class="provider-url-link" href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener noreferrer" title="打开线路官网">
      <span class="provider-url-text">${escapeHtml(displayUrl)}</span>
      <span class="provider-url-mark" aria-hidden="true">↗</span>
    </a>
  `
}

function providerWebsiteUrl(baseUrl) {
  try {
    const url = new URL(String(baseUrl || '').trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
  } catch {
    return ''
  }
}

function preferredRealTestModel(provider) {
  const models = availableProviderModels(provider)
  return preferredTestModel(models)
}

function preferredTestModel(models = []) {
  if (models.includes('gpt-5.6-luna')) return 'gpt-5.6-luna'
  if (models.includes('gpt-5.4-mini')) return 'gpt-5.4-mini'
  return models.find((model) => /mini|flash|lite|small/i.test(model)) || models[0] || ''
}

function availableProviderModels(provider) {
  return [...new Set((Array.isArray(provider.models) ? provider.models : [])
    .map((model) => String(model).trim())
    .filter(Boolean))]
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
  if (mode === 'pinned') return '单线锁定'
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

function localDateStart(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number)
  return new Date(year, month - 1, day).getTime()
}

function finiteDateKey(timestamp) {
  return Number.isFinite(timestamp) ? localDateKey(new Date(timestamp)) : ''
}

function formatDateLabel(timestamp) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`
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
