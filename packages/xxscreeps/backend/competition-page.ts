/** Shared standalone competition-board theme. No dependency on the game client or its assets. */
export const competitionStyles = `
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
.meta { margin-left: auto; display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; }
button.action {
	padding: 5px 12px; border: 1px solid var(--line); background: #202020; color: var(--text);
	cursor: pointer; font: inherit; font-size: 12px;
}
button.action:hover { background: var(--panel-2); border-color: var(--gold-dim); color: var(--gold); }
button.action[disabled] { opacity: .45; cursor: default; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--teal); margin-right: 6px; }

main { padding: 18px; display: grid; gap: 18px; grid-template-columns: minmax(0, 1fr); }
/* Two lists side by side while each has room for its columns; one under that, rather than two
   cramped ones. */
.boards { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(520px, 1fr)); }
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
.pager {
	display: flex; align-items: center; gap: 10px; padding: 10px 15px; color: var(--muted); font-size: 12px;
	background: var(--panel); border: 1px solid var(--line);
}

.drawer {
	position: fixed; top: 0; right: 0; width: min(680px, 92vw); height: 100%; z-index: 20;
	background: #1f1f1f; border-left: 1px solid var(--line); overflow-y: auto;
	box-shadow: -12px 0 30px rgba(0, 0, 0, .45);
}
.drawer[hidden] { display: none; }
.drawer > h2 { margin: 0; padding: 13px 16px; font-size: 15px; font-weight: 400; color: var(--gold); border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; }
.drawer > h2 button { margin-left: auto; }
.drawer .section { padding: 13px 16px; border-bottom: 1px solid var(--line); }
.drawer .section h3 { margin: 0 0 9px; font-size: 12px; font-weight: 400; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
.scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, .5); z-index: 15; }
.scrim[hidden] { display: none; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { border: 1px solid var(--line); padding: 5px 10px; font-size: 12px; color: var(--muted); }
.chip b { color: var(--gold); font-weight: 400; }
footer { padding: 16px 18px 34px; color: var(--dim); font-size: 12px; }
.nowrap { white-space: nowrap; }
@media (max-width: 720px) { .meta { width: 100%; margin-left: 0; } }
`;
