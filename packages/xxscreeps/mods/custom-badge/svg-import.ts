import type { Drawing, Limits, Shape } from './drawing.js';
import type { Matrix, PathCommand } from './svg-path.js';
import { DrawingError, compileDrawing, defaultLimits, maxRequestBytes } from './drawing.js';
import { SvgPathError, identity, mapPath, multiply, parsePath, parseTransform, pathText, positiveWinding } from './svg-path.js';

const namespace = 'http://www.w3.org/2000/svg';
const presentation = new Set([
	'fill', 'color', 'stroke', 'fill-rule', 'opacity', 'fill-opacity', 'stroke-opacity',
	'display', 'visibility', 'clip-path',
]);
const common = new Set([
	'id', 'class', 'transform', 'style', ...presentation,
	'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
	'stroke-dashoffset', 'vector-effect', 'shape-rendering', 'version', 'role', 'focusable',
]);
const attributes: Record<string, string[]> = {
	svg: [ 'viewBox', 'width', 'height', 'preserveAspectRatio' ],
	g: [],
	path: [ 'd', 'pathLength' ],
	rect: [ 'x', 'y', 'width', 'height', 'rx', 'ry' ],
	circle: [ 'cx', 'cy', 'r' ],
	ellipse: [ 'cx', 'cy', 'rx', 'ry' ],
	polygon: [ 'points' ],
	polyline: [ 'points' ],
	defs: [],
	clipPath: [ 'clipPathUnits' ],
};
const forbidden = new Set([
	'script', 'style', 'foreignobject', 'image', 'use', 'a', 'animate', 'animatemotion',
	'animatetransform', 'set', 'filter', 'lineargradient', 'radialgradient', 'pattern',
]);
const names: Record<string, string> = {
	black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
	lime: '#00ff00', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff',
	fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000',
	navy: '#000080', olive: '#808000', purple: '#800080', teal: '#008080', orange: '#ffa500',
};

export interface SvgImportReport {
	filtered: string[];
	notes: string[];
}

type Filter = (item: string, reason: string) => void;

function scalar(value: string, min = -1000000, max = 1000000, pixels = false) {
	const text = value.trim();
	const pattern = pixels ? /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px)?$/i : /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
	if (!pattern.test(text)) { throw new DrawingError('SVG 数值必须是有限数字；长度仅支持用户单位或 px'); }
	const number = Number(pixels ? text.replace(/px$/i, '') : text);
	if (!Number.isFinite(number) || number < min || number > max) { throw new DrawingError('SVG 数值超出允许范围'); }
	return number;
}

function color(value: string): string | null {
	const text = value.trim().toLowerCase();
	if (text === 'none' || text === 'transparent') { return null; }
	if (/^#[0-9a-f]{3}$/.test(text)) { return '#' + [ ...text.slice(1) ].map(value => value + value).join(''); }
	if (/^#[0-9a-f]{6}$/.test(text)) { return text; }
	if (/^#[0-9a-f]{4}$/.test(text) || /^#[0-9a-f]{8}$/.test(text)) {
		const alpha = text.length === 5 ? text[4]! + text[4]! : text.slice(7);
		if (alpha === '00') { return null; }
		if (alpha !== 'ff') { throw new DrawingError('原生 Badge 不支持半透明填充，请先改成不透明纯色'); }
		return color(text.length === 5 ? text.slice(0, 4) : text.slice(0, 7));
	}
	if (Object.hasOwn(names, text)) { return names[text]!; }
	const match = /^rgba?\(([^()]*)\)$/.exec(text);
	if (match) {
		const content = match[1]!;
		let channels: string[];
		let alpha: string | undefined;
		if (content.includes(',')) {
			channels = content.split(',').map(value => value.trim());
			if (channels.length === 4) { alpha = channels.pop(); }
		} else {
			const parts = content.split('/');
			if (parts.length > 2) { throw new DrawingError('SVG RGB 颜色不合法'); }
			channels = parts[0]!.trim().split(/\s+/);
			alpha = parts[1]?.trim();
		}
		if (channels.length !== 3) { throw new DrawingError('SVG RGB 颜色需要三个分量'); }
		if (alpha !== undefined) {
			const opacity = alpha.endsWith('%') ? scalar(alpha.slice(0, -1), 0, 100) / 100 : scalar(alpha, 0, 1);
			if (opacity === 0) { return null; }
			if (opacity !== 1) { throw new DrawingError('原生 Badge 不支持半透明填充'); }
		}
		return '#' + channels.map(value => {
			const byte = value.endsWith('%') ? scalar(value.slice(0, -1), 0, 100) * 255 / 100 : scalar(value, 0, 255);
			return Math.round(byte).toString(16).padStart(2, '0');
		}).join('');
	}
	throw new DrawingError('SVG 仅支持不透明纯色，请使用 #rrggbb / RGB；不支持渐变或颜色引用');
}

interface Style {
	fill: string;
	color: string;
	stroke: string;
	rule: string;
	hidden: boolean;
	visible: boolean;
	fillOpacity: number;
}

function checkPresentation(key: string, value: string, clips: Set<string>) {
	if (!presentation.has(key) || value === '') { throw new DrawingError('不支持的样式'); }
	if (value === 'inherit') { return; }
	if (key === 'fill' || key === 'color' || key === 'stroke') {
		if (value === 'currentColor' && key !== 'stroke') { return; }
		const parsed = color(value);
		if (key === 'stroke' && parsed !== null) { throw new DrawingError('原生 Badge 不支持描边'); }
		if (key === 'color' && parsed === null) { throw new DrawingError('color 需要不透明纯色'); }
	} else if (key === 'fill-rule') {
		if (value !== 'nonzero') { throw new DrawingError('仅支持 nonzero 填充'); }
	} else if (key === 'display') {
		if (value !== 'none' && value !== 'inline') { throw new DrawingError('不支持的 display'); }
	} else if (key === 'visibility') {
		if (![ 'hidden', 'collapse', 'visible' ].includes(value)) { throw new DrawingError('不支持的 visibility'); }
	} else if (key === 'clip-path') {
		const match = /^url\(\s*#([a-zA-Z0-9_-]+)\s*\)$/.exec(value);
		if (value !== 'none' && (!match || !clips.has(match[1]!))) {
			throw new DrawingError('仅支持原版 Badge 圆形裁切');
		}
	} else {
		const opacity = value.endsWith('%') ? scalar(value.slice(0, -1), 0, 100) / 100 : scalar(value, 0, 1);
		if (opacity !== 0 && opacity !== 1) { throw new DrawingError('原生 Badge 不支持半透明'); }
	}
}

function appearance(element: Element, inherited: Style, clips: Set<string>, filter: Filter): Style {
	const declarations = new Map<string, string>();
	for (const name of presentation) {
		const value = element.getAttribute(name);
		if (value === null) { continue; }
		try {
			checkPresentation(name, value.trim(), clips);
			declarations.set(name, value.trim());
		} catch (error) {
			if (!(error instanceof DrawingError)) { throw error; }
			element.removeAttribute(name);
			filter(`attr <${element.localName}>.${name}`, error.message);
		}
	}
	const styles = new Map<string, string>();
	for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
		if (declaration.trim() === '') { continue; }
		const split = declaration.indexOf(':');
		const key = declaration.slice(0, split).trim().toLowerCase();
		const value = declaration.slice(split + 1).trim();
		try {
			if (split === -1) { throw new DrawingError('样式声明格式不合法'); }
			checkPresentation(key, value, clips);
			styles.set(key, value);
		} catch (error) {
			if (!(error instanceof DrawingError)) { throw error; }
			filter(`attr <${element.localName}>.style.${split === -1 ? '(invalid)' : key || '(empty)'}`, error.message);
		}
	}
	if (element.hasAttribute('style')) {
		if (styles.size) { element.setAttribute('style', [ ...styles ].map(([ key, value ]) => `${key}:${value}`).join(';')); }
		else { element.removeAttribute('style'); }
	}
	for (const [ key, value ] of styles) { declarations.set(key, value); }
	const state = { ...inherited };
	for (const [ key, value ] of declarations) {
		if (value === 'inherit') { continue; }
		if (key === 'fill' || key === 'color' || key === 'stroke') {
			state[key] = key === 'color' && value === 'currentColor' ? inherited.color : value;
		}
		else if (key === 'fill-rule') { state.rule = value; }
		else if (key === 'display') {
			if (value === 'none') { state.hidden = true; }
		} else if (key === 'visibility') {
			if (value === 'hidden' || value === 'collapse') { state.visible = false; }
			else if (value === 'visible') { state.visible = true; }
		} else if (key !== 'clip-path') {
			const opacity = value.endsWith('%') ? scalar(value.slice(0, -1), 0, 100) / 100 : scalar(value, 0, 1);
			if (key === 'fill-opacity') { state.fillOpacity = opacity; }
			else if (key === 'opacity' && opacity === 0) { state.hidden = true; }
		}
	}
	return state;
}

function filterAttributes(element: Element, filter: Filter) {
	const allowed = attributes[element.localName]!;
	for (const attribute of [ ...element.attributes ]) {
		if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/' || attribute.name === 'xmlns') { continue; }
		try {
			const name = attribute.localName.toLowerCase();
			if (name.startsWith('on') || name === 'href' || name === 'src') {
				throw new DrawingError('事件处理器、链接和外部资源不进入头像');
			}
			if (attribute.namespaceURI !== null) { throw new DrawingError('命名空间属性不进入头像'); }
			if (!common.has(attribute.name) && !allowed.includes(attribute.name) &&
				!attribute.name.startsWith('data-') && !attribute.name.startsWith('aria-')) {
				throw new DrawingError('不支持的属性');
			}
			const value = attribute.value;
			if (attribute.name === 'transform') {
				if (!parseTransform(value).every(Number.isFinite)) { throw new DrawingError('变换矩阵不是有限数值'); }
			}
			else if (attribute.name === 'd' && value.trim() !== '') { parsePath(value); }
			else if (attribute.name === 'points' && value.trim() !== '') { parsePath(`M ${value} Z`); }
			else if ([ 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'pathLength' ].includes(attribute.name)) {
				const min = [ 'r', 'rx', 'ry', 'width', 'height', 'pathLength' ].includes(attribute.name) ? 0 : -1000000;
				scalar(value, element.localName === 'svg' && [ 'width', 'height' ].includes(attribute.name) ? 0.001 : min, 1000000, true);
			} else if (attribute.name === 'viewBox') {
				const view = value.trim().split(/[\s,]+/).map(value => scalar(value));
				if (view.length !== 4 || view[2]! <= 0 || view[3]! <= 0) { throw new DrawingError('viewBox 需要四个数字和正数宽高'); }
			} else if (attribute.name === 'preserveAspectRatio') {
				if (![ 'none', 'xMidYMid', 'xMidYMid meet' ].includes(value.trim())) { throw new DrawingError('不支持的宽高比对齐方式，使用默认等比居中'); }
			} else if ((attribute.name.startsWith('stroke-') && !presentation.has(attribute.name)) || attribute.name === 'vector-effect') {
				throw new DrawingError('描边布局不进入头像');
			}
		} catch (error) {
			if (!(error instanceof DrawingError) && !(error instanceof SvgPathError)) { throw error; }
			element.removeAttributeNode(attribute);
			filter(`attr <${element.localName}>.${attribute.name}`, error.message);
		}
	}
}

function geometry(element: Element): PathCommand[] {
	const length = (name: string, fallback = 0, min = -1000000) =>
		scalar(element.getAttribute(name) ?? String(fallback), min, 1000000, true);
	const kind = element.localName;
	if (kind === 'path') {
		const path = element.getAttribute('d')?.trim() ?? '';
		return path === '' ? [] : parsePath(path);
	}
	if (kind === 'polygon' || kind === 'polyline') {
		const text = element.getAttribute('points')?.trim() ?? '';
		if (text === '') { return []; }
		// SVG polygon points use the same numeric token grammar as an implicit lineto list.
		return parsePath(`M ${text} Z`);
	}
	if (kind === 'circle' || kind === 'ellipse') {
		const cx = length('cx');
		const cy = length('cy');
		const rx = length(kind === 'circle' ? 'r' : 'rx', 0, 0);
		const ry = kind === 'circle' ? rx : length('ry', 0, 0);
		if (rx === 0 || ry === 0) { return []; }
		return parsePath(`M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} Z`);
	}
	const xx = length('x');
	const yy = length('y');
	const width = length('width', 0, 0);
	const height = length('height', 0, 0);
	if (width === 0 || height === 0) { return []; }
	const radiusX = length('rx', length('ry', 0, 0), 0);
	const radiusY = length('ry', radiusX, 0);
	const rx = Math.min(width / 2, radiusX);
	const ry = Math.min(height / 2, radiusY);
	if (rx === 0 || ry === 0) { return parsePath(`M ${xx} ${yy} H ${xx + width} V ${yy + height} H ${xx} Z`); }
	return parsePath(`M ${xx + rx} ${yy} H ${xx + width - rx} A ${rx} ${ry} 0 0 1 ${xx + width} ${yy + ry} V ${yy + height - ry} A ${rx} ${ry} 0 0 1 ${xx + width - rx} ${yy + height} H ${xx + rx} A ${rx} ${ry} 0 0 1 ${xx} ${yy + height - ry} V ${yy + ry} A ${rx} ${ry} 0 0 1 ${xx + rx} ${yy} Z`);
}

function importedShape(path: PathCommand[], layer: 1 | 2): Shape {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const command of path) {
		for (const point of command.points) {
			minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
			maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
		}
	}
	const width = Math.max(0.5, maxX - minX);
	const height = Math.max(0.5, maxY - minY);
	const xx = (minX + maxX) / 2;
	const yy = (minY + maxY) / 2;
	if (xx < 0 || xx > 100 || yy < 0 || yy > 100 || width > 200 || height > 200) {
		throw new DrawingError('SVG 路径超出画布范围，请调整 viewBox 或裁剪 / 简化曲线后再导入');
	}
	const local = mapPath(path, [ 100 / width, 0, 0, 100 / height, -xx * 100 / width, -yy * 100 / height ]);
	for (const command of local) {
		for (const point of command.points) {
			// Protect exact bounding-box extrema against floating-point overshoot.
			point.x = Math.max(-50, Math.min(50, point.x));
			point.y = Math.max(-50, Math.min(50, point.y));
		}
	}
	return {
		id: `svg-layer-${layer}`, kind: 'path', layer, x: xx, y: yy, width, height,
		rotation: 0, mirrorX: false, mirrorY: false, path: pathText(local),
	};
}

/** Parse in an inert XML document; never attach imported nodes, attributes or markup to the page.
 * Only the resulting numeric paths reach the shared compiler and existing authenticated save API. */
export function importSvg(source: string, limits: Limits = defaultLimits,
	fallbackColors: Drawing['colors'] = [ '#ffffff', '#000000', '#000000' ],
	report: SvgImportReport = { filtered: [], notes: [] }): Drawing {
	const filter: Filter = (item, reason) => {
		const message = `${item}：${reason}`;
		if (!report.filtered.includes(message)) { report.filtered.push(message); }
	};
	try {
		if (new TextEncoder().encode(source).byteLength > maxRequestBytes) { throw new DrawingError('SVG 文件不能超过 64 KiB'); }
		const xml = source.replace(/^\uFEFF/, '').replace(/^\s*<\?xml\s[^?]*\?>/, '');
		if (/<!DOCTYPE|<!ENTITY|<\?/i.test(xml)) { throw new DrawingError('不允许 SVG DTD、实体声明或处理指令'); }
		// This is an inert XML document, not an HTML/SVG insertion. No imported node is ever
		// adopted into the live document, including nodes that will be removed by the allowlist.
		const document = new DOMParser().parseFromString(xml, 'image/svg+xml');
		const root = document.documentElement;
		if (document.getElementsByTagName('parsererror').length || root.localName !== 'svg' || root.namespaceURI !== namespace) {
			throw new DrawingError('文件不是有效的 SVG；请包含标准 SVG xmlns 和正确的 XML 结构');
		}
		if (document.getElementsByTagName('*').length > 512) { throw new DrawingError('SVG 元素过多，请简化后再导入'); }
		const remove = (element: Element, reason: string) => {
			filter(`element <${element.localName}>`, reason);
			// Drop the entire subtree. Never unwrap scripts, foreign documents, or unsupported
			// containers into visible artwork.
			element.remove();
		};
		const sanitize = (element: Element, depth: number) => {
			if (depth > 32) { throw new DrawingError('SVG 嵌套过深'); }
			if (forbidden.has(element.localName.toLowerCase()) || element.namespaceURI !== namespace ||
				!Object.hasOwn(attributes, element.localName) || (element.localName === 'svg' && element !== root)) {
				remove(element, '不支持或不安全的元素及其子树已忽略');
				return;
			}
			filterAttributes(element, filter);
			for (const child of [ ...element.children ]) { sanitize(child, depth + 1); }
		};
		sanitize(root, 0);
		const elements = Array.from(document.getElementsByTagName('*'));
		let view: number[];
		const viewBox = root.getAttribute('viewBox');
		if (viewBox !== null) {
			view = viewBox.trim().split(/[\s,]+/).map(value => scalar(value));
			if (view.length !== 4 || view[2]! <= 0 || view[3]! <= 0) { throw new DrawingError('SVG viewBox 需要四个数字和正数宽高'); }
		} else {
			view = [ 0, 0, scalar(root.getAttribute('width') ?? '100', 0.001, 1000000, true),
				scalar(root.getAttribute('height') ?? '100', 0.001, 1000000, true) ];
		}
		const aspect = root.getAttribute('preserveAspectRatio')?.trim() ?? 'xMidYMid meet';
		if (aspect !== 'none' && aspect !== 'xMidYMid' && aspect !== 'xMidYMid meet') {
			throw new DrawingError('SVG 请使用 preserveAspectRatio="xMidYMid meet" 或 "none"');
		}
		const scale = Math.min(100 / view[2]!, 100 / view[3]!);
		const scaleX = aspect === 'none' ? 100 / view[2]! : scale;
		const scaleY = aspect === 'none' ? 100 / view[3]! : scale;
		const viewport: Matrix = [ scaleX, 0, 0, scaleY,
			(100 - view[2]! * scaleX) / 2 - view[0]! * scaleX,
			(100 - view[3]! * scaleY) / 2 - view[1]! * scaleY ];
		const clips = new Set<string>();
		for (const element of elements.filter(element => element.localName === 'clipPath')) {
			const circle = element.children[0];
			const clipId = element.getAttribute('id');
			if (!clipId || !/^[a-zA-Z0-9_-]+$/.test(clipId) || element.children.length !== 1 || circle?.localName !== 'circle' ||
				view.join(' ') !== '0 0 100 100' || element.hasAttribute('transform') || circle.hasAttribute('transform') ||
				element.parentElement?.localName !== 'defs' || element.parentElement.parentElement !== root ||
				element.parentElement.hasAttribute('transform') || element.parentElement.hasAttribute('style') ||
				(element.getAttribute('clipPathUnits') ?? 'userSpaceOnUse') !== 'userSpaceOnUse' ||
				scalar(circle.getAttribute('cx') ?? '0') !== 50 || scalar(circle.getAttribute('cy') ?? '0') !== 50 ||
				scalar(circle.getAttribute('r') ?? '0') !== 52) {
				remove(element, '仅兼容原版 Badge 的默认圆形 clipPath，其他裁切已忽略');
				continue;
			}
			// No styles/presentation may alter a supposedly native clipping circle.
			if (circle.hasAttribute('style') || element.hasAttribute('style') ||
				[ ...presentation ].some(name => circle.hasAttribute(name) || element.hasAttribute(name))) {
				remove(element, '圆形 clipPath 带有额外样式，裁切已忽略');
				continue;
			}
			clips.add(clipId);
		}
		for (const element of elements.filter(element => element.localName === 'defs')) {
			for (const child of [ ...element.children ]) {
				if (child.localName !== 'clipPath' || !clips.has(child.getAttribute('id') ?? '')) {
					remove(child, 'defs 中仅保留原版圆形裁切定义');
				}
			}
		}
		// Validate presentation on every surviving element, including hidden artwork, so all
		// filtered attributes are reported rather than silently bypassed by display="none".
		for (const element of Array.from(document.getElementsByTagName('*'))) {
			appearance(element, {
				fill: '#000000', color: '#000000', stroke: 'none', rule: 'nonzero',
				hidden: false, visible: true, fillOpacity: 1,
			}, clips, filter);
		}
		const records: { color: string; path: PathCommand[]; background: boolean; element: string }[] = [];
		const walk = (element: Element, parent: Matrix, inherited: Style, depth: number) => {
			if (depth > 32) { throw new DrawingError('SVG 嵌套过深'); }
			if (element.localName === 'defs' || element.localName === 'clipPath') { return; }
			const state = appearance(element, inherited, clips, filter);
			const matrix = multiply(parent, parseTransform(element.getAttribute('transform') ?? ''));
			if (!matrix.every(Number.isFinite)) {
				remove(element, '变换合成结果不是有限数值，元素及其子树已忽略');
				return;
			}
			if (state.hidden) { return; }
			if (element.localName === 'svg' || element.localName === 'g') {
				for (const child of [ ...element.children ]) { walk(child, matrix, state, depth + 1); }
				return;
			}
			for (const child of [ ...element.children ]) { remove(child, '图形内部的嵌套元素已忽略'); }
			if (!state.visible || state.fillOpacity === 0) { return; }
			const fill = color(state.fill === 'currentColor' ? state.color : state.fill);
			if (fill === null) { return; }
			let commands: PathCommand[];
			try { commands = geometry(element); } catch (error) {
				if (!(error instanceof DrawingError) && !(error instanceof SvgPathError)) { throw error; }
				remove(element, `几何参数无法生成有效路径：${error.message}`);
				return;
			}
			if (commands.length === 0) {
				filter(`element <${element.localName}>`, '缺少有效几何或尺寸为零，未生成图案');
				return;
			}
			const original = mapPath(commands, matrix);
			if (!original.every(command => command.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))) {
				remove(element, '变换后的路径坐标不是有限数值');
				return;
			}
			const corners = original.flatMap(command => command.points);
			const background = element.localName === 'rect' && !element.hasAttribute('rx') && !element.hasAttribute('ry') &&
				corners.length === 4 && corners.every(point =>
					(Math.abs(point.x - view[0]!) < 0.000001 || Math.abs(point.x - view[0]! - view[2]!) < 0.000001) &&
					(Math.abs(point.y - view[1]!) < 0.000001 || Math.abs(point.y - view[1]! - view[3]!) < 0.000001)) &&
				new Set(corners.map(point => `${point.x},${point.y}`)).size === 4;
			records.push({ color: fill, path: positiveWinding(mapPath(original, viewport)), background, element: element.localName });
		};
		walk(root, identity, {
			fill: '#000000', color: '#000000', stroke: 'none', rule: 'nonzero',
			hidden: false, visible: true, fillOpacity: 1,
		}, 0);
		const colors: Drawing['colors'] = [ ...fallbackColors ];
		const bottom = records.shift();
		if (!bottom) { throw new DrawingError('过滤后 SVG 中没有可导入的可见填充图案'); }
		colors[0] = bottom.color;
		if (!bottom.background) {
			report.notes.push(`最底层 <${bottom.element}> 的填色 ${bottom.color} 将用作背景色并铺满头像；原来的轮廓和透明区域可能改变，请确认预览。`);
		}
		const palette: string[] = [];
		const layers: PathCommand[][] = [ [], [] ];
		let previous = 0;
		let commands = bottom.path.length;
		for (const record of records) {
			let index = palette.indexOf(record.color);
			if (index === -1) { index = palette.length; palette.push(record.color); }
			if (index > 1) {
				throw new DrawingError('游戏原生 Badge 只能表示一个背景色和两个前景色，无法保留此 SVG 的全部颜色；未导入，也不会自动减色或替换颜色');
			}
			if (index < previous) { throw new DrawingError('SVG 的两种前景色交错叠放，不能无损转换为两个图层；请先按颜色整理层级'); }
			previous = index;
			commands += record.path.length;
			if (commands > 4096) { throw new DrawingError('SVG 路径过于复杂，请先简化'); }
			layers[index]!.push(...record.path);
		}
		for (let index = 0; index < palette.length; ++index) { colors[index + 1] = palette[index]!; }
		const shapes = layers.flatMap((path, index) => path.length ? [ importedShape(path, index === 0 ? 1 : 2) ] : []);
		const compiled = compileDrawing({ schemaVersion: 1, source: 'svg', colors, shapes }, limits).drawing;
		// Keep enough room for version/publish and the enclosing JSON object in the existing API.
		if (new TextEncoder().encode(JSON.stringify(compiled)).byteLength > maxRequestBytes - 256) {
			throw new DrawingError('转换后的 SVG 设计超过保存接口的 64 KiB 限额，请先简化路径');
		}
		return compiled;
	} catch (error) {
		if (error instanceof SvgPathError) { throw new DrawingError(error.message); }
		throw error;
	}
}
