import { competitionStyles } from 'xxscreeps/backend/competition-page.js';

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
// The shared competition theme also styles the stronghold challenge board.

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
var state = { brackets: [], offset: 0, limit: 25, tick: 0, busy: false, user: null };
var elements = {
	boards: document.getElementById('boards'),
	detail: document.getElementById('detail'),
	detailBody: document.getElementById('detail-body'),
	detailName: document.getElementById('detail-name'),
	live: document.getElementById('live'),
	liveCount: document.getElementById('live-count'),
	pager: document.getElementById('pager'),
	refresh: document.getElementById('refresh'),
	scrim: document.getElementById('scrim'),
	tick: document.getElementById('tick')
};

// Every bracket is its own list, side by side: a player's standing at 20k is not their standing at
// 40k, and the two are read together more often than either is read alone.
function boardShell(page) {
	var players = page.count + ' player' + (page.count === 1 ? '' : 's');
	return '<section class="panel"><h2><span>Best after ' + ticks(page.bracket) + ' ticks</span>' +
		'<span class="sub">' + players + '</span></h2>' +
		'<div class="body table-wrap"><table></table></div></section>';
}

function renderBoards(pages) {
	if (pages.length === 0) {
		elements.boards.innerHTML = '<section class="panel"><div class="empty">' +
			'No brackets are configured, so nothing has been recorded.</div></section>';
		elements.pager.innerHTML = '';
		return;
	}
	elements.boards.innerHTML = pages.map(boardShell).join('');
	var tables = elements.boards.querySelectorAll('table');
	Array.prototype.forEach.call(tables, function(table, index) {
		renderBoard(table, pages[index]);
	});
	var shortest = Math.min.apply(null, pages.map(function(page) { return page.count; }));
	var exhausted = pages.every(function(page) { return state.offset + state.limit >= page.count; });
	var from = shortest === 0 ? 0 : state.offset + 1;
	var to = Math.min(state.offset + state.limit, shortest);
	elements.pager.innerHTML =
		'<button class="action" id="pager-prev"' + (state.offset === 0 ? ' disabled' : '') + '>‹ Prev</button>' +
		'<span class="nowrap">' + from + '–' + to + '</span>' +
		'<button class="action" id="pager-next"' + (exhausted ? ' disabled' : '') + '>Next ›</button>' +
		'<span class="muted">one row per player, their best</span>';
	var prev = document.getElementById('pager-prev');
	var next = document.getElementById('pager-next');
	if (prev) { prev.addEventListener('click', function() { state.offset = Math.max(0, state.offset - state.limit); loadBoard(); }); }
	if (next) { next.addEventListener('click', function() { state.offset += state.limit; loadBoard(); }); }
}

function renderBoard(board, page) {
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
	board.innerHTML =
		'<thead><tr><th class="num">#</th><th>Player</th><th class="num">Level</th><th>Progress</th>' +
		'<th class="num">Score</th><th>Room</th><th class="num">Run</th><th>Recorded</th></tr></thead>' +
		'<tbody>' + (rows || '<tr><td colspan="8" class="empty">Nobody has finished this bracket yet.</td></tr>') + '</tbody>';
	Array.prototype.forEach.call(board.querySelectorAll('tbody tr[data-user]'), function(row) {
		row.addEventListener('click', function() { openDetail(row.getAttribute('data-user')); });
	});
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

function boardQuery(bracket) {
	return '/api/speedrun/leaderboard?offset=' + state.offset + '&limit=' + state.limit +
		(bracket == null ? '' : '&bracket=' + bracket);
}

// One page of every bracket, asked for at once so the lists stay in step as the page moves. With no
// bracket known yet the request names none and the answer carries the list of them.
function loadBoard() {
	elements.refresh.disabled = true;
	var known = state.brackets;
	var requests = known.length === 0
		? [ boardQuery(null) ]
		: known.map(function(bracket) { return boardQuery(bracket); });
	return Promise.all(requests.map(function(query) { return api(query); })).then(function(pages) {
		var brackets = known.length === 0 ? pages[0].brackets || [] : known;
		state.brackets = brackets;
		return Promise.all(brackets.map(function(bracket, index) {
			return known.length === 0 && index === 0 ? pages[0] : api(boardQuery(bracket));
		}));
	}).then(function(pages) {
		renderBoards(pages);
	}).catch(function(error) {
		elements.boards.innerHTML = '<section class="panel"><div class="empty">Could not load the board: ' +
			escape(error.message) + '</div></section>';
		elements.pager.innerHTML = '';
	}).then(function() { elements.refresh.disabled = false; });
}

function loadLive() {
	return api('/api/speedrun/racing').then(function(page) {
		state.tick = page.time;
		elements.tick.textContent = 'tick ' + page.time;
		if (state.brackets.length === 0 && page.brackets) { state.brackets = page.brackets; }
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
<style>${competitionStyles}</style>
</head>
<body>
<header>
	<div class="brand">SPEEDRUN<small>race results</small></div>
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
	<div class="boards" id="boards"></div>
	<div class="pager" id="pager"></div>
</main>
<footer>
	Every landing starts a run; a result is recorded once the bracket's ticks are up, while the room is
	still held at RCL 2 or above. Ranks come from control points — every level passed in full plus the
	progress on the current one — so a level breaks any tie. Click a player for every run they have.
</footer>
<div class="scrim" id="scrim" hidden></div>
<aside class="drawer" id="detail" hidden>
	<h2><span id="detail-name"></span><button class="action" id="detail-close">Close</button></h2>
	<div id="detail-body"></div>
</aside>
<script>${script}</script>
</body>
</html>
`;
