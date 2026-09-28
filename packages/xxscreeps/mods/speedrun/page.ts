// The speedrun board, as a page. It is served by the backend at `/speedrun` (see `backend.ts`) rather
// than injected into the client: the client is the official AngularJS bundle from the Steam package,
// which a mod cannot add a route or a module to. What a mod can add is a sidebar entry, and that entry
// points here -- `item.href` opens the page in its own tab, which is the shape the client's own
// external links (forum, store) use.
//
// The markup, styles and script live in one string because nothing here is built: the page has to work
// from the running server exactly as it is compiled, with no bundler and no dependency on the client's
// assets. It reads the three ends of `/api/speedrun` (leaderboard, records, racing) at the same origin,
// so there is no CORS to arrange and no token to carry.
//
// Colours are taken from the official client's dark theme: page `#1d1d1d`, panel `#222`, gold headings
// `#f5d08c`, teal for progress `#6fb3a8`, muted text `#909090`.

const styles = `
:root {
	--bg: #1d1d1d;
	--panel: #222222;
	--panel-2: #262626;
	--line: #2e2e2e;
	--line-soft: #2a2a2a;
	--text: #c8c8c8;
	--text-strong: #e8e8e8;
	--muted: #909090;
	--dim: #686868;
	--gold: #f5d08c;
	--gold-dim: #8a7448;
	--teal: #6fb3a8;
	--mint: #b8f8e8;
	--red: #a05050;
	--green: #285040;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
	background: var(--bg);
	color: var(--text);
	font: 14px/1.45 Ubuntu, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
	-webkit-font-smoothing: antialiased;
}
a { color: var(--gold); text-decoration: none; }
a:hover { color: var(--mint); }
::-webkit-scrollbar { width: 10px; height: 10px; background: #1a1a1a; }
::-webkit-scrollbar-thumb { background: #333; }
::-webkit-scrollbar-thumb:hover { background: #3d3d3d; }

header {
	display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
	padding: 10px 18px; background: #191a1f; border-bottom: 1px solid var(--line);
	position: sticky; top: 0; z-index: 5;
}
.brand { color: var(--gold); font-size: 17px; letter-spacing: 2px; font-weight: 500; }
.brand small { color: var(--dim); letter-spacing: 1px; font-size: 11px; margin-left: 8px; }
.tabs { display: flex; gap: 4px; margin-left: 6px; }
.tab {
	padding: 5px 13px; border: 1px solid var(--line); background: #202020; color: var(--muted);
	cursor: pointer; font: inherit; font-size: 13px;
}
.tab:hover { background: var(--panel-2); color: var(--text); }
.tab[aria-selected='true'] { background: #2b2b2b; border-color: var(--gold-dim); color: var(--gold); }
.meta { margin-left: auto; display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; }
button.action {
	padding: 5px 12px; border: 1px solid var(--line); background: #202020; color: var(--text);
	cursor: pointer; font: inherit; font-size: 12px;
}
button.action:hover { background: var(--panel-2); border-color: var(--gold-dim); color: var(--gold); }
button.action[disabled] { opacity: .45; cursor: default; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--teal); margin-right: 6px; }

main { padding: 18px; display: grid; gap: 18px; grid-template-columns: minmax(0, 1fr); }
.panel { background: var(--panel); border: 1px solid var(--line); }
.panel > h2 {
	margin: 0; padding: 11px 15px; font-size: 15px; font-weight: 400; color: var(--gold);
	border-bottom: 1px solid var(--line); display: flex; align-items: baseline; gap: 10px;
}
.panel > h2 .sub { color: var(--muted); font-size: 12px; }
.panel .body { padding: 0; }
.empty { padding: 22px 15px; color: var(--dim); }

.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th {
	text-align: left; padding: 7px 12px; color: var(--muted); font-weight: 400; font-size: 11px;
	text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid var(--line);
	white-space: nowrap; background: #202020;
}
td { padding: 7px 12px; border-bottom: 1px solid var(--line-soft); white-space: nowrap; }
tbody tr:hover { background: var(--panel-2); }
tbody tr.clickable { cursor: pointer; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.rank { color: var(--muted); }
tr.top1 .rank, tr.top1 .player { color: var(--gold); }
tr.top2 .rank { color: #cfcfcf; }
tr.top3 .rank { color: #c08a5a; }
.player { color: var(--text-strong); }
.room { color: var(--muted); }
.score { color: var(--gold); font-variant-numeric: tabular-nums; }
.bar { position: relative; height: 5px; background: #2b2b2b; min-width: 60px; }
.bar > i { position: absolute; inset: 0 auto 0 0; background: var(--teal); }
.bar.red > i { background: var(--red); }
.muted { color: var(--dim); }
.badge { color: var(--teal); }
.pager { display: flex; align-items: center; gap: 10px; padding: 10px 15px; color: var(--muted); font-size: 12px; }

aside {
	position: fixed; top: 0; right: 0; width: min(680px, 92vw); height: 100%; z-index: 20;
	background: #1f1f1f; border-left: 1px solid var(--line); overflow-y: auto;
	box-shadow: -12px 0 30px rgba(0, 0, 0, .45);
}
aside[hidden] { display: none; }
aside > h2 { margin: 0; padding: 13px 16px; font-size: 15px; font-weight: 400; color: var(--gold); border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; }
aside > h2 button { margin-left: auto; }
aside .section { padding: 13px 16px; border-bottom: 1px solid var(--line); }
aside .section h3 { margin: 0 0 9px; font-size: 12px; font-weight: 400; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
.scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, .5); z-index: 15; }
.scrim[hidden] { display: none; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { border: 1px solid var(--line); padding: 5px 10px; font-size: 12px; color: var(--muted); }
.chip b { color: var(--gold); font-weight: 400; }
footer { padding: 16px 18px 34px; color: var(--dim); font-size: 12px; }
.nowrap { white-space: nowrap; }
@media (max-width: 720px) { .meta { width: 100%; margin-left: 0; } }
`;

// The script is plain ES2020 with no build step: string concatenation rather than template literals,
// and every value that comes off the wire goes through `escape` before it reaches the DOM.
const script = `
'use strict';
var api = function(path) {
	return fetch(path, { headers: { accept: 'application/json' } }).then(function(response) {
		if (!response.ok) { throw new Error(path + ': ' + response.status); }
		return response.json();
	});
};
var escape = function(value) {
	return String(value == null ? '' : value).replace(/[&<>"']/g, function(character) {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
	});
};
var round = function(value, digits) {
	var factor = Math.pow(10, digits);
	return Math.round(value * factor) / factor;
};
var ticks = function(value) {
	if (value >= 1000000) { return round(value / 1000000, 2) + 'M'; }
	if (value >= 10000) { return round(value / 1000, 1) + 'k'; }
	return String(value);
};
var when = function(milliseconds) {
	if (!milliseconds) { return '—'; }
	var date = new Date(milliseconds);
	var pad = function(value) { return (value < 10 ? '0' : '') + value; };
	return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
		' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
};
// Wall time from a tick count: a tick is not a second. The shard runs at game.tickSpeed milliseconds
// per tick, which the endpoint hands over, so the Running column is how long the player has actually
// been at it -- the countdowns beside it stay in ticks, which is the clock the race is run on.
var duration = function(ticks, tickSpeed) {
	var minutes = Math.round(ticks * (tickSpeed || 1000) / 60000);
	if (minutes < 90) { return minutes + ' min'; }
	return round(minutes / 60, 1) + ' h';
};
var progressBar = function(level, progress, total) {
	var percent = level >= 8 ? 100 : total > 0 ? Math.min(100, progress / total * 100) : 0;
	return '<div class="bar" title="' + escape(progress) + ' / ' + escape(total || '—') + '">' +
		'<i style="width:' + percent.toFixed(1) + '%"></i></div>';
};
var state = { bracket: null, brackets: [], offset: 0, limit: 25, tick: 0, busy: false, user: null };
var elements = {
	board: document.getElementById('board'),
	boardTitle: document.getElementById('board-title'),
	detail: document.getElementById('detail'),
	detailBody: document.getElementById('detail-body'),
	detailName: document.getElementById('detail-name'),
	live: document.getElementById('live'),
	liveCount: document.getElementById('live-count'),
	pager: document.getElementById('pager'),
	refresh: document.getElementById('refresh'),
	scrim: document.getElementById('scrim'),
	tabs: document.getElementById('tabs'),
	tick: document.getElementById('tick')
};

function renderTabs() {
	elements.tabs.innerHTML = state.brackets.map(function(bracket) {
		return '<button class="tab" role="tab" data-bracket="' + escape(bracket) + '"' +
			(bracket === state.bracket ? ' aria-selected="true"' : '') + '>' + ticks(bracket) + ' ticks</button>';
	}).join('');
	Array.prototype.forEach.call(elements.tabs.querySelectorAll('.tab'), function(tab) {
		tab.addEventListener('click', function() {
			state.bracket = Number(tab.getAttribute('data-bracket'));
			state.offset = 0;
			closeDetail();
			loadBoard();
		});
	});
}

function renderBoard(page) {
	var rows = page.list.map(function(entry, index) {
		var score = entry.record || {};
		var place = entry.rank + 1;
		var room = score.room ? score.room : '—';
		return '<tr class="clickable ' + (place <= 3 ? 'top' + place : '') + '" data-user="' + escape(entry.user) + '">' +
			'<td class="num rank">' + place + '</td>' +
			'<td class="player">' + escape((page.users[entry.user] || {}).username || score.username || entry.user) + '</td>' +
			'<td class="num">' + (score.level == null ? '—' : 'RCL ' + score.level) + '</td>' +
			'<td class="nowrap">' + progressBar(score.level || 0, score.progress || 0, score.progressTotal || 0) + '</td>' +
			'<td class="num score">' + escape(entry.score) + '</td>' +
			'<td class="room">' + escape(room) + '</td>' +
			'<td class="num muted">' + (score.run == null ? '—' : '#' + score.run) + '</td>' +
			'<td class="muted">' + escape(when(score.at)) + '</td>' +
			'</tr>';
	}).join('');
	elements.boardTitle.textContent = 'Best after ' + state.bracket + ' ticks';
	elements.board.innerHTML =
		'<thead><tr><th class="num">#</th><th>Player</th><th class="num">Level</th><th>Progress</th>' +
		'<th class="num">Score</th><th>Room</th><th class="num">Run</th><th>Recorded</th></tr></thead>' +
		'<tbody>' + (rows || '<tr><td colspan="8" class="empty">Nobody has finished this bracket yet.</td></tr>') + '</tbody>';
	Array.prototype.forEach.call(elements.board.querySelectorAll('tbody tr[data-user]'), function(row) {
		row.addEventListener('click', function() { openDetail(row.getAttribute('data-user')); });
	});
	var from = page.count === 0 ? 0 : state.offset + 1;
	var to = Math.min(state.offset + state.limit, page.count);
	elements.pager.innerHTML = '<span>' + from + '–' + to + ' of ' + page.count + ' players</span>' +
		'<button class="action" id="pager-prev"' + (state.offset === 0 ? ' disabled' : '') + '>‹ Prev</button>' +
		'<button class="action" id="pager-next"' + (to >= page.count ? ' disabled' : '') + '>Next ›</button>';
	var prev = document.getElementById('pager-prev');
	var next = document.getElementById('pager-next');
	if (prev) { prev.addEventListener('click', function() { state.offset = Math.max(0, state.offset - state.limit); loadBoard(); }); }
	if (next) { next.addEventListener('click', function() { state.offset += state.limit; loadBoard(); }); }
}

function renderLive(page) {
	elements.liveCount.textContent = page.list.length + ' running';
	var rows = page.list.map(function(entry) {
		var brackets = entry.brackets.map(function(item) {
			var left = item.left > 0 ? ticks(item.left) + ' to go' : 'due';
			return '<div class="nowrap"><span class="muted">' + ticks(item.bracket) + '</span> ' +
				(left === 'due' ? '<span class="badge">due</span>' : escape(left)) + '</div>';
		}).join('');
		return '<tr class="clickable" data-user="' + escape(entry.user) + '">' +
			'<td class="player">' + escape((page.users[entry.user] || {}).username || entry.user) + '</td>' +
			'<td class="room">' + escape(entry.room) + '</td>' +
			'<td class="num">RCL ' + entry.level + '</td>' +
			'<td class="nowrap">' + progressBar(entry.level, entry.progress, entry.progressTotal) + '</td>' +
			'<td class="num score">' + escape(entry.score) + '</td>' +
			'<td class="muted">' + escape(duration(entry.elapsed, page.tickSpeed)) + '</td>' +
			'<td>' + brackets + '</td>' +
			'</tr>';
	}).join('');
	elements.live.innerHTML =
		'<thead><tr><th>Player</th><th>Room</th><th class="num">Level</th><th>Progress</th>' +
		'<th class="num">Score</th><th>Running</th><th>Brackets</th></tr></thead>' +
		'<tbody>' + (rows || '<tr><td colspan="7" class="empty">Nobody is on the clock right now.</td></tr>') + '</tbody>';
	Array.prototype.forEach.call(elements.live.querySelectorAll('tbody tr[data-user]'), function(row) {
		row.addEventListener('click', function() { openDetail(row.getAttribute('data-user')); });
	});
}

function renderDetail(payload) {
	var name = payload.username || payload.user;
	elements.detailName.textContent = name;
	var chips = payload.brackets.map(function(entry) {
		return '<span class="chip">' + ticks(entry.bracket) + ' ticks &middot; best <b>' + escape(entry.score) + '</b></span>';
	}).join('');
	var rows = payload.list.map(function(entry) {
		var record = entry.record;
		return '<tr' + (entry.rank === 0 ? ' class="top1"' : '') + '>' +
			'<td class="num">' + ticks(record.bracket) + '</td>' +
			'<td class="num muted">#' + record.run + '</td>' +
			'<td class="num rank">' + (entry.rank == null ? '—' : entry.rank + 1) + '</td>' +
			'<td class="num">RCL ' + record.level + '</td>' +
			'<td class="num score">' + escape(entry.score) + '</td>' +
			'<td class="room">' + escape(record.room) + '</td>' +
			'<td class="muted">' + escape(when(record.at)) + '</td>' +
			'</tr>';
	}).join('');
	elements.detailBody.innerHTML =
		'<div class="section"><h3>Brackets</h3><div class="chips">' + (chips || '<span class="muted">No results yet.</span>') + '</div></div>' +
		'<div class="section"><h3>Every run</h3><div class="table-wrap"><table>' +
		'<thead><tr><th class="num">Bracket</th><th class="num">Run</th><th class="num">Rank</th>' +
		'<th class="num">Level</th><th class="num">Score</th><th>Room</th><th>Recorded</th></tr></thead>' +
		'<tbody>' + (rows || '<tr><td colspan="7" class="empty">Nothing recorded.</td></tr>') + '</tbody></table></div></div>' +
		'<div class="section muted">Player id ' + escape(payload.user) + '</div>';
}

function openDetail(user) {
	state.user = user;
	elements.detail.hidden = false;
	elements.scrim.hidden = false;
	elements.detailName.textContent = user;
	elements.detailBody.innerHTML = '<div class="empty">Loading…</div>';
	if (history.replaceState) { history.replaceState(null, '', '#player=' + encodeURIComponent(user)); }
	api('/api/speedrun/records/' + encodeURIComponent(user)).then(function(payload) {
		if (state.user === user) { renderDetail(payload); }
	}).catch(function(error) {
		elements.detailBody.innerHTML = '<div class="empty">Could not load this player: ' + escape(error.message) + '</div>';
	});
}

function closeDetail() {
	state.user = null;
	elements.detail.hidden = true;
	elements.scrim.hidden = true;
	if (history.replaceState) { history.replaceState(null, '', location.pathname); }
}

function loadBoard() {
	elements.refresh.disabled = true;
	var query = '/api/speedrun/leaderboard?offset=' + state.offset + '&limit=' + state.limit +
		(state.bracket == null ? '' : '&bracket=' + state.bracket);
	return api(query).then(function(page) {
		if (state.bracket == null && page.bracket != null) { state.bracket = page.bracket; }
		if (state.brackets.length === 0 && page.brackets) { state.brackets = page.brackets; renderTabs(); }
		renderBoard(page);
	}).catch(function(error) {
		elements.board.innerHTML = '<tbody><tr><td class="empty">Could not load the board: ' + escape(error.message) + '</td></tr></tbody>';
	}).then(function() { elements.refresh.disabled = false; });
}

function loadLive() {
	return api('/api/speedrun/racing').then(function(page) {
		state.tick = page.time;
		elements.tick.textContent = 'tick ' + page.time;
		if (state.brackets.length === 0 && page.brackets) { state.brackets = page.brackets; renderTabs(); }
		renderLive(page);
	}).catch(function(error) {
		elements.live.innerHTML = '<tbody><tr><td class="empty">Could not load the live board: ' + escape(error.message) + '</td></tr></tbody>';
	});
}

function refresh() {
	if (state.busy) { return Promise.resolve(); }
	state.busy = true;
	return Promise.all([ loadLive(), loadBoard() ]).then(function() { state.busy = false; });
}

elements.refresh.addEventListener('click', refresh);
document.getElementById('detail-close').addEventListener('click', closeDetail);
elements.scrim.addEventListener('click', closeDetail);
document.addEventListener('keydown', function(event) { if (event.key === 'Escape') { closeDetail(); } });
setInterval(function() { if (!document.hidden) { loadLive(); } }, 20000);
var hash = /#player=([^&]+)/.exec(location.hash);
window.addEventListener('hashchange', function() {
	var match = /#player=([^&]+)/.exec(location.hash);
	if (match) { openDetail(decodeURIComponent(match[1])); }
});
refresh().then(function() {
	if (hash) { openDetail(decodeURIComponent(hash[1])); }
});
`;

/** The page, ready to serve: `backend.ts` answers `GET /speedrun` with it. */
export const speedrunPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Speedrun — xxscreeps</title>
<style>${styles}</style>
</head>
<body>
<header>
	<div class="brand">SPEEDRUN<small>race results</small></div>
	<nav class="tabs" role="tablist" id="tabs"></nav>
	<div class="meta">
		<span id="tick"></span>
		<span><span class="dot"></span>live</span>
		<button class="action" id="refresh">Refresh</button>
	</div>
</header>
<main>
	<section class="panel">
		<h2>Racing now <span class="sub" id="live-count"></span></h2>
		<div class="body table-wrap"><table id="live"></table></div>
	</section>
	<section class="panel">
		<h2><span id="board-title">Leaderboard</span> <span class="sub">one row per player, their best</span></h2>
		<div class="body table-wrap"><table id="board"></table></div>
		<div class="pager" id="pager"></div>
	</section>
</main>
<footer>
	Every landing starts a run; a result is recorded once the bracket's ticks are up, while the room is
	still held at RCL 2 or above. Ranks come from control points — every level passed in full plus the
	progress on the current one — so a level breaks any tie. Click a player for every run they have.
</footer>
<div class="scrim" id="scrim" hidden></div>
<aside id="detail" hidden>
	<h2><span id="detail-name"></span><button class="action" id="detail-close">Close</button></h2>
	<div id="detail-body"></div>
</aside>
<script>${script}</script>
</body>
</html>
`;
