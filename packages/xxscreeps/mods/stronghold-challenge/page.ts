import { competitionStyles } from 'xxscreeps/backend/competition-page.js';

/** A standalone board served by the backend; gameplay starts by placing a spawn in a group's left room. */
export const challengePage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>5 级要塞挑战 — xxscreeps</title>
<style>
${competitionStyles}
:root { color-scheme: dark; }
h1.brand { margin: 0; }
button.player { border: 0; background: none; color: inherit; padding: 0; font: inherit; cursor: pointer; }
button.player:hover { color: var(--mint); }
button:focus-visible { outline: 1px solid var(--gold); outline-offset: 3px; }
.error { margin: 0; color: #ff9292; }
.countdown { display: flex; align-items: center; gap: 12px; }
.countdown .bar { width: 90px; }
.pager { border-top: 0; }
dialog.drawer { inset: 0 0 0 auto; margin: 0; padding: 0; max-width: none; max-height: none; border: 0; border-left: 1px solid var(--line); color: var(--text); }
dialog::backdrop { background: rgba(0, 0, 0, .5); }
dialog form { margin-left: auto; }
.drawer > h2 form button { margin-left: 0; }
.drawer .section p { margin: 0; font-size: 12px; color: var(--muted); }
@media (max-width: 600px) { header, main { padding: 12px; } .brand small { display: block; margin: 2px 0 0; } }
</style>
</head>
<body>
<header>
	<h1 class="brand">STRONGHOLD<small>5 级要塞挑战</small></h1>
	<div class="meta"><span id="status" role="status">正在读取比赛…</span><span><span class="dot"></span>live</span><button class="action" id="refresh">刷新</button></div>
</header>
<main>
<p id="error" class="error" role="alert" hidden></p>
<section class="panel"><h2>正在挑战 <span class="sub" id="live-count">读取中…</span></h2><div class="body table-wrap"><table><thead><tr><th>玩家</th><th>落地房</th><th>要塞房</th><th>挑战时间</th><th class="num">已用 tick</th><th>剩余 tick</th></tr></thead><tbody id="racing"><tr><td colspan="6" class="empty">正在读取进行中的挑战…</td></tr></tbody></table></div></section>
<div>
	<section class="panel"><h2>最快通关 <span class="sub" id="board-count">每位玩家最佳成绩</span></h2><div class="body table-wrap"><table><thead><tr><th class="num">#</th><th>玩家</th><th class="num">用时 tick</th><th>落地房</th><th>要塞房</th><th>完成时间</th></tr></thead><tbody id="board"><tr><td colspan="6" class="empty">正在读取通关记录…</td></tr></tbody></table></div></section>
	<div class="pager"><button class="action" id="previous" disabled>‹ 上一页</button><span id="range" role="status">—</span><button class="action" id="next" disabled>下一页 ›</button><span class="muted">每位玩家仅显示最快成功局</span></div>
</div>
</main>
<footer>在一组房间的左房放置 Spawn 开始挑战，击破右房指定的 5 级 Invader Core 完成通关。成功成绩按用时 tick 排名，用时越短越靠前；点击玩家查看历次成功记录。页面每 20 秒刷新，计时以服务端游戏 tick 为准。</footer>
<dialog class="drawer" id="detail" aria-labelledby="detail-title">
	<h2><span id="detail-title">成功记录</span><form method="dialog"><button class="action" autofocus>关闭</button></form></h2>
	<div class="section"><p id="detail-status" role="status"></p></div>
	<div class="section"><h3>历次成功局</h3><div class="table-wrap"><table><thead><tr><th class="num">排名</th><th class="num">用时 tick</th><th>落地房</th><th>要塞房</th><th class="num">完成 tick</th><th>完成时间</th></tr></thead><tbody id="records"></tbody></table></div></div>
</dialog>
<script>
'use strict';
const state = { offset: 0, limit: 25, count: 0, busy: false, user: null };
const element = id => document.getElementById(id);
async function api(path) {
	const response = await fetch('/api/stronghold-challenge/' + path, { headers: { accept: 'application/json' } });
	if (!response.ok) { throw new Error('HTTP ' + response.status); }
	const payload = await response.json();
	if (payload.error) { throw new Error(payload.error); }
	return payload;
}
function recordedAt(at) { return at ? new Date(at).toLocaleString() : '—'; }
function duration(ticks, tickSpeed) {
	const minutes = Math.round(ticks * tickSpeed / 60000);
	return minutes < 90 ? minutes + ' min' : (minutes / 60).toFixed(1) + ' h';
}
function countdown(entry) {
	const container = document.createElement('div');
	container.className = 'countdown';
	const label = document.createElement('span');
	label.className = 'badge';
	label.textContent = entry.left.toLocaleString();
	const bar = document.createElement('div');
	bar.className = 'bar' + (entry.left === 0 ? ' red' : '');
	bar.setAttribute('aria-hidden', 'true');
	const fill = document.createElement('i');
	const total = entry.deadlineTick - entry.startedTick;
	fill.style.width = (total > 0 ? Math.min(100, Math.max(0, entry.elapsed / total * 100)) : 100) + '%';
	bar.title = '已用 ' + entry.elapsed + ' / ' + total + ' tick';
	bar.append(fill);
	container.append(label, bar);
	return container;
}
function player(user, users) {
	const button = document.createElement('button');
	button.className = 'player';
	button.textContent = users[user]?.username || user;
	button.addEventListener('click', () => openRecords(user));
	return button;
}
function table(id, rows, classes, empty) {
	const body = element(id);
	body.replaceChildren();
	for (const values of rows) {
		const row = document.createElement('tr');
		for (const [ index, value ] of values.entries()) {
			const cell = document.createElement('td');
			cell.className = classes[index];
			if (value instanceof Node) { cell.append(value); } else { cell.textContent = String(value ?? '—'); }
			row.append(cell);
		}
		if (id === 'board' || id === 'records') {
			const rank = Number(values[0]);
			if (rank >= 1 && rank <= 3) { row.classList.add('top' + rank); }
		}
		const button = row.querySelector('button.player');
		if (button) {
			row.classList.add('clickable');
			row.addEventListener('click', event => { if (!event.target.closest('button')) { button.click(); } });
		}
		body.append(row);
	}
	if (rows.length === 0) {
		const cell = document.createElement('td');
		cell.colSpan = classes.length;
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
		state.count = board.count;
		table('board', board.list.map(entry => [
			entry.rank + 1, player(entry.user, board.users), entry.score,
			entry.record?.room, entry.record?.targetRoom, recordedAt(entry.record?.at)
		]), [ 'num rank', 'player', 'num score', 'room', 'room', 'muted' ], '还没有成功通关的记录。');
		table('racing', racing.list.map(entry => [
			player(entry.user, racing.users), entry.room, entry.targetRoom,
			duration(entry.elapsed, racing.tickSpeed), entry.elapsed, countdown(entry)
		]), [ 'player', 'room', 'room', 'muted', 'num', '' ], '当前没有进行中的挑战。');
		element('status').textContent = 'tick ' + racing.time;
		element('live-count').textContent = racing.list.length + ' 位玩家挑战中';
		element('board-count').textContent = board.count + ' 位玩家 · 每位玩家最佳成绩';
		const from = board.list.length ? state.offset + 1 : 0;
		element('range').textContent = from + '–' + (board.list.length ? state.offset + board.list.length : 0) + ' / ' + board.count;
	} catch (error) {
		element('error').textContent = '读取失败：' + error.message;
		element('error').hidden = false;
	} finally {
		state.busy = false;
		element('refresh').disabled = false;
		element('previous').disabled = state.offset === 0;
		element('next').disabled = state.offset + state.limit >= state.count;
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
		]), [ 'num rank', 'num score', 'room', 'room', 'num muted', 'muted' ], '还没有成功记录。');
	} catch (error) {
		if (state.user === user) { element('detail-status').textContent = '读取失败：' + error.message; }
	}
}
element('refresh').addEventListener('click', refresh);
element('previous').addEventListener('click', () => { if (!state.busy) { state.offset = Math.max(0, state.offset - state.limit); refresh(); } });
element('next').addEventListener('click', () => { if (!state.busy) { state.offset += state.limit; refresh(); } });
element('detail').addEventListener('close', () => { state.user = null; });
element('detail').addEventListener('click', event => {
	if (event.target !== element('detail')) { return; }
	const rect = element('detail').getBoundingClientRect();
	if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { element('detail').close(); }
});
setInterval(() => { if (!document.hidden) { refresh(); } }, 20000);
refresh();
</script>
</body>
</html>`;
