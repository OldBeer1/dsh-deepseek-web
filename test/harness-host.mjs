/**
 * 集成验证：把文档里的 Host 代码（block-12）真实跑起来。
 * 只桩掉 DeepSeek 的 /api/v0/* 三个端点；wasm 的发现链路（首页→main.js→wasm 下载→实例化）
 * 走真站，因此这一段的代码是被真正验证的。
 *
 *  变体 A：真 PoW 路径 → 预期在 solveChallenge 处失败，并带 raw= 诊断
 *  变体 B：把 PoW 边界打桩 → 验证后半段（SSE 归一化 → 转发给面板）真的对
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 指向**真实包文件**（正在运行的那一份），而不是文档里抽取的代码块副本。
const SRC = new URL('../packages/dsh-deepseek-web/index.js', import.meta.url)
const B64_32 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
const B64_16 = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
const STUB_CHALLENGE = {
  algorithm: 'DeepSeekHashV1', challenge: B64_32, salt: B64_16, signature: 'stub-signature',
  target_path: '/api/v0/chat/completion', difficulty: 144000,
  expire_at: Date.now() + 300000, expire_after: 300000,
}

// ---- 假 req / res --------------------------------------------------------

class FakeRes {
  constructor() { this.status = 0; this.headers = {}; this.chunks = []; this.writableEnded = false }
  writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; return this }
  write(chunk) { this.chunks.push(String(chunk)); return true }
  end(chunk) { if (chunk !== undefined) this.chunks.push(String(chunk)); this.writableEnded = true }
  // 真实的 ServerResponse 是 EventEmitter，插件会 res.once('close') / res.off('close')
  once() { return this }
  off() { return this }
  on() { return this }
  get text() { return this.chunks.join('') }
}
function fakeReq({ method = 'GET', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const req = {
    method,
    headers,
    url: '/',
    socket: { remoteAddress },
    once() { return req },
    off() { return req },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }
  return req
}
const SAME_ORIGIN = {
  'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387',
}

// ---- 网络桩 --------------------------------------------------------------

const realFetch = globalThis.fetch
let completionFrames = []
let lastCompletionBody = null
function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}
function sseResponse(frames) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function installStub({ powChallenge }) {
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/api/v0/chat_session/create')) {
      return jsonResponse({ code: 0, msg: '', data: { biz_data: { chat_session: { id: 'stub-session-1' } } } })
    }
    if (target.includes('/api/v0/chat/create_pow_challenge')) {
      if (powChallenge === null) return jsonResponse({ code: 40003, msg: 'INVALID_TOKEN', data: null })
      return jsonResponse({ code: 0, msg: '', data: { biz_code: 0, biz_data: { challenge: powChallenge } } })
    }
    if (target.includes('/api/v0/chat/completion')) {
      lastCompletionBody = JSON.parse(String(init?.body ?? '{}'))
      return sseResponse(completionFrames)
    }
    return realFetch(url, init) // 首页 / main.js / wasm 走真站
  }
}

async function loadHostModule(dshHome) {
  process.env.DSH_HOME = dshHome
  const source = readFileSync(SRC, 'utf8')
  return { source }
}

async function mount(source, tag) {
  const dir = join(tmpdir(), `dsw-test-${tag}-${Date.now()}`)
  rmSync(dir, { recursive: true, force: true })   // 清理上一次运行残留的 config.json
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'index.mjs')
  writeFileSync(file, source)
  const mod = await import(`file:///${file.replace(/\\/g, '/')}`)
  const routes = []
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {} } },
    effect(fn) { fn(); return () => {} },
    get() { return undefined },
  }
  await mod.apply(ctx)
  return { routes, dir }
}

const call = async (routes, path, req) => {
  // 真实的 IncomingMessage 里 req.url 带 query，路由本身按 pathname 匹配 —— 这里照做。
  const [pathname] = path.split('?')
  const route = routes.find((r) => r.path === pathname)
  if (route === undefined) throw new Error('没有注册路由 ' + pathname)
  req.url = path
  const res = new FakeRes()
  await route.handler(req, res)
  return res
}

/** 每个挂载点都是全新的 DSH_HOME，所以要先播种 token，否则 /chat 直接 no-token。 */
const seedToken = (routes) => call(routes, '/api/deepseek-web/config', fakeReq({
  method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' }, body: { token: 'fake-token-for-test' },
}))

const chatFrame = async (routes) => parseSse((await call(routes, '/api/deepseek-web/chat', fakeReq({
  method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' }, body: { prompt: 'hi' },
}))).text)

const parseSse = (text) => text.split('\n\n').filter((b) => b.trim() !== '').map((block) => {
  let event = 'message'
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  let parsed
  try { parsed = JSON.parse(data) } catch { parsed = data }
  return { event, data: parsed }
})

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail === '' ? '' : '  → ' + detail}`)
  if (!ok) failures += 1
}

// ================= 变体 A：真 PoW 路径 =================
console.log('\n=== 变体 A：真 wasm 发现链 + 真求解（预期在求解处失败并带诊断） ===')
{
  const { source } = await loadHostModule(join(tmpdir(), 'dsw-A'))
  rmSync(join(tmpdir(), 'dsw-A'), { recursive: true, force: true })   // 清掉上次运行残留的 config.json
  installStub({ powChallenge: STUB_CHALLENGE })
  const { routes } = await mount(source, 'A')

  check('注册了全部路由', routes.length === 13, routes.length + ' 条')

  const status = await call(routes, '/api/deepseek-web/status', fakeReq({ headers: SAME_ORIGIN }))
  const statusBody = JSON.parse(status.text)
  check('同源环回 GET /status 通过守卫', status.status === 200 && statusBody.configured === false, status.text.slice(0, 80))

  const hostile = await call(routes, '/api/deepseek-web/status', fakeReq({
    headers: { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example', host: '127.0.0.1:19387' },
    remoteAddress: '203.0.113.9',
  }))
  check('跨站/远端请求被 403 拒绝', hostile.status === 403, hostile.text.slice(0, 60))

  const saved = await call(routes, '/api/deepseek-web/config', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' }, body: { token: 'fake-token-for-test' },
  }))
  check('POST /config 保存 token', JSON.parse(saved.text).ok === true, saved.text.slice(0, 60))

  const cfg = await call(routes, '/api/deepseek-web/config', fakeReq({ headers: SAME_ORIGIN }))
  check('GET /config 不下发 token', !cfg.text.includes('fake-token-for-test'), cfg.text)

  const chat = await call(routes, '/api/deepseek-web/chat', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
    body: { prompt: '自检', thinking: false, search: false },
  }))
  const frames = parseSse(chat.text)
  check('SSE 收到 meta（会话由上游建）', frames[0]?.event === 'meta' && frames[0].data.sessionId === 'stub-session-1', JSON.stringify(frames[0]?.data))
  const errorFrame = frames.find((f) => f.event === 'error')
  const message = String(errorFrame?.data?.message ?? '')
  check('真 wasm 链路跑通直到求解（首页→main.js→wasm→实例化→调用）',
    message.includes('PoW 求解未产出答案'), message.slice(0, 160))
  check('失败信息带 raw= 原始字节诊断', /raw=[0-9a-f]{32}/.test(message), (message.match(/raw=[0-9a-f]+/) ?? [''])[0])
}

// ================= 变体 B：打桩 PoW，验证后半段 =================
console.log('\n=== 变体 B：PoW 边界打桩，验证 SSE 归一化与转发 ===')
{
  const { source: rawSource } = await loadHostModule(join(tmpdir(), 'dsw-B'))
  const patched = rawSource.replace(
    'const { answer } = pow.solveChallenge(challenge)',
    'const { answer } = { answer: 1 } // 测试专用：PoW 边界打桩',
  )
  check('测试补丁已生效', patched !== rawSource)

  // 形态 1：★ 真实帧序列（本机抓的真流），就是用户看到的"思考混进答案"那个 bug 的复现
  completionFrames = [
    { v: { response: { fragments: [{ id: 2, type: 'THINK', content: '我们需要' }] } } },
    { v: '用' },
    { v: '两' },
    { v: '句话' },
    { p: 'response/fragments/-1/elapsed_secs', o: 'SET', v: 0.5 },
    { v: [{ id: 3, type: 'RESPONSE', content: '二分查找是在有序数组里折半定位。', references: [], stage_id: 1 }] },
    { v: [{ p: 'accumulated_token_usage', v: 67 }, { p: 'quasi_status', v: 'FINISHED' }] },
  ]
  installStub({ powChallenge: STUB_CHALLENGE })
  const b1 = await mount(patched, 'B1')
  await seedToken(b1.routes)
  const r1 = await chatFrame(b1.routes)
  const deltas1 = r1.filter((f) => f.event === 'delta').map((f) => f.data.text).join('')
  const thinks1 = r1.filter((f) => f.event === 'thinking').map((f) => f.data.text).join('')
  check('真实序列：思考全部归到 thinking（含纯串增量）',
    thinks1 === '我们需要用两句话', JSON.stringify(thinks1))
  check('真实序列：答案取自数组帧里的 RESPONSE 片段',
    deltas1 === '二分查找是在有序数组里折半定位。', JSON.stringify(deltas1))
  check('★ 答案里不含任何思考文字（这正是之前糊成一团的根因）',
    !deltas1.includes('我们需要'), JSON.stringify(deltas1))
  check('结束帧存在', r1.some((f) => f.event === 'done'))

  // 形态 2：无思考模式 —— RESPONSE 片段先到，之后的纯串增量必须流进它
  completionFrames = [
    { v: { response: { fragments: [{ id: 2, type: 'RESPONSE', content: '你' }] } } },
    { v: '好' },
    { v: '呀' },
  ]
  const b2 = await mount(patched, 'B2')
  await seedToken(b2.routes)
  const r2 = await chatFrame(b2.routes)
  const deltas2 = r2.filter((f) => f.event === 'delta').map((f) => f.data.text).join('|')
  const thinks2 = r2.filter((f) => f.event === 'thinking').map((f) => f.data.text).join('|')
  check('无思考模式：纯串增量流进 RESPONSE 片段', deltas2 === '你|好|呀', deltas2)
  check('无思考模式：没有误判成思考', thinks2 === '', JSON.stringify(thinks2))

  // ★ 线程锚点：parent_message_id 必须透传到上游。一直发 null 会让每条用户消息各自成根，
  //   网页端就把它们渲染成并列分支（表现为 1/2/3 翻页），而面板是扁平列表 —— 两边就不一致了。
  completionFrames = [{ v: { response: { fragments: [{ id: 2, type: 'RESPONSE', content: 'ok' }] } } }]
  installStub({ powChallenge: STUB_CHALLENGE })
  const b4 = await mount(patched, 'B4')
  await seedToken(b4.routes)
  await call(b4.routes, '/api/deepseek-web/chat', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
    body: { prompt: 'hi', sessionId: 's1', parentMessageId: 42 },
  }))
  check('★ parent_message_id 透传到上游', lastCompletionBody?.parent_message_id === 42, JSON.stringify(lastCompletionBody).slice(0, 130))
  await call(b4.routes, '/api/deepseek-web/chat', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
    body: { prompt: 'hi', sessionId: 's1' },
  }))
  check('没给锚点时退回 null（新会话的第一条本来就该是 null）',
    lastCompletionBody?.parent_message_id === null, JSON.stringify(lastCompletionBody).slice(0, 130))

  // 上游返 HTML（风控）时的可读报错
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/api/v0/chat/completion')) {
      return new Response('<html>Request Blocked</html>', { status: 429, headers: { 'content-type': 'text/html' } })
    }
    if (target.includes('/api/v0/chat_session/create')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 's' } } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (target.includes('/api/v0/chat/create_pow_challenge')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { challenge: STUB_CHALLENGE } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(url, init)
  }
  const b3 = await mount(patched, 'B3')
  await seedToken(b3.routes)
  const r3 = await chatFrame(b3.routes)
  const htmlError = r3.find((f) => f.event === 'error')?.data?.message ?? ''
  check('上游 429 HTML 被识别成可读错误（不是 JSON 语法错）',
    htmlError.includes('非流式响应') && !htmlError.includes('Unexpected token'), htmlError.slice(0, 120))
}

// ================= 变体 C：守卫修复 + 登录链路（真 guest 挑战 + 真 wasm 求解） =================
console.log('\n=== 变体 C：信任守卫修复与登录链路 ===')
{
  const homeC = join(tmpdir(), 'dsw-C')
  rmSync(homeC, { recursive: true, force: true })
  const { source } = await loadHostModule(homeC)

  const upstream = { send: null, verify: null }
  // 真机上踩到的坑：已有账号时官方返回 biz_code=1 LOGIN_TO_EXISTING_ACCOUNT，
  // 而官网自己的代码把它当"登录成功"。所以这里就用 1 来测 —— 用 0 测就测不出这个坑。
  let loginReply = { code: 0, data: { biz_code: 1, biz_msg: 'LOGIN_TO_EXISTING_ACCOUNT', biz_data: { token: 'stub-token-from-login', user: { id: 'u1' } } } }
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/api/v0/users/create_sms_verification_code')) {
      upstream.send = { headers: init?.headers ?? {}, body: JSON.parse(String(init?.body ?? '{}')) }
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { send_window_secs: 60 } } })
    }
    if (target.includes('/api/v0/users/login_by_mobile_sms')) {
      upstream.verify = { headers: init?.headers ?? {}, body: JSON.parse(String(init?.body ?? '{}')) }
      return jsonResponse(loginReply)
    }
    return realFetch(url, init)   // ← guest 挑战**走真站**，所以 PoW 是真实求解
  }
  const c = await mount(source, 'C')
  check('注册了全部 13 条路由', c.routes.length === 13, c.routes.length + ' 条')

  // ---- 守卫：Desktop 外壳转发的真实形态 ----
  const cookieOnly = await call(c.routes, '/api/deepseek-web/status', fakeReq({
    headers: { host: '127.0.0.1:19387', cookie: 'dsh-auth-abc=1' },
  }))
  check('只有 dsh-auth cookie 的请求被放行（Desktop 外壳的形态）', cookieOnly.status === 200, cookieOnly.text.slice(0, 60))

  const bare = await call(c.routes, '/api/deepseek-web/status', fakeReq({ headers: { host: '127.0.0.1:19387' } }))
  check('裸请求（无标记无 cookie）仍被拒，且说明原因',
    bare.status === 403 && JSON.parse(bare.text).reason === 'no-browser-marker', bare.text.slice(0, 150))

  const mismatch = await call(c.routes, '/api/deepseek-web/status', fakeReq({
    headers: { host: '127.0.0.1:19387', cookie: 'dsh-auth-abc=1', origin: 'http://evil.example' },
  }))
  check('cookie + Origin 与 Host 不一致仍被拒',
    mismatch.status === 403 && JSON.parse(mismatch.text).reason === 'origin-host-mismatch', mismatch.text.slice(0, 150))

  const evilRemote = await call(c.routes, '/api/deepseek-web/status', fakeReq({
    headers: { host: '127.0.0.1:19387', cookie: 'dsh-auth-abc=1' }, remoteAddress: '203.0.113.9',
  }))
  check('cookie + 非环回来源仍被拒',
    evilRemote.status === 403 && JSON.parse(evilRemote.text).reason === 'remote-socket', evilRemote.text.slice(0, 150))

  const crossSite = await call(c.routes, '/api/deepseek-web/status', fakeReq({
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' },
  }))
  check('跨站标记仍被拒', crossSite.status === 403 && JSON.parse(crossSite.text).reason === 'cross-site', crossSite.text.slice(0, 150))

  // ---- 登录链路 ----
  const send = JSON.parse((await call(c.routes, '/api/deepseek-web/login/send-code', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' }, body: { mobile: '138 0000 0000' },
  }))).text)
  check('发验证码：真 guest 挑战 + 真 wasm 求解跑通', send.ok === true, JSON.stringify(send).slice(0, 160))
  check('上游体：scenario=login、手机号已归一化',
    upstream.send?.body?.scenario === 'login' && upstream.send?.body?.mobile_number === '13800000000',
    JSON.stringify(upstream.send?.body))

  const decode = (value) => { try { return JSON.parse(Buffer.from(String(value ?? ''), 'base64').toString('utf8')) } catch { return null } }
  // 登录链路走 guest 挑战 → 头名必须是 x-ds-guest-pow-response（实测：发 x-ds-pow-response 会得到 40300 Missing Header）
  check('guest 链路用的是 x-ds-guest-pow-response 头',
    upstream.send?.headers?.['x-ds-guest-pow-response'] !== undefined
      && upstream.send?.headers?.['x-ds-pow-response'] === undefined,
    JSON.stringify(Object.keys(upstream.send?.headers ?? {})))
  const pow = decode(upstream.send?.headers?.['x-ds-guest-pow-response'])
  check('guest 头是短版 {salt, answer} 且答案是真实求解结果',
    pow !== null && typeof pow.answer === 'number' && typeof pow.salt === 'string' && pow.signature === undefined,
    JSON.stringify(pow))

  const verify = JSON.parse((await call(c.routes, '/api/deepseek-web/login/verify', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
    body: { mobile: '13800000000', code: '123456' },
  }))).text)
  check('biz_code=1（已有账号 = 登录成功）被正确处理', verify.ok === true, JSON.stringify(verify).slice(0, 160))
  check('登录请求体正确',
    upstream.verify?.body?.sms_verification_code === '123456' && upstream.verify?.body?.os === 'web'
      && upstream.verify?.body?.mobile_number === '13800000000',
    JSON.stringify(upstream.verify?.body))
  check('两次调用复用同一个 device_id（设备身份一致）',
    typeof upstream.send?.body?.device_id === 'string' && upstream.send.body.device_id === upstream.verify?.body?.device_id,
    String(upstream.send?.body?.device_id))

  const cfgAfter = JSON.parse((await call(c.routes, '/api/deepseek-web/config', fakeReq({ headers: { ...SAME_ORIGIN } }))).text)
  check('登录后 /config 显示已配置', cfgAfter.configured === true, JSON.stringify(cfgAfter))
  check('/config 不下发 token 明文', !JSON.stringify(cfgAfter).includes('stub-token-from-login'), JSON.stringify(cfgAfter))
  check('手机号只回显掩码', cfgAfter.mobile === '138****0000', String(cfgAfter.mobile))

  const onDisk = JSON.parse(readFileSync(join(homeC, 'deepseek-web', 'config.json'), 'utf8'))
  check('token 与 deviceId 真的落盘了',
    onDisk.token === 'stub-token-from-login' && typeof onDisk.deviceId === 'string' && onDisk.deviceId.length >= 16,
    `token=${onDisk.token === '' ? '(空)' : '(已写入)'} deviceId=${onDisk.deviceId}`)

  // 负向对照：别的非 0 业务码必须仍然是失败，并且被翻成中文
  loginReply = { code: 0, data: { biz_code: 7, biz_msg: 'SMS_EXPIRED', biz_data: null } }
  const expired = JSON.parse((await call(c.routes, '/api/deepseek-web/login/verify', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
    body: { mobile: '13800000000', code: '000000' },
  }))).text)
  check('biz_code=7 SMS_EXPIRED 仍判失败，并被翻成人话',
    expired.ok === false && expired.message.includes('验证码已过期'), JSON.stringify(expired).slice(0, 160))

  const logout = JSON.parse((await call(c.routes, '/api/deepseek-web/config', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' }, body: { logout: true },
  }))).text)
  const afterLogout = JSON.parse((await call(c.routes, '/api/deepseek-web/config', fakeReq({ headers: { ...SAME_ORIGIN } }))).text)
  check('退出登录清掉 token', logout.ok === true && afterLogout.configured === false, JSON.stringify(afterLogout))
}

// ================= 变体 D：Phase 1 会话管理 =================
console.log('\n=== 变体 D：会话管理（列表 / 历史 / 重命名 / 置顶 / 删除 / 新建） ===')
{
  const homeD = join(tmpdir(), 'dsw-D')
  rmSync(homeD, { recursive: true, force: true })
  const { source } = await loadHostModule(homeD)

  const seen = { rename: null, pin: null, del: null, messages: null, delAll: false }
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/api/v0/chat_session/fetch_page')) {
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { has_more: true, chat_sessions: [
        { id: 's1', title: '今天的问题', updated_at: 1790706104.348, pinned: true, model_type: 'default', inserted_at: 1790706000 },
        { id: 's2', title: '', updated_at: 1790705000.5, pinned: false, model_type: 'default' },
      ] } } })
    }
    if (target.includes('/api/v0/chat/history_messages')) {
      seen.messages = target
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: {
        chat_session: { id: 's1', title: '今天的问题', pinned: true, updated_at: 1790706104.348 },
        chat_messages: [
          { message_id: 1, role: 'USER', status: 'FINISHED', fragments: [{ id: 1, type: 'REQUEST', content: '你好' }] },
          { message_id: 2, role: 'ASSISTANT', status: 'FINISHED', feedback: null, ban_regenerate: false,
            fragments: [
              { id: 2, type: 'THINK', content: '他只是在打招呼' },
              { id: 3, type: 'RESPONSE', content: '你好！有什么可以帮你？' },
            ] },
          { message_id: 3, role: 'ASSISTANT', status: 'FINISHED', fragments: [{ id: 9, type: 'RESPONSE', content: '' }] },
        ],
      } } })
    }
    if (target.includes('/api/v0/chat_session/update_title')) {
      seen.rename = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: {} } })
    }
    if (target.includes('/api/v0/chat_session/batch_update_pinned')) {
      seen.pin = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { illegal_chat_session_ids: ['s9'] } } })
    }
    if (target.includes('/api/v0/chat_session/delete_all')) {
      seen.delAll = true
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: {} } })
    }
    if (target.includes('/api/v0/chat_session/delete')) {
      seen.del = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: {} } })
    }
    if (target.includes('/api/v0/chat_session/create')) {
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { id: 'new-session' } } })
    }
    return realFetch(url, init)
  }
  const d = await mount(source, 'D')
  await seedToken(d.routes)
  check('Phase 1 后共 13 条路由', d.routes.length === 13, String(d.routes.length))

  const list = JSON.parse((await call(d.routes, '/api/deepseek-web/sessions', fakeReq({ headers: { ...SAME_ORIGIN } }))).text)
  check('会话列表：条数与字段归一化',
    list.ok === true && list.sessions.length === 2 && list.sessions[0].id === 's1', JSON.stringify(list).slice(0, 200))
  check('会话列表：空标题兜底为「新对话」', list.sessions[1].title === '新对话', list.sessions[1].title)
  check('会话列表：pinned / updatedAt 原样透出',
    list.sessions[0].pinned === true && list.sessions[0].updatedAt === 1790706104.348, JSON.stringify(list.sessions[0]))
  check('会话列表：hasMore 透出', list.hasMore === true)

  const msgs = JSON.parse((await call(d.routes, '/api/deepseek-web/session/messages?id=s1', fakeReq({ headers: { ...SAME_ORIGIN } }))).text)
  check('历史消息：REQUEST→用户、THINK→思考、RESPONSE→答案',
    msgs.ok === true && msgs.messages[0].role === 'user' && msgs.messages[0].content === '你好'
      && msgs.messages[1].thinking === '他只是在打招呼' && msgs.messages[1].content === '你好！有什么可以帮你？',
    JSON.stringify(msgs.messages).slice(0, 240))
  check('历史消息：空内容消息被丢掉', msgs.messages.length === 2, String(msgs.messages.length))
  check('历史消息：id / status / feedback 透出（消息级操作用得到）',
    msgs.messages[1].id === 2 && msgs.messages[1].status === 'FINISHED', JSON.stringify(msgs.messages[1]).slice(0, 140))
  check('历史消息：省略 cache 参数（传了会被服务端 400 拒掉）',
    !seen.messages.includes('cache_version'), (seen.messages.split('?')[1] ?? '').slice(0, 80))

  const renamed = JSON.parse((await call(d.routes, '/api/deepseek-web/sessions/rename', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' }, body: { id: 's1', title: '新标题' },
  }))).text)
  check('重命名：上游体正确',
    renamed.ok === true && seen.rename?.chat_session_id === 's1' && seen.rename?.title === '新标题', JSON.stringify(seen.rename))

  const pinned = JSON.parse((await call(d.routes, '/api/deepseek-web/sessions/pin', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' }, body: { ids: ['s1', 's2'], pinned: true },
  }))).text)
  check('批量置顶：上游体是数组',
    pinned.ok === true && Array.isArray(seen.pin?.chat_session_ids) && seen.pin.chat_session_ids.length === 2 && seen.pin.pinned === true,
    JSON.stringify(seen.pin))
  check('批量置顶：非法 id 透出给前端', Array.isArray(pinned.illegal) && pinned.illegal[0] === 's9', JSON.stringify(pinned.illegal))

  const deleted = JSON.parse((await call(d.routes, '/api/deepseek-web/sessions/delete', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' }, body: { ids: ['s2'] },
  }))).text)
  check('删除：上游体正确', deleted.ok === true && seen.del?.chat_session_ids?.[0] === 's2', JSON.stringify(seen.del))

  const noConfirm = JSON.parse((await call(d.routes, '/api/deepseek-web/sessions/delete-all', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' }, body: {},
  }))).text)
  check('清空全部：缺 confirm 时拒绝', noConfirm.ok === false && noConfirm.code === 'need-confirm', JSON.stringify(noConfirm))
  const confirmed = JSON.parse((await call(d.routes, '/api/deepseek-web/sessions/delete-all', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' }, body: { confirm: true },
  }))).text)
  check('清空全部：带 confirm 才执行', confirmed.ok === true && seen.delAll === true, JSON.stringify(confirmed))

  const created = JSON.parse((await call(d.routes, '/api/deepseek-web/sessions/new', fakeReq({
    method: 'POST', headers: { ...SAME_ORIGIN, 'content-type': 'application/json' }, body: {},
  }))).text)
  check('新建会话返回 id', created.ok === true && created.sessionId === 'new-session', JSON.stringify(created))

  if (failures > 0) console.log('')
  const homeNoToken = join(tmpdir(), 'dsw-D2')
  rmSync(homeNoToken, { recursive: true, force: true })
  const bareSource = await loadHostModule(homeNoToken)
  const d2 = await mount(bareSource.source, 'D2')
  const noToken = JSON.parse((await call(d2.routes, '/api/deepseek-web/sessions', fakeReq({ headers: { ...SAME_ORIGIN } }))).text)
  check('未登录时给明确提示（而不是去撞上游 40002）', noToken.ok === false && noToken.code === 'no-token', JSON.stringify(noToken))
}

rmSync(join(tmpdir(), 'dsw-A'), { recursive: true, force: true })
rmSync(join(tmpdir(), 'dsw-C'), { recursive: true, force: true })
rmSync(join(tmpdir(), 'dsw-D'), { recursive: true, force: true })
rmSync(join(tmpdir(), 'dsw-D2'), { recursive: true, force: true })
console.log(`\n=== 结论：${failures === 0 ? '全部通过' : failures + ' 项未通过'} ===`)
process.exit(failures === 0 ? 0 : 1)
