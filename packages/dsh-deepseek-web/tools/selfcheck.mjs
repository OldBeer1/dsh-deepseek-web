/**
 * 独立自检：不装插件也能跑。
 *   node packages/dsh-deepseek-web/tools/selfcheck.mjs <token>
 * 或   设置 DEEPSEEK_WEB_TOKEN 环境变量。
 *
 * 它会依次做：发现 wasm → 实例化 → 拿真挑战 → 求解（打印原始返回槽）
 * → 打一发真 completion 并把上游 SSE 原文前若干行打出来。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHAT = 'https://chat.deepseek.com'
const STATIC = 'https://fe-static.deepseek.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function tokenFromDisk() {
  try {
    const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'deepseek-web', 'config.json')
    return JSON.parse(readFileSync(file, 'utf8')).token ?? ''
  } catch { return '' }
}
const token = (process.argv[2] ?? process.env.DEEPSEEK_WEB_TOKEN ?? tokenFromDisk()).trim()
if (token === '') { console.error('缺少 token：node selfcheck.mjs <token>'); process.exit(1) }

const auth = {
  'content-type': 'application/json', accept: '*/*', 'user-agent': UA,
  origin: CHAT, referer: `${CHAT}/`, authorization: `Bearer ${token}`,
}

// 1) 发现 wasm
const html = await (await fetch(`${CHAT}/`, { headers: { 'user-agent': UA } })).text()
const mainUrl = new URL(/src="([^"]*\/static\/main\.[0-9a-f]+\.js)"/.exec(html)[1], CHAT).href
const bundle = await (await fetch(mainUrl, { headers: { 'user-agent': UA } })).text()
const wasmName = /static\/(sha3_wasm_bg\.[0-9a-f]+\.wasm)/.exec(bundle)[1]
console.log('[1] main =', mainUrl)
console.log('[1] wasm =', `${STATIC}/chat/static/${wasmName}`)

// 2) 实例化
const bytes = new Uint8Array(await (await fetch(`${STATIC}/chat/static/${wasmName}`)).arrayBuffer())
const { instance } = await WebAssembly.instantiate(bytes, {})
const ex = instance.exports
console.log('[2] imports =', WebAssembly.Module.imports(await WebAssembly.compile(bytes)).length,
  ' exports =', Object.keys(ex).join(','))
const { memory, wasm_solve: solve, __wbindgen_export_0: malloc, __wbindgen_add_to_stack_pointer: bump } = ex

const writeString = (s) => {
  const d = new TextEncoder().encode(s)
  const p = malloc(d.length, 1)
  new Uint8Array(memory.buffer, p, d.length).set(d)
  return [p, d.length]
}

// 3) 真挑战
const challengeResp = await (await fetch(`${CHAT}/api/v0/chat/create_pow_challenge`, {
  method: 'POST', headers: auth, body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
})).json()
console.log('[3] challenge resp =', JSON.stringify(challengeResp).slice(0, 400))
const challenge = challengeResp?.data?.biz_data?.challenge
if (challenge === undefined) { console.error('拿不到挑战——先确认 token 是否有效'); process.exit(1) }
console.log('[3] challenge =', JSON.stringify(challenge))

// 4) 求解 + 原始返回槽透视
const prefix = `${challenge.salt}_${challenge.expire_at}_`
const ret = bump(-16)
const [cp, cl] = writeString(challenge.challenge)
const [pp, pl] = writeString(prefix)
const t0 = Date.now()
solve(ret, cp, cl, pp, pl, challenge.difficulty)
const view = new DataView(memory.buffer)
const i32At0 = view.getInt32(ret, true)
const f64At8 = view.getFloat64(ret + 8, true)
const raw = Buffer.from(new Uint8Array(memory.buffer, ret, 16))
bump(16)
console.log(`[4] solve 用时 ${Date.now() - t0}ms`)
console.log('[4] 原始 16 字节 =', raw.toString('hex'))
console.log('[4] 读法A  i32@0 =', i32At0, ' f64@8 =', f64At8)
console.log('[4] 读法B  若 @0 是指针，指向 heap 偏移 =', i32At0)
const answer = i32At0 !== 0 ? f64At8 : (f64At8 !== 0 ? f64At8 : 0)
console.log('[4] 采用答案 =', answer, answer === 0 ? '  ← 若为 0，说明读法与官网不同，把上面的原始字节贴给维护者' : '  ✅')

// 5) 真打一发，看上游 SSE 原文
const powHeader = Buffer.from(JSON.stringify({
  algorithm: challenge.algorithm, challenge: challenge.challenge, salt: challenge.salt,
  answer, signature: challenge.signature, target_path: challenge.target_path,
})).toString('base64')

const session = await (await fetch(`${CHAT}/api/v0/chat_session/create`, {
  method: 'POST', headers: auth, body: '{}',
})).json()
console.log('[5] 建会话 =', JSON.stringify(session).slice(0, 300))
const sessionId = session?.data?.biz_data?.chat_session?.id ?? session?.data?.biz_data?.id
if (sessionId === undefined) { console.error('拿不到 session id，见上面响应原文'); process.exit(1) }

const stream = await fetch(`${CHAT}/api/v0/chat/completion`, {
  method: 'POST',
  headers: { ...auth, 'x-ds-pow-response': powHeader },
  body: JSON.stringify({
    chat_session_id: sessionId, parent_message_id: null, prompt: '只回四个字：自检成功',
    ref_file_ids: [], thinking_enabled: false, search_enabled: false, preempt: false,
  }),
})
console.log('[5] completion HTTP =', stream.status, stream.headers.get('content-type'))
const reader = stream.body.getReader()
const decoder = new TextDecoder()
let seen = 0
let buffer = ''
for (;;) {
  const { value, done } = await reader.read()
  if (done === true) break
  buffer += decoder.decode(value, { stream: true })
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '' || seen >= 12) continue
    seen += 1
    console.log('[5] 帧' + seen + ':', line.slice(0, 300))
  }
  if (seen >= 12) { await reader.cancel(); break }
}
console.log('\n把 [4] 和 [5] 的输出保留下来：前者决定 solveChallenge 的读法，后者决定 normalizeFrame 要留哪个分支。')
