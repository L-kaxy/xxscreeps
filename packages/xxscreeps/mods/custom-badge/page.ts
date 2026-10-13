export const editorPage = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Badge Studio · Screeps</title>
<style>
:root{color-scheme:dark;--bg:#101519;--panel:#182025;--line:#303c43;--text:#e6ede8;--muted:#9daeb3;--accent:#73d7bd;--gold:#f5d58a;font:14px/1.6 system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text)}
button,input,select{font:inherit}
button{cursor:pointer;background:#243137;color:var(--text);border:1px solid #43545b;border-radius:6px;padding:8px 12px}
button:hover:not(:disabled){border-color:var(--accent);background:#30423f}
button:disabled{opacity:.4;cursor:not-allowed}
button.primary{background:var(--accent);border-color:var(--accent);color:#10251e;font-weight:700}
button.danger{color:#ffaaa0}
input,select{min-width:0;width:100%;background:#11191d;border:1px solid #40515a;border-radius:5px;color:var(--text);padding:6px 8px}
input[type=color]{height:38px;padding:3px;cursor:pointer}
input[type=checkbox]{width:auto}
a{color:var(--accent)}
h1,h2,h3,p{margin:0}
h1{font-size:29px;letter-spacing:-1px;font-weight:650}
h2{font-size:14px;font-weight:650}
h3{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}
.shell{max-width:1420px;margin:auto;padding:28px 32px}
.header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:25px}
.eyebrow{font-size:10px;font-weight:700;letter-spacing:2.8px;color:var(--accent);margin-bottom:4px}
.sub{color:var(--muted);font-size:12px}
.session{text-align:right;display:flex;gap:12px;align-items:center}
.dot{display:inline-block;width:7px;height:7px;background:var(--gold);border-radius:50%;margin-right:8px}
.grid{display:grid;grid-template-columns:240px minmax(300px,1fr) 250px;gap:16px;align-items:start}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px;min-width:0}
.panel+.panel{margin-top:16px}
.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.index{font:11px monospace;color:var(--muted)}
.tools{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.tool{min-height:63px;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px}
.tool span{font-size:20px;line-height:1.2;color:var(--accent)}
.tools .active{border-color:var(--gold)}
.colors{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:18px}
.colors label{font-size:10px;color:var(--muted)}
.label{font-size:12px;color:var(--muted);display:block;margin:10px 0 4px}
.layer-row{display:flex;gap:6px;align-items:center;margin-top:8px;padding:9px;border:1px solid var(--line);border-radius:6px;background:#121a1e}
.layer-row button{flex:1;text-align:left;padding:3px 7px;border:0;background:none;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.layer-row.selected{border-color:var(--accent)}
.swatch{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.canvas-panel{padding:20px}
.canvas-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:18px}
.canvas-box{background-color:#10171b;background-image:radial-gradient(#334048 1px,transparent 1px);background-size:18px 18px;border:1px solid var(--line);border-radius:7px;padding:14px;position:relative}
#canvas{display:block;width:100%;max-height:560px;aspect-ratio:1;touch-action:none;overflow:hidden;outline:none}
.canvas-help{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:11px;margin-top:14px}
.canvas-actions{display:flex;gap:7px}
.canvas-actions button{padding:4px 10px}
.row{display:flex;gap:8px}
.row>*{flex:1;min-width:0}
.props{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.props label{color:var(--muted);font-size:11px}
.props input,.props select{margin-top:3px}
.span2{grid-column:span 2}
.preview-big{display:flex;justify-content:center;padding:12px 0 20px}
.preview-big svg{width:128px;height:128px;filter:drop-shadow(0 8px 14px #0006)}
.preview-small{display:flex;justify-content:center;align-items:end;gap:26px;padding-top:12px;border-top:1px solid var(--line);text-align:center}
.preview-small small{display:block;color:var(--muted);font:10px monospace;margin-top:5px}
.hint{font-size:11px;color:var(--muted);margin-top:12px}
.footer{display:flex;gap:14px;align-items:center;justify-content:space-between;margin-top:18px}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.status{min-height:23px;color:var(--muted);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.status.error{color:#ffaaa0}
.status.success{color:var(--accent)}
.tag{border:1px solid #37564c;color:var(--accent);font:10px monospace;border-radius:4px;padding:3px 7px;white-space:nowrap}
.small{font-size:11px}
.login{margin-bottom:18px}
.login form{display:flex;align-items:end;gap:12px;flex-wrap:wrap}
.login label{display:block;min-width:140px;flex:1;color:var(--muted);font-size:12px}
.login input{margin-top:5px}
.login button{flex-shrink:0}
.login h2{margin-bottom:8px}
.admin{margin-top:20px}
.admin .row{max-width:600px}
.admin-output{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted);font-size:12px;margin:12px 0}
.hidden,[hidden]{display:none!important}
fieldset{padding:0;border:0;margin:0;min-width:0}
#layers{max-height:290px;overflow:auto}
.notice{margin-bottom:16px;border-left:3px solid var(--gold);padding:8px 12px;color:var(--gold);background:#28251e;font-size:12px}
.bottom-note{margin-top:22px;color:#7e969e;font-size:11px;border-top:1px solid var(--line);padding-top:14px;display:flex;justify-content:space-between;gap:10px}
.keyboard{font:10px monospace;border:1px solid #44525a;border-radius:3px;padding:0 4px}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--gold);outline-offset:2px}

@media(max-width:1080px){.shell{padding:20px}
.grid{grid-template-columns:210px minmax(300px,1fr)}
.right{grid-column:span 2;display:grid;grid-template-columns:1fr 1fr;gap:16px}
.right .panel+.panel{margin:0}
.preview-big{padding:0 0 12px}
}

@media(max-width:620px){.shell{padding:16px 12px}
.header{align-items:flex-start;gap:12px}
.session{font-size:11px;flex-wrap:wrap;justify-content:flex-end;max-width:150px}
.grid{display:flex;flex-direction:column}
.grid>*,.right{width:100%}
.left{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.left .panel+.panel{margin:0}
.panel{padding:12px}
.colors{gap:5px}
.right{display:grid;grid-template-columns:1fr}
.canvas-panel{order:-1}
.footer{align-items:flex-start;flex-direction:column}
.footer .actions{width:100%}
.footer .primary{flex:1}
.login form{display:block}
.login label{margin-top:7px}
.login button{margin-top:9px}
.bottom-note{flex-direction:column}
.canvas-help{font-size:10px}
.canvas-box{padding:0}
}

</style><script type="module" src="assets/editor.js"></script></head>
<body><main class="shell">
<header class="header"><div><div class="eyebrow">SCREEPS / IDENTITY LAB</div><h1>Badge Studio<span style="color:var(--accent)">.</span></h1><p class="sub">你的图案，你的身份。两个图层，无限组合。</p></div><div class="session"><span id="account"><span class="dot"></span>本地预览 · 未登录</span><button id="logout" hidden>退出</button></div></header>
<section class="panel login" id="login-panel"><h2>登录后保存到本服账号</h2><p class="sub" id="login-note">可先自由设计。登录不会改变地图或赛季数据。</p><form id="login-form"><label>用户名 / 邮箱<input id="identity" autocomplete="username" maxlength="254" required></label><label>本服密码<input id="password" type="password" autocomplete="current-password" maxlength="1024" required></label><button class="primary" type="submit">登录</button></form><button id="steam-login" hidden>使用 Steam 登录</button></section>
<div id="notice" class="notice" hidden></div>
<div class="grid"><aside class="left"><section class="panel"><div class="section-head"><h2>添加图形</h2><span class="index">01 / SHAPES</span></div><div class="tools"><button class="tool" data-kind="circle"><span aria-hidden="true">○</span>圆 / 椭圆</button><button class="tool" data-kind="rectangle"><span aria-hidden="true">□</span>矩形</button><button class="tool" data-kind="triangle"><span aria-hidden="true">△</span>三角形</button><button class="tool" id="polygon"><span aria-hidden="true">⬠</span>多边形</button></div><div id="polygon-tools" hidden><button id="finish-polygon">完成多边形</button><button id="cancel-polygon">取消</button></div><label class="label" for="add-layer">新图形所属图层</label><select id="add-layer"><option value="1">图层 1 · 下层</option><option value="2">图层 2 · 上层</option></select><div class="colors"><label>背景<input id="color0" type="color" aria-label="背景颜色"></label><label>图层 1<input id="color1" type="color" aria-label="图层一颜色"></label><label>图层 2<input id="color2" type="color" aria-label="图层二颜色"></label></div><p class="hint">同层图形合并填色，图层 2 始终覆盖图层 1。超出圆形边界的部分会被裁切。</p></section><section class="panel"><div class="section-head"><h2>图形列表</h2><span class="index" id="shape-count"></span></div><div id="layers"></div><p class="hint">点击选择；也可直接拖动画布中的图形。</p></section></aside>
<section class="panel canvas-panel"><div class="canvas-head"><h2>设计画布 <span class="tag">100 × 100</span></h2><div class="canvas-actions"><button id="undo" title="撤销 Ctrl/Cmd+Z" aria-label="撤销">↶</button><button id="redo" title="重做 Ctrl/Cmd+Shift+Z" aria-label="重做">↷</button><button id="new">新建</button></div></div><div class="canvas-box"><svg id="canvas" viewBox="-10 -10 120 120" role="img" aria-label="头像设计画布，点击图形选择并拖动" tabindex="0"></svg></div><div class="canvas-help"><span id="canvas-help">拖动图形调整位置 · 右侧编辑尺寸与角度</span><span>圆形裁切</span></div></section>
<aside class="right"><section class="panel"><div class="section-head"><h2>实际尺寸预览</h2><span class="index">02 / PREVIEW</span></div><div class="preview-big" id="preview128"></div><div class="preview-small"><div><div id="preview32"></div><small>32 PX</small></div><div><div id="preview64"></div><small>64 PX</small></div></div></section><section class="panel"><div class="section-head"><h2>图形属性</h2><span class="index" id="selection-label">未选中</span></div><fieldset id="properties" disabled><div class="props"><label>X 位置<input id="prop-x" type="number" min="0" max="100" step="0.5"></label><label>Y 位置<input id="prop-y" type="number" min="0" max="100" step="0.5"></label><label>宽度<input id="prop-width" type="number" min="0.5" max="200" step="0.5"></label><label>高度<input id="prop-height" type="number" min="0.5" max="200" step="0.5"></label><label>旋转角度<input id="prop-rotation" type="number" min="-180" max="180" step="1"></label><label>图层<select id="prop-layer"><option value="1">1 · 下层</option><option value="2">2 · 上层</option></select></label><label><input id="mirror-x" type="checkbox"> 水平镜像</label><label><input id="mirror-y" type="checkbox"> 垂直镜像</label><div class="row span2"><button id="duplicate">复制</button><button id="delete" class="danger">删除</button></div></div></fieldset><p class="hint">修改颜色和几何数据，不接受 SVG 文件、脚本或外链。</p></section></aside></div>
<div class="footer"><div><div id="status" class="status" role="status" aria-live="polite">正在连接本服…</div><span id="revision" class="sub">本地草稿</span></div><div class="actions"><button id="reload" disabled>重新载入</button><button id="reset" disabled>恢复默认头像</button><button id="save-draft" disabled>保存草稿</button><button class="primary" id="publish" disabled>保存并应用 ↗</button></div></div>
<section class="panel admin" id="admin-panel" hidden><h2>头像管理</h2><p class="hint">重置 / 禁用会清除对方的自定义设计和授权，并立即将账号头像恢复默认。解除禁用不会恢复旧图案。</p><div class="row"><input id="admin-user" placeholder="玩家账号 ID" aria-label="管理目标玩家 ID" maxlength="64"><button id="admin-load">查询玩家</button></div><div id="admin-output" class="admin-output"></div><div id="admin-actions" class="actions" hidden><button data-moderation="reset">重置头像</button><button data-moderation="block" class="danger">重置并禁用</button><button data-moderation="unblock">解除禁用</button></div></section>
<footer class="bottom-note"><span>账号头像 · 两个赛季共用 · 重生不清除 · 不影响游戏规则</span><span>完成后刷新游戏查看新头像。原版 Badge 编辑器仍然可用。</span></footer>
</main></body></html>`;
