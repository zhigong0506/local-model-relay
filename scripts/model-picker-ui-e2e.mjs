const relay = process.env.RELAY_URL || 'http://127.0.0.1:25818'

const response = await fetch(`${relay}/admin`)
if (!response.ok) throw new Error(`/admin -> HTTP ${response.status}`)
const html = await response.text()
if (html.includes('list="speedModelOptions"') || html.includes('<datalist')) {
  throw new Error('Model picker still uses native datalist.')
}
if (html.includes('<select name="model" required></select>')) {
  throw new Error('Real-test model picker still uses a native select.')
}

const scriptResponse = await fetch(`${relay}/assets/js/main.mjs`)
if (!scriptResponse.ok) throw new Error(`/assets/js/main.mjs -> HTTP ${scriptResponse.status}`)
const script = await scriptResponse.text()
const requiredSnippets = [
  'bindModelPicker',
  'setModelPickerOptions',
  'renderModelPicker',
  '匹配 ${visible.length} / ${picker.models.length} 个模型',
]
const missing = requiredSnippets.filter((snippet) => !script.includes(snippet))
if (missing.length) throw new Error(`Model picker script is missing: ${missing.join(', ')}`)

const styleResponse = await fetch(`${relay}/assets/styles.css`)
if (!styleResponse.ok) throw new Error(`/assets/styles.css -> HTTP ${styleResponse.status}`)
const css = await styleResponse.text()
if (!css.includes('.model-picker-list') || !css.includes('max-height: min(420px, 52vh)')) {
  throw new Error('Model picker dropdown styles are missing.')
}

console.log(JSON.stringify({
  ok: true,
  nativeDatalistRemoved: true,
  realTestSelectRemoved: true,
  searchablePickerScript: true,
  boundedScrollableList: true,
}, null, 2))
