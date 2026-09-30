# DSH × DeepSeek 网页版插件 · DSH × DeepSeek Web Plugin

**中文** | [English](#english)

在 [DSH（DeepSeek Harness）](https://github.com/) 里直接问 **chat.deepseek.com**：走**网页额度**，不消耗官方 API 的按量计费，也不用再来回切浏览器。

> ⚠️ **这是逆向调用，不是官方接口。** 官方一改版就可能失效；请用**小号**，别用主力号；注意风控，不要并发轰炸。详见下方「风险」。

---

## 功能

面板是「会话栏 + 对话区」两栏，尽量对齐网页端：

- **会话栏**：新对话、多选批量置顶/删除、重命名、置顶、清空全部；按 `置顶 / 今天 / 昨天 / 7 天内 / 更早` 分组
- **对话区**：思考与答案分离，并**按实际发生的顺序交错**显示：
  `思考段（含用时）→ 搜索到 N 个网页 → 思考段 → 浏览 N 个页面（可点链接）→ 回答`
- **回答**：真 markdown（标题 / 列表 / 引用 / 代码块 / 加粗 / 链接）；`[reference:N]` 渲染成**可点的来源角标**
- **深度思考 / 联网搜索**：**按对话分别记忆**，关掉软件也还在
- **登录**：面板内置手机号 + 短信验证码；token 只落在本机
- 流式输出、中途停止

## 安装

需要 DSH 桌面版（开发环境为 `0.2.0-rc.2`）。**零依赖、免构建。**

1. 把 `packages/dsh-deepseek-web` 放到本机任意目录（路径**别带空格**）
2. 让 DSH 装上它 —— 对你的 DSH 助手说：

   > 把 `<那个目录>` 作为插件包装进当前 profile

3. **完全退出 DSH 再打开**（不是刷新页面）

装好后左侧图标栏会多一个图标。更细的步骤和排错表见
[packages/dsh-deepseek-web/安装说明.md](packages/dsh-deepseek-web/安装说明.md)。

### 为什么必须重启

| 半边 | 生效方式 |
|---|---|
| 前端（面板 UI） | 刷新页面即可 |
| 宿主（Node：PoW、路由、SSE 解析） | **必须完全重启 DSH** —— 插件开关、卸载重装都**不会**重载模块 |

安装方式是 `link:`（指向你的目录），所以**更新 = 覆盖目录里的文件**：前端刷新、宿主重启。
设置页里会显示插件版本，可用来确认更新是否生效。

## 登录

面板右上角 **设置** → 手机号 → 发送验证码。

官方强制人机验证，**插件代发短信大概率会被挡**：这种情况下到浏览器打开
`chat.deepseek.com`，点一次「获取验证码」，把 6 位码填回面板即可。

凭证只保存在 `%USERPROFILE%\.dsh\deepseek-web\config.json`（权限 0600），
**不会回传给浏览器页面**。请不要把该文件或 token 发给任何人。

## 风险（请认真读）

1. **逆向实现**：接口一旦变更就可能失效。`docs/实现文档.md` 记录了重新发现流程
   （PoW 挑战、SSE 帧形状、各端点契约），便于修。
2. **账号风险**：这是非官方调用，建议用小号。
3. 风控：不要并发请求、不要脚本化连续提问。
4. 无任何担保。

## 开发

```
test/harness-host.mjs     宿主集成测试（打桩上游，PoW 走真站）
test/harness-client.mjs   前端集成测试（手写 React shim，无浏览器）
```

两者都直接读**真实包文件**（相对路径解析），所以断言的是实际发布的那份代码：

```bash
node test/harness-host.mjs
node test/harness-client.mjs
```

约定：**每修一个 bug 就加一条断言，并带上反例**。例如
「真实 SSE 序列必须让答案里不含思考文本」「`parent_message_id` 必须透传」
「渲染顺序必须恰好是 `think>search>think>browse>answer`」。

`docs/实现文档.md` 是完整的实现文档，含所有实测结论与踩坑记录（§9 是逐轮实测日志）。

## 目录

```
packages/dsh-deepseek-web/   插件本体
  index.js                   宿主半边：PoW、端点代理、SSE 解析
  client.js                  前端半边：面板 UI（单文件，无打包器）
  cordis.patch.yml           插入 profile 的补丁
  tools/                     独立自检与手工登录脚本
test/                        集成测试
docs/实现文档.md              实现文档
```

## 许可

仅供个人学习研究使用。使用者需自行承担因使用本插件产生的全部风险与后果。

---
---

<a id="english"></a>

# DSH × DeepSeek Web Plugin

[中文](#dsh--deepseek-网页版插件--dsh--deepseek-web-plugin) | **English**

Ask **chat.deepseek.com** from inside [DSH (DeepSeek Harness)](https://github.com/) — it spends your **web quota**, not the metered official API, and you never have to switch back to a browser tab.

> ⚠️ **Unofficial and reverse-engineered.** It can break the moment DeepSeek ships a change.
> Use a **secondary account**, not your main one. Be gentle: no concurrent hammering.
> See "Risks" below.

## Features

A two-pane panel — session list plus conversation — kept as close to the web UI as practical:

- **Session list**: new chat, multi-select batch pin/delete, rename, pin, clear all;
  grouped into `Pinned / Today / Yesterday / Last 7 days / Earlier`
- **Conversation**: reasoning and answer are kept apart and **interleaved in the order they actually happened**:
  `reasoning (with elapsed time) → "Found N web pages" → reasoning → "Opened N pages" (clickable links) → answer`
- **Answer**: real markdown (headings, lists, quotes, code blocks, bold, links);
  `[reference:N]` becomes a **clickable source chip**
- **Deep thinking / Web search**: remembered **per conversation**, and they survive restarts
- **Login**: built-in phone number + SMS code; the token never leaves your machine
- Streaming output, and you can stop mid-way

## Install

Requires DSH Desktop (developed against `0.2.0-rc.2`). **Zero dependencies, no build step.**

1. Put `packages/dsh-deepseek-web` anywhere on your machine (avoid spaces in the path).
2. Have DSH install it — just tell your DSH assistant:

   > Install the bundle at `<that directory>` into the current profile.

3. **Quit DSH completely and reopen it** (a page refresh is not enough).

An extra icon then appears in the left icon rail. Step-by-step details and a troubleshooting
table are in [packages/dsh-deepseek-web/安装说明.md](packages/dsh-deepseek-web/安装说明.md).

### Why a full restart is required

| Half | How it takes effect |
|---|---|
| Client (the panel UI) | A page refresh is enough |
| Host (Node: proof-of-work, routes, SSE parsing) | **A full DSH restart** — toggling the plugin or reinstalling it does **not** reload the module |

Installation uses a `link:` to your directory, so **updating means overwriting the files in place**:
refresh for the client half, restart for the host half. The settings page shows the plugin
version, which is how you confirm an update actually landed.

## Login

**Settings** (top right of the panel) → phone number → send code.

DeepSeek enforces a captcha, so **the plugin's own SMS request is very likely to be rejected**.
When that happens, open `chat.deepseek.com` in a browser, click "Get code" once, and paste the
6-digit code back into the panel.

The credential is stored only in `%USERPROFILE%\.dsh\deepseek-web\config.json` (mode 0600) and is
**never sent back to the browser page**. Do not share that file or the token with anyone.

## Risks (please read)

1. **Reverse-engineered**: any API change can break it. `docs/实现文档.md` documents how to
   re-discover the protocol (proof-of-work challenge, SSE frame shapes, endpoint contracts).
2. **Account risk**: this is an unofficial client. Use a secondary account.
3. Rate limits: no concurrent requests, no scripted bulk prompting.
4. No warranty of any kind.

## Development

```
test/harness-host.mjs     host integration tests (upstream stubbed, PoW hits the real site)
test/harness-client.mjs   client integration tests (hand-written React shim, no browser)
```

Both read the **real package files** (resolved relatively), so what they assert is exactly what
ships:

```bash
node test/harness-host.mjs
node test/harness-client.mjs
```

Convention: **every bug fix adds an assertion, plus a negative control.** For example
"the real SSE sequence must not leak reasoning text into the answer", "`parent_message_id` must be
forwarded", "blocks must render in exactly this order: `think>search>think>browse>answer`".

`docs/实现文档.md` is the full implementation document, including every measured finding and every
dead end (§9 is a round-by-round log). It is written in Chinese.

## Layout

```
packages/dsh-deepseek-web/   the plugin
  index.js                   host half: PoW, endpoint proxy, SSE parsing
  client.js                  client half: the panel UI (single file, no bundler)
  cordis.patch.yml           patch that inserts it into the profile
  tools/                     standalone self-check and manual-login scripts
test/                        integration tests
docs/实现文档.md              implementation document
```

## License

For personal study and research only. You bear all risks and consequences of using this plugin.
