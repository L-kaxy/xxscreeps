import type { Drawing, Limits, Point, Shape } from './drawing.js';
import { compileDrawing, defaultLimits, maxPoints, maxRequestBytes, newDrawing, polygonFromCanvas, shapePath } from './drawing.js';
import { importSvg } from './svg-import.js';

interface Profile {
	userId: string;
	username: string;
	version: number;
	blocked: boolean;
	draft: Drawing | null;
	isAdmin: boolean;
}
interface Options extends Limits {
	enabled: boolean;
	saveCooldownSeconds: number;
	auth: { password: boolean; steam: boolean };
}

const byId = <Type extends HTMLElement>(id: string) => document.getElementById(id) as Type;
const input = (id: string) => byId<HTMLInputElement>(id);
const button = (id: string) => byId<HTMLButtonElement>(id);
const canvas = document.getElementById('canvas') as unknown as SVGSVGElement;
const ns = 'http://www.w3.org/2000/svg';
const apiBase = new URL('../../api/', import.meta.url);
const storageKey = 'custom-badge.token';
const logoutKey = 'custom-badge.loggedOut';
const hardLimits: Limits = { maxShapes: 64, maxPathLength: 131072 };

function storedToken() {
	try {
		const token = sessionStorage.getItem(storageKey);
		if (token !== null && token !== '') { return token; }
		if (sessionStorage.getItem(logoutKey) !== null) { return ''; }
		const shared: unknown = JSON.parse(localStorage.getItem('auth') ?? 'null');
		return typeof shared === 'string' && shared !== 'guest' ? shared : '';
	} catch { return ''; }
}

let token = storedToken();
let authEpoch = 0;
let profile: Profile | null = null;
let options: Options = { ...defaultLimits, enabled: false, saveCooldownSeconds: 10, auth: { password: false, steam: false } };
let drawing = newDrawing();
let selected: string | null = drawing.shapes[0]!.id;
let dirty = false;
let busy = false;
let polygon: Point[] | null = null;
let target: Profile | null = null;
const past: string[] = [];
const future: string[] = [];
let drag: { pointer: number; start: Point; origin: Point; before: string } | null = null;
let popup: Window | null = null;
let steamTimeout: ReturnType<typeof setTimeout> | undefined;

function status(message: string, kind = '') {
	const node = byId('status');
	node.textContent = message;
	node.className = `status ${kind}`;
}

function setToken(value: string) {
	token = value;
	try {
		if (value) {
			sessionStorage.setItem(storageKey, value);
			sessionStorage.removeItem(logoutKey);
		} else {
			sessionStorage.removeItem(storageKey);
			sessionStorage.setItem(logoutKey, '1');
		}
	} catch { /* Private browsing may disable storage; memory-only sessions still work. */ }
}

class ApiError extends Error {
	readonly status;

	constructor(status: number, message: string) { super(message); this.status = status; }
}

async function api<Result>(path: string, payload?: unknown, authenticated = true): Promise<Result> {
	const epoch = authEpoch;
	const headers: Record<string, string> = {};
	if (authenticated && token) { headers['X-Token'] = token; }
	if (payload !== undefined) { headers['Content-Type'] = 'application/json'; }
	const response = await fetch(new URL(path, apiBase), {
		method: payload === undefined ? 'GET' : 'POST', headers,
		...payload === undefined ? {} : { body: JSON.stringify(payload) },
		credentials: 'omit', cache: 'no-store', redirect: 'error',
	});
	const isJson = (response.headers.get('Content-Type') ?? '').includes('application/json');
	if (!isJson) {
		throw new ApiError(response.status, response.status === 401 ? '登录失败或会话已过期，请重新登录。' : `服务器响应异常 (${response.status})`);
	}
	const result = await response.json() as { error?: string; message?: string } & Result;
	if (!response.ok || result.error !== undefined) {
		const wait = response.headers.get('Retry-After');
		throw new ApiError(response.status, (result.message ?? `请求失败 (${response.status})`) + (wait === null ? '' : `（${wait} 秒后重试）`));
	}
	const refresh = response.headers.get('X-Token');
	if (authenticated && token && refresh !== null && refresh !== '' && epoch === authEpoch) { setToken(refresh); }
	return result;
}

function error(error: unknown) {
	status(error instanceof Error ? error.message : '操作失败，请重试', 'error');
	if (error instanceof ApiError && error.status === 401) {
		++authEpoch;
		setToken('');
		profile = null;
		target = null;
		byId('admin-actions').hidden = true;
		byId('admin-output').textContent = '';
		updateControls();
	}
}

async function operation(task: () => Promise<void>) {
	if (busy) { return; }
	busy = true;
	updateControls();
	try { await task(); } catch (caught) { error(caught); } finally { busy = false; updateControls(); }
}

function svgNode<Name extends keyof SVGElementTagNameMap>(name: Name, attrs: Record<string, string | number> = {}) {
	const node = document.createElementNS(ns, name);
	for (const [ key, value ] of Object.entries(attrs)) { node.setAttribute(key, String(value)); }
	return node;
}

function artwork(svg: SVGSVGElement, id: string, interactive = false) {
	const compiled = compileDrawing(drawing, hardLimits);
	const defs = svgNode('defs');
	const clip = svgNode('clipPath', { id });
	clip.append(svgNode('circle', { cx: 50, cy: 50, r: 52 }));
	defs.append(clip);
	svg.append(defs);
	const group = svgNode('g', { 'clip-path': `url(#${id})` });
	group.append(svgNode('rect', { x: 0, y: 0, width: 100, height: 100, fill: drawing.colors[0] }));
	for (const layer of [ 1, 2 ] as const) {
		const path = layer === 1 ? compiled.badge.type.path1 : compiled.badge.type.path2;
		group.append(svgNode('path', { d: path, fill: drawing.colors[layer] }));
	}
	// Separate transparent hit regions preserve combined-path preview semantics and layer order.
	if (interactive) {
		for (const layer of [ 1, 2 ]) {
			for (const shape of drawing.shapes.filter(shape => shape.layer === layer)) {
				group.append(svgNode('path', { d: shapePath(shape), fill: 'transparent', 'data-id': shape.id, cursor: 'move' }));
			}
		}
	}
	svg.append(group);
}

function preview(size: number) {
	const svg = svgNode('svg', { viewBox: '0 0 100 100', width: size, height: size, role: 'img', 'aria-label': `${size} 像素头像预览` });
	artwork(svg, `clip-preview-${size}`);
	byId(`preview${size}`).replaceChildren(svg);
}

const labels = { circle: '圆形', rectangle: '矩形', triangle: '三角形', polygon: '多边形', path: 'SVG 路径' };
const selectedShape = () => drawing.shapes.find(shape => shape.id === selected);
const serialize = () => JSON.stringify(drawing);

function updateControls() {
	const canSave = profile !== null && options.enabled && !profile.blocked && !busy && polygon === null;
	button('publish').disabled = !canSave;
	button('save-draft').disabled = !canSave;
	button('reset').disabled = profile === null || busy;
	button('reload').disabled = profile === null || busy;
	button('undo').disabled = busy || past.length === 0 || polygon !== null;
	button('redo').disabled = busy || future.length === 0 || polygon !== null;
	button('new').disabled = busy;
	button('import-svg').disabled = busy || polygon !== null || drag !== null;
	input('svg-file').disabled = busy || polygon !== null || drag !== null;
	button('logout').hidden = profile === null;
	button('logout').disabled = busy;
	byId('login-panel').hidden = profile !== null;
	byId('login-form').hidden = !options.auth.password;
	button('steam-login').hidden = !options.auth.steam;
	for (const node of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('#login-panel button,#login-panel input')) { node.disabled = busy; }
	for (const node of document.querySelectorAll<HTMLButtonElement>('[data-kind],#polygon')) {
		node.disabled = busy || polygon !== null || drawing.shapes.length >= options.maxShapes;
	}
	for (const node of document.querySelectorAll<HTMLInputElement>('.colors input')) { node.disabled = busy; }
	for (const node of document.querySelectorAll<HTMLButtonElement>('#layers button')) { node.disabled = busy || polygon !== null; }
	byId<HTMLFieldSetElement>('properties').disabled = busy || selectedShape() === undefined || polygon !== null;
	button('duplicate').disabled = busy || drawing.shapes.length >= options.maxShapes;
	byId('admin-panel').hidden = profile?.isAdmin !== true;
	for (const node of document.querySelectorAll<HTMLButtonElement>('#admin-panel button')) { node.disabled = busy; }
	byId('account').textContent = profile ? `${profile.username} · 已登录` : '本地预览 · 未登录';
	byId('revision').textContent = `${profile ? `账号版本 ${profile.version}` : '本地草稿'}${dirty ? ' · 有未保存修改' : ''}`;
	byId('polygon-tools').hidden = polygon === null;
	button('finish-polygon').disabled = busy || polygon === null || polygon.length < 3;
	button('cancel-polygon').disabled = busy;
	byId('canvas-help').textContent = polygon === null ? '拖动图形调整位置 · 右侧编辑尺寸与角度' : `点击画布添加顶点 (${polygon.length}/${maxPoints})，然后点「完成多边形」`;
	const notice = byId('notice');
	if (!options.enabled) {
		notice.textContent = '服务器已暂停保存。仍可在本地预览，已佩戴头像不受影响。';
	} else if (profile?.blocked) {
		notice.textContent = '管理员已禁用此账号的自定义头像。仍可切回原版头像。';
	} else {
		notice.textContent = '';
	}
	notice.hidden = notice.textContent === '';
	if (!options.auth.password && !options.auth.steam) {
		byId('login-note').textContent = '本服未开启此页面可用的登录方式。请在同源浏览器客户端登录后刷新，或请管理员开启本服密码 / Steam 登录。';
	} else {
		byId('login-note').textContent = '可先自由设计。登录不会改变地图或赛季数据。';
	}
}

function render() {
	try {
		canvas.replaceChildren();
		artwork(canvas, 'clip-canvas', true);
		canvas.append(svgNode('circle', { cx: 50, cy: 50, r: 52, fill: 'none', stroke: '#70898b', 'stroke-width': 0.3, 'stroke-dasharray': '1 1', 'pointer-events': 'none' }));
		const shape = selectedShape();
		if (shape && polygon === null) {
			canvas.append(svgNode('path', { d: shapePath(shape), fill: 'none', stroke: '#f5d58a', 'stroke-width': 0.5, 'stroke-dasharray': '1 1', 'pointer-events': 'none' }));
		}
		if (polygon) {
			canvas.append(svgNode('polyline', { points: polygon.map(point => `${point.x},${point.y}`).join(' '), fill: 'none', stroke: '#f5d58a', 'stroke-width': 0.7, 'pointer-events': 'none' }));
			for (const point of polygon) { canvas.append(svgNode('circle', { cx: point.x, cy: point.y, r: 0.9, fill: '#f5d58a', 'pointer-events': 'none' })); }
		}
		for (const size of [ 32, 64, 128 ]) { preview(size); }
		for (let index = 0; index < 3; ++index) { input(`color${index}`).value = drawing.colors[index]!; }
		const list = byId('layers');
		list.replaceChildren();
		for (const item of [ ...drawing.shapes ].sort((aa, bb) => bb.layer - aa.layer)) {
			const row = document.createElement('div');
			row.className = `layer-row${item.id === selected ? ' selected' : ''}`;
			const swatch = document.createElement('span');
			swatch.className = 'swatch';
			swatch.style.backgroundColor = drawing.colors[item.layer];
			const pick = document.createElement('button');
			pick.textContent = `${labels[item.kind]} · 图层 ${item.layer}`;
			pick.disabled = busy;
			pick.addEventListener('click', () => { selected = item.id; render(); });
			row.append(swatch, pick);
			list.append(row);
		}
		byId('shape-count').textContent = `${drawing.shapes.length} / ${options.maxShapes}`;
		byId('selection-label').textContent = shape ? labels[shape.kind] : '未选中';
		for (const key of [ 'x', 'y', 'width', 'height', 'rotation', 'layer' ] as const) {
			input(`prop-${key}`).value = shape ? String(shape[key]) : '';
		}
		input('mirror-x').checked = shape?.mirrorX ?? false;
		input('mirror-y').checked = shape?.mirrorY ?? false;
		updateControls();
	} catch (caught) { error(caught); }
}

function remember(before: string) {
	if (before !== serialize()) {
		past.push(before);
		if (past.length > 50) { past.shift(); }
		future.length = 0;
		dirty = true;
	}
}

function edit(change: () => void) {
	if (busy) { return; }
	const before = serialize();
	try {
		change();
		drawing = compileDrawing(drawing, hardLimits).drawing;
		remember(before);
	} catch (caught) {
		drawing = JSON.parse(before) as Drawing;
		error(caught);
	}
	if (!selectedShape()) { selected = drawing.shapes.at(-1)?.id ?? null; }
	render();
}

const id = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const newShape = (kind: Shape['kind']): Shape => ({
	id: id(), kind, layer: input('add-layer').value === '2' ? 2 : 1,
	x: 50, y: 50, width: 35, height: 35, rotation: 0, mirrorX: false, mirrorY: false,
});

for (const node of document.querySelectorAll<HTMLButtonElement>('[data-kind]')) {
	node.addEventListener('click', () => edit(() => {
		const shape = newShape(node.dataset.kind as Shape['kind']);
		drawing.shapes.push(shape);
		selected = shape.id;
	}));
}
button('polygon').addEventListener('click', () => { polygon = []; render(); });
button('cancel-polygon').addEventListener('click', () => { polygon = null; render(); });
button('finish-polygon').addEventListener('click', () => {
	if (polygon === null) { return; }
	const points = polygon;
	edit(() => {
		const shape = polygonFromCanvas(points, id(), input('add-layer').value === '2' ? 2 : 1);
		drawing.shapes.push(shape);
		// Don't leave drawing mode on validation failure; the user can cancel and redraw.
		compileDrawing(drawing, hardLimits);
		selected = shape.id;
		polygon = null;
	});
});

for (let index = 0; index < 3; ++index) {
	const color = input(`color${index}`);
	const apply = () => edit(() => { drawing.colors[index] = color.value; });
	color.addEventListener('input', apply);
	color.addEventListener('change', apply);
}
for (const key of [ 'x', 'y', 'width', 'height', 'rotation' ] as const) {
	input(`prop-${key}`).addEventListener('change', () => edit(() => {
		const shape = selectedShape();
		if (shape) { shape[key] = input(`prop-${key}`).valueAsNumber; }
	}));
}
input('prop-layer').addEventListener('change', () => edit(() => {
	const shape = selectedShape();
	if (shape) { shape.layer = input('prop-layer').value === '2' ? 2 : 1; }
}));
for (const [ element, key ] of [ [ 'mirror-x', 'mirrorX' ], [ 'mirror-y', 'mirrorY' ] ] as const) {
	input(element).addEventListener('change', () => edit(() => { const shape = selectedShape(); if (shape) { shape[key] = input(element).checked; } }));
}
button('delete').addEventListener('click', () => edit(() => { drawing.shapes = drawing.shapes.filter(shape => shape.id !== selected); }));
button('duplicate').addEventListener('click', () => edit(() => {
	const shape = selectedShape();
	if (shape) {
		const copy = structuredClone(shape);
		copy.id = id(); copy.x = Math.min(100, copy.x + 5); copy.y = Math.min(100, copy.y + 5);
		drawing.shapes.push(copy); selected = copy.id;
	}
}));
button('new').addEventListener('click', () => {
	if (confirm('新建空白设计？可以使用撤销恢复，尚未保存到服务器。')) {
		polygon = null;
		edit(() => { drawing = { schemaVersion: 1, colors: [ ...drawing.colors ], shapes: [] }; selected = null; });
	}
});

button('import-svg').addEventListener('click', () => { input('svg-file').click(); });
input('svg-file').addEventListener('change', () => {
	const file = input('svg-file').files?.[0];
	input('svg-file').value = '';
	if (!file) { return; }
	void operation(async () => {
		if (!/\.svg$/i.test(file.name)) { throw new Error('请选择 .svg 文件'); }
		if (file.size > maxRequestBytes) { throw new Error('SVG 文件不能超过 64 KiB'); }
		// Parse first, then ask before replacing a valid design. A failed/cancelled import leaves
		// the drawing, undo history, version and server data completely unchanged.
		const imported = importSvg(await file.text(), options, drawing.colors);
		if ((dirty || drawing.shapes.length !== 0) && !confirm('导入 SVG 将替换当前设计，可以使用撤销恢复。是否继续？')) { return; }
		const before = serialize();
		drawing = imported;
		polygon = null;
		selected = drawing.shapes[0]?.id ?? null;
		remember(before);
		render();
		status('SVG 已导入为原生图层。可拖动、缩放、旋转、镜像和调色；确认预览后点击「保存并应用」。当前游戏头像尚未改变。', 'success');
	});
});

function travel(from: string[], to: string[]) {
	if (busy || polygon !== null || from.length === 0) { return; }
	to.push(serialize());
	drawing = JSON.parse(from.pop()!) as Drawing;
	selected = drawing.shapes.at(-1)?.id ?? null;
	dirty = true;
	render();
}
button('undo').addEventListener('click', () => travel(past, future));
button('redo').addEventListener('click', () => travel(future, past));
window.addEventListener('keydown', event => {
	if (event.target instanceof HTMLElement && (event.target.matches('input,textarea,select') || event.target.isContentEditable)) { return; }
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
		event.preventDefault();
		if (event.shiftKey) { travel(future, past); } else { travel(past, future); }
	} else if (event.key === 'Delete' || event.key === 'Backspace') {
		event.preventDefault();
		if (!button('delete').disabled && !byId<HTMLFieldSetElement>('properties').disabled) { button('delete').click(); }
	} else if (event.key === 'Escape') {
		polygon = null; render();
	}
});

function position(event: PointerEvent): Point {
	const matrix = canvas.getScreenCTM();
	if (!matrix) { return { x: 50, y: 50 }; }
	const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
	return { x: point.x, y: point.y };
}
const clamp = (value: number) => Math.round(Math.max(0, Math.min(100, value)) * 1000) / 1000;
canvas.addEventListener('pointerdown', event => {
	if (busy || event.button !== 0 || drag) { return; }
	event.preventDefault();
	const point = position(event);
	if (polygon !== null) {
		if (polygon.length < maxPoints) { polygon.push({ x: clamp(point.x), y: clamp(point.y) }); render(); }
		return;
	}
	selected = event.target instanceof Element ? event.target.closest('[data-id]')?.getAttribute('data-id') ?? null : null;
	const shape = selectedShape();
	if (shape) {
		drag = { pointer: event.pointerId, start: point, origin: { x: shape.x, y: shape.y }, before: serialize() };
		canvas.setPointerCapture(event.pointerId);
	}
	render();
});
canvas.addEventListener('pointermove', event => {
	const shape = selectedShape();
	if (drag?.pointer !== event.pointerId || !shape) { return; }
	const point = position(event);
	shape.x = clamp(drag.origin.x + point.x - drag.start.x);
	shape.y = clamp(drag.origin.y + point.y - drag.start.y);
	render();
});
for (const name of [ 'pointerup', 'pointercancel' ] as const) {
	canvas.addEventListener(name, event => {
		if (drag?.pointer !== event.pointerId) { return; }
		if (name === 'pointercancel') { drawing = JSON.parse(drag.before) as Drawing; } else { remember(drag.before); }
		drag = null;
		if (canvas.hasPointerCapture(event.pointerId)) { canvas.releasePointerCapture(event.pointerId); }
		render();
	});
}

async function loadAccount(replace: boolean) {
	const epoch = authEpoch;
	const next = await api<Profile>('custom-badge/me');
	if (epoch !== authEpoch) { return; }
	profile = next;
	if (replace || !dirty) {
		// A tightened server limit must not make an old drawing impossible to inspect/remove shapes.
		// Read old drafts using hard bounds; publishing still checks the current configured limits.
		drawing = next.draft ? compileDrawing(next.draft, hardLimits).drawing : newDrawing();
		past.length = 0; future.length = 0; dirty = false; polygon = null;
		selected = drawing.shapes[0]?.id ?? null;
	}
	render();
	status(dirty ? '已登录，保留了你的本地设计。保存将更新此账号的草稿。' : '已载入账号草稿。修改完成后点击「保存并应用」。', 'success');
}

byId<HTMLFormElement>('login-form').addEventListener('submit', event => {
	event.preventDefault();
	void operation(async () => {
		const password = input('password').value;
		input('password').value = '';
		const result = await api<{ token: string }>('auth/signin', { email: input('identity').value.trim(), password }, false);
		++authEpoch;
		setToken(result.token);
		await loadAccount(false);
	});
});
button('logout').addEventListener('click', () => {
	if (dirty && !confirm('退出会丢弃当前未保存的设计，是否继续？')) { return; }
	++authEpoch; setToken(''); profile = null; target = null;
	drawing = newDrawing(); dirty = false; polygon = null; selected = drawing.shapes[0]!.id;
	past.length = 0; future.length = 0;
	byId('admin-actions').hidden = true; byId('admin-output').textContent = '';
	render(); status('已退出本页面，不会退出其他游戏窗口。');
});
button('reload').addEventListener('click', () => {
	if (!dirty || confirm('重新载入会丢弃当前未保存的设计，是否继续？')) { void operation(() => loadAccount(true)); }
});

for (const [ element, publish ] of [ [ 'save-draft', false ], [ 'publish', true ] ] as const) {
	button(element).addEventListener('click', () => {
		void operation(async () => {
			if (!profile) { return; }
			const compiled = compileDrawing(drawing, options);
			const result = await api<{ version: number }>('custom-badge/save', { version: profile.version, drawing: compiled.drawing, publish });
			profile.version = result.version;
			drawing = compiled.drawing;
			dirty = false;
			status(publish ? '头像已应用！刷新游戏即可查看。此头像在两个赛季共用。' : '草稿已保存，当前游戏头像没有改变。', 'success');
			render();
		});
	});
}
button('reset').addEventListener('click', () => {
	if (!confirm('将账号头像恢复默认，并撤销当前自定义图案授权？已保存草稿仍会保留。')) { return; }
	void operation(async () => {
		if (!profile) { return; }
		const result = await api<{ version: number }>('custom-badge/reset', { version: profile.version });
		profile.version = result.version;
		status('已恢复默认头像，设计草稿仍保留。', 'success');
	});
});

button('steam-login').addEventListener('click', () => {
	popup?.close();
	clearTimeout(steamTimeout);
	popup = window.open(new URL('auth/steam', apiBase), 'custom-badge-steam', 'width=720,height=720');
	if (!popup) { status('浏览器阻止了登录弹窗，请允许本页打开弹窗后重试。', 'error'); return; }
	status('请在 Steam 弹窗完成登录。');
	steamTimeout = setTimeout(() => { popup?.close(); popup = null; status('Steam 登录超时，请重试。', 'error'); }, 180000);
});
window.addEventListener('message', event => {
	if (!popup || event.source !== popup || event.origin !== apiBase.origin || busy) { return; }
	let result: unknown;
	try { result = typeof event.data === 'string' ? JSON.parse(event.data) as unknown : event.data as unknown; } catch { return; }
	if (result === null || typeof result !== 'object' || !('token' in result) || typeof result.token !== 'string') { return; }
	const steamToken = result.token;
	clearTimeout(steamTimeout); popup.close(); popup = null;
	void operation(async () => { ++authEpoch; setToken(steamToken); await loadAccount(false); });
});

async function loadTarget() {
	target = null;
	byId('admin-actions').hidden = true;
	const next = await api<Profile>(`custom-badge/admin/user?userId=${encodeURIComponent(input('admin-user').value.trim())}`);
	target = next;
	byId('admin-output').textContent = `${next.username} (${next.userId}) · 版本 ${next.version} · ${next.blocked ? '已禁用' : '允许自定义'}`;
	byId('admin-actions').hidden = false;
}
button('admin-load').addEventListener('click', () => { void operation(loadTarget); });
input('admin-user').addEventListener('input', () => { target = null; byId('admin-actions').hidden = true; byId('admin-output').textContent = ''; });
for (const node of document.querySelectorAll<HTMLButtonElement>('[data-moderation]')) {
	node.addEventListener('click', () => {
		if (!target || !confirm(`确定对 ${target.username} 执行「${node.textContent}」？`)) { return; }
		void operation(async () => {
			if (!target) { return; }
			const own = target.userId === profile?.userId;
			await api('custom-badge/admin/moderate', { userId: target.userId, version: target.version, action: node.dataset.moderation });
			await loadTarget();
			if (own) { await loadAccount(true); }
			status('管理操作已生效。', 'success');
		});
	});
}

window.addEventListener('beforeunload', event => {
	if (dirty || polygon !== null) { event.preventDefault(); event.returnValue = ''; }
});

// Core tokens expire after two minutes. Refresh without reloading the drawing/version, otherwise
// a background request could silently defeat optimistic concurrency or discard ongoing edits.
let refreshing = false;
async function refreshSession() {
	if (!profile || !token || busy || refreshing || document.hidden) { return; }
	const epoch = authEpoch;
	refreshing = true;
	try {
		const current = await api<Profile>('custom-badge/me');
		if (epoch === authEpoch) { profile.blocked = current.blocked; updateControls(); }
	} catch (caught) {
		if (epoch === authEpoch && caught instanceof ApiError && caught.status === 401) { error(caught); }
	} finally { refreshing = false; }
}
setInterval(() => { void refreshSession(); }, 45000);
document.addEventListener('visibilitychange', () => { void refreshSession(); });

render();
void operation(async () => {
	options = await api<Options>('custom-badge/config', undefined, false);
	// Preserve valid existing drafts when limits decrease, but never let the server's hard bounds
	// be exceeded. Rendering uses hard limits; editing/saving reports the configured limit.
	if (drawing.shapes.length > options.maxShapes) { drawing.shapes.length = options.maxShapes; }
	render();
	if (token) { await loadAccount(false); } else { status('先自由设计，登录后即可保存。'); }
});
