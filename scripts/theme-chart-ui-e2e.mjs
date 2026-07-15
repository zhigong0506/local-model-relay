const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'

const response = await fetch(`${relay}/admin`)
if (!response.ok) throw new Error(`/admin -> HTTP ${response.status}`)
const html = await response.text()

const requiredHtml = [
  "matchMedia('(prefers-color-scheme: dark)')",
  'local-model-relay-theme',
  'id="themeToggleBtn"',
  'id="modelShareLegend"',
  'id="usageModelShareLegend"',
  'id="usageProviderShareLegend"',
  'class="chart-card model-share-card"',
]
const missingHtml = requiredHtml.filter((snippet) => !html.includes(snippet))
if (missingHtml.length) throw new Error(`Theme/chart markup is missing: ${missingHtml.join(', ')}`)

const scriptResponse = await fetch(`${relay}/assets/js/main.mjs`)
if (!scriptResponse.ok) throw new Error(`/assets/js/main.mjs -> HTTP ${scriptResponse.status}`)
const script = await scriptResponse.text()
const requiredScript = [
  'bindThemeControls',
  'applyThemeMode',
  'syncChartTheme',
  'renderShareLegend',
  "legend: { display: false }",
  "cutout: '63%'",
]
const missingScript = requiredScript.filter((snippet) => !script.includes(snippet))
if (missingScript.length) throw new Error(`Theme/chart behavior is missing: ${missingScript.join(', ')}`)

const styleResponse = await fetch(`${relay}/assets/styles.css`)
if (!styleResponse.ok) throw new Error(`/assets/styles.css -> HTTP ${styleResponse.status}`)
const css = await styleResponse.text()
const requiredCss = [
  'html[data-theme="dark"]',
  'html[data-theme="dark"] .outbound-card',
  'html[data-theme="dark"] .proxy-options .radio-label',
  'html[data-theme="dark"] .proxy-options .radio-label:has(input:checked)',
  '.share-chart-layout',
  'grid-template-columns: minmax(190px, 226px) minmax(0, 1fr)',
  '.share-chart-legend',
]
const missingCss = requiredCss.filter((snippet) => !css.includes(snippet))
if (missingCss.length) throw new Error(`Theme/chart styles are missing: ${missingCss.join(', ')}`)
if (!/\.chart-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.2fr\) minmax\(330px, 0\.8fr\)/s.test(css)) {
  throw new Error('Dashboard must keep its two-column chart layout with a slightly wider visualization column')
}
if (!/\.model-share-card \.share-chart-layout\s*\{[^}]*grid-template-columns:\s*minmax\(300px, 0\.95fr\) minmax\(0, 1\.05fr\)/s.test(css)) {
  throw new Error('Model share card must balance a large chart with a flexible legend column')
}
if (!/\.model-share-card \.share-chart-legend\s*\{[^}]*align-content:\s*space-evenly/s.test(css)) {
  throw new Error('Model share legend must use the available card height')
}
if (!/@media \(min-width: 761px\) and \(max-width: 1200px\)[\s\S]*?\.model-share-card \.share-chart-layout\s*\{[^}]*grid-template-columns:\s*minmax\(230px, 0\.8fr\) minmax\(0, 1\.2fr\)/s.test(css)) {
  throw new Error('Model share card must shrink without overflowing at intermediate desktop widths')
}

console.log(JSON.stringify({
  ok: true,
  systemThemeDetection: true,
  manualThemeMode: true,
  persistentPreference: true,
  readableDarkProxyOptions: true,
  compactShareCharts: 3,
  externalLegends: 3,
  restoredDashboardColumns: true,
  balancedModelShareCard: true,
  intermediateWidthGuard: true,
}, null, 2))
