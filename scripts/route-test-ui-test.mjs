import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rootDir } from '../src/paths.mjs'

const [html, main, styles] = await Promise.all([
  readFile(join(rootDir, 'public', 'index.html'), 'utf8'),
  readFile(join(rootDir, 'public', 'js', 'main.mjs'), 'utf8'),
  readFile(join(rootDir, 'public', 'styles.css'), 'utf8'),
])

assert.match(html, /id="routeTestDialog"/)
assert.match(html, /id="routeTestForm"/)
assert.match(html, /value="pinned"/)
assert.match(html, /单线锁定（不故障转移）/)
assert.match(html, /class="providers-table"/)
assert.match(html, /id="providerDangerZone"/)
assert.match(html, /id="deleteProviderBtn"/)
assert.match(html, /id="manageProviderGroupsBtn"/)
assert.match(html, /id="providerGroupTabs"/)
assert.match(html, /id="providerGroupSummary"/)
assert.match(html, /id="providerGroupsDialog"/)
assert.match(html, /id="providerGroupRows"/)
assert.match(html, /id="providerGroupForm"/)
assert.match(html, /name="groupId"/)
assert.match(html, /id="runCodexTestBtn"/)
assert.match(html, /id="codexTestResult"/)
assert.match(html, /id="errorDetailDialog"/)
assert.match(html, /id="errorDetailTitle"/)
assert.match(html, /id="errorDetailText"/)
assert.match(html, /id="copyErrorDetailBtn"/)
assert.match(html, /id="runAiDiagnosisBtn"/)
assert.match(html, /id="aiDiagnosisPanel"/)
assert.match(html, /name="diagnosticsLlmEnabled"/)
assert.match(html, /name="diagnosticsLlmBaseUrl"/)
assert.match(html, /name="diagnosticsLlmModel"/)
assert.match(html, /id="testDiagnosticsLlmBtn"/)
assert.match(html, /id="runtimeNotice"/)
assert.match(html, /id="runtimeCheckBtn"/)
assert.match(html, /name="sessionAffinity"/)
assert.match(html, /name="sessionTtlSeconds"/)
assert.match(html, /name="sessionLimit"/)
assert.match(main, /data-action="route-test"/)
assert.match(main, /openRouteTestDialog/)
assert.match(main, /\/api\/routes\/\$\{routeId\}\/real-test/)
assert.doesNotMatch(main, /data-action="codex-test"/)
assert.doesNotMatch(main, /data-action="sync-usage"/)
assert.doesNotMatch(main, /data-action="delete-provider"/)
assert.doesNotMatch(main, /\/usage-sync/)
assert.match(main, /runCodexCompatibilityTestForForm/)
assert.match(main, /deleteProviderFromEditor/)
assert.match(main, /openProviderGroupsDialog/)
assert.match(main, /renderProviderGroupRows/)
assert.match(main, /saveProviderGroup/)
assert.match(main, /preferredNewProviderGroupId/)
assert.match(main, /groupId: formField\(form, 'groupId'\)\.value/)
assert.match(main, /groupId: providerGroupId\(provider\)/)
assert.match(main, /status-stack/)
assert.match(main, /data-action="show-error-detail"/)
assert.match(main, /compactLogErrorSummary/)
assert.match(main, /formatLogErrorDetail/)
assert.match(main, /copyErrorDetail/)
assert.match(main, /runAiDiagnosis/)
assert.match(main, /\/api\/diagnostics\/ai/)
assert.match(main, /renderAiDiagnosis/)
assert.doesNotMatch(main, /logDiagnosticsMarkup\(log, 2\)/)
assert.match(main, /mode === 'pinned'/)
assert.match(main, /线路失败时不会故障转移/)
assert.match(main, /actualMode !== mode/)
assert.match(main, /模式未生效：后台仍为/)
assert.match(main, /CLIENT_RUNTIME_PROTOCOL = 1/)
assert.match(main, /\/api\/state\/summary/)
assert.match(main, /actualProviderId !== provider\.id \|\| actualMode !== requestedMode/)
assert.match(main, /renderRuntimeNotice/)
assert.match(main, /route-test-attempt/)
assert.match(main, /sessionAffinity: formField\(form, 'sessionAffinity'\)\.checked/)
assert.match(styles, /\.route-test-dialog/)
assert.match(styles, /\.route-test-attempt/)
assert.match(styles, /\.session-affinity-card/)
assert.match(styles, /\.providers-table/)
assert.match(styles, /\.real-test-tools/)
assert.match(styles, /\.codex-test-result/)
assert.match(styles, /\.danger-zone/)
assert.match(styles, /\.provider-group-bar/)
assert.match(styles, /\.provider-group-tab/)
assert.match(styles, /\.provider-group-badge/)
assert.match(styles, /\.provider-groups-dialog/)
assert.match(styles, /\.provider-group-editor/)
assert.match(styles, /\.routing-bar\.pinned/)
assert.match(styles, /\.error-summary-button/)
assert.match(styles, /\.error-detail-dialog/)
assert.match(styles, /\.runtime-notice/)
assert.match(styles, /\.ai-diagnostics-card/)
assert.match(styles, /\.ai-diagnosis-panel/)

console.log(JSON.stringify({
  ok: true,
  routeTestDialog: true,
  routeTestAction: true,
  providerStatusLayout: true,
  codexValidationInRealTest: true,
  providerDeleteInEditor: true,
  providerGroupTabs: true,
  providerGroupCrudDialog: true,
  providerGroupSelectionInEditor: true,
  syncUsageActionRemoved: true,
  pinnedStartMode: true,
  sessionAffinitySettings: true,
  compactErrorDetails: true,
  copyableErrorDetails: true,
  aiDiagnosticsUi: true,
  runtimeCompatibilityNotice: true,
  lightweightStatePolling: true,
  startProviderResponseValidation: true,
  responsiveStyles: true,
}, null, 2))
