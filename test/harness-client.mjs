/**
 * 集成验证（Client 半边）：把真实包文件 client.js 跑起来。
 * 没有 react 可用（在 asar 里），所以写一个最小 React shim：函数组件 + hooks，
 * 跨渲染保持实例状态，并且能「排空 effect」以验证异步数据流。
 *
 * Phase 1 起数据流是「服务端为准」：面板先拉 /sessions，再拉 /session/messages。
 * 所以测试用 settle() 反复 drain+tick+render，让这两轮异步都落地。
 */
import { readFileSync } from 'node:fs'

// 指向**真实包文件**（正在运行的那一份），而不是文档里抽取的代码块副本。
const SRC = new URL('../packages/dsh-deepseek-web/client.js', import.meta.url)

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail === '' ? '' : '  → ' + detail}`)
  if (!ok) failures += 1
}

// ---- 最小 React shim -----------------------------------------------------

function createRuntime() {
  const instances = new Map()
  const pending = []
  let dirty = false
  let active = null

  const currentInstance = () => {
    if (active === null) throw new Error('hook 在组件外调用')
    return active
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true)
      return { $$element: true, type, props: props ?? {}, children: flat }
    },
    useState(initial) {
      const instance = currentInstance()
      const index = instance.cursor++
      if (instance.values.length <= index) {
        instance.values[index] = typeof initial === 'function' ? initial() : initial
      }
      return [instance.values[index], (next) => {
        instance.values[index] = typeof next === 'function' ? next(instance.values[index]) : next
        dirty = true
      }]
    },
    useRef(initial) {
      const instance = currentInstance()
      const index = instance.cursor++
      if (instance.values.length <= index) instance.values[index] = { current: initial }
      return instance.values[index]
    },
    useCallback(fn) { currentInstance().cursor++; return fn },
    useMemo(fn) { currentInstance().cursor++; return fn() },
    useEffect(fn) { currentInstance().effects.push(fn) },
  }

  const build = (element) => {
    if (element === null || element === undefined || element === true || element === false) return null
    if (typeof element === 'string' || typeof element === 'number') return { text: String(element), children: [] }
    if (Array.isArray(element)) return { tag: '#fragment', props: {}, children: element.map(build).filter(Boolean) }
    if (element.$$element !== true) return null
    if (typeof element.type === 'function') {
      const key = element.type
      if (!instances.has(key)) instances.set(key, { values: [], effects: [], cursor: 0 })
      const instance = instances.get(key)
      instance.cursor = 0
      const previous = active
      active = instance
      let output
      try { output = element.type({ ...element.props, children: element.children }) } finally { active = previous }
      return build(output)
    }
    return { tag: element.type, props: element.props, children: element.children.map(build).filter(Boolean) }
  }

  const mount = (element) => {
    let tree = build(element)
    let rounds = 0
    while (dirty && rounds < 5) { dirty = false; rounds += 1; tree = build(element) }
    return tree
  }
  const drain = () => {
    for (const instance of instances.values()) {
      for (const effect of instance.effects.splice(0)) pending.push(effect)
    }
    for (const effect of pending.splice(0)) effect()
  }
  return { React, mount, drain }
}

const walk = (node, visit) => {
  if (node === null || node === undefined) return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}
const allText = (node) => {
  let text = ''
  walk(node, (n) => { if (typeof n.text === 'string') text += n.text })
  return text
}
const find = (node, predicate) => {
  const hits = []
  walk(node, (n) => { if (predicate(n) === true) hits.push(n) })
  return hits
}
const clickByText = (tree, label) => {
  const button = find(tree, (n) => n.tag === 'button' && allText(n) === label)[0]
  if (button === undefined) throw new Error(`没有找到按钮「${label}」`)
  button.props.onClick()
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

// ---- 浏览器环境桩 --------------------------------------------------------

function makeEnv({ fetchImpl = () => Promise.reject(new Error('不该联网')), toggles } = {}) {
  const styleTags = []
  const mapStorage = () => {
    const map = new Map()
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) }
  }
  const document = {
    documentElement: { lang: 'zh-CN' },
    querySelector: (selector) => styleTags.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
    createElement: (tag) => ({ tag, dataset: {}, textContent: '', remove() {} }),
    head: { appendChild: (node) => styleTags.push(node) },
  }
  let captured = null
  const window = { __ModuleLoader__: { load: (def) => { captured = def } } }
  const localStorage = mapStorage()
  if (toggles !== undefined) localStorage.setItem('dsh.deepseekWeb.toggles.v1', JSON.stringify(toggles))
  return {
    window, document, styleTags,
    localStorage, sessionStorage: mapStorage(),
    fetch: fetchImpl, console,
    definition: () => captured,
  }
}

function runClient(env, React) {
  const source = readFileSync(SRC, 'utf8')
  new Function('window', 'document', 'localStorage', 'sessionStorage', 'fetch', 'console', source)(
    env.window, env.document, env.localStorage, env.sessionStorage, env.fetch, env.console,
  )
  const def = env.definition()
  const require = (specifier) => {
    if (specifier === 'react') return React
    throw new Error('未知模块表条目: ' + specifier)
  }
  return { def, plugin: def.factory(require) }
}

function localeFace(records) {
  return {
    register(ns, dict) { records.locales.push({ ns, langs: Object.keys(dict) }); records.dicts[ns] = dict; return () => {} },
    bind(ns) {
      return (key, params) => {
        let text = records.dicts[ns]?.zh?.[key] ?? key
        if (params !== undefined) for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v))
        return text
      }
    },
  }
}

const jsonRes = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** 一个能回答面板所有路由的 fetch 桩（Phase 1 的数据流：/status → /sessions → /session/messages）。 */
function panelFetch(options = {}) {
  const status = options.status ?? { ok: true, configured: true, tokenValid: true }
  const sessions = options.sessions ?? []
  const messages = options.messages ?? []
  const overrides = options.overrides ?? {}
  return async (url, init) => {
    const target = String(url)
    for (const [fragment, reply] of Object.entries(overrides)) {
      if (target.includes(fragment)) return typeof reply === 'function' ? reply(url, init) : jsonRes(reply)
    }
    if (target.includes('/status')) return jsonRes(status)
    if (target.includes('/session/messages')) {
      // 标题与列表一致：面板会用这里返回的标题覆盖列表项（真实接口里这才是权威标题）
      return jsonRes({ ok: true, session: { id: 's1', title: '今天问的' }, messages })
    }
    if (target.includes('/sessions')) return jsonRes({ ok: true, sessions, hasMore: false })
    if (target.includes('/config')) return jsonRes({ ok: true })
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  }
}

/** 挂载面板，并反复 drain+tick+render 让「拉会话 → 拉消息」两轮异步都落地。 */
async function mountPanel(options = {}) {
  const env = makeEnv({ fetchImpl: panelFetch(options), toggles: options.toggles })
  const runtime = createRuntime()
  const run = runClient(env, runtime.React)
  const records = { slots: [], locales: [], effects: [], dicts: {} }
  let main = null
  run.plugin.apply({
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    get: (name) => (name === 'locale' ? localeFace(records) : undefined),
    slots: { inject: (k, cb) => { cb(); return () => {} }, register: (o, component) => { if (o.name === 'main') main = { ...o, component }; return () => {} } },
  })
  const face = main.inject()
  const element = runtime.React.createElement(main.component, { ...face })
  const panel = {
    env, runtime, face, records,
    render: () => runtime.mount(element),
    drain: runtime.drain,
    async settle(rounds = 5) {
      let tree = runtime.mount(element)
      for (let i = 0; i < rounds; i += 1) {
        runtime.drain()
        await tick()
        tree = runtime.mount(element)
      }
      return tree
    },
  }
  return panel
}

const now = Math.floor(Date.now() / 1000)
// 分组是按**日历天**算的，所以"昨天"必须落在昨天的日历天里（用"今天 00:00 减 12 小时"= 昨天中午），
// 不能写成 now-1.5天 —— 凌晨跑的时候那会落到前天，断言就会假失败。
const startOfToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() / 1000
const SESSIONS = [
  { id: 's1', title: '今天问的', updatedAt: now - 60, pinned: false, modelType: 'default' },
  { id: 's2', title: '昨天问的', updatedAt: startOfToday - 43200, pinned: false, modelType: 'default' },
  { id: 's3', title: '上周问的', updatedAt: startOfToday - 86400 * 4, pinned: false, modelType: 'default' },
  { id: 's4', title: '很久以前', updatedAt: startOfToday - 86400 * 40, pinned: false, modelType: 'default' },
  { id: 's5', title: '钉住的', updatedAt: startOfToday - 86400 * 40, pinned: true, modelType: 'default' },
]
const MESSAGES = [
  { role: 'user', content: '介绍一下 **DSH**' },
  {
    role: 'assistant',
    blocks: [
      { kind: 'thinking', text: '先想了一下', secs: 0 },
      { kind: 'answer', text: '看这段：\n```js\nconst a = 1\n```\n**结论**：就是这样' },
    ],
    refs: [],
  },
]

// 用户那条真实答案的形状：交错块（思考→搜索→思考→浏览→答案）+ markdown + [reference:N] 角标
const RICH_MESSAGE = {
  role: 'assistant',
  refs: [{ id: 5, type: 'TOOL_OPEN' }, { id: 6, type: 'TOOL_OPEN' }],
  blocks: [
    { kind: 'thinking', text: '用户想知道潍坊今天的天气情况和风力大小。', secs: 0.5 },
    {
      kind: 'search', id: 3, label: 'Found 25 web pages', queries: ['潍坊 天气', '潍坊 风力'], resultCount: 25,
      results: [{ url: 'https://www.nmc.cn/x', title: '潍坊-天气预报', siteName: '中央气象台' }],
    },
    { kind: 'thinking', text: '搜索结果显示了一些相关条目，我们需要同时打开这些结果。', secs: 0.2 },
    { kind: 'source', id: 5, url: 'https://www.nmc.cn/x', title: '潍坊-天气预报', siteName: '中央气象台' },
    { kind: 'source', id: 6, url: 'https://www.weather.com.cn/y', title: '大风蓝色预警', siteName: '天气网' },
    {
      kind: 'answer',
      text: [
        '潍坊今天（9月30日）天气**多云**，气温12℃~23℃[reference:0][reference:1]。',
        '',
        '### ☀️ 天气详情',
        '',
        '*   天气状况：多云',
        '*   气温范围：12℃ ~ 23℃',
        '',
        '| 项目 | 数值 |',
        '| --- | --- |',
        '| 气温 | 12℃ |',
        '| 风力 | 4~5级 |',
        '',
        '---',
        '',
        '> 提示：风大',
        '',
        '1. 第一步',
        '2. 第二步',
      ].join('\n'),
    },
  ],
}

// ================= 1) 插件对象与槽位注册 =================
console.log('\n=== 1) factory / apply / 槽位注册 ===')
const records = { slots: [], locales: [], effects: [], dicts: {} }
const env1 = makeEnv()
const { def, plugin } = runClient(env1, createRuntime().React)
check('__ModuleLoader__.load 的 id 正确', def.id === '@local/dsh-deepseek-web', def.id)
check('插件声明 inject: [slots]', JSON.stringify(plugin.inject) === '["slots"]', JSON.stringify(plugin.inject))

let threw = null
try {
  plugin.apply({
    effect(fn, label) { records.effects.push(label ?? 'anon'); const d = fn(); return () => { if (typeof d === 'function') d() } },
    get: (name) => (name === 'locale' ? localeFace(records) : undefined),
    slots: {
      inject(key, callback) { records.slots.push({ kind: 'inject', key }); callback(); return () => {} },
      register(options, component) { records.slots.push({ kind: 'register', options, component }); return () => {} },
    },
  })
} catch (error) { threw = error }
check('apply 不抛异常（抛错会拖垮整个 Web shell 启动）', threw === null, threw === null ? '' : String(threw.message))
check('注册了自己的样式表', env1.styleTags.length === 1, JSON.stringify(env1.styleTags.map((t) => t.dataset.pluginCss)))
check('通过 locale 服务注册 zh + en 词典',
  records.locales.length === 1 && records.locales[0].langs.join(',') === 'zh,en', JSON.stringify(records.locales))
check('所有注册都走 ctx.effect（可干净卸载）', records.effects.length === 4, JSON.stringify(records.effects))

const sideEntry = records.slots.find((r) => r.kind === 'register' && r.options.name === 'sidebar.panellist')
const mainPanel = records.slots.find((r) => r.kind === 'register' && r.options.name === 'main')
check('注册了 sidebar.panellist 入口', sideEntry !== undefined, JSON.stringify(sideEntry?.options))
check('入口 id 与主面板 key 完全一致（不一致会「点了没反应」）',
  sideEntry?.options.id === mainPanel?.options.key, `${sideEntry?.options.id} vs ${mainPanel?.options.key}`)
check('label 是函数（切语言能刷新）', typeof sideEntry?.options.label === 'function' && sideEntry.options.label() === 'DeepSeek 网页版', sideEntry?.options.label?.())
check('先 inject 再 register（未声明的槽位直接 register 会抛错）',
  records.slots.map((r) => r.kind).join(',') === 'inject,register,inject,register',
  records.slots.map((r) => `${r.kind}:${r.key ?? r.options.name}`).join(' '))

// ================= 2) 渲染：会话栏 + 对话区 =================
console.log('\n=== 2) 渲染组件树（会话栏 / 分组 / 多选 / 重命名 / 删除确认） ===')

// 2a 空态
const a = await mountPanel({ sessions: [], messages: [] })
const treeA = await a.settle()
check('空态渲染不抛异常', treeA !== null)
check('空态显示「暂无历史对话」与对话区提示',
  allText(treeA).includes('暂无历史对话') && allText(treeA).includes('还没有对话'), allText(treeA).slice(0, 80))
check('头部含两个开关与设置', ['深度思考', '联网搜索', '设置'].every((s) => allText(treeA).includes(s)))

// 2b 状态点三态
const b = await mountPanel({ status: { ok: true, configured: false }, sessions: [] })
const treeBad = await b.settle()
check('未配置 token 时状态点变 bad',
  find(treeBad, (n) => n.props?.['data-dsw-dot'] !== undefined)[0]?.props['data-dsw-dot'] === 'bad')
const c = await mountPanel({ status: { ok: true, configured: true, tokenValid: false }, sessions: [] })
const treeInvalid = await c.settle()
check('token 无效时状态点变 bad',
  find(treeInvalid, (n) => n.props?.['data-dsw-dot'] !== undefined)[0]?.props['data-dsw-dot'] === 'bad')

// 2c 会话分组
const d = await mountPanel({ sessions: SESSIONS, messages: MESSAGES })
const treeD = await d.settle()
const groups = find(treeD, (n) => n.props?.['data-dsw-group'] !== undefined).map((n) => allText(n))
check('★ 会话按 置顶/今天/昨天/7天内/更早 分组', ['置顶', '今天', '昨天', '7 天内', '更早'].every((g) => groups.includes(g)),
  JSON.stringify(groups))
check('会话标题都渲染出来', ['今天问的', '昨天问的', '上周问的', '很久以前', '钉住的'].every((s) => allText(treeD).includes(s)))
check('置顶会话带 ★ 标记', find(treeD, (n) => n.props?.['data-dsw-session-pin'] !== undefined).length === 1)
check('侧栏底部显示会话总数', allText(treeD).includes('共 5 个对话'))
check('自动选中第一个会话（data-dsw-session=active 只应有一个）',
  find(treeD, (n) => n.props?.['data-dsw-session'] === 'active').length === 1)

// 2d 服务端消息渲染成对话
check('用户消息原样渲染（不做 markdown）', allText(treeD).includes('介绍一下 **DSH**'))
check('助手消息渲染', allText(treeD).includes('就是这样'))
check('代码块渲染成 <pre><code>', find(treeD, (n) => n.tag === 'pre').length === 1)
check('代码块内容正确', find(treeD, (n) => n.tag === 'pre').map((n) => allText(n)).join('') === 'const a = 1')
check('粗体解析成 <strong>', find(treeD, (n) => n.tag === 'strong').some((n) => allText(n) === '结论'))
check('★ 思考块带「深度思考」标签且默认展开', (() => {
  const details = find(treeD, (n) => n.tag === 'details')[0]
  return details !== undefined && details.props.open === true && allText(details).includes('深度思考')
})())
check('★ 有思考时答案带「回答」标签', (() => {
  const labels = find(treeD, (n) => n.props?.['data-dsw-label'] !== undefined)
  return labels.length === 1 && allText(labels[0]) === '回答'
})())

// 2d-2 富文本：标题 / 列表 / 引用 / 分割线 / 引用角标 / 搜索卡 / 思考耗时
const rich = await mountPanel({ sessions: SESSIONS, messages: [RICH_MESSAGE] })
const treeRich = await rich.settle()
check('★ markdown 标题渲染成 <h4>（不是字面量 ###）',
  find(treeRich, (n) => n.tag === 'h4').length === 1 && allText(find(treeRich, (n) => n.tag === 'h4')[0]).includes('天气详情'))
check('★ 无序列表渲染成 <ul><li>', find(treeRich, (n) => n.tag === 'ul').length === 1
  && find(treeRich, (n) => n.tag === 'li').length === 4, `ul=${find(treeRich, (n) => n.tag === 'ul').length} li=${find(treeRich, (n) => n.tag === 'li').length}`)
check('★ 有序列表渲染成 <ol>', find(treeRich, (n) => n.tag === 'ol').length === 1)
check('引用块与分割线', find(treeRich, (n) => n.tag === 'blockquote').length === 1 && find(treeRich, (n) => n.tag === 'hr').length === 1)
check('★ [reference:N] 是**真链接**（之前是只有 title 的 <sup>，所以点不动）', (() => {
  const chips = find(treeRich, (n) => n.props?.['data-dsw-cite'] !== undefined)
  if (chips.length !== 2) return false
  if (!chips.every((n) => n.tag === 'a' && String(n.props.href ?? '').startsWith('http'))) return false
  const titles = chips.map((n) => String(n.props.title ?? ''))
  return titles[0].includes('潍坊-天气预报') && titles[1].includes('大风蓝色预警')
})(), JSON.stringify(find(treeRich, (n) => n.props?.['data-dsw-cite'] !== undefined).map((n) => `${n.tag}:${n.props.href ?? '-'}`)))
check('角标序号是 1 起（不是 0）',
  find(treeRich, (n) => n.props?.['data-dsw-cite'] !== undefined).map((n) => allText(n)).join(',') === '1,2')
check('★ 块按片段原顺序交错渲染（思考→搜索→思考→浏览→答案）', (() => {
  const bubble = find(treeRich, (n) => n.props?.['data-dsw-msg'] === 'assistant')[0]
  if (bubble === undefined) return false
  const mark = (node) => {
    if (node.props?.['data-dsw-think'] !== undefined) return 'think'
    if (node.props?.['data-dsw-search'] !== undefined) return 'search'
    if (node.props?.['data-dsw-browse'] !== undefined) return 'browse'
    if (node.props?.['data-dsw-answer'] !== undefined) return 'answer'
    return null
  }
  return bubble.children.map(mark).filter(Boolean).join('>') === 'think>search>think>browse>answer'
})(), (() => {
  const bubble = find(treeRich, (n) => n.props?.['data-dsw-msg'] === 'assistant')[0]
  return bubble === undefined ? '' : bubble.children.map((n) => n.props?.['data-dsw-think'] !== undefined ? 'think' : n.props?.['data-dsw-search'] !== undefined ? 'search' : n.props?.['data-dsw-browse'] !== undefined ? 'browse' : n.props?.['data-dsw-answer'] !== undefined ? 'answer' : '-').join('>')
})())
check('★ 搜索卡是一行「搜索到 N 个网页（点这里展开）」',
  allText(treeRich).includes('搜索到 25 个网页') && allText(treeRich).includes('点这里展开'), allText(treeRich).slice(0, 50))
check('★ 浏览的页面归成一组，标题「浏览 2 个页面」', allText(treeRich).includes('浏览 2 个页面'))
check('来源行是可见的链接（主色 + 外链箭头由 CSS 给）', (() => {
  const rows = find(treeRich, (n) => n.props?.['data-dsw-sourcerow'] !== undefined)
  if (rows.length < 2) return false
  const links = rows.flatMap((row) => find(row, (n) => n.tag === 'a'))
  return links.length >= 2 && links.every((n) => String(n.props.href ?? '').startsWith('http'))
})())
check('★ 两个思考段各自带自己的耗时', (() => {
  const sums = find(treeRich, (n) => n.tag === 'summary').map((n) => allText(n))
  return sums.some((s) => s.includes('0.5 秒')) && sums.some((s) => s.includes('0.2 秒'))
})(), find(treeRich, (n) => n.tag === 'summary').map((n) => allText(n)).join(' | ').slice(0, 100))
check('加粗仍渲染成 <strong>', find(treeRich, (n) => n.tag === 'strong').some((n) => allText(n) === '多云'))
check('★ markdown 表格渲染成 <table>（之前整张表被当纯文本，看到一堆竖线）', (() => {
  const tables = find(treeRich, (n) => n.tag === 'table')
  const ths = find(treeRich, (n) => n.tag === 'th')
  const tds = find(treeRich, (n) => n.tag === 'td')
  return tables.length === 1 && ths.length === 2 && tds.length === 4
    && allText(ths[0]) === '项目' && allText(tds[0]) === '气温'
})(), 'table=' + find(treeRich, (n) => n.tag === 'table').length + ' th=' + find(treeRich, (n) => n.tag === 'th').length + ' td=' + find(treeRich, (n) => n.tag === 'td').length)
check('表格套了可横向滚动的容器（宽表不撑破面板）',
  find(treeRich, (n) => n.props?.['data-dsw-table'] !== undefined).length === 1)

// 2d-3 搜索结果必须**全部**显示（曾经写死只带 12 条）
const MANY = 25
const allResults = await mountPanel({
  sessions: SESSIONS,
  messages: [{
    role: 'assistant',
    refs: [],
    blocks: [
      {
        kind: 'search', id: 3, label: 'Found 25 web pages', queries: ['潍坊 天气'], resultCount: MANY,
        results: Array.from({ length: MANY }, (_, i) => ({
          url: 'https://example.com/' + i, title: '第 ' + (i + 1) + ' 条结果', siteName: '某站',
        })),
      },
      { kind: 'answer', text: '共 25 条' },
    ],
  }],
})
const treeMany = await allResults.settle()
check('★ 搜索结果的 ' + MANY + ' 条全部渲染（不截断）',
  find(treeMany, (n) => n.props?.['data-dsw-sourcerow'] !== undefined).length === MANY,
  '实际渲染 ' + find(treeMany, (n) => n.props?.['data-dsw-sourcerow'] !== undefined).length + ' 条')

// 2e 侧栏交互：⋯ 菜单 → 重命名
const e = await mountPanel({ sessions: SESSIONS, messages: MESSAGES })
let treeE = await e.settle()
find(treeE, (n) => n.props?.['data-dsw-icon-btn'] !== undefined && allText(n) === '⋯')[0].props.onClick({ stopPropagation() {} })
treeE = e.render()
check('点 ⋯ 出现重命名/置顶/删除菜单',
  allText(treeE).includes('重命名') && allText(treeE).includes('置顶') && allText(treeE).includes('删除'))
clickByText(treeE, '重命名')
treeE = e.render()
check('进入重命名态后出现输入框（草稿=被点那条的标题，注意首个 ⋯ 属于置顶组）',
  find(treeE, (n) => n.tag === 'input' && SESSIONS.some((s) => s.title === n.props.value)).length === 1,
  JSON.stringify(find(treeE, (n) => n.tag === 'input').map((n) => n.props.value)))

// 2f 多选与批量操作
const f = await mountPanel({ sessions: SESSIONS, messages: MESSAGES })
let treeF = await f.settle()
clickByText(treeF, '多选')
treeF = f.render()
check('多选模式出现勾选框', find(treeF, (n) => n.tag === 'input' && n.props.type === 'checkbox').length >= 5)
check('多选模式显示「已选 0 / 99」', allText(treeF).includes('已选 0 / 99'), allText(treeF).slice(0, 60))
check('未选中时批量按钮禁用',
  find(treeF, (n) => n.tag === 'button' && allText(n) === '批量置顶')[0]?.props.disabled === true)
// 勾选两个会话
const clickable = find(treeF, (n) => n.props?.['data-dsw-session'] !== undefined)
clickable[0].props.onClick()
clickable[1].props.onClick()
treeF = f.render()
check('勾选后计数更新且按钮可用',
  allText(treeF).includes('已选 2 / 99')
    && find(treeF, (n) => n.tag === 'button' && allText(n) === '批量置顶')[0]?.props.disabled === false,
  allText(treeF).slice(0, 60))

// 2g 删除二次确认
clickByText(treeF, '批量删除')
treeF = f.render()
check('★ 删除前出现不可恢复警示与确认按钮',
  allText(treeF).includes('删除后不可恢复') && find(treeF, (n) => n.tag === 'button' && allText(n) === '删除').length >= 1,
  allText(treeF).slice(-70))
check('确认条可取消', find(treeF, (n) => n.tag === 'button' && allText(n) === '取消').length === 1)

// 2h 加载失败态
const g = await mountPanel({ overrides: { '/sessions': { ok: false, message: '接口挂了' } } })
const treeG = await g.settle()
check('会话加载失败时显示失败态与重试', allText(treeG).includes('加载失败') && allText(treeG).includes('重试'))
check('失败原因透出到提示条', allText(treeG).includes('接口挂了'), allText(treeG).slice(0, 70))

// 2j 深度思考/联网搜索：按对话记忆 + 跨重启保留
const t1 = await mountPanel({ sessions: SESSIONS, messages: MESSAGES })
let treeT = await t1.settle()
const chipBoxes = () => find(treeT, (n) => n.tag === 'input' && n.props.type === 'checkbox')
check('默认两个勾选都是关的', chipBoxes().every((n) => n.props.checked === false), JSON.stringify(chipBoxes().map((n) => n.props.checked)))
chipBoxes()[0].props.onChange({ target: { checked: true } })
chipBoxes()[1].props.onChange({ target: { checked: true } })
treeT = t1.render()
check('勾上后状态更新', chipBoxes().every((n) => n.props.checked === true))
const stored = JSON.parse(t1.env.localStorage.getItem('dsh.deepseekWeb.toggles.v1') ?? '{}')
check('★ 勾选写进了本机存储（关掉软件也在）', stored.__default?.thinking === true && stored.__default?.search === true, JSON.stringify(stored).slice(0, 120))
check('★ 勾选是按对话存的（记在该会话 id 下）', stored.s1?.thinking === true, JSON.stringify(Object.keys(stored)))
// 换一条会话：应读回"那条会话自己的"记录，而不是沿用刚才的
const t2 = await mountPanel({ sessions: SESSIONS, messages: MESSAGES, toggles: { __default: { thinking: false, search: false }, s1: { thinking: true, search: true }, s2: { thinking: false, search: false } } })
const treeT2 = await t2.settle()
check('★ 切到某条会话时读回它自己的勾选（s1 记为开 → 显示开，尽管默认是关）', (() => {
  const boxes = find(treeT2, (n) => n.tag === 'input' && n.props.type === 'checkbox')
  return boxes.length === 2 && boxes.every((n) => n.props.checked === true)
})(), JSON.stringify(find(treeT2, (n) => n.tag === 'input' && n.props.type === 'checkbox').map((n) => n.props.checked)))

// 2i 设置视图
const h2 = await mountPanel({ sessions: SESSIONS, messages: MESSAGES })
let treeH = await h2.settle()
clickByText(treeH, '设置')
treeH = h2.render()
check('设置页可进入且有手机号输入框', allText(treeH).includes('登录 token') && find(treeH, (n) => n.tag === 'input' && n.props.type === 'tel').length === 1)
check('设置页把「先去官网拿码」写成第 1 步', allText(treeH).includes('第 1 步'))
check('token 输入框是 password 类型', find(treeH, (n) => n.tag === 'input' && n.props.type === 'password').length === 1)
check('验证码为空时「登录」禁用', find(treeH, (n) => n.tag === 'button' && allText(n) === '登录')[0]?.props.disabled === true)

// ================= 3) 前端 SSE 解析 =================
console.log('\n=== 3) 前端 SSE 解析（EventSource 不能 POST，所以是手写的） ===')
const sseResponse = (frames) => {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close() },
  }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

const api = (await mountPanel({ overrides: {
  '/chat': () => sseResponse([
    'event: meta\ndata: {"requestId":"r1","sessionId":"sess-9"}\n\n',
    'event: thinking\ndata: {"text":"思考A"}\n\n',
    'event: delta\ndata: {"text":"你"}\n\n',
    'event: delta\ndata: {"text":"好"}\n\n',
    'event: done\ndata: {"sessionId":"sess-9"}\n\n',
  ]),
} })).face.api
const got = { meta: null, deltas: [], thinks: [] }
await api.chat({
  prompt: 'hi', onMeta: (m) => { got.meta = m },
  onDelta: (t) => got.deltas.push(t), onThinking: (t) => got.thinks.push(t),
})
check('meta 帧解析出 sessionId', got.meta?.sessionId === 'sess-9', JSON.stringify(got.meta))
check('delta 帧按到达顺序回调', got.deltas.join('') === '你好', JSON.stringify(got.deltas))
check('thinking 帧与正文分流', got.thinks.join('') === '思考A', JSON.stringify(got.thinks))

const apiErr = (await mountPanel({ overrides: {
  '/chat': () => sseResponse(['event: meta\ndata: {"sessionId":"s"}\n\n', 'event: error\ndata: {"code":"upstream","message":"上游 HTTP 429"}\n\n']),
} })).face.api
let caught = null
try { await apiErr.chat({ prompt: 'x', onMeta() {}, onDelta() {}, onThinking() {} }) } catch (error) { caught = error }
check('error 帧转成 reject 并保留原因', caught !== null && String(caught.message).includes('429'), String(caught?.message))

// ================= 4) 未挂载路由返回纯文本 not found =================
console.log('\n=== 4) 未挂载 /api/* 的纯文本容错 ===')
const api404 = (await mountPanel({ overrides: { '/status': () => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }) } })).face.api
let caught404 = null
try { await api404.status() } catch (error) { caught404 = error }
check('得到可读错误而不是 JSON 语法错',
  caught404 !== null && String(caught404.message).includes('not found') && !String(caught404.message).includes('Unexpected token'),
  String(caught404?.message))

console.log(`\n=== 结论：${failures === 0 ? '全部通过' : failures + ' 项未通过'} ===`)
process.exit(failures === 0 ? 0 : 1)
