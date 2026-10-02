/** A standalone board served by the backend; gameplay starts by placing a spawn in a group's left room. */
export const challengePage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>5 级要塞挑战 — xxscreeps</title>
<style>
:root { color-scheme: dark; font-family: system-ui, sans-serif; background: #161b22; color: #d5dfed; }
body { margin: 0; }
header, main { max-width: 1200px; margin: auto; padding: 24px; }
header { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; border-bottom: 1px solid #303c4c; }
h1 { margin: 0; font-size: 24px; color: #f0c674; }
h2 { font-size: 18px; margin: 0 0 16px; }
p { line-height: 1.6; color: #94a8c3; }
.status { margin-left: auto; color: #94a8c3; font-size: 13px; }
section { margin-bottom: 28px; padding: 22px; background: #1e2632; border: 1px solid #303c4c; border-radius: 10px; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; white-space: nowrap; }
th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid #303c4c; font-variant-numeric: tabular-nums; }
th { color: #94a8c3; font-size: 13px; font-weight: 500; }
tbody tr:hover { background: #263243; }
button { cursor: pointer; font: inherit; border: 1px solid #465b73; background: #263243; color: #d5dfed; padding: 7px 12px; border-radius: 6px; }
button:disabled { opacity: .4; cursor: default; }
button.player { border: 0; background: none; color: #7dc9de; padding: 0; }
.pager { display: flex; gap: 14px; align-items: center; margin-top: 18px; }
.empty { color: #94a8c3; padding: 24px 14px; }
.error { color: #ff9292; }
dialog { width: min(1000px, 85vw); border: 1px solid #465b73; border-radius: 10px; background: #1e2632; color: #d5dfed; }
dialog::backdrop { background: #0009; }
dialog form { float: right; }
@media (max-width: 600px) { header, main { padding: 16px; } section { padding: 14px; } .status { margin-left: 0; } }
</style>
</head>
<body>
<header><h1>5 级要塞挑战</h1><span class="status" id="status">正在读取比赛…</span><button id="refresh">刷新</button></header>
<main>
<p>在一组房间的左房放置 Spawn 开始挑战。成功成绩按用时 tick 排名，用时越短越靠前；点击玩家查看历次成功记录。</p>
<p id="error" class="error" role="alert" hidden></p>
<section><h2>正在挑战</h2><div class="scroll"><table><thead><tr><th>玩家</th><th>落地房</th><th>要塞房</th><th>已用 tick</th><th>剩余 tick</th></tr></thead><tbody id="racing"></tbody></table></div></section>
<section><h2>最快通关 · 每位玩家最佳成绩</h2><div class="scroll"><table><thead><tr><th>排名</th><th>玩家</th><th>用时 tick</th><th>落地房</th><th>要塞房</th><th>完成时间</th></tr></thead><tbody id="board"></tbody></table></div><div class="pager"><button id="previous">上一页</button><span id="range"></span><button id="next">下一页</button></div></section>
</main>
<dialog id="detail"><form method="dialog"><button>关闭</button></form><h2 id="detail-title">成功记录</h2><p id="detail-status"></p><div class="scroll"><table><thead><tr><th>本次排名</th><th>用时 tick</th><th>落地房</th><th>要塞房</th><th>完成 tick</th><th>完成时间</th></tr></thead><tbody id="records"></tbody></table></div></dialog>
<script>
'use strict';
const state = { offset: 0, limit: 25, busy: false, user: null };
const element = id => document.getElementById(id);
async function api(path) {
	const response = await fetch('/api/stronghold-challenge/' + path, { headers: { accept: 'application/json' } });
	if (!response.ok) { throw new Error('HTTP ' + response.status); }
	const payload = await response.json();
	if (payload.error) { throw new Error(payload.error); }
	return payload;
}
function recordedAt(at) { return at ? new Date(at).toLocaleString() : '—'; }
function player(user, users) {
	const button = document.createElement('button');
	button.className = 'player';
	button.textContent = users[user]?.username || user;
	button.addEventListener('click', () => openRecords(user));
	return button;
}
function table(id, rows, columns, empty) {
	const body = element(id);
	body.replaceChildren();
	for (const values of rows) {
		const row = document.createElement('tr');
		for (const value of values) {
			const cell = document.createElement('td');
			if (value instanceof Node) { cell.append(value); } else { cell.textContent = String(value ?? '—'); }
			row.append(cell);
		}
		body.append(row);
	}
	if (rows.length === 0) {
		const cell = document.createElement('td');
		cell.colSpan = columns;
		cell.className = 'empty';
		cell.textContent = empty;
		const row = document.createElement('tr');
		row.append(cell);
		body.append(row);
	}
}
async function refresh() {
	if (state.busy) { return; }
	state.busy = true;
	element('refresh').disabled = true;
	element('previous').disabled = true;
	element('next').disabled = true;
	element('error').hidden = true;
	try {
		const [ board, racing ] = await Promise.all([
			api('leaderboard?offset=' + state.offset + '&limit=' + state.limit), api('racing')
		]);
		table('board', board.list.map(entry => [
			entry.rank + 1, player(entry.user, board.users), entry.score,
			entry.record?.room, entry.record?.targetRoom, recordedAt(entry.record?.at)
		]), 6, '还没有成功通关的记录。');
		table('racing', racing.list.map(entry => [
			player(entry.user, racing.users), entry.room, entry.targetRoom, entry.elapsed, entry.left
		]), 5, '当前没有进行中的挑战。');
		element('status').textContent = 'tick ' + racing.time + ' · ' + racing.list.length + ' 位玩家挑战中';
		const from = board.list.length ? state.offset + 1 : 0;
		element('range').textContent = from + '–' + (board.list.length ? state.offset + board.list.length : 0) + ' / ' + board.count;
		element('previous').disabled = state.offset === 0;
		element('next').disabled = state.offset + state.limit >= board.count;
	} catch (error) {
		element('error').textContent = '读取失败：' + error.message;
		element('error').hidden = false;
	} finally {
		state.busy = false;
		element('refresh').disabled = false;
	}
}
async function openRecords(user) {
	state.user = user;
	const detail = element('detail');
	if (!detail.open) { detail.showModal(); }
	element('detail-title').textContent = user + ' · 成功记录';
	element('detail-status').textContent = '正在读取…';
	element('records').replaceChildren();
	try {
		const payload = await api('records/' + encodeURIComponent(user));
		if (state.user !== user) { return; }
		element('detail-title').textContent = payload.username + ' · 成功记录';
		element('detail-status').textContent = '排名对应所有成功局，用时最短的局在前。';
		table('records', payload.list.map(entry => [
			entry.rank == null ? '—' : entry.rank + 1, entry.score, entry.record.room,
			entry.record.targetRoom, entry.record.finishedTick, recordedAt(entry.record.at)
		]), 6, '还没有成功记录。');
	} catch (error) {
		if (state.user === user) { element('detail-status').textContent = '读取失败：' + error.message; }
	}
}
element('refresh').addEventListener('click', refresh);
element('previous').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); refresh(); });
element('next').addEventListener('click', () => { state.offset += state.limit; refresh(); });
element('detail').addEventListener('close', () => { state.user = null; });
setInterval(() => { if (!document.hidden) { refresh(); } }, 20000);
refresh();
</script>
</body>
</html>`;
