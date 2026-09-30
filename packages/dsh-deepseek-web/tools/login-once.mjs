/**
 * 一次性登录：不走插件，直接把 token 写进插件读的配置文件。
 *
 * 用途：插件 Host 侧的代码改动需要重启 DSH 才生效，而验证码只有几分钟寿命。
 * 这个脚本让你**不必等重启**就能先把 token 拿下来：
 *
 *     node packages/dsh-deepseek-web/tools/login-once.mjs <手机号> <6位验证码>
 *
 * 它做的事和插件完全一样：guest 挑战 → wasm 求解 → x-ds-guest-pow-response
 * → POST login_by_mobile_sms → 把 token 与手机号写进 $DSH_HOME/deepseek-web/config.json
 *
 * 关键点：官方对「已有账号」返回 biz_code=1 LOGIN_TO_EXISTING_ACCOUNT，
 * 那不是错误，那就是登录成功（官网自己的代码也把它当成功）。只有 0 和 1 都接受才对。
 *
 * 验证码怎么来：浏览器打开 chat.deepseek.com 点「获取验证码」。
 * 插件自己发不了 —— 官方那一步强制 reCAPTCHA（实测 biz_code=2 RECAPTCHA_VERIFY_FAILED）。
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CHAT = 'https://chat.deepseek.com'
const STATIC = 'https://fe-static.deepseek.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const LOGIN_PATH = '/api/v0/users/login_by_mobile_sms'

const mobile = String(process.argv[2] ?? '').replace(/[^0-9]/g, '')
const code = String(process.argv[3] ?? '').replace(/[^0-9]/g, '')
if (mobile.length < 6 || code.length < 4) {
  console.error('用法: node login-once.mjs <手机号> <6位验证码>')
  process.exit(1)
}

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const configFile = join(home, 'deepseek-web', 'config.json')
const readConfig = () => { try { return JSON.parse(readFileSync(configFile, 'utf8')) } catch { return {} } }
const config = readConfig()
const deviceId = typeof config.deviceId === 'string' && config.deviceId.length >= 16
  ? config.deviceId
  : randomUUID().replace(/-/g, '')

const base = { 'content-type': 'application/json', accept: '*/*', 'user-agent': UA, origin: CHAT, referer: `${CHAT}/` }
const post = async (path, body, extra = {}) => {
  const r = await fetch(`${CHAT}${path}`, { method: 'POST', headers: { ...base, ...extra }, body: JSON.stringify(body) })
  return { status: r.status, text: await r.text() }
}

// ---- 1) wasm + PoW -------------------------------------------------------
const html = await (await fetch(`${CHAT}/`, { headers: { 'user-agent': UA } })).text()
const mainUrl = new URL(/src="([^"]*\/static\/main\.[0-9a-f]+\.js)"/.exec(html)[1], CHAT).href
const bundle = await (await fetch(mainUrl, { headers: { 'user-agent': UA } })).text()
const wasmName = /static\/(sha3_wasm_bg\.[0-9a-f]+\.wasm)/.exec(bundle)[1]
console.log(`[1] wasm = ${wasmName}`)
const bytes = new Uint8Array(await (await fetch(`${STATIC}/chat/static/${wasmName}`)).arrayBuffer())
const { instance } = await WebAssembly.instantiate(bytes, {})
const { memory, wasm_solve: solve, __wbindgen_export_0: malloc, __wbindgen_add_to_stack_pointer: bump } = instance.exports
const writeString = (s) => {
  const d = new TextEncoder().encode(s)
  const p = malloc(d.length, 1)
  new Uint8Array(memory.buffer, p, d.length).set(d)
  return [p, d.length]
}

const challengeResp = await post('/api/v0/users/create_guest_challenge', { target_path: LOGIN_PATH })
const challenge = JSON.parse(challengeResp.text)?.data?.biz_data?.guest_challenge
if (challenge === undefined) {
  console.error('[2] 拿不到 guest 挑战：' + challengeResp.text.slice(0, 300))
  process.exit(1)
}
const ret = bump(-16)
const [cp, cl] = writeString(challenge.challenge)
const [pp, pl] = writeString(`${challenge.salt}_${challenge.expire_at}_`)
solve(ret, cp, cl, pp, pl, challenge.difficulty)
const view = new DataView(memory.buffer)
const powStatus = view.getInt32(ret, true)
const answer = view.getFloat64(ret + 8, true)
bump(16)
if (powStatus === 0) { console.error('[2] PoW 求解失败'); process.exit(1) }
console.log(`[2] PoW 解出 answer=${answer}`)

// guest 挑战必须配 guest 头名 + 短版 payload（发 x-ds-pow-response 会得到 40300 Missing Header）
const powHeader = Buffer.from(JSON.stringify({ salt: challenge.salt, answer })).toString('base64')

// ---- 2) 登录 -------------------------------------------------------------
const loginResp = await post(LOGIN_PATH, {
  region: 'CN',
  locale: 'zh_CN',
  mobile_number: mobile,
  area_code: String(config.areaCode ?? '+86'),
  sms_verification_code: code,
  device_id: deviceId,
  os: 'web',
}, { 'x-ds-guest-pow-response': powHeader })
console.log(`[3] 登录 HTTP ${loginResp.status} → ${loginResp.text.slice(0, 300)}`)

let parsed = null
try { parsed = JSON.parse(loginResp.text) } catch { /* 非 JSON */ }
const biz = parsed?.data
const bizCode = biz?.biz_code
const HINTS = {
  1: '已有账号，登录成功（官网也把它当成功）',
  0: '新账号，注册并登录成功',
  3: '账号被封禁',
  6: '只支持中国大陆手机号注册',
  7: '验证码已过期 —— 重新获取一个',
  8: '验证码不对',
  9: '尝试次数过多，稍后再试',
  11: '官方判定设备有风险',
  98: '此通道被临时关闭',
}
if (bizCode !== 0 && bizCode !== 1) {
  console.error(`\n❌ 登录失败：biz_code=${bizCode} ${biz?.biz_msg ?? ''} ${HINTS[bizCode] ?? ''}`)
  process.exit(1)
}
const token = biz?.biz_data?.token ?? biz?.biz_data?.user?.token
if (typeof token !== 'string' || token === '') {
  console.error('\n❌ 登录通过了，但响应里没有 token：' + JSON.stringify(parsed).slice(0, 400))
  process.exit(1)
}

mkdirSync(dirname(configFile), { recursive: true })
const next = { ...config, token, mobile, deviceId }
writeFileSync(configFile, JSON.stringify(next, null, 2), { encoding: 'utf8' })
try { chmodSync(configFile, 0o600) } catch { /* Windows 靠 ACL */ }
console.log(`\n✅ 成功（${HINTS[bizCode] ?? bizCode}）`)
console.log(`   token 长度 ${token.length}，已写入 ${configFile}`)
console.log('   现在直接刷新 DSH 页面，面板头部的状态点应该变绿，可以开始提问。')
