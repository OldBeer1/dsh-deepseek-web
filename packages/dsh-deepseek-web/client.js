/**
 * DSH x DeepSeek Web plugin - CLIENT half (runs in the DSH web page).
 * DSH x DeepSeek 网页版插件 —— 前端半边（跑在 DSH 的网页里）。
 *
 * Single file on purpose: no bundler, no relative imports - only `react` from the module table.
 * 故意做成单文件：没有打包器、没有相对导入，只从模块表里取 `react`。
 *
 * Read this first (English): ../docs/IMPLEMENTATION.md
 * 详尽实测日志（中文）: ../docs/实现文档.md
 *
 * Client-side changes take effect on a page refresh; host-side changes need a DSH restart.
 * 前端改动刷新页面即生效；宿主改动必须重启 DSH。
 *//**
 * DSH × DeepSeek 网页版 —— 浏览器半边。
 * 手写 client.js：只从模块表里取 react，样式自己注入，字符串走 locale 服务。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-deepseek-web',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'deepseek-web'
    // 版本号：前端半边刷新页面就能换新，所以用它来确认"更新有没有生效"最快。
    // （宿主半边要重启 DSH 才换，设置页里两个数字不一致就说明还没重启。）
    const VERSION = '0.2.1'
    // 历史改为服务端为准后，本地只记「当前会话 id」（原来那个存消息数组的键已废弃）
    const SESSION_KEY = 'dsh.deepseekWeb.sessionId'
    const API = `api/${NS}`          // 文档相对路径：页面带 <base href="./">

    // ---- 文案 ----------------------------------------------------------
    const zh = {
      'entry.label': 'DeepSeek 网页版',
      'panel.title': 'DeepSeek 网页版',
      'panel.subtitle': '走网页额度，不消耗官方 API',
      'composer.placeholder': '问点什么…（Enter 发送，Shift+Enter 换行）',
      'composer.send': '发送',
      'composer.stop': '停止',
      'toggle.thinking': '深度思考',
      'toggle.search': '联网搜索',
      'action.clear': '清空',
      'action.settings': '设置',
      'action.back': '返回',
      'side.new': '新对话',
      'side.multi': '多选',
      'side.exitMulti': '退出多选',
      'side.refresh': '刷新列表',
      'side.pinned': '置顶',
      'side.today': '今天',
      'side.yesterday': '昨天',
      'side.week': '7 天内',
      'side.earlier': '更早',
      'side.empty': '暂无历史对话',
      'side.loading': '正在加载…',
      'side.failed': '加载失败',
      'side.retry': '重试',
      'side.selected': '已选 {n} / {max}',
      'side.batchPin': '批量置顶',
      'side.batchDelete': '批量删除',
      'side.rename': '重命名',
      'side.renameFailed': '重命名失败',
      'side.pin': '置顶',
      'side.unpin': '取消置顶',
      'side.pinLimit': '已超过可置顶对话限制',
      'side.delete': '删除',
      'side.cancel': '取消',
      'side.deleteWarn': '删除后不可恢复，由该对话生成的分享链接也将失效。',
      'side.clearAll': '清空全部对话',
      'side.clearAllWarn': '所有历史对话将被清空且无法找回，由对话生成的分享链接也会失效。',
      'side.deleteAllConfirm': '确认清空',
      'side.tooMany': '最多可选择 {n} 个对话',
      'side.count': '共 {n} 个对话',
      'side.maxNotice': '已加载最近 {n} 个（官方接口不支持翻页，游标参数实测无效）',
      'login.title': '登录（手机号 + 短信验证码）',
      'login.step1': '第 1 步：在浏览器打开 chat.deepseek.com，点「获取验证码」，等短信到达。',
      'login.mobile': '手机号',
      'login.code': '短信验证码',
      'login.sendCode': '试发验证码',
      'login.sendHint': '「试发」只有在官方不要求人机验证时才成功；实测它现在会要，所以请直接按第 1 步自己拿码。',
      'login.sending': '发送中…',
      'login.sent': '验证码已发出，请查看短信。',
      'login.submit': '登录',
      'login.verifying': '登录中…',
      'login.ok': '登录成功，token 已保存到本机（不会显示出来）。',
      'login.logout': '退出登录（清除 token）',
      'login.loggedOut': '已清除本机保存的 token。',
      'login.hint': '登录只换取一个凭证并保存在本机，密码不经过本插件；DeepSeek 网页版本身也只支持短信验证码登录。',
      'settings.token': '登录 token',
      'settings.tokenHint': '从 chat.deepseek.com 的 localStorage.userToken 里取 value 字段，见文档附录 A。',
      'settings.save': '保存',
      'settings.saved': '已保存',
      'settings.version': '插件版本 v{v}（前端；宿主要重启 DSH 才会换）',
      'status.checking': '检查中…',
      'status.ready': '已连接',
      'status.noToken': '未配置 token',
      'status.invalid': 'token 无效或已过期',
      'thinking.title': '深度思考（点这里折叠）',
      'thinking.titleWithSecs': '已深度思考（用时 {s} 秒）',
      'search.summary': '已搜索 {queries} 个关键词 · 浏览 {pages} 个网页',
      'search.found': '搜索到 {n} 个网页',
      'search.expandHint': '（点这里展开）',
      'search.browsed': '浏览 {n} 个页面',
      'search.queries': '搜索词：',
      'answer.title': '回答',
      'answer.pending': '正在思考…',
      'error.prefix': '出错了：',
      'empty.hint': '还没有对话。下面输入框里问第一句。',
    }
    const en = {
      'entry.label': 'DeepSeek Web',
      'panel.title': 'DeepSeek Web',
      'panel.subtitle': 'Uses your web quota, not the paid API',
      'composer.placeholder': 'Ask something… (Enter to send, Shift+Enter for newline)',
      'composer.send': 'Send',
      'composer.stop': 'Stop',
      'toggle.thinking': 'Deep thinking',
      'toggle.search': 'Web search',
      'action.clear': 'Clear',
      'action.settings': 'Settings',
      'action.back': 'Back',
      'side.new': 'New chat',
      'side.multi': 'Select',
      'side.exitMulti': 'Exit select',
      'side.refresh': 'Refresh list',
      'side.pinned': 'Pinned',
      'side.today': 'Today',
      'side.yesterday': 'Yesterday',
      'side.week': 'Previous 7 days',
      'side.earlier': 'Earlier',
      'side.empty': 'No conversations yet',
      'side.loading': 'Loading…',
      'side.failed': 'Failed to load',
      'side.retry': 'Retry',
      'side.selected': '{n} / {max} selected',
      'side.batchPin': 'Pin',
      'side.batchDelete': 'Delete',
      'side.rename': 'Rename',
      'side.renameFailed': 'Rename failed',
      'side.pin': 'Pin',
      'side.unpin': 'Unpin',
      'side.pinLimit': 'Pinned conversation limit reached',
      'side.delete': 'Delete',
      'side.cancel': 'Cancel',
      'side.deleteWarn': 'Deleted conversations cannot be recovered, and share links made from them stop working.',
      'side.clearAll': 'Delete all conversations',
      'side.clearAllWarn': 'All conversations will be erased and cannot be recovered; share links stop working too.',
      'side.deleteAllConfirm': 'Delete all',
      'side.tooMany': 'You can select at most {n} conversations',
      'side.count': '{n} conversations',
      'side.maxNotice': 'Showing the latest {n} (the API ignores cursor paging in testing)',
      'login.title': 'Sign in (phone + SMS code)',
      'login.step1': 'Step 1: open chat.deepseek.com in a browser, click "Get code", and wait for the SMS.',
      'login.mobile': 'Phone number',
      'login.code': 'SMS code',
      'login.sendCode': 'Try sending',
      'login.sendHint': '"Try sending" only works when DeepSeek skips its captcha; it currently does not — use step 1 instead.',
      'login.sending': 'Sending…',
      'login.sent': 'Code sent — check your messages.',
      'login.submit': 'Sign in',
      'login.verifying': 'Signing in…',
      'login.ok': 'Signed in. The token is stored locally and never shown.',
      'login.logout': 'Sign out (clear token)',
      'login.loggedOut': 'Local token cleared.',
      'login.hint': 'Signing in only yields a credential stored on this machine; your password never passes through this plugin — DeepSeek web itself only supports SMS login.',
      'settings.token': 'Login token',
      'settings.tokenHint': 'Copy the `value` field of localStorage.userToken from chat.deepseek.com. See appendix A.',
      'settings.save': 'Save',
      'settings.saved': 'Saved',
      'settings.version': 'Plugin v{v} (client half; the host half changes only after a DSH restart)',
      'status.checking': 'Checking…',
      'status.ready': 'Connected',
      'status.noToken': 'No token configured',
      'status.invalid': 'Token invalid or expired',
      'thinking.title': 'Reasoning (click to collapse)',
      'thinking.titleWithSecs': 'Thought for {s}s',
      'search.summary': '{queries} queries · {pages} pages opened',
      'search.found': 'Found {n} web pages',
      'search.expandHint': ' (click to expand)',
      'search.browsed': 'Opened {n} pages',
      'search.queries': 'Queries: ',
      'answer.title': 'Answer',
      'answer.pending': 'Thinking…',
      'error.prefix': 'Error: ',
      'empty.hint': 'No conversation yet. Ask something below.',
    }

    let t = (key, params) => {
      const dict = (document.documentElement.lang || '').toLowerCase().startsWith('en') ? en : zh
      let text = dict[key] ?? key
      if (params !== undefined) {
        for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
      }
      return text
    }

    // ---- 样式（只走主题 token） ------------------------------------------
    const CSS = `
[data-dsw-root]{display:flex;flex-direction:column;height:100%;min-height:0;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
[data-dsw-head]{display:flex;align-items:center;gap:10px;padding:14px 18px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
[data-dsw-head] h2{margin:0;font-size:15px;font-weight:600}
[data-dsw-sub]{color:var(--dsw-alias-label-secondary);font-size:12px}
[data-dsw-dot]{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
[data-dsw-dot="ok"]{background:var(--dsw-alias-state-success-primary)}
[data-dsw-dot="bad"]{background:var(--dsw-alias-state-error-primary)}
[data-dsw-grow]{flex:1 1 auto}
[data-dsw-list]{flex:1 1 auto;min-height:0;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:14px}
[data-dsw-empty]{color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center;margin-top:40px}
[data-dsw-msg]{max-width:820px;border-radius:10px;padding:10px 13px;
  word-break:break-word;font-size:13.5px;line-height:1.62}
[data-dsw-msg="user"]{white-space:pre-wrap}
[data-dsw-msg] p{margin:0 0 8px;white-space:pre-wrap}
[data-dsw-msg] p:last-child{margin-bottom:0}
[data-dsw-msg] h3,[data-dsw-msg] h4{margin:12px 0 6px;font-weight:650;line-height:1.4;color:var(--dsw-alias-label-primary)}
[data-dsw-msg] h3{font-size:15px}
[data-dsw-msg] h4{font-size:14px}
[data-dsw-msg] ul,[data-dsw-msg] ol{margin:6px 0 9px;padding-left:21px}
[data-dsw-msg] li{margin:3px 0}
[data-dsw-msg] blockquote{margin:8px 0;padding:3px 10px;border-left:3px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-secondary)}
[data-dsw-msg] hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:10px 0}
[data-dsw-msg] a{color:var(--dsw-alias-brand-primary);text-decoration:none}
[data-dsw-msg] a:hover{text-decoration:underline}
/* 加粗要一眼看得出来：默认 400 在这个字号/配色下确实不够 */
[data-dsw-msg] strong{font-weight:800;color:var(--dsw-alias-label-primary)}
[data-dsw-msg] em{font-style:italic;color:var(--dsw-alias-label-secondary)}
[data-dsw-cite]{display:inline-block;min-width:15px;height:15px;line-height:15px;text-align:center;
  margin:0 1px;padding:0 3px;border-radius:8px;font-size:10px;font-weight:600;vertical-align:super;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  cursor:pointer;text-decoration:none}
[data-dsw-cite]:hover{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground, #fff)}
/* 表格：常被 DeepSeek 用来做对比，宽了要能横向滚，不能撑破面板 */
[data-dsw-table]{margin:9px 0;max-width:100%;overflow-x:auto}
[data-dsw-table] table{border-collapse:collapse;font-size:12.5px}
[data-dsw-table] th,[data-dsw-table] td{border:1px solid var(--dsw-alias-border-l1);
  padding:5px 10px;text-align:left;vertical-align:top;line-height:1.55}
[data-dsw-table] th{background:var(--dsw-alias-bg-layer-2);font-weight:650;
  color:var(--dsw-alias-label-primary);white-space:nowrap}
[data-dsw-table] tbody tr:nth-child(even) td{background:var(--dsw-alias-bg-layer-2)}
[data-dsw-search]{margin:0 0 10px;padding:8px 11px;border-radius:7px;
  background:var(--dsw-alias-bg-layer-2);font-size:12.5px}
[data-dsw-search] summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-weight:600;user-select:none}
[data-dsw-query]{margin-top:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6}
/* 搜索命中可能几十条：给个高度上限让它自己滚，而不是把面板撑到天上去 */
[data-dsw-sources]{margin-top:8px;display:flex;flex-direction:column;gap:7px;
  max-height:360px;overflow-y:auto;overscroll-behavior:contain}
[data-dsw-sourcerow]{display:flex;flex-direction:column;gap:2px}
/* 让"这是一个能点开的网页"一眼看得出来：主色 + 外链箭头 + 悬停下划线 */
[data-dsw-sourcerow] a{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;
  color:var(--dsw-alias-brand-primary);text-decoration:none;cursor:pointer}
[data-dsw-sourcerow] a:hover{text-decoration:underline}
[data-dsw-sourcerow] a::after{content:'↗';font-size:11px;opacity:.75}
[data-dsw-sitename]{font-size:11px;color:var(--dsw-alias-label-secondary)}
[data-dsw-browse]{display:flex;flex-direction:column;gap:7px;margin:0 0 10px;padding:8px 11px;
  border-radius:7px;background:var(--dsw-alias-bg-layer-2)}
[data-dsw-browse-head]{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:600}
[data-dsw-browse] [data-dsw-sourcerow] a{font-size:12.5px}
[data-dsw-msg="user"]{align-self:flex-end;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
[data-dsw-msg="assistant"]{align-self:flex-start;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2)}
[data-dsw-msg] pre{margin:8px 0;padding:9px 11px;overflow:auto;border-radius:7px;
  background:var(--dsw-alias-markdown-code-block);font-size:12.5px}
[data-dsw-msg] code{background:var(--dsw-alias-markdown-code-block);padding:1px 4px;border-radius:4px}
[data-dsw-think]{margin:0 0 10px;padding:8px 11px;border-radius:7px;
  border-left:3px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);font-size:12.5px}
[data-dsw-think] summary{cursor:pointer;user-select:none;font-weight:600;letter-spacing:.02em}
[data-dsw-think-body]{margin-top:6px;white-space:pre-wrap;line-height:1.55}
[data-dsw-label]{font-size:11px;letter-spacing:.06em;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
[data-dsw-pending]{color:var(--dsw-alias-label-secondary);font-style:italic}
[data-dsw-body]{flex:1 1 auto;min-height:0;display:flex}
[data-dsw-side]{flex:0 0 236px;min-width:0;display:flex;flex-direction:column;
  border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
[data-dsw-side-head]{display:flex;gap:6px;padding:10px;align-items:center}
[data-dsw-side-list]{flex:1 1 auto;min-height:0;overflow:auto;padding:0 8px 10px}
[data-dsw-side-foot]{padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);
  font-size:11px;color:var(--dsw-alias-label-secondary)}
[data-dsw-main]{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
[data-dsw-group]{font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);padding:10px 6px 4px}
[data-dsw-item]{margin-bottom:2px}
[data-dsw-session]{display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:7px;
  cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary)}
[data-dsw-session]:hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-dsw-session="active"]{background:var(--dsw-alias-bg-layer-2)}
[data-dsw-session-title]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-dsw-session-when]{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
[data-dsw-session-pin]{flex:none;font-size:11px;color:var(--dsw-alias-brand-primary)}
[data-dsw-icon-btn]{flex:none;border:none;background:transparent;cursor:pointer;font-size:14px;
  line-height:1;padding:2px 4px;border-radius:5px;color:var(--dsw-alias-label-secondary)}
[data-dsw-icon-btn]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
[data-dsw-itemmenu]{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px 8px;
  border-radius:7px;background:var(--dsw-alias-bg-layer-2)}
[data-dsw-warn]{color:var(--dsw-alias-state-warn-primary);font-size:12px}
[data-dsw-err]{align-self:center;color:var(--dsw-alias-state-error-primary);font-size:12.5px}
[data-dsw-foot]{border-top:1px solid var(--dsw-alias-border-l1);padding:12px 18px;display:flex;flex-direction:column;gap:10px}
[data-dsw-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
[data-dsw-input]{width:100%;box-sizing:border-box;resize:vertical;min-height:64px;max-height:240px;
  border-radius:9px;padding:10px 12px;font:inherit;font-size:13.5px;
  background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1)}
[data-dsw-input]:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
[data-dsw-btn]{border-radius:8px;padding:5px 13px;font-size:12.5px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
[data-dsw-btn]:hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-dsw-btn="primary"]{background:var(--dsw-alias-brand-primary);border-color:transparent;
  color:var(--dsw-alias-label-primary-foreground, #fff)}
[data-dsw-btn]:disabled{opacity:.5;cursor:not-allowed}
[data-dsw-chip]{display:inline-flex;align-items:center;gap:5px;font-size:12px;
  color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
[data-dsw-set]{padding:18px;display:flex;flex-direction:column;gap:10px;max-width:680px}
[data-dsw-set] label{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
[data-dsw-note]{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
`
    const CSS_ID = '@local/dsh-deepseek-web/client.css'

    // ---- markdown 渲染（无打包器，手写一个够用的块级/行内解析器） --------------
    // 之前只认代码块和 **粗体**，于是 ### 标题、* 列表、[reference:N] 全被当纯文本吐出来。
    function renderInline(text, refs, byId) {
      const nodes = []
      const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\[reference:\d+\])/g
      let last = 0
      let key = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) {
          nodes.push(h('strong', { key: key++ }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          nodes.push(h('code', { key: key++ }, token.slice(1, -1)))
        } else if (token.startsWith('[reference:')) {
          const index = Number(token.slice('[reference:'.length, -1))
          const ref = Array.isArray(refs) ? refs[index] : undefined
          const source = ref === undefined || ref === null ? undefined : byId[String(ref.id)]
          const url = source === undefined ? '' : String(source.url ?? '')
          const tip = source === undefined
            ? `reference:${index}`
            : `${source.title !== '' ? source.title : source.label ?? ''} ${url}`.trim()
          // 有链接就渲染成**真链接**（之前是个只有 title 的 <sup>，所以点不动）
          nodes.push(url === ''
            ? h('sup', { key: key++, 'data-dsw-cite': '', title: tip }, String(index + 1))
            : h('a', {
                key: key++, 'data-dsw-cite': '', href: url, target: '_blank', rel: 'noreferrer', title: tip,
              }, String(index + 1)))
        } else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          if (link === null) nodes.push(token)
          else nodes.push(h('a', { key: key++, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]))
        } else {
          nodes.push(h('em', { key: key++ }, token.slice(1, -1)))
        }
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    const BLOCK_START = /^(#{1,4}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*>)/
    function renderMarkdown(text, refs, byId) {
      const lines = String(text).split('\n')
      const blocks = []
      let i = 0
      let key = 0
      while (i < lines.length) {
        const line = lines[i]
        if (/^```/.test(line)) {
          const body = []
          i += 1
          while (i < lines.length && /^```/.test(lines[i]) === false) { body.push(lines[i]); i += 1 }
          i += 1
          blocks.push(h('pre', { key: key++ }, h('code', null, body.join('\n'))))
          continue
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line)
        if (heading !== null) {
          const level = heading[1].length
          blocks.push(h(level <= 2 ? 'h3' : 'h4', { key: key++ }, renderInline(heading[2], refs, byId)))
          i += 1
          continue
        }
        if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push(h('hr', { key: key++ })); i += 1; continue }
        if (/^\s*[-*+]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            items.push(h('li', { key: key++ }, renderInline(lines[i].replace(/^\s*[-*+]\s+/, ''), refs, byId)))
            i += 1
          }
          blocks.push(h('ul', { key: key++ }, items))
          continue
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
            items.push(h('li', { key: key++ }, renderInline(lines[i].replace(/^\s*\d+[.)]\s+/, ''), refs, byId)))
            i += 1
          }
          blocks.push(h('ol', { key: key++ }, items))
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const body = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            body.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          blocks.push(h('blockquote', { key: key++ }, renderInline(body.join('\n'), refs, byId)))
          continue
        }
        // 表格：一行 | a | b | 紧跟分隔行 |---|---|（也支持不写首尾竖线的写法）
        // 之前完全没处理，于是整张表被当纯文本吐出来 —— 用户看到的就是一堆竖线。
        const isTableSeparator = (row) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(row) && row.includes('-')
        if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
          const splitRow = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
          const header = splitRow(line)
          i += 2
          const rows = []
          while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
            rows.push(splitRow(lines[i]))
            i += 1
          }
          blocks.push(h('div', { key: key++, 'data-dsw-table': '' },
            h('table', null,
              h('thead', null, h('tr', null, header.map((cell, cellIndex) => (
                h('th', { key: cellIndex }, renderInline(cell, refs, byId))
              )))),
              h('tbody', null, rows.map((row, rowIndex) => h('tr', { key: rowIndex },
                header.map((_, cellIndex) => h('td', { key: cellIndex },
                  renderInline(row[cellIndex] === undefined ? '' : row[cellIndex], refs, byId)))))))))
          continue
        }
        if (line.trim() === '') { i += 1; continue }
        const paragraph = []
        while (i < lines.length && lines[i].trim() !== '' && BLOCK_START.test(lines[i]) === false) {
          paragraph.push(lines[i])
          i += 1
        }
        blocks.push(h('p', { key: key++ }, renderInline(paragraph.join('\n'), refs, byId)))
      }
      return blocks
    }

    /** 搜索卡：一行「搜索到 N 个网页」，点开是实际搜到的网页（每条可点）。 */
    function SearchCard({ block }) {
      const results = Array.isArray(block.results) ? block.results : []
      const children = []
      if (block.queries !== undefined && block.queries.length > 0) {
        children.push(h('div', { key: 'q', 'data-dsw-query': '' }, `${t('search.queries')}${block.queries.join(' / ')}`))
      }
      if (results.length > 0) {
        children.push(h('div', { key: 'r', 'data-dsw-sources': '' },
          results.map((result, index) => h(SourceRow, { key: index, source: result }))))
      }
      return h('details', { 'data-dsw-search': '', open: false },
        h('summary', null, `${t('search.found', { n: block.resultCount ?? results.length })}${t('search.expandHint')}`),
        children)
    }

    function SourceRow({ source }) {
      const label = source.title !== undefined && source.title !== '' ? source.title : source.url
      return h('div', { 'data-dsw-sourcerow': '' },
        h('a', { href: source.url, target: '_blank', rel: 'noreferrer' }, label),
        source.siteName === undefined || source.siteName === '' ? null : h('span', { 'data-dsw-sitename': '' }, source.siteName))
    }

    /**
     * 按**片段原顺序**交错渲染：思考段 → 搜索卡 → 浏览的页面 → 思考段 → … → 答案。
     * 之前是把思考合并成一块、再列搜索、最后答案，网页端的时序信息就丢了。
     * 连续的"浏览的页面"归成一组成员，标题写「浏览 N 个页面」。
     */
    function MessageRow({ message }) {
      const isUser = message.role === 'user'
      if (isUser) return h('div', { 'data-dsw-msg': 'user' }, message.content)
      const blocks = Array.isArray(message.blocks) ? message.blocks : []
      const refs = Array.isArray(message.refs) ? message.refs : []
      // byId 由块现算：引用角标 [reference:N] → refs[N].id → 对应来源/搜索卡
      const byId = {}
      for (const block of blocks) {
        if (block.id !== null && block.id !== undefined) byId[String(block.id)] = block
      }
      const children = []
      let answerCount = 0
      let index = 0
      while (index < blocks.length) {
        const block = blocks[index]
        if (block.kind === 'source') {
          const group = []
          while (index < blocks.length && blocks[index].kind === 'source') {
            group.push(blocks[index])
            index += 1
          }
          children.push(h('div', { 'data-dsw-browse': '', key: `g${index}` },
            h('div', { 'data-dsw-browse-head': '' }, t('search.browsed', { n: group.length })),
            group.map((item, i) => h(SourceRow, { key: i, source: item }))))
          continue
        }
        if (block.kind === 'thinking') {
          const secs = Number(block.secs) || 0
          children.push(h('details', { 'data-dsw-think': '', open: true, key: `t${index}` },
            h('summary', null, secs > 0 ? t('thinking.titleWithSecs', { s: secs.toFixed(1) }) : t('thinking.title')),
            h('div', { 'data-dsw-think-body': '' }, block.text)))
        } else if (block.kind === 'search') {
          children.push(h(SearchCard, { key: `s${index}`, block }))
        } else if (block.kind === 'answer') {
          answerCount += 1
          children.push(h('div', { key: `a${index}`, 'data-dsw-answer': '' },
            answerCount === 1 ? h('div', { 'data-dsw-label': '' }, t('answer.title')) : null,
            renderMarkdown(block.text, refs, byId)))
        }
        index += 1
      }
      if (answerCount === 0) {
        children.push(h('span', { key: 'pending', 'data-dsw-pending': '' },
          blocks.length === 0 ? '…' : t('answer.pending')))
      }
      return h('div', { 'data-dsw-msg': 'assistant' }, children)
    }

    // ---- 面板 ------------------------------------------------------------
    const SELECT_MAX = 99          // 官方文案：最多可选择 99 个对话

    // ---- 深度思考 / 联网搜索：**按对话**记忆，且跨重启保留（官方也是每个对话各自记） ----
    const TOGGLE_KEY = 'dsh.deepseekWeb.toggles.v1'
    function readToggleStore() {
      try {
        const raw = localStorage.getItem(TOGGLE_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch { return {} }
    }
    function writeToggleStore(store) {
      try { localStorage.setItem(TOGGLE_KEY, JSON.stringify(store)) } catch { /* ignore */ }
    }
    function readDefaultToggles() {
      const saved = readToggleStore().__default
      return { thinking: saved?.thinking === true, search: saved?.search === true }
    }

    // ---- 流式积木：把事件按到达顺序拼成 blocks，保住网页端的时序 ----
    function pushThinking(blocks, text) {
      const next = Array.isArray(blocks) ? blocks.slice() : []
      const last = next[next.length - 1]
      if (last !== undefined && last.kind === 'thinking') next[next.length - 1] = { ...last, text: last.text + text }
      else next.push({ kind: 'thinking', text, secs: 0 })
      return next
    }
    function pushAnswer(blocks, text) {
      const next = Array.isArray(blocks) ? blocks.slice() : []
      const last = next[next.length - 1]
      if (last !== undefined && last.kind === 'answer') next[next.length - 1] = { ...last, text: last.text + text }
      else next.push({ kind: 'answer', text })
      return next
    }
    function addThinkingSecs(blocks, secs) {
      const next = Array.isArray(blocks) ? blocks.slice() : []
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i].kind === 'thinking') {
          next[i] = { ...next[i], secs: (Number(next[i].secs) || 0) + secs }
          break
        }
      }
      return next
    }

    /** 会话按时间分组：置顶 / 今天 / 昨天 / 7 天内 / 更早（官方没有独立端点，是客户端分组）。 */
    function groupSessions(sessions) {
      const now = new Date()
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
      const buckets = [
        { key: 'today', labelKey: 'side.today', from: startOfToday, items: [] },
        { key: 'yesterday', labelKey: 'side.yesterday', from: startOfToday - 86400, items: [] },
        { key: 'week', labelKey: 'side.week', from: startOfToday - 6 * 86400, items: [] },
        { key: 'earlier', labelKey: 'side.earlier', from: -Infinity, items: [] },
      ]
      const pinned = { key: 'pinned', labelKey: 'side.pinned', items: [] }
      for (const session of sessions) {
        if (session.pinned === true) { pinned.items.push(session); continue }
        const at = typeof session.updatedAt === 'number' ? session.updatedAt : (session.insertedAt ?? 0)
        const bucket = buckets.find((item) => at >= item.from) ?? buckets[buckets.length - 1]
        bucket.items.push(session)
      }
      const out = []
      if (pinned.items.length > 0) out.push({ key: pinned.key, label: t(pinned.labelKey), items: pinned.items })
      for (const bucket of buckets) {
        if (bucket.items.length > 0) out.push({ key: bucket.key, label: t(bucket.labelKey), items: bucket.items })
      }
      return out
    }

    function formatWhen(ts) {
      if (typeof ts !== 'number' || ts <= 0) return ''
      const date = new Date(ts * 1000)
      const now = new Date()
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      if (date.getTime() >= startOfToday) {
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
      }
      if (date.getTime() >= startOfToday - 86400000) return t('side.yesterday')
      if (date.getTime() >= startOfToday - 6 * 86400000) return `${date.getMonth() + 1}/${date.getDate()}`
      return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
    }

    function SessionRow(props) {
      const { session, active, selectMode, selected, menuOpen, renaming, renameDraft } = props
      const stop = (event, fn) => (e) => { e.stopPropagation(); fn() }
      return h('div', { 'data-dsw-item': '' },
        h('div', {
          'data-dsw-session': active === true ? 'active' : '',
          onClick: () => (selectMode === true ? props.onToggleSelect() : props.onOpen()),
        },
          selectMode === true ? h('input', { type: 'checkbox', checked: selected, readOnly: true }) : null,
          session.pinned === true ? h('span', { 'data-dsw-session-pin': '' }, '★') : null,
          renaming === true
            ? h('input', {
                'data-dsw-input': '', style: { padding: '2px 6px', minHeight: '0' }, value: renameDraft,
                onChange: (event) => props.onRenameDraft(event.target.value),
                onClick: (event) => event.stopPropagation(),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') props.onCommitRename()
                  else if (event.key === 'Escape') props.onCancelRename()
                },
              })
            : h('span', { 'data-dsw-session-title': '' }, session.title),
          renaming === true
            ? h('button', { 'data-dsw-icon-btn': '', onClick: stop(null, props.onCommitRename) }, '✓')
            : h('span', { 'data-dsw-session-when': '' }, formatWhen(session.updatedAt)),
          (selectMode === true || renaming === true)
            ? null
            : h('button', { 'data-dsw-icon-btn': '', onClick: stop(null, props.onMenu) }, '⋯')),
        menuOpen === true
          ? h('div', { 'data-dsw-itemmenu': '' },
              h('button', { 'data-dsw-btn': '', onClick: props.onStartRename }, t('side.rename')),
              h('button', { 'data-dsw-btn': '', onClick: props.onTogglePin },
                session.pinned === true ? t('side.unpin') : t('side.pin')),
              h('button', { 'data-dsw-btn': '', onClick: props.onAskDelete }, t('side.delete')))
          : null)
    }

    function Panel({ api }) {
      const [sessions, setSessions] = useState([])
      const [sessionsState, setSessionsState] = useState('loading')   // loading | ready | failed
      const [activeId, setActiveId] = useState(() => api.activeSessionId())
      const [messages, setMessages] = useState([])
      const [messagesState, setMessagesState] = useState('idle')
      // 线程锚点：上一条消息的 id。发请求时带上它，网页端才不会把每轮都当成新分支。
      const [lastMessageId, setLastMessageId] = useState(null)
      const [menuFor, setMenuFor] = useState(null)
      const [renaming, setRenaming] = useState(null)
      const [renameDraft, setRenameDraft] = useState('')
      const [selectMode, setSelectMode] = useState(false)
      const [selected, setSelected] = useState([])
      const [confirming, setConfirming] = useState(null)              // {kind, ids}
      const [notice, setNotice] = useState('')
      const [input, setInput] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [view, setView] = useState('chat')
      const [status, setStatus] = useState({ state: 'checking' })
      const [thinking, setThinking] = useState(() => readDefaultToggles().thinking)
      const [search, setSearch] = useState(() => readDefaultToggles().search)
      const togglesRef = useRef(readToggleStore())
      // 勾选的"活值"镜像：连点两个勾选时，第二次必须看到第一次的结果，
      // 不能依赖闭包里那份（上一次渲染的）state，否则会互相覆盖。
      const liveToggles = useRef({ thinking: readDefaultToggles().thinking, search: readDefaultToggles().search })
      const abortRef = useRef(null)
      const listRef = useRef(null)
      const historySeq = useRef(0)

      const loadSessions = useCallback(async () => {
        setSessionsState('loading')
        try {
          const result = await api.listSessions(100)
          if (result.ok !== true) throw new Error(result.message ?? '')
          const list = Array.isArray(result.sessions) ? result.sessions : []
          setSessions(list)
          setSessionsState('ready')
          setActiveId((current) => (current === null || current === undefined ? (list[0]?.id ?? null) : current))
        } catch (err) {
          setSessionsState('failed')
          setNotice(String(err?.message ?? err))
        }
      }, [api])

      useEffect(() => { void loadSessions() }, [loadSessions])

      useEffect(() => {
        let cancelled = false
        api.status().then((result) => {
          if (cancelled) return
          if (result.configured !== true) setStatus({ state: 'noToken' })
          else if (result.tokenValid === true) setStatus({ state: 'ready' })
          else setStatus({ state: 'invalid', message: result.message ?? '' })
        }, (err) => { if (!cancelled) setStatus({ state: 'invalid', message: String(err?.message ?? err) }) })
        return () => { cancelled = true }
      }, [api])

      // 会话消息改为「服务端为准」：切会话就重新拉，且作废在途请求（避免竞态串台）
      useEffect(() => {
        if (activeId === null || activeId === undefined) { setMessages([]); setMessagesState('idle'); setLastMessageId(null); return undefined }
        api.rememberSession(activeId)
        const seq = ++historySeq.current
        setMessagesState('loading')
        setLastMessageId(null)
        api.loadMessages(activeId).then((result) => {
          if (seq !== historySeq.current) return
          if (result.ok !== true) throw new Error(result.message ?? '')
          const list = Array.isArray(result.messages) ? result.messages : []
          setMessages(list)
          setMessagesState('ready')
          // 历史里最后一条带 id 的消息就是下一次的 parent —— 这就是"线性对话"的锚点
          const anchor = [...list].reverse().find((m) => typeof m.id === 'number')
          setLastMessageId(anchor === undefined ? null : anchor.id)
          if (typeof result.session?.title === 'string' && result.session.title !== '') {
            const title = result.session.title
            setSessions((previous) => previous.map((s) => (s.id === activeId ? { ...s, title } : s)))
          }
        }, (err) => {
          if (seq !== historySeq.current) return
          setMessagesState('failed')
          setNotice(String(err?.message ?? err))
        })
        return () => { historySeq.current += 1 }
      }, [activeId, api])

      useEffect(() => {
        const node = listRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [messages])

      // 切到某个对话 → 载入它自己记住的勾选（没记录就沿用当前默认）
      useEffect(() => {
        if (activeId === null || activeId === undefined) return
        const saved = togglesRef.current[String(activeId)]
        if (saved === undefined) return
        liveToggles.current = { thinking: saved.thinking === true, search: saved.search === true }
        setThinking(saved.thinking === true)
        setSearch(saved.search === true)
      }, [activeId])

      /** 改勾选：立刻写入该对话，同时更新"新对话的默认值"。 */
      const rememberToggles = useCallback((sessionId, next) => {
        const store = togglesRef.current
        store.__default = next
        if (typeof sessionId === 'string' && sessionId !== '') store[sessionId] = next
        writeToggleStore(store)
      }, [])

      const onToggle = useCallback((key, value) => {
        const next = { ...liveToggles.current, [key]: value }
        liveToggles.current = next
        setThinking(next.thinking)
        setSearch(next.search)
        rememberToggles(activeId, next)
      }, [activeId, rememberToggles])

      const patchLast = useCallback((patch) => {
        setMessages((previous) => {
          const next = previous.slice()
          const last = next[next.length - 1]
          if (last === undefined || last.role !== 'assistant') return previous
          next[next.length - 1] = { ...last, ...patch(last) }
          return next
        })
      }, [])

      const openSession = useCallback((id) => {
        setMenuFor(null)
        setRenaming(null)
        setNotice('')
        setError('')
        setActiveId(id)
      }, [])

      const startNew = useCallback(async () => {
        setNotice(''); setError(''); setMenuFor(null)
        try {
          const result = await api.newSession()
          if (result.ok !== true) throw new Error(result.message ?? '')
          setMessages([])
          setMessagesState('ready')
          setSelectMode(false)
          setSelected([])
          setActiveId(result.sessionId)
          await loadSessions()
        } catch (err) {
          setNotice(String(err?.message ?? err))
        }
      }, [api, loadSessions])

      const commitRename = useCallback(async (id) => {
        const title = renameDraft.trim()
        setRenaming(null)
        if (title === '') return
        const result = await api.renameSession(id, title)
        if (result.ok !== true) { setNotice(result.message ?? t('side.renameFailed')); return }
        setSessions((previous) => previous.map((s) => (s.id === id ? { ...s, title } : s)))
      }, [api, renameDraft])

      const togglePin = useCallback(async (session) => {
        setMenuFor(null)
        const pinned = session.pinned !== true
        const result = await api.pinSessions([session.id], pinned)
        if (result.ok !== true) { setNotice(result.message ?? ''); return }
        if (Array.isArray(result.illegal) && result.illegal.length > 0) { setNotice(t('side.pinLimit')); return }
        setSessions((previous) => previous.map((s) => (s.id === session.id ? { ...s, pinned } : s)))
      }, [api])

      const doDelete = useCallback(async (ids) => {
        setConfirming(null)
        const result = await api.deleteSessions(ids)
        if (result.ok !== true) { setNotice(result.message ?? ''); return }
        setSessions((previous) => previous.filter((s) => ids.includes(s.id) !== true))
        setSelected([])
        setSelectMode(false)
        if (activeId !== null && ids.includes(activeId)) { setActiveId(null); setMessages([]) }
      }, [activeId, api])

      const doDeleteAll = useCallback(async () => {
        setConfirming(null)
        const result = await api.deleteAllSessions()
        if (result.ok !== true) { setNotice(result.message ?? ''); return }
        setSessions([]); setMessages([]); setActiveId(null); setSelected([]); setSelectMode(false)
      }, [api])

      const toggleSelected = useCallback((id) => {
        setSelected((previous) => {
          if (previous.includes(id)) return previous.filter((item) => item !== id)
          if (previous.length >= SELECT_MAX) { setNotice(t('side.tooMany', { n: SELECT_MAX })); return previous }
          return [...previous, id]
        })
      }, [])

      const batchPin = useCallback(async (pinned) => {
        if (selected.length === 0) return
        const result = await api.pinSessions(selected, pinned)
        if (result.ok !== true) { setNotice(result.message ?? ''); return }
        const illegal = Array.isArray(result.illegal) ? result.illegal : []
        setSessions((previous) => previous.map((s) => (
          selected.includes(s.id) && illegal.includes(s.id) !== true ? { ...s, pinned } : s
        )))
        if (illegal.length > 0) setNotice(t('side.pinLimit'))
        setSelected([])
      }, [api, selected])

      const send = useCallback(async () => {
        const prompt = input.trim()
        if (prompt === '' || busy) return
        setInput('')
        setError('')
        setBusy(true)
        setNotice('')
        setMessages((previous) => [
          ...previous,
          { role: 'user', content: prompt },
          { role: 'assistant', content: '', thinking: '', blocks: [], refs: [] },
        ])
        const abort = new AbortController()
        abortRef.current = abort
        try {
          await api.chat({
            prompt,
            sessionId: activeId ?? undefined,
            parentMessageId: lastMessageId ?? undefined,
            thinking,
            search,
            signal: abort.signal,
            onMeta: (meta) => {
              if (typeof meta.sessionId === 'string' && meta.sessionId !== '') {
                api.rememberSession(meta.sessionId)
                setActiveId((current) => current ?? meta.sessionId)
                // 新对话也要记住当前的勾选，之后切回来才不会丢
                rememberToggles(meta.sessionId, { thinking, search })
              }
              if (typeof meta.responseMessageId === 'number') setLastMessageId(meta.responseMessageId)
            },
            onDelta: (text) => patchLast((last) => ({ blocks: pushAnswer(last.blocks, text), content: last.content + text })),
            onThinking: (text) => patchLast((last) => ({
              blocks: pushThinking(last.blocks, text),
              thinking: (last.thinking ?? '') + text,
            })),
            onThinkingTime: (secs) => patchLast((last) => ({ blocks: addThinkingSecs(last.blocks, Number(secs) || 0) })),
            onSearch: (payload) => patchLast((last) => ({
              blocks: [...(last.blocks ?? []), {
                kind: 'search', id: payload.fragmentId ?? null, label: payload.label ?? '',
                queries: Array.isArray(payload.queries) ? payload.queries : [],
                resultCount: payload.resultCount ?? 0,
                results: Array.isArray(payload.results) ? payload.results : [],
              }],
            })),
            onSource: (payload) => patchLast((last) => ({
              blocks: [...(last.blocks ?? []), {
                kind: 'source', id: payload.fragmentId ?? null, url: payload.url ?? '',
                title: payload.title ?? '', siteName: payload.siteName ?? '', snippet: payload.snippet ?? '',
              }],
            })),
            onRefs: (refs) => patchLast(() => ({ refs: Array.isArray(refs) ? refs : [] })),
          })
          void loadSessions()
        } catch (err) {
          if (abort.signal.aborted !== true) setError(String(err?.message ?? err))
        } finally {
          abortRef.current = null
          setBusy(false)
        }
      }, [activeId, api, busy, input, lastMessageId, loadSessions, patchLast, rememberToggles, search, thinking])

      const stop = useCallback(() => {
        abortRef.current?.abort()
        api.stop().catch(() => {})
        setBusy(false)
      }, [api])

      const onKeyDown = (event) => {
        if (event.key === 'Enter' && event.shiftKey !== true) {
          event.preventDefault()
          void send()
        }
      }

      const statusText = {
        checking: t('status.checking'), ready: t('status.ready'),
        noToken: t('status.noToken'), invalid: t('status.invalid'),
      }[status.state] ?? ''
      const dot = status.state === 'ready' ? 'ok' : (status.state === 'noToken' || status.state === 'invalid' ? 'bad' : 'idle')
      const groups = groupSessions(sessions)

      if (view === 'settings') {
        return h('div', { 'data-dsw-root': '' },
          h('div', { 'data-dsw-head': '' },
            h('h2', null, t('panel.title')),
            h('div', { 'data-dsw-grow': '' }),
            h('button', { 'data-dsw-btn': '', onClick: () => setView('chat') }, t('action.back'))),
          h(SettingsView, { api, onSaved: () => setStatus({ state: 'ready' }) }))
      }

      const sidebar = h('div', { 'data-dsw-side': '' },
        h('div', { 'data-dsw-side-head': '' },
          h('button', { 'data-dsw-btn': 'primary', onClick: () => void startNew() }, t('side.new')),
          h('button', {
            'data-dsw-btn': '',
            onClick: () => { setSelectMode((value) => value !== true); setSelected([]); setMenuFor(null) },
          }, selectMode === true ? t('side.exitMulti') : t('side.multi')),
          h('button', { 'data-dsw-btn': '', title: t('side.refresh'), onClick: () => void loadSessions() }, '⟳')),
        selectMode === true
          ? h('div', { 'data-dsw-itemmenu': '' },
              h('span', { 'data-dsw-session-when': '' }, t('side.selected', { n: selected.length, max: SELECT_MAX })),
              h('button', {
                'data-dsw-btn': '', disabled: selected.length === 0, onClick: () => void batchPin(true),
              }, t('side.batchPin')),
              h('button', {
                'data-dsw-btn': '', disabled: selected.length === 0,
                onClick: () => setConfirming({ kind: 'delete', ids: selected }),
              }, t('side.batchDelete')))
          : null,
        h('div', { 'data-dsw-side-list': '' },
          sessionsState === 'loading' && sessions.length === 0 ? h('div', { 'data-dsw-group': '' }, t('side.loading')) : null,
          sessionsState === 'failed'
            ? h('div', { 'data-dsw-group': '' },
                t('side.failed'),
                h('button', { 'data-dsw-btn': '', onClick: () => void loadSessions() }, t('side.retry')))
            : null,
          sessionsState === 'ready' && sessions.length === 0 ? h('div', { 'data-dsw-group': '' }, t('side.empty')) : null,
          groups.map((group) => h('div', { key: group.key },
            h('div', { 'data-dsw-group': '' }, group.label),
            group.items.map((session) => h(SessionRow, {
              key: session.id,
              session,
              active: session.id === activeId,
              selectMode,
              selected: selected.includes(session.id),
              menuOpen: menuFor === session.id,
              renaming: renaming === session.id,
              renameDraft,
              onOpen: () => openSession(session.id),
              onToggleSelect: () => toggleSelected(session.id),
              onMenu: () => setMenuFor(menuFor === session.id ? null : session.id),
              onStartRename: () => { setRenaming(session.id); setRenameDraft(session.title); setMenuFor(null) },
              onRenameDraft: setRenameDraft,
              onCommitRename: () => void commitRename(session.id),
              onCancelRename: () => setRenaming(null),
              onTogglePin: () => void togglePin(session),
              onAskDelete: () => { setMenuFor(null); setConfirming({ kind: 'delete', ids: [session.id] }) },
            }))))),
        h('div', { 'data-dsw-side-foot': '' },
          h('div', null, t('side.count', { n: sessions.length })),
          sessions.length >= 100 ? h('div', { 'data-dsw-warn': '' }, t('side.maxNotice', { n: sessions.length })) : null,
          h('button', {
            'data-dsw-btn': '', style: { marginTop: '6px' },
            onClick: () => setConfirming({ kind: 'deleteAll', ids: [] }),
          }, t('side.clearAll'))))

      return h('div', { 'data-dsw-root': '' },
        h('div', { 'data-dsw-head': '' },
          h('span', { 'data-dsw-dot': dot, title: statusText }),
          h('h2', null, t('panel.title')),
          h('span', { 'data-dsw-sub': '' }, `${statusText} · ${t('panel.subtitle')}`),
          h('div', { 'data-dsw-grow': '' }),
          h('button', { 'data-dsw-btn': '', onClick: () => setView('settings') }, t('action.settings'))),

        notice === '' ? null : h('div', { 'data-dsw-row': '', style: { padding: '6px 18px' } },
          h('span', { 'data-dsw-warn': '' }, notice),
          h('button', { 'data-dsw-btn': '', onClick: () => setNotice('') }, t('side.cancel'))),

        confirming === null ? null : h('div', { 'data-dsw-row': '', style: { padding: '6px 18px' } },
          h('span', { 'data-dsw-warn': '' },
            confirming.kind === 'deleteAll' ? t('side.clearAllWarn') : t('side.deleteWarn')),
          h('button', {
            'data-dsw-btn': 'primary',
            onClick: () => void (confirming.kind === 'deleteAll' ? doDeleteAll() : doDelete(confirming.ids)),
          }, confirming.kind === 'deleteAll' ? t('side.deleteAllConfirm') : t('side.delete')),
          h('button', { 'data-dsw-btn': '', onClick: () => setConfirming(null) }, t('side.cancel'))),

        h('div', { 'data-dsw-body': '' },
          sidebar,
          h('div', { 'data-dsw-main': '' },
            h('div', { 'data-dsw-list': '', ref: listRef },
              messagesState === 'loading' ? h('div', { 'data-dsw-empty': '' }, t('side.loading')) : null,
              messagesState === 'failed' ? h('div', { 'data-dsw-empty': '' }, t('side.failed')) : null,
              messages.length === 0 && messagesState !== 'loading'
                ? h('div', { 'data-dsw-empty': '' }, t('empty.hint'))
                : messages.map((message, index) => h(MessageRow, { key: index, message })),
              error === '' ? null : h('div', { 'data-dsw-err': '' }, `${t('error.prefix')}${error}`)),

            h('div', { 'data-dsw-foot': '' },
              h('textarea', {
                'data-dsw-input': '', value: input, placeholder: t('composer.placeholder'),
                onChange: (event) => setInput(event.target.value), onKeyDown,
              }),
              h('div', { 'data-dsw-row': '' },
                h('label', { 'data-dsw-chip': '' },
                  h('input', {
                    type: 'checkbox', checked: thinking,
                    onChange: (e) => onToggle('thinking', e.target.checked),
                  }),
                  t('toggle.thinking')),
                h('label', { 'data-dsw-chip': '' },
                  h('input', {
                    type: 'checkbox', checked: search,
                    onChange: (e) => onToggle('search', e.target.checked),
                  }),
                  t('toggle.search')),
                h('div', { 'data-dsw-grow': '' }),
                busy
                  ? h('button', { 'data-dsw-btn': '', onClick: stop }, t('composer.stop'))
                  : h('button', {
                      'data-dsw-btn': 'primary',
                      // 历史还在加载时禁止发送：此时线程锚点还没拿到，发出去会变成新分支
                      disabled: input.trim() === '' || messagesState === 'loading',
                      onClick: () => void send(),
                    }, t('composer.send')))))))
    }

    // （旧的 MessageRow 已删除：它把思考合并成一块、再列搜索、最后答案，时序信息丢失。
    //   现行版本在上面，按 blocks 原顺序渲染。）

    function SettingsView({ api, onSaved }) {
      const [token, setToken] = useState('')
      const [saved, setSaved] = useState(false)
      const [mobile, setMobile] = useState('')
      const [code, setCode] = useState('')
      const [phase, setPhase] = useState('idle')       // idle | sending | verifying
      const [notice, setNotice] = useState('')
      const [failed, setFailed] = useState(false)

      const digits = (value) => String(value).replace(/[^0-9]/g, '')

      const sendCode = useCallback(async () => {
        setPhase('sending'); setNotice(''); setFailed(false)
        try {
          const result = await api.sendCode(digits(mobile))
          if (result.ok === true) {
            setNotice(t('login.sent'))
          } else {
            setFailed(true)
            setNotice([result.message, result.hint].filter(Boolean).join('\n'))
          }
        } catch (error) {
          setFailed(true); setNotice(String(error?.message ?? error))
        } finally {
          setPhase('idle')
        }
      }, [api, mobile])

      const verify = useCallback(async () => {
        setPhase('verifying'); setNotice(''); setFailed(false)
        try {
          const result = await api.verify(digits(mobile), digits(code))
          if (result.ok === true) { setNotice(t('login.ok')); onSaved() }
          else { setFailed(true); setNotice(String(result.message ?? '')) }
        } catch (error) {
          setFailed(true); setNotice(String(error?.message ?? error))
        } finally {
          setPhase('idle')
        }
      }, [api, code, mobile, onSaved])

      const save = useCallback(async () => {
        await api.saveConfig({ token })
        setSaved(true)
        onSaved()
      }, [api, onSaved, token])

      const logout = useCallback(async () => {
        await api.saveConfig({ logout: true })
        setFailed(false)
        setNotice(t('login.loggedOut'))
        onSaved()
      }, [api, onSaved])

      const busy = phase !== 'idle'
      return h('div', { 'data-dsw-set': '' },
        h('label', null, t('login.title')),
        h('div', { 'data-dsw-note': '' }, t('login.step1')),
        h('div', { 'data-dsw-row': '' },
          h('input', {
            'data-dsw-input': '', style: { maxWidth: '200px' }, type: 'tel', inputMode: 'numeric',
            placeholder: t('login.mobile'), value: mobile, spellCheck: false,
            onChange: (event) => { setMobile(event.target.value); setNotice('') },
          }),
          h('input', {
            'data-dsw-input': '', style: { maxWidth: '150px' }, inputMode: 'numeric',
            placeholder: t('login.code'), value: code, spellCheck: false,
            onChange: (event) => { setCode(event.target.value); setNotice('') },
          }),
          h('button', {
            'data-dsw-btn': 'primary',
            disabled: digits(code).length < 4 || digits(mobile).length < 6 || busy,
            onClick: () => void verify(),
          }, phase === 'verifying' ? t('login.verifying') : t('login.submit'))),
        notice === ''
          ? null
          : h('div', {
              'data-dsw-note': '',
              style: failed ? { color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' } : { whiteSpace: 'pre-wrap' },
            }, notice),
        h('div', { 'data-dsw-row': '' },
          h('button', {
            'data-dsw-btn': '', disabled: digits(mobile).length < 6 || busy,
            onClick: () => void sendCode(),
          }, phase === 'sending' ? t('login.sending') : t('login.sendCode'))),
        h('div', { 'data-dsw-note': '' }, t('login.sendHint')),
        h('div', { 'data-dsw-note': '' }, t('login.hint')),
        h('button', {
          'data-dsw-btn': '', style: { alignSelf: 'flex-start' }, onClick: () => void logout(),
        }, t('login.logout')),

        h('div', { style: { height: '1px', background: 'var(--dsw-alias-border-l1)', margin: '8px 0' } }),
        h('label', null, t('settings.token')),
        h('input', {
          'data-dsw-input': '', type: 'password', value: token, spellCheck: false,
          onChange: (event) => { setToken(event.target.value); setSaved(false) },
        }),
        h('div', { 'data-dsw-note': '' }, t('settings.tokenHint')),
        h('div', { 'data-dsw-row': '' },
          h('button', { 'data-dsw-btn': 'primary', onClick: () => void save(), disabled: token.trim() === '' },
            t('settings.save')),
          saved ? h('span', { 'data-dsw-note': '' }, t('settings.saved')) : null),
        // 更新后先看这一行：前端刷新页面就会变，宿主只有重启 DSH 才会变
        h('div', { 'data-dsw-note': '', 'data-dsw-version': VERSION }, t('settings.version', { v: VERSION })))
    }

    // ---- 面板图标（只画图形，行/标签/高亮由宿主负责） --------------------
    function EntryIcon({ size }) {
      const s = typeof size === 'number' ? size : 18
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, 'data-dsh-panel-entry': NS,
      },
        h('path', { d: 'M3 13.5c2.5-4 6-6 10-6 2 0 3.5.6 5 1.8' }),
        h('path', { d: 'M12 7.5V4.2' }),
        h('circle', { cx: 12, cy: 3.2, r: 1 }),
        h('path', { d: 'M6.5 16.5c2 2.4 5 3.2 8.2 2.4' }),
        h('path', { d: 'M15.5 20.5c1.6-.6 2.8-1.7 3.5-3.2' }))
    }

    // ---- 与 Host 的通信 --------------------------------------------------
    const api = {
      async status() { return await json(`${API}/status`, { cache: 'no-store' }) },
      async config() { return await json(`${API}/config`, { cache: 'no-store' }) },
      async saveConfig(patch) {
        return await json(`${API}/config`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
        })
      },
      /** 第一步：让 Host 去要一条短信验证码。失败时返回 ok:false + hint（例如需要人机验证）。 */
      async sendCode(mobile) {
        return await json(`${API}/login/send-code`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mobile }),
        })
      },
      /** 第二步：用验证码换 token，Host 直接落盘，token 不回浏览器。 */
      async verify(mobile, code) {
        return await json(`${API}/login/verify`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mobile, code }),
        })
      },
      // ---- 会话（Phase 1：历史以服务端为准，本地只留偏好与当前会话 id）----
      activeSessionId() {
        try { return localStorage.getItem(SESSION_KEY) ?? null } catch { return null }
      },
      rememberSession(id) {
        try {
          if (typeof id === 'string' && id !== '') localStorage.setItem(SESSION_KEY, id)
        } catch { /* ignore */ }
      },
      forgetSession() {
        try { localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ }
      },
      async listSessions(count) {
        return await json(`${API}/sessions?count=${count ?? 100}`, { cache: 'no-store' })
      },
      async newSession() {
        return await json(`${API}/sessions/new`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })
      },
      async renameSession(id, title) {
        return await json(`${API}/sessions/rename`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, title }),
        })
      },
      async pinSessions(ids, pinned) {
        return await json(`${API}/sessions/pin`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, pinned }),
        })
      },
      async deleteSessions(ids) {
        return await json(`${API}/sessions/delete`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
        })
      },
      async deleteAllSessions() {
        return await json(`${API}/sessions/delete-all`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
        })
      },
      async loadMessages(id) {
        return await json(`${API}/session/messages?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
      },
      async stop() {
        return await json(`${API}/stop`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: api.currentRequestId, sessionId: api.activeSessionId() ?? '' }),
        })
      },
      /** 手写 SSE 读取：EventSource 不能 POST，所以用 fetch + ReadableStream。 */
      async chat({ prompt, sessionId, parentMessageId, thinking, search, signal, onMeta, onDelta, onThinking, onThinkingTime, onSearch, onSource, onRefs }) {
        const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
        api.currentRequestId = requestId
        const response = await fetch(`${API}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId, sessionId, parentMessageId, prompt, thinking, search }),
          signal,
        })
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.includes('event-stream')) {
          const text = await response.text()
          let message = `HTTP ${response.status}`
          try { message = JSON.parse(text).message ?? message } catch { /* 纯文本，例如未挂载时的 not found */ }
          throw new Error(message)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done === true) break
          buffer += decoder.decode(value, { stream: true })
          let index
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const raw = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            let event = 'message'
            let data = ''
            for (const line of raw.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('data:')) data += line.slice(5).trim()
            }
            if (data === '') continue
            let parsed
            try { parsed = JSON.parse(data) } catch { continue }
            if (event === 'meta') onMeta(parsed)
            else if (event === 'delta') onDelta(parsed.text ?? '')
            else if (event === 'thinking') onThinking(parsed.text ?? '')
            else if (event === 'thinking-time') { if (typeof onThinkingTime === 'function') onThinkingTime(parsed.elapsedSecs ?? 0) }
            else if (event === 'search') { if (typeof onSearch === 'function') onSearch(parsed) }
            else if (event === 'source') { if (typeof onSource === 'function') onSource(parsed) }
            else if (event === 'refs') { if (typeof onRefs === 'function') onRefs(parsed.references ?? []) }
            else if (event === 'error') throw new Error(parsed.message ?? 'upstream error')
          }
        }
      },
      currentRequestId: '',
    }

    async function json(url, init) {
      const response = await fetch(url, init)
      const text = await response.text()          // 未挂载的 /api/* 返回纯文本 not found
      let parsed
      try { parsed = JSON.parse(text) } catch { throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`) }
      if (response.ok !== true && parsed?.message === undefined) throw new Error(`HTTP ${response.status}`)
      return parsed
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) === null) {
            const tag = document.createElement('style')
            tag.dataset.plugin = '@local/dsh-deepseek-web'
            tag.dataset.pluginCss = CSS_ID
            tag.textContent = CSS
            document.head.appendChild(tag)
            ctx.effect(() => () => { tag.remove() }, 'deepseek-web: styles')
          }
          try {
            const locale = ctx.get('locale')
            if (locale !== undefined) {
              ctx.effect(() => locale.register(NS, { zh, en }), 'deepseek-web: dictionaries')
              const bound = locale.bind(NS)
              if (typeof bound === 'function') t = bound
            }
          } catch { /* locale 服务缺失时用文档语言兜底 */ }

          const slots = ctx.slots
          ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist', id: NS, order: 30, label: () => t('entry.label'),
          }, EntryIcon)), 'deepseek-web: sidebar entry')

          ctx.effect(() => slots.inject('main', () => slots.register({
            name: 'main', key: NS, inject: () => ({ api }),
          }, Panel)), 'deepseek-web: panel')
        } catch (error) {
          // apply 抛错会让整个 Web shell 启动失败，所以这里只记录。
          console.error('[deepseek-web] 面板挂载失败：', error)
        }
      },
    }
  },
})
