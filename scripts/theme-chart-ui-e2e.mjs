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
  '.share-chart-layout',
  'grid-template-columns: minmax(190px, 226px) minmax(0, 1fr)',
  '.share-chart-legend',
]
const missingCss = requiredCss.filter((snippet) => !css.includes(snippet))
if (missingCss.length) throw new Error(`Theme/chart styles are missing: ${missingCss.join(', ')}`)

console.log(JSON.stringify({
  ok: true,
  systemThemeDetection: true,
  manualThemeMode: true,
  persistentPreference: true,
  compactShareCharts: 3,
  externalLegends: 3,
}, null, 2))
