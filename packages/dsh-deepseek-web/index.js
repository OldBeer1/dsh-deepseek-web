/**
 * DSH × DeepSeek 网页版 —— Host 半边。
 *
 * 职责：凭证保管（永不下发）、PoW 求解、把 chat.deepseek.com 的 SSE
 * 归一化成自己的事件流再转发给面板、提供 stop。
 *
 * 零依赖：只用 Node 内置模块 + 全局 fetch / WebAssembly。
 */
import { randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export const inject = ['webServer']

const NS = 'deepseek-web'
const API_PREFIX = '/api/deepseek-web'

const CHAT_BASE = 'https://chat.deepseek.com'
const STATIC_BASE = 'https://fe-static.deepseek.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// ---- 路径 / 配置 ---------------------------------------------------------

function dshHome() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const expanded = raw.trim().startsWith('~/')
      ? join(homedir(), raw.trim().slice(2))
      : raw.trim()
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(homedir(), '.dsh')
}

const DATA_DIR = join(dshHome(), NS)
const CONFIG_FILE = join(DATA_DIR, 'config.json')

const DEFAULT_CONFIG = {
  token: '',
  baseUrl: CHAT_BASE,
  thinking: false,
  search: false,
  wasmPath: '',
  requestTimeoutMs: 120000,
  // 登录相关：deviceId 首次使用时生成并复用（登录与后续请求应保持同一个设备身份）
  deviceId: '',
  mobile: '',
  areaCode: '+86',
}

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return { ...DEFAULT_CONFIG, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  const tmp = `${CONFIG_FILE}.tmp-${process.pid}`
  let fd
  try {
    fd = openSync(tmp, 'w', 0o600)
    writeFileSync(fd, JSON.stringify(next, null, 2), { encoding: 'utf8' })
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  try { chmodSync(tmp, 0o600) } catch { /* Windows 上由 ACL 决定 */ }
  renameSync(tmp, CONFIG_FILE)
  return next
}

// ---- HTTP 小工具 ---------------------------------------------------------

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

// ---- 信任守卫 ------------------------------------------------------------
// 权威性来自 socket 地址 + Host 头，浏览器标记只是第一道绊线（与参考实现一致）。
//
// 关键的一条：Desktop 窗口的页面来自 `dsh-app://app/`，外壳转发到 127.0.0.1 时
// **只带一个 `dsh-auth-` cookie，不带 sec-fetch-site / Origin**。少了这条判定，
// Desktop 里的面板会被自己人拒之门外（这正是参考实现设 BROWSER_AUTH_COOKIE_PREFIX 的原因）。
const BROWSER_AUTH_COOKIE_PREFIX = 'dsh-auth-'

function carriesBrowserAuthCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return false
  for (const part of cookieHeader.split(';')) {
    if (part.trim().startsWith(BROWSER_AUTH_COOKIE_PREFIX)) return true
  }
  return false
}

function isLoopbackAddress(address) {
  return typeof address === 'string' &&
    (address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'))
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '::1' ||
    hostname === '127.0.0.1' || hostname.startsWith('127.')
}

/**
 * 返回 undefined 表示可信；否则返回被拒的原因和当时看到的头部快照。
 * 之所以要回显原因：403 只写一句「仅允许本机同源访问」时，从面板里根本看不出
 * 是哪一条判定没过——这次就是这么被卡住的。
 */
function trustFailure(req) {
  const site = req.headers['sec-fetch-site']
  const origin = req.headers.origin
  const hasAuthCookie = carriesBrowserAuthCookie(req.headers.cookie)
  const host = String(req.headers.host ?? '').toLowerCase()
  const hostname = host === '' ? '' : (host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0])
  const seen = {
    site: typeof site === 'string' ? site : null,
    origin: typeof origin === 'string' ? origin : null,
    host: host === '' ? null : host,
    remote: typeof req.socket?.remoteAddress === 'string' ? req.socket.remoteAddress : null,
    authCookie: hasAuthCookie,
  }
  const fail = (reason) => ({ reason, seen })

  // 顺序有讲究：先排掉确定是攻击的形态，再认凭证。
  // 1) 跨站标记 —— 任何浏览器发起的跨站请求都带它，直接拒。
  if (site === 'cross-site') return fail('cross-site')
  // 2) Origin 与 Host 不一致 —— 伪造来源，拒。
  if (typeof origin === 'string' && origin !== 'null') {
    let originHost
    try { originHost = new URL(origin).host.toLowerCase() } catch { return fail('origin-unparsable') }
    if (originHost !== host) return fail('origin-host-mismatch')
  }
  // 3) 来源必须是本机。
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return fail('remote-socket')
  // 4) Desktop 外壳转发请求时只带 dsh-auth cookie，Host 头形态不做保证 ——
  //    这个 cookie 只有本机的 DSH 外壳才有，等价于一个共享密钥，所以认它即可，
  //    不再额外要求 Host 是环回（否则会因外壳怎么填 Host 而时灵时不灵）。
  if (hasAuthCookie) return undefined
  // 5) 其余情况（浏览器直连）走原来的完整判定。
  if (site !== 'same-origin' && typeof origin !== 'string') return fail('no-browser-marker')
  if (host === '') return fail('no-host')
  if (!isLoopbackHost(hostname)) return fail('non-loopback-host')
  return undefined
}

// ---- PoW 求解器 ----------------------------------------------------------

let powPromise

function getPow() {
  if (powPromise === undefined) {
    powPromise = loadPow().catch((error) => { powPromise = undefined; throw error })
  }
  return powPromise
}

/** 从官网首页 → main.*.js → wasm 文件名，三步发现（本机实测跑通）。 */
async function discoverWasmUrl() {
  const home = await fetch(`${CHAT_BASE}/`, { headers: { 'user-agent': UA } })
  const html = await home.text()
  const main = /(?:src|href)="([^"]*\/static\/main\.[0-9a-f]+\.js)"/.exec(html)
  if (main === null) throw new Error('无法在首页里找到 main.*.js（官网结构可能已变，见文档 7.3）')
  const mainUrl = main[1].startsWith('http') ? main[1] : `${CHAT_BASE}${main[1]}`
  const bundle = await (await fetch(mainUrl, { headers: { 'user-agent': UA } })).text()
  const wasm = /static\/(sha3_wasm_bg\.[0-9a-f]+\.wasm)/.exec(bundle)
  if (wasm === null) throw new Error(`无法在 ${mainUrl} 里找到 sha3_wasm_bg.*.wasm`)
  return { url: `${STATIC_BASE}/chat/static/${wasm[1]}`, file: wasm[1] }
}

async function loadWasmBytes(configuredPath) {
  if (typeof configuredPath === 'string' && configuredPath !== '' && existsSync(configuredPath)) {
    return readFileSync(configuredPath)
  }
  const { url, file } = await discoverWasmUrl()
  const cacheFile = join(DATA_DIR, file)
  if (existsSync(cacheFile)) return readFileSync(cacheFile)
  const response = await fetch(url, { headers: { 'user-agent': UA } })
  if (!response.ok) throw new Error(`下载 ${url} 失败：HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(cacheFile, bytes)
  try { chmodSync(cacheFile, 0o600) } catch { /* ignore */ }
  return bytes
}

async function loadPow() {
  const cfg = readConfig()
  const bytes = await loadWasmBytes(cfg.wasmPath)
  const { instance } = await WebAssembly.instantiate(bytes, {})
  const ex = instance.exports
  const memory = ex.memory
  const malloc = ex.__wbindgen_export_0
  const bump = ex.__wbindgen_add_to_stack_pointer
  const solve = ex.wasm_solve
  if (memory === undefined || malloc === undefined || bump === undefined || solve === undefined) {
    throw new Error('wasm 导出与预期不符（官网可能换了实现），导出为：' + Object.keys(ex).join(', '))
  }

  const writeString = (text) => {
    const data = new TextEncoder().encode(text)
    const pointer = malloc(data.length, 1)
    new Uint8Array(memory.buffer, pointer, data.length).set(data)
    return [pointer, data.length]
  }

  return {
    /** 返回 { answer, raw }；raw 是 16 字节返回槽的十六进制，便于诊断。 */
    solveChallenge(challenge) {
      const prefix = `${challenge.salt}_${challenge.expire_at}_`
      const ret = bump(-16)
      let raw
      let status
      let answer
      try {
        const [cp, cl] = writeString(challenge.challenge)
        const [pp, pl] = writeString(prefix)
        solve(ret, cp, cl, pp, pl, challenge.difficulty)
        const view = new DataView(memory.buffer)
        status = view.getInt32(ret, true)
        answer = view.getFloat64(ret + 8, true)
        raw = Buffer.from(new Uint8Array(memory.buffer, ret, 16)).toString('hex')
      } finally {
        bump(16)
      }
      if (status === 0 || !Number.isFinite(answer)) {
        throw new Error(
          `PoW 求解未产出答案（status=${status} answer=${answer} raw=${raw}）。` +
          '若 raw 前 4 字节非零，说明返回槽读法与官网实现不同——' +
          '用 tools/selfcheck.mjs 打印原始字节后修正 index.js 里的 solveChallenge。',
        )
      }
      return { answer, raw, prefix }
    },
  }
}

// ---- DeepSeek 网页端客户端 ----------------------------------------------

function authHeaders(token) {
  const headers = {
    'content-type': 'application/json',
    accept: '*/*',
    'user-agent': UA,
    origin: CHAT_BASE,
    referer: `${CHAT_BASE}/`,
  }
  // 登录链路的接口是「未登录」状态调的，带一个空的 Bearer 反而会被判无效 token。
  if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
  return headers
}

/**
 * 业务码在 body 里，HTTP 200 也可能是错误；429 的失败形态是 HTML。
 *
 * acceptBizCodes：某些接口的「非 0 biz_code」其实是成功。最典型的是
 * login_by_mobile_sms —— 官方枚举里 OK=0（新账号注册成功）、
 * LOGIN_TO_EXISTING_ACCOUNT=1（已有账号登录成功），官网把 1 也当成功处理
 * （它的代码里就是 case LOGIN_TO_EXISTING_ACCOUNT: → signInOk "验证码登录成功"）。
 * 不知道这一点就会把一次成功的登录当成失败，然后把已经拿到的 token 丢掉。
 */
async function readBiz(response, path, acceptBizCodes) {
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  // 必须失败在非 2xx 上：FastAPI 的参数校验错是 HTTP 422 + {"detail":[...]}，
  // 里面既没有 code 也没有 biz_code —— 只查那两个字段会把「参数被拒」当成成功，
  // 然后向用户报「验证码已发出」。这个 bug 真的发生过。
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path} 请求被拒：${text.slice(0, 200)}`)
  }
  if (!contentType.includes('json')) {
    throw new Error(
      `HTTP ${response.status} 非 JSON 响应（很可能是风控拦截页）：${text.slice(0, 200)}`,
    )
  }
  const payload = JSON.parse(text)
  const code = payload?.code
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`接口 ${path} 返回 code=${code} msg=${payload?.msg ?? ''}`)
  }
  const biz = payload?.data
  if (biz !== null && typeof biz === 'object' && typeof biz.biz_code === 'number' && biz.biz_code !== 0) {
    const accepted = Array.isArray(acceptBizCodes) && acceptBizCodes.includes(biz.biz_code)
    if (!accepted) {
      throw new Error(`接口 ${path} 返回 biz_code=${biz.biz_code} biz_msg=${biz.biz_msg}`)
    }
  }
  return payload?.data ?? payload
}

async function callJson(path, token, body, signal, extraHeaders, acceptBizCodes) {
  const response = await fetch(`${CHAT_BASE}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(token), ...(extraHeaders ?? {}) },
    body: JSON.stringify(body),
    signal,
  })
  return await readBiz(response, path, acceptBizCodes)
}

/**
 * GET 版本。注意 history_messages 的 cache_version / cache_reset_at：
 * 官网在未知时传 null，但作为 **query 参数** 传字符串 "null" 会被服务端拒
 * （实测：`Failed to deserialize query string: cache_version: invalid digit found in string`）。
 * 所以未知参数一律**省略**，不要传 null。
 */
async function callGet(token, path, query, signal) {
  const url = new URL(`${CHAT_BASE}${path}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  const response = await fetch(url, { headers: authHeaders(token), signal })
  return await readBiz(response, path)
}

/** 把官方登录错误码翻成人话（枚举取自官方 bundle 的 LOGIN_BY_MOBILE_SMS_ERROR_CODE）。 */
const LOGIN_ERROR_TEXT = {
  ACCOUNT_BANNED: '这个账号被官方封禁了。',
  ONLY_SUPPORT_REGISTER_FROM_MAINLAND: '官方只支持中国大陆手机号注册。',
  SMS_EXPIRED: '验证码已过期，请重新获取一个。',
  SMS_VERIFY_FAILED: '验证码不对，请重新输入。',
  MOBILE_VERIFY_TOO_MANY_ATTEMPTS: '尝试次数过多，请过一会儿再试。',
  RISK_DEVICE_DETECTED: '官方判定当前设备身份有风险。重试一次；再不行就用附录 A 的办法手工复制 token。',
  TEMP_DISABLED_IN_THIS_CHANNEL: '此登录通道被官方临时关闭了。',
}

function explainLoginError(message) {
  for (const [code, text] of Object.entries(LOGIN_ERROR_TEXT)) {
    if (message.includes(code)) return `${text}（原始错误：${message}）`
  }
  return message
}

/**
 * 取挑战。两条链路，字段名不同（本机实测确认）：
 *  - 聊天：POST /api/v0/chat/create_pow_challenge（要 token）→ biz_data.challenge
 *  - 登录：POST /api/v0/users/create_guest_challenge（**无需 token**）→ biz_data.guest_challenge
 * 实测：register / register_by_mobile / login_by_mobile_sms /
 * create_sms_verification_code / create_email_verification_code 这 5 个路径走 guest 挑战。
 */
async function fetchChallenge(token, targetPath) {
  const guest = typeof token !== 'string' || token === ''
  const path = guest ? '/api/v0/users/create_guest_challenge' : '/api/v0/chat/create_pow_challenge'
  const data = await callJson(path, token, { target_path: targetPath })
  const challenge = guest ? data?.biz_data?.guest_challenge : data?.biz_data?.challenge
  if (challenge === undefined || challenge === null) {
    throw new Error(`${path} 没有返回挑战（target=${targetPath}）：` + JSON.stringify(data).slice(0, 300))
  }
  return challenge
}

/**
 * 头名 + payload 是一对，**不能混用**（官方 bundle 里就是这样成对定义的，实测确认）：
 *   guest 挑战  → x-ds-guest-pow-response : {salt, answer}
 *   authed 挑战 → x-ds-pow-response       : {algorithm, challenge, salt, answer, signature, target_path}
 * 实测教训：登录接口用 guest 挑战，发错头名只会得到 40300 Missing Header ——
 * 而"Missing Header"看起来像缺个无关紧要的头，很容易误判成别的问题。
 */
const POW_HEADER_GUEST = 'x-ds-guest-pow-response'
const POW_HEADER_AUTHED = 'x-ds-pow-response'

/**
 * 求解并构造 PoW 头。
 * 读法已用真挑战校准：返回槽 i32@+0 是状态（1=成功），f64@+8 是答案。
 * （实测原始字节 01000000000000000000000000002c40 → status=1, answer=14）
 */
async function buildPowHeader(challenge, targetPath, guest) {
  const pow = await getPow()
  const { answer } = pow.solveChallenge(challenge)
  const payload = guest === true
    ? { salt: challenge.salt, answer }
    : {
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer,
        signature: challenge.signature,
        target_path: challenge.target_path ?? targetPath,
      }
  return { name: guest === true ? POW_HEADER_GUEST : POW_HEADER_AUTHED, value: Buffer.from(JSON.stringify(payload)).toString('base64') }
}

/**
 * 像不像「PoW 头被拒」—— 用来决定要不要换一种头组合重试。
 *
 * 这里必须收窄：早先写成 /expire/ 时，`SMS_EXPIRED` 也会命中 → 每次验证码错误都会
 * 偷偷重发一次登录请求。而官方对验证码尝试次数是有限制的（MOBILE_VERIFY_TOO_MANY_ATTEMPTS），
 * 多打一次就等于把用户的尝试次数白白消耗掉一格。
 * 所以只认真正与 PoW 相关的措辞。
 */
function looksLikePowRejection(message) {
  return /missing header|invalid.{0,3}pow|pow.{0,12}(invalid|fail|expired)|invalid.{0,3}challenge|invalid.{0,3}signature/i.test(message)
}

/**
 * 带 PoW 的 POST。
 * 正常情况按挑战类型选对应的头名与 payload；万一以后官网又换了配对，
 * 只有错误看起来像 PoW 问题时才换另一组重试一次（自愈，不是主路径）。
 */
async function postWithPow(token, path, body, signal, acceptBizCodes) {
  const guest = typeof token !== 'string' || token === ''
  const attempt = async (useGuest) => {
    const challenge = await fetchChallenge(useGuest ? '' : token, path)
    const header = await buildPowHeader(challenge, path, useGuest)
    return await callJson(path, token, body, signal, { [header.name]: header.value }, acceptBizCodes)
  }
  try {
    return await attempt(guest)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (!looksLikePowRejection(message)) throw error
    try {
      return await attempt(!guest)
    } catch (second) {
      throw new Error(
        `PoW 头两种配对都被拒 —— 第一次：${message}；第二次：${String(second?.message ?? second)}`,
      )
    }
  }
}

/** 设备身份：生成一次并持久化，登录与后续请求复用同一个。 */
function ensureDeviceId() {
  const cfg = readConfig()
  if (typeof cfg.deviceId === 'string' && /^[0-9a-zA-Z]{16,64}$/.test(cfg.deviceId)) return cfg.deviceId
  const fresh = randomUUID().replace(/-/g, '')
  writeConfig({ deviceId: fresh })
  return fresh
}

async function createPowHeader(token, targetPath) {
  const challenge = await fetchChallenge(token, targetPath)
  return await buildPowHeader(challenge, targetPath, false)
}

async function createSession(token, signal) {
  const data = await callJson('/api/v0/chat_session/create', token, {}, signal)
  const biz = data?.biz_data ?? data
  const id = biz?.chat_session?.id ?? biz?.id ?? biz?.chat_session_id
  if (typeof id !== 'string' || id === '') {
    throw new Error('建会话响应里找不到 session id：' + JSON.stringify(data).slice(0, 300))
  }
  return id
}

// ---- 会话管理（Phase 1） -------------------------------------------------
// 端点与字段都经本机真机实测确认（见文档 §9.9）：
//   fetch_page      GET  ?count=N           → biz_data.{has_more, chat_sessions[]}
//   history_messages GET ?chat_session_id=  → biz_data.{chat_session, chat_messages[]}
//   update_title    POST {chat_session_id, title}
//   batch_update_pinned POST {chat_session_ids[], pinned}
//   chat_session/delete POST {chat_session_ids[]}；delete_all POST {}
//
// 实测限制：count 上限 100（传 200 直接返回 0 条）；游标参数
// （gte_cursor.* / lte_cursor.*，试过 6 种写法）**全部无效**，所以翻页只能靠加大 count。
const SESSION_PAGE_MAX = 100

function normalizeSession(raw) {
  const title = typeof raw?.title === 'string' && raw.title.trim() !== '' ? raw.title : '新对话'
  return {
    id: typeof raw?.id === 'string' ? raw.id : '',
    title,
    updatedAt: typeof raw?.updated_at === 'number' ? raw.updated_at : null,
    insertedAt: typeof raw?.inserted_at === 'number' ? raw.inserted_at : null,
    pinned: raw?.pinned === true,
    modelType: typeof raw?.model_type === 'string' ? raw.model_type : '',
  }
}

/**
 * 历史消息的片段数组 → 面板需要的全部内容。
 *
 * 实测的片段类型（一个联网搜索会话会全部出现）：
 *   REQUEST      用户输入
 *   THINK        推理，带 elapsed_secs（★ 思考耗时，历史里也持久化）
 *   TOOL_SEARCH  联网搜索：content="Found 25 web pages"、queries[]（实际搜的词）、results[]
 *   TOOL_OPEN    ★ 打开的网页：result.{url,title,snippet,site_name,site_icon,published_at}
 *   RESPONSE     答案；正文里含字面量 [reference:N]，而 references[N] **按下标**指回上面某条片段
 * 这里和流式的 normalizeFrame 是同一套语义，不要各写一份。
 */
function collectParts(fragments) {
  let request = ''
  let thinking = ''
  let answer = ''
  let thinkingSecs = 0
  const blocks = []
  const byId = {}
  let refs = []
  // 按片段顺序产出**有序块**：思考段 / 搜索卡 / 浏览的页面 / 答案 —— 与网页端的交错顺序一致。
  // 相邻的思考段合并成一块（官方也是把连续推理合成一段展示）。
  const pushThinking = (text, secs) => {
    if (text === '') return
    const last = blocks[blocks.length - 1]
    if (last !== undefined && last.kind === 'thinking') {
      last.text += text
      last.secs += secs
      return
    }
    blocks.push({ kind: 'thinking', text, secs })
  }
  for (const fragment of Array.isArray(fragments) ? fragments : []) {
    const type = String(fragment?.type ?? '')
    const content = typeof fragment?.content === 'string' ? fragment.content : ''
    const id = fragment?.id ?? null
    if (type === 'REQUEST') { request += content; continue }
    if (type.includes('THINK') || type === 'REASONING') {
      const secs = typeof fragment?.elapsed_secs === 'number' ? fragment.elapsed_secs : 0
      thinking += content
      thinkingSecs += secs
      pushThinking(content, secs)
      continue
    }
    if (type === 'RESPONSE') {
      answer += content
      if (Array.isArray(fragment?.references)) refs = fragment.references
      blocks.push({ kind: 'answer', text: content })
      continue
    }
    if (type === 'TOOL_SEARCH') {
      const queries = (Array.isArray(fragment?.queries) ? fragment.queries : [])
        .map((q) => (typeof q === 'string' ? q : q?.query))
        .filter((q) => typeof q === 'string' && q !== '')
      const results = Array.isArray(fragment?.results) ? fragment.results : []
      const card = {
        kind: 'search',
        id,
        label: content,
        queries,
        resultCount: results.length,
        results: results.slice(0, 12).map((r) => ({
          url: r?.url ?? '', title: r?.title ?? '', siteName: r?.site_name ?? '', snippet: r?.snippet ?? '',
        })),
      }
      blocks.push(card)
      if (id !== null) byId[String(id)] = card
      continue
    }
    if (type === 'TOOL_OPEN') {
      const result = fragment?.result ?? {}
      const card = {
        kind: 'source',
        id,
        url: result.url ?? '',
        title: result.title ?? '',
        siteName: result.site_name ?? '',
        snippet: result.snippet ?? '',
      }
      blocks.push(card)
      if (id !== null) byId[String(id)] = card
    }
  }
  return { request, thinking, answer, thinkingSecs, blocks, refs, byId }
}

async function listSessions(token, count, signal) {
  const size = Math.min(Math.max(Number(count) || 50, 1), SESSION_PAGE_MAX)
  const data = await callGet(token, '/api/v0/chat_session/fetch_page', { count: size }, signal)
  const biz = data?.biz_data ?? data
  const raw = Array.isArray(biz?.chat_sessions) ? biz.chat_sessions : []
  return { sessions: raw.map(normalizeSession), hasMore: biz?.has_more === true, count: size }
}

async function loadMessages(token, sessionId, signal) {
  const data = await callGet(token, '/api/v0/chat/history_messages', { chat_session_id: sessionId }, signal)
  const biz = data?.biz_data ?? data
  const header = biz?.chat_session ?? {}
  const raw = Array.isArray(biz?.chat_messages) ? biz.chat_messages : []
  const messages = raw.map((item) => {
    const parts = collectParts(item?.fragments)
    const isUser = String(item?.role ?? '').toUpperCase() === 'USER'
    return {
      id: item?.message_id ?? null,
      parentId: item?.parent_id ?? null,
      role: isUser ? 'user' : 'assistant',
      content: isUser ? parts.request : parts.answer,
      thinking: isUser ? '' : parts.thinking,
      thinkingSecs: isUser ? 0 : parts.thinkingSecs,
      blocks: isUser ? [] : parts.blocks,
      refs: isUser ? [] : parts.refs,
      byId: isUser ? {} : parts.byId,
      status: typeof item?.status === 'string' ? item.status : '',
      feedback: item?.feedback ?? null,
      insertedAt: typeof item?.inserted_at === 'number' ? item.inserted_at : null,
      thinkingEnabled: item?.thinking_enabled === true,
      banRegenerate: item?.ban_regenerate === true,
      banEdit: item?.ban_edit === true,
    }
  }).filter((message) => message.content !== '' || message.thinking !== '')
  return { session: normalizeSession({ id: sessionId, ...header }), messages }
}

async function renameSession(token, sessionId, title, signal) {
  await callJson('/api/v0/chat_session/update_title', token, { chat_session_id: sessionId, title }, signal)
  return { id: sessionId, title }
}

async function pinSessions(token, ids, pinned, signal) {
  const data = await callJson('/api/v0/chat_session/batch_update_pinned', token, {
    chat_session_ids: ids, pinned: pinned === true,
  }, signal)
  const biz = data?.biz_data ?? data
  // 字段名没有实测样本（我没到过置顶上限），两种拼法都认
  const illegal = biz?.illegal_chat_session_ids ?? biz?.illegalChatSessionIds
  return { illegal: Array.isArray(illegal) ? illegal : [] }
}

async function deleteSessions(token, ids, signal) {
  await callJson('/api/v0/chat_session/delete', token, { chat_session_ids: ids }, signal)
  return { deleted: ids }
}

async function deleteAllSessions(token, signal) {
  await callJson('/api/v0/chat_session/delete_all', token, {}, signal)
  return { ok: true }
}

/**
 * 把一个上游 SSE `data:` 帧归一化成 [{kind:'delta'|'thinking', text}]。
 *
 * 真实帧形状（本机抓真实流确认，不是猜的）：
 *   1) { v: { response: { fragments: [ {id,type:'THINK',content} ] } } }   快照：宣布片段及其类型
 *   2) { v: [ {id,type:'RESPONSE',content:'2'} ] }                         数组：新片段整体到达
 *      同一数组里还会混着 {p:'accumulated_token_usage',v:67} 这类元数据补丁，要跳过。
 *   3) { p:'response/fragments/-1/content', o:'APPEND', v:'文本' }          JSON-Patch 增量
 *   4) { v: '文本' }                                                        纯串增量
 *
 * 第 4 种是之前的致命 bug：它**不自带目标**，我当时把所有纯串增量都当成正文，
 * 于是整段推理被拼进了答案里 —— 真实流里推理恰恰就是这样一格一格来的，
 * 而答案是以第 2 种形态**整体**到达的（被当时的我直接忽略了，等于答案丢失）。
 * 正确做法：跟着"当前片段"走 —— 谁最后被更新，增量就属于谁，再按它的 type 分流。
 * 而路径里的 /-1/ 指"最后一个片段"，此刻它往往正是 THINK 片段。
 */
function fragmentKind(type) {
  if (typeof type !== 'string' || type === '') return null
  if (type.includes('THINK') || type === 'REASONING') return 'thinking'
  if (type === 'RESPONSE') return 'delta'
  return null
}

const makeStreamState = () => ({ fragments: new Map(), order: [], currentId: null })

function makeEntry(id) {
  return {
    id, type: '', content: '', emitted: 0,
    elapsedSecs: null, status: '', queries: [], results: [], references: [], result: undefined,
    sentTime: false, sentSearch: false, sentSource: false, sentRefs: 0,
  }
}

/** 片段内容或元数据有了变化 → 产出给面板的事件（文本增量 + 搜索/来源/耗时/引用）。 */
function emitEntry(state, id, out) {
  const entry = state.fragments.get(String(id))
  if (entry === undefined) return
  const chunk = entry.content.slice(entry.emitted)
  entry.emitted = entry.content.length
  const kind = fragmentKind(entry.type)
  if (kind !== null && chunk !== '') out.push({ kind, text: chunk, fragmentId: entry.id })

  if (entry.type.includes('THINK') && entry.sentTime !== true && typeof entry.elapsedSecs === 'number') {
    entry.sentTime = true
    out.push({ kind: 'thinking-time', fragmentId: entry.id, elapsedSecs: entry.elapsedSecs })
  }
  if (entry.type === 'TOOL_SEARCH' && entry.sentSearch !== true && entry.status === 'FINISHED') {
    entry.sentSearch = true
    out.push({
      kind: 'search', fragmentId: entry.id, label: entry.content,
      queries: entry.queries, resultCount: entry.results.length,
      results: entry.results.slice(0, 12).map((r) => ({
        url: r?.url ?? '', title: r?.title ?? '', siteName: r?.site_name ?? '', snippet: r?.snippet ?? '',
      })),
    })
  }
  if (entry.type === 'TOOL_OPEN' && entry.sentSource !== true && entry.result !== undefined) {
    entry.sentSource = true
    const r = entry.result ?? {}
    out.push({
      kind: 'source', fragmentId: entry.id, url: r.url ?? '', title: r.title ?? '',
      siteName: r.site_name ?? '', snippet: r.snippet ?? '',
    })
  }
  if (entry.type === 'RESPONSE' && Array.isArray(entry.references) && entry.sentRefs !== entry.references.length) {
    entry.sentRefs = entry.references.length
    out.push({
      kind: 'refs', fragmentId: entry.id,
      references: entry.references.map((r) => ({ id: r?.id ?? null, type: r?.type ?? '' })),
    })
  }
}

/** 整量片段（快照里的 / APPEND 进来的）。 */
function upsertFragment(state, raw, out) {
  if (raw === null || typeof raw !== 'object') return
  const key = String(raw.id ?? `anon:${state.order.length}`)
  let entry = state.fragments.get(key)
  if (entry === undefined) {
    entry = makeEntry(raw.id ?? null)
    state.fragments.set(key, entry)
    state.order.push(key)
  }
  if (typeof raw.type === 'string' && raw.type !== '') entry.type = raw.type
  if (typeof raw.content === 'string' && raw.content.length >= entry.emitted) entry.content = raw.content
  if (typeof raw.elapsed_secs === 'number') entry.elapsedSecs = raw.elapsed_secs
  if (typeof raw.status === 'string' && raw.status !== '') entry.status = raw.status
  if (Array.isArray(raw.queries)) {
    entry.queries = raw.queries.map((q) => (typeof q === 'string' ? q : q?.query)).filter((q) => typeof q === 'string' && q !== '')
  }
  if (Array.isArray(raw.results)) entry.results = raw.results
  if (Array.isArray(raw.references)) entry.references = raw.references
  if (raw.result !== undefined && raw.result !== null) entry.result = raw.result
  state.currentId = key
  emitEntry(state, key, out)
}

/** 单个字段的补丁。 */
function setField(state, id, field, op, value, out) {
  const entry = state.fragments.get(String(id))
  if (entry === undefined) return
  if (field === 'content') {
    if (typeof value !== 'string') return
    if (op === 'APPEND') entry.content += value
    else if (value.length >= entry.emitted) entry.content = value
  } else if (field === 'elapsed_secs') {
    if (typeof value === 'number') entry.elapsedSecs = value
  } else if (field === 'status') {
    if (typeof value === 'string' && value !== '') entry.status = value
  } else if (field === 'references') {
    if (Array.isArray(value)) entry.references = value
  } else if (field === 'queries') {
    if (Array.isArray(value)) {
      entry.queries = value.map((q) => (typeof q === 'string' ? q : q?.query)).filter((q) => typeof q === 'string' && q !== '')
    }
  } else if (field === 'results') {
    if (Array.isArray(value)) entry.results = value
  } else if (field === 'result') {
    entry.result = value
  } else {
    return
  }
  emitEntry(state, id, out)
}

function resolveIndex(state, index) {
  if (index < 0) return state.order.length === 0 ? state.currentId : state.order[state.order.length - 1]
  return state.order[index] ?? null
}

/**
 * 按路径派发补丁。实测的形状（联网搜索那次抓的）：
 *   {p:'response', o:'BATCH', v:[{p:'fragments', o:'APPEND', v:[片段]}]}          ← 嵌套批量
 *   {p:'response/fragments/-1', o:'BATCH', v:[{p:'content',o:'APPEND',v:'[reference:0]'},
 *                                             {p:'references',o:'SET',v:[{id,type}]}]}
 *   {p:'response/fragments/-1/elapsed_secs', o:'SET', v:0.53}
 *   {v:[{p:'content',o:'APPEND',v:'…'},{p:'references',v:[…]}]}                    ← 无 frame.p，作用于当前片段
 */
/**
 * 嵌套 BATCH 里的子补丁路径是**相对的**：{p:'response', v:[{p:'fragments',…}]}。
 * 必须拼成完整路径，否则子补丁全部落空 —— 实测后果是 TOOL_SEARCH / TOOL_OPEN
 * 这些片段根本不会被创建，流式时"搜索卡与浏览来源"永远不出现，
 * 而读历史那条路（片段是完整下发的）却正常 —— 症状就是"切走再回来才正常"。
 */
const joinPath = (base, sub) => (typeof sub === 'string' && sub !== '' ? `${base}/${sub}` : base)

function applyOp(state, path, op, value, out) {
  if (path === 'response') {
    if (Array.isArray(value)) for (const sub of value) applyOp(state, joinPath(path, sub?.p), sub?.o, sub?.v, out)
    return
  }
  if (path === 'response/fragments') {
    if (Array.isArray(value)) for (const fragment of value) upsertFragment(state, fragment, out)
    return
  }
  const single = /^response\/fragments\/(-?\d+)$/.exec(path)
  if (single !== null) {
    const id = resolveIndex(state, Number(single[1]))
    if (id === null) return
    if (Array.isArray(value)) {
      for (const sub of value) applyOp(state, joinPath(path, sub?.p), sub?.o, sub?.v, out)
    }
    return
  }
  const field = /^response\/fragments\/(-?\d+)\/([a-z_]+)$/.exec(path)
  if (field !== null) {
    const id = resolveIndex(state, Number(field[1]))
    if (id !== null) setField(state, id, field[2], op, value, out)
  }
}

/**
 * 从数组帧里捞出 quasi_status（实测形状：
 * {"v":[{"p":"accumulated_token_usage","v":67},{"p":"quasi_status","v":"FINISHED"}]}）。
 * 面板用它判断"这一轮真的结束了"，从而决定消息级操作是否可用。
 */
function scanQuasiStatus(frame) {
  const v = frame?.v
  if (!Array.isArray(v)) return null
  for (const item of v) {
    if (item !== null && typeof item === 'object' && item.p === 'quasi_status' && typeof item.v === 'string') {
      return item.v
    }
  }
  return null
}

function normalizeFrame(frame, state) {
  if (frame === null || typeof frame !== 'object') return []
  const out = []
  const v = frame.v

  // 1) 带路径的补丁优先（含嵌套 BATCH）。它的 value 可能是数组，不能被下面的数组分支抢走。
  if (typeof frame.p === 'string') {
    applyOp(state, frame.p, frame.o, v, out)
    return out
  }

  // 2) 顶层数组：元素要么是片段，要么是不带 frame.p 的裸补丁（作用于当前片段）
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.p === 'string') {
        if (state.currentId !== null) setField(state, state.currentId, item.p, item.o, item.v, out)
        continue
      }
      upsertFragment(state, item, out)
    }
    return out
  }

  // 3) 对象：要么是 {v:{response:{fragments:[…]}}} 快照，要么是数字键补丁表
  if (v !== null && typeof v === 'object') {
    const fragments = v.response?.fragments ?? (Array.isArray(v.fragments) ? v.fragments : undefined)
    if (Array.isArray(fragments)) {
      for (const fragment of fragments) upsertFragment(state, fragment, out)
      return out
    }
    const keys = Object.keys(v)
    if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
      for (const key of keys) upsertFragment(state, v[key], out)
    }
    return out
  }

  // 4) 纯串增量：不自带目标，属于"当前片段" —— 这里正是最早出错的地方
  if (typeof v === 'string') {
    if (state.currentId === null) return out
    setField(state, state.currentId, 'content', 'APPEND', v, out)
  }
  return out
}

/** 逐行解析上游 SSE，回调每个 data 帧的 JSON 对象。 */
async function readUpstreamSse(response, onFrame, signal) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done === true) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        try { onFrame(JSON.parse(payload)) } catch { /* 非 JSON 帧直接忽略 */ }
      }
    }
  } finally {
    if (signal?.aborted !== true) {
      try { await reader.cancel() } catch { /* ignore */ }
    }
  }
}

// ---- 插件本体 ------------------------------------------------------------

export async function apply(ctx) {
  const liveStreams = new Map()

  const guard = (req, res) => {
    const failure = trustFailure(req)
    if (failure === undefined) return true
    // 403 里带上判据快照：只写一句「仅允许本机同源访问」时，从面板看不出是哪条没过。
    writeJson(res, 403, {
      ok: false,
      code: 'forbidden',
      message: '仅允许本机同源访问',
      reason: failure.reason,
      seen: failure.seen,
    })
    return false
  }

  /** 需要登录的路由统一入口：没 token 就直接给明确提示，别让它去撞 40002。 */
  const needToken = (res) => {
    const cfg = readConfig()
    if (cfg.token === '') {
      writeJson(res, 200, { ok: false, code: 'no-token', message: '还没有登录 DeepSeek，请先在设置里登录。' })
      return null
    }
    return cfg
  }
  const fail = (res, error, code = 'failed') => writeJson(res, 200, {
    ok: false, code, message: explainLoginError(String(error?.message ?? error)),
  })
  const readBody = async (req, res) => {
    try {
      return await readJsonBody(req)
    } catch (error) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: String(error?.message ?? error) })
      return null
    }
  }
  const requirePost = (req, res) => {
    if (req.method === 'POST') return true
    writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
    return false
  }

  const routes = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
        const cfg = readConfig()
        if (cfg.token === '') return writeJson(res, 200, { ok: true, configured: false })
        try {
          await callJson('/api/v0/chat/create_pow_challenge', cfg.token, {
            target_path: '/api/v0/chat/completion',
          })
          return writeJson(res, 200, { ok: true, configured: true, tokenValid: true })
        } catch (error) {
          return writeJson(res, 200, {
            ok: true, configured: true, tokenValid: false, message: String(error?.message ?? error),
          })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/config`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method === 'GET') {
          const cfg = readConfig()
          // token 永不下发，只回答「有没有」；手机号只回显掩码。
          return writeJson(res, 200, {
            ok: true,
            configured: cfg.token !== '',
            thinking: cfg.thinking === true,
            search: cfg.search === true,
            baseUrl: cfg.baseUrl,
            mobile: typeof cfg.mobile === 'string' && cfg.mobile.length >= 7
              ? `${cfg.mobile.slice(0, 3)}****${cfg.mobile.slice(-4)}`
              : null,
          })
        }
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
        try {
          const body = await readJsonBody(req)
          const patch = {}
          if (typeof body.token === 'string') patch.token = body.token.trim()
          if (typeof body.thinking === 'boolean') patch.thinking = body.thinking
          if (typeof body.search === 'boolean') patch.search = body.search
          if (typeof body.baseUrl === 'string' && body.baseUrl !== '') patch.baseUrl = body.baseUrl
          if (body.logout === true) patch.token = ''
          writeConfig(patch)
          return writeJson(res, 200, { ok: true })
        } catch (error) {
          return writeJson(res, 400, { ok: false, code: 'bad-request', message: String(error?.message ?? error) })
        }
      },
    },
    {
      // 第一步：发短信验证码。走 guest 挑战（无需 token）。
      // 注意：官网这一步可能要求人机验证（turnstile / 数美 / hcaptcha）。拿不到就返回
      // ok:false + hint，让用户去官网点一次「获取验证码」，再走第二步 —— 第二步不需要人机验证。
      kind: 'exact',
      path: `${API_PREFIX}/login/send-code`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
        const hint = '如果这一步失败（例如提示需要人机验证），请到 chat.deepseek.com 点一次「获取验证码」，'
          + '然后把收到的 6 位验证码直接填到下面的输入框里 —— 第二步登录不需要人机验证。'
        try {
          const body = await readJsonBody(req)
          const mobile = String(body.mobile ?? '').replace(/[^0-9]/g, '')
          if (mobile.length < 6) {
            return writeJson(res, 200, { ok: false, code: 'bad-mobile', message: '手机号看起来不对', hint })
          }
          const deviceId = ensureDeviceId()
          const data = await postWithPow('', '/api/v0/users/create_sms_verification_code', {
            locale: 'zh_CN',
            device_id: deviceId,
            // 实测：这个字段只接受 'login'。'mobileLogin' / 'normal' / 'signUp' /
            // 'forgetPassword' / 空串 全部被 HTTP 422 拒掉（错误定位就是 body.scenario）。
            scenario: 'login',
            mobile_number: mobile,
            ticket: '',
          })
          writeConfig({ mobile })
          return writeJson(res, 200, {
            ok: true,
            mobile,
            sendWindowSecs: data?.biz_data?.send_window_secs ?? null,
          })
        } catch (error) {
          const message = String(error?.message ?? error)
          // 实测：这一步官方强制 reCAPTCHA，插件拿不到令牌 → 必然失败。
          // 所以这不是"出错"，而是"此路不通"，要把人引到走得通的那条路上去。
          if (/recaptcha_verify_failed/i.test(message)) {
            return writeJson(res, 200, {
              ok: false,
              code: 'recaptcha',
              message: '官方要求人机验证，插件无法代你发验证码。',
              hint: '请在浏览器打开 chat.deepseek.com 点一次「获取验证码」，把收到的 6 位码填到下面，再点「登录」—— 换取 token 那一步不需要人机验证。',
            })
          }
          return writeJson(res, 200, { ok: false, code: 'send-failed', message, hint })
        }
      },
    },
    {
      // 第二步：用验证码换 token，直接落盘（token 不下发到浏览器）。
      kind: 'exact',
      path: `${API_PREFIX}/login/verify`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
        try {
          const body = await readJsonBody(req)
          const mobile = String(body.mobile ?? '').replace(/[^0-9]/g, '')
          const code = String(body.code ?? '').replace(/[^0-9]/g, '')
          if (mobile.length < 6) return writeJson(res, 200, { ok: false, code: 'bad-mobile', message: '手机号看起来不对' })
          if (code.length < 4) return writeJson(res, 200, { ok: false, code: 'bad-code', message: '验证码看起来不对' })
          const cfg = readConfig()
          const deviceId = ensureDeviceId()
          // [0, 1]：0=新账号注册成功，1=已有账号登录成功 —— 两个都是成功。
          const data = await postWithPow('', '/api/v0/users/login_by_mobile_sms', {
            region: 'CN',
            locale: 'zh_CN',
            mobile_number: mobile,
            area_code: String(body.areaCode ?? cfg.areaCode ?? '+86'),
            sms_verification_code: code,
            device_id: deviceId,
            os: 'web',
          }, undefined, [0, 1])
          const biz = data?.biz_data ?? data
          const token = biz?.token ?? biz?.user?.token
          if (typeof token !== 'string' || token === '') {
            throw new Error('登录返回里没有 token：' + JSON.stringify(data).slice(0, 300))
          }
          writeConfig({ token, mobile })
          return writeJson(res, 200, { ok: true, mobile })
        } catch (error) {
          return writeJson(res, 200, {
            ok: false, code: 'login-failed', message: explainLoginError(String(error?.message ?? error)),
          })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/sessions`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
        const cfg = needToken(res)
        if (cfg === null) return
        try {
          const result = await listSessions(cfg.token, new URL(req.url, 'http://x').searchParams.get('count'))
          return writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          return fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/sessions/new`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (!requirePost(req, res)) return
        const cfg = needToken(res)
        if (cfg === null) return
        try {
          const sessionId = await createSession(cfg.token)
          return writeJson(res, 200, { ok: true, sessionId })
        } catch (error) {
          return fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/sessions/rename`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (!requirePost(req, res)) return
        const cfg = needToken(res)
        if (cfg === null) return
        const body = await readBody(req, res)
        if (body === null) return
        const id = String(body.id ?? '')
        const title = String(body.title ?? '').trim()
        if (id === '') return writeJson(res, 400, { ok: false, code: 'bad-id', message: '缺少会话 id' })
        if (title === '') return writeJson(res, 400, { ok: false, code: 'bad-title', message: '标题不能为空' })
        try {
          return writeJson(res, 200, { ok: true, ...(await renameSession(cfg.token, id, title.slice(0, 100))) })
        } catch (error) {
          return fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/sessions/pin`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (!requirePost(req, res)) return
        const cfg = needToken(res)
        if (cfg === null) return
        const body = await readBody(req, res)
        if (body === null) return
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id !== '') : []
        if (ids.length === 0) return writeJson(res, 400, { ok: false, code: 'bad-ids', message: '没有选中任何对话' })
        try {
          return writeJson(res, 200, { ok: true, ...(await pinSessions(cfg.token, ids, body.pinned === true)) })
        } catch (error) {
          return fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/sessions/delete`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (!requirePost(req, res)) return
        const cfg = needToken(res)
        if (cfg === null) return
        const body = await readBody(req, res)
        if (body === null) return
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id !== '') : []
        if (ids.length === 0) return writeJson(res, 400, { ok: false, code: 'bad-ids', message: '没有选中任何对话' })
        try {
          return writeJson(res, 200, { ok: true, ...(await deleteSessions(cfg.token, ids)) })
        } catch (error) {
          return fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/sessions/delete-all`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (!requirePost(req, res)) return
        const cfg = needToken(res)
        if (cfg === null) return
        const body = await readBody(req, res)
        if (body === null) return
        // 不可恢复操作：必须显式带 confirm，避免前端误触发
        if (body.confirm !== true) {
          return writeJson(res, 400, { ok: false, code: 'need-confirm', message: '清空全部对话需要二次确认' })
        }
        try {
          return writeJson(res, 200, { ok: true, ...(await deleteAllSessions(cfg.token)) })
        } catch (error) {
          return fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/session/messages`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
        const cfg = needToken(res)
        if (cfg === null) return
        const id = new URL(req.url, 'http://x').searchParams.get('id') ?? ''
        if (id === '') return writeJson(res, 400, { ok: false, code: 'bad-id', message: '缺少会话 id' })
        try {
          return writeJson(res, 200, { ok: true, ...(await loadMessages(cfg.token, id)) })
        } catch (error) {
          return fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/stop`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
        try {
          const body = await readJsonBody(req)
          const live = liveStreams.get(body.requestId)
          if (live !== undefined) {
            live.abort.abort()
            liveStreams.delete(body.requestId)
          }
          const cfg = readConfig()
          if (typeof body.sessionId === 'string' && body.sessionId !== '' && cfg.token !== '') {
            await callJson('/api/v0/chat/stop_stream', cfg.token, { chat_session_id: body.sessionId })
          }
          return writeJson(res, 200, { ok: true })
        } catch (error) {
          return writeJson(res, 200, { ok: false, code: 'stop-failed', message: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/chat`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: 'method-not-allowed' })

        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return writeJson(res, 400, { ok: false, code: 'bad-request', message: String(error?.message ?? error) })
        }
        const prompt = typeof body.prompt === 'string' ? body.prompt : ''
        if (prompt.trim() === '') return writeJson(res, 400, { ok: false, code: 'empty-prompt' })

        const cfg = readConfig()
        if (cfg.token === '') return writeJson(res, 400, { ok: false, code: 'no-token', message: '还没有填写 token' })

        const requestId = typeof body.requestId === 'string' && body.requestId !== ''
          ? body.requestId
          : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const abort = new AbortController()
        liveStreams.set(requestId, { abort })

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        const send = (event, data) => {
          if (res.writableEnded === true) return
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }

        const onClose = () => {
          abort.abort()
          liveStreams.delete(requestId)
        }
        // 只监听 res：POST 的 req 在 body 读完后就会触发 'close'，拿它当断连信号
        // 会把正在生成的上游请求误杀（客户端其实还在等）。
        res.once('close', onClose)

        try {
          const sessionId = typeof body.sessionId === 'string' && body.sessionId !== ''
            ? body.sessionId
            : await createSession(cfg.token, abort.signal)
          send('meta', { requestId, sessionId })

          const powHeader = await createPowHeader(cfg.token, '/api/v0/chat/completion')
          const upstream = await fetch(`${CHAT_BASE}/api/v0/chat/completion`, {
            method: 'POST',
            headers: { ...authHeaders(cfg.token), [powHeader.name]: powHeader.value },
            body: JSON.stringify({
              chat_session_id: sessionId,
              // ★ 必须指向上一条消息的 id。一直发 null 会让每条用户消息各自成根，
              // 网页端就把这些根渲染成并列分支（表现为"1/2/3"翻页），而面板按扁平列表画，
              // 于是两边看起来不一样。实测：parent 指对上一条时，历史链条是线性的。
              parent_message_id: typeof body.parentMessageId === 'number' && body.parentMessageId > 0
                ? body.parentMessageId
                : null,
              prompt,
              ref_file_ids: [],
              thinking_enabled: body.thinking === true,
              search_enabled: body.search === true,
              preempt: false,
            }),
            signal: abort.signal,
          })

          const contentType = upstream.headers.get('content-type') ?? ''
          if (!contentType.includes('event-stream') && !contentType.includes('json')) {
            const text = await upstream.text()
            throw new Error(`上游 HTTP ${upstream.status} 非流式响应：${text.slice(0, 200)}`)
          }

          const state = makeStreamState()
          let announcedMessageId = false
          await readUpstreamSse(upstream, (frame) => {
            // 首帧 {"request_message_id":1,"response_message_id":2,...} 不带 v，
            // 但它是后续「重新生成 / 编辑重发」唯一能拿到的消息 id 来源。
            if (announcedMessageId === false && typeof frame?.response_message_id === 'number') {
              announcedMessageId = true
              send('meta', {
                requestId,
                sessionId,
                requestMessageId: frame.request_message_id ?? null,
                responseMessageId: frame.response_message_id,
              })
            }
            const finished = scanQuasiStatus(frame)
            if (finished !== null) send('status', { quasiStatus: finished })
            for (const item of normalizeFrame(frame, state)) {
              switch (item.kind) {
                case 'delta': send('delta', { text: item.text }); break
                case 'thinking': send('thinking', { text: item.text }); break
                case 'thinking-time': send('thinking-time', { elapsedSecs: item.elapsedSecs }); break
                case 'search':
                  send('search', {
                    label: item.label, queries: item.queries,
                    resultCount: item.resultCount, results: item.results,
                  })
                  break
                case 'source':
                  send('source', {
                    fragmentId: item.fragmentId, url: item.url, title: item.title,
                    siteName: item.siteName, snippet: item.snippet,
                  })
                  break
                case 'refs': send('refs', { references: item.references }); break
                default: break
              }
            }
          }, abort.signal)
          send('done', { sessionId })
        } catch (error) {
          const aborted = abort.signal.aborted
          if (!aborted) {
            send('error', { code: 'upstream', message: String(error?.message ?? error) })
          } else {
            send('done', { aborted: true })
          }
        } finally {
          liveStreams.delete(requestId)
          res.off('close', onClose)
          if (res.writableEnded !== true) res.end()
        }
      },
    },
  ]

  ctx.effect(() => {
    const disposers = []
    try {
      for (const route of routes) disposers.push(ctx.webServer.register(route))
    } catch (error) {
      for (const dispose of disposers.splice(0)) dispose()
      throw error            // 挂载失败绝不吞掉：抛错的 effect 不会执行清理
    }
    return () => { for (const dispose of disposers.splice(0)) dispose() }
  }, 'deepseek-web: http routes')

  // 可选：让 Agent 也能自己问（Part D，见第 8 节）。允许缺失该服务。
  try {
    const tools = ctx.get('tools')
    if (tools !== undefined && typeof tools.register === 'function') {
      ctx.effect(() => tools.register({
        name: 'ask_deepseek_web',
        description: '把一个问题交给 DeepSeek 网页版回答（走网页额度，不耗官方 API）。'
          + '适合需要第二意见、或想省额度的查询。Triggers: 问 DeepSeek, ask deepseek, 网页版 DeepSeek.',
        parameters: {
          question: { type: 'string', required: true, description: '要问的完整问题。' },
          thinking: { type: 'boolean', description: '是否开启深度思考模式。默认 false。' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          try {
            const cfg = readConfig()
            if (cfg.token === '') return { ok: false, code: 'no-token', message: '插件里还没有填写 DeepSeek token' }
            const answer = await askOnce(cfg, String(args.question ?? ''), args.thinking === true, exec?.signal)
            return { ok: true, answer }
          } catch (error) {
            return { ok: false, code: 'failed', message: String(error?.message ?? error) }
          }
        },
      }), 'deepseek-web: agent tool')
    }
  } catch { /* 没有 tools 服务就跳过，插件照常可用 */ }
}

/** 一次性问答（给 Agent 工具用，非流式聚合）。 */
async function askOnce(cfg, prompt, thinking, signal) {
  const sessionId = await createSession(cfg.token, signal)
  const powHeader = await createPowHeader(cfg.token, '/api/v0/chat/completion')
  const upstream = await fetch(`${CHAT_BASE}/api/v0/chat/completion`, {
    method: 'POST',
    headers: { ...authHeaders(cfg.token), [powHeader.name]: powHeader.value },
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinking,
      search_enabled: cfg.search === true,
      preempt: false,
    }),
    signal,
  })
  const state = makeStreamState()
  let answer = ''
  let think = ''
  await readUpstreamSse(upstream, (frame) => {
    for (const item of normalizeFrame(frame, state)) {
      if (item.kind === 'delta') answer += item.text
      else if (item.kind === 'thinking') think += item.text
    }
  }, signal)
  return think === '' ? answer : `【思考】\n${think}\n\n【回答】\n${answer}`
}
