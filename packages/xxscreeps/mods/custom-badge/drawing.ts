import { SvgPathError, mapPath, parsePath, pathText, positiveWinding } from './svg-path.js';

/** Shared geometry compiler. SVG imports arrive as bounded, numeric-only local paths, never XML. */
export interface Point { x: number; y: number }

export interface Shape {
	id: string;
	kind: 'circle' | 'rectangle' | 'triangle' | 'polygon' | 'path';
	layer: 1 | 2;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
	mirrorX: boolean;
	mirrorY: boolean;
	/** Polygon-local coordinates, from -50 to 50. */
	points?: Point[];
	/** Imported path-local coordinates, from -50 to 50. No SVG markup or attributes. */
	path?: string;
}

export interface Drawing {
	schemaVersion: 1;
	/** Origin metadata only; SVG uploads remain editable, including after reloading a draft. */
	source?: 'svg';
	colors: [ string, string, string ];
	shapes: Shape[];
}

export interface Limits { maxShapes: number; maxPathLength: number }
export const defaultLimits: Limits = { maxShapes: 32, maxPathLength: 32768 };
export const maxPoints = 16;
export const maxRequestBytes = 65536;

export class DrawingError extends Error {}

export function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))) {
		throw new DrawingError('对象字段不合法');
	}
	return value as Record<string, unknown>;
}

function number(value: unknown, min: number, max: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
		throw new DrawingError(`数值必须介于 ${min} 和 ${max} 之间`);
	}
	return Math.round(value * 1000) / 1000;
}

function boolean(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		throw new DrawingError('镜像参数必须是布尔值');
	}
	return value;
}

const cross = (start: Point, end: Point, point: Point) =>
	(end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
const signedArea = (points: Point[]) => points.reduce((area, point, index) => {
	const next = points[(index + 1) % points.length]!;
	return area + point.x * next.y - next.x * point.y;
}, 0);

function intersects(aa: Point, bb: Point, cc: Point, dd: Point) {
	if (Math.max(aa.x, bb.x) < Math.min(cc.x, dd.x) || Math.max(cc.x, dd.x) < Math.min(aa.x, bb.x) ||
		Math.max(aa.y, bb.y) < Math.min(cc.y, dd.y) || Math.max(cc.y, dd.y) < Math.min(aa.y, bb.y)) {
		return false;
	}
	return cross(aa, bb, cc) * cross(aa, bb, dd) <= 0 && cross(cc, dd, aa) * cross(cc, dd, bb) <= 0;
}

function parsePoints(value: unknown): Point[] {
	if (!Array.isArray(value) || value.length < 3 || value.length > maxPoints) {
		throw new DrawingError(`多边形需要 3–${maxPoints} 个顶点`);
	}
	const points = value.map((value: unknown) => {
		const point = object(value, [ 'x', 'y' ]);
		return { x: number(point.x, -50, 50), y: number(point.y, -50, 50) };
	});
	if (Math.abs(signedArea(points)) < 0.1) {
		throw new DrawingError('多边形面积过小');
	}
	for (let index = 0; index < points.length; ++index) {
		const start = points[index]!;
		const end = points[(index + 1) % points.length]!;
		if (start.x === end.x && start.y === end.y) {
			throw new DrawingError('多边形不能有重复顶点');
		}
		for (let other = index + 1; other < points.length; ++other) {
			if (other !== index + 1 && !(index === 0 && other === points.length - 1) &&
				intersects(start, end, points[other]!, points[(other + 1) % points.length]!)) {
				throw new DrawingError('多边形不能自交');
			}
		}
	}
	return points;
}

function parseLocalPath(value: unknown, limits: Limits): string {
	if (typeof value !== 'string' || value.length > limits.maxPathLength) {
		throw new DrawingError('导入路径必须是字符串且不能超过路径长度上限');
	}
	try {
		const commands = parsePath(value);
		for (const command of commands) {
			for (const point of command.points) {
				point.x = number(point.x, -50, 50);
				point.y = number(point.y, -50, 50);
			}
		}
		return pathText(positiveWinding(commands));
	} catch (error) {
		if (error instanceof SvgPathError) { throw new DrawingError(error.message); }
		throw error;
	}
}

export function parseDrawing(value: unknown, limits = defaultLimits): Drawing {
	const drawing = object(value, [ 'schemaVersion', 'source', 'colors', 'shapes' ]);
	if (drawing.source !== undefined && drawing.source !== 'svg') {
		throw new DrawingError('设计来源不合法');
	}
	if (drawing.schemaVersion !== 1 || !Array.isArray(drawing.colors) || drawing.colors.length !== 3 ||
		!drawing.colors.every((color: unknown) => typeof color === 'string' && color.length === 7 && /^#[0-9a-f]{6}$/i.test(color))) {
		throw new DrawingError('需要版本 1 和三个 #rrggbb 颜色');
	}
	if (!Array.isArray(drawing.shapes) || drawing.shapes.length > limits.maxShapes) {
		throw new DrawingError(`最多允许 ${limits.maxShapes} 个图形`);
	}
	const ids = new Set<string>();
	let importedLength = 0;
	const shapes = drawing.shapes.map((value: unknown): Shape => {
		const shape = object(value, [ 'id', 'kind', 'layer', 'x', 'y', 'width', 'height', 'rotation', 'mirrorX', 'mirrorY', 'points', 'path' ]);
		if (typeof shape.id !== 'string' || shape.id.length < 1 || shape.id.length > 40 || /[^a-zA-Z0-9_-]/.test(shape.id) || ids.has(shape.id)) {
			throw new DrawingError('图形 ID 不合法或重复');
		}
		ids.add(shape.id);
		if (shape.kind !== 'circle' && shape.kind !== 'rectangle' && shape.kind !== 'triangle' && shape.kind !== 'polygon' && shape.kind !== 'path') {
			throw new DrawingError('不支持的图形类型');
		}
		if (shape.layer !== 1 && shape.layer !== 2) {
			throw new DrawingError('图形必须属于图层 1 或 2');
		}
		if (shape.kind !== 'polygon' && shape.points !== undefined) {
			throw new DrawingError('只有多边形可以携带顶点');
		}
		if (shape.kind !== 'path' && shape.path !== undefined) {
			throw new DrawingError('只有导入路径可以携带 path');
		}
		let path: string | undefined;
		if (shape.kind === 'path') {
			path = parseLocalPath(shape.path, limits);
			importedLength += path.length;
			if (importedLength > limits.maxPathLength) { throw new DrawingError('导入路径合计过长，请先简化 SVG'); }
		}
		return {
			id: shape.id, kind: shape.kind, layer: shape.layer,
			x: number(shape.x, 0, 100), y: number(shape.y, 0, 100),
			width: number(shape.width, 0.5, 200), height: number(shape.height, 0.5, 200),
			rotation: number(shape.rotation, -180, 180),
			mirrorX: boolean(shape.mirrorX), mirrorY: boolean(shape.mirrorY),
			...shape.kind === 'polygon' ? { points: parsePoints(shape.points) } : {},
			...path === undefined ? {} : { path },
		};
	});
	const [ first, second, third ] = drawing.colors as [ string, string, string ];
	return {
		schemaVersion: 1,
		...drawing.source === 'svg' ? { source: 'svg' as const } : {},
		colors: [ first.toLowerCase(), second.toLowerCase(), third.toLowerCase() ], shapes,
	};
}

function transform(shape: Shape, point: Point, mirror = true): Point {
	const angle = shape.rotation * Math.PI / 180;
	const xx = point.x * shape.width / 100 * (mirror && shape.mirrorX ? -1 : 1);
	const yy = point.y * shape.height / 100 * (mirror && shape.mirrorY ? -1 : 1);
	return {
		x: shape.x + xx * Math.cos(angle) - yy * Math.sin(angle),
		y: shape.y + xx * Math.sin(angle) + yy * Math.cos(angle),
	};
}

const coordinates = (point: Point) => `${Math.round(point.x * 1000) / 1000} ${Math.round(point.y * 1000) / 1000}`;

/** Validated shapes only. Primitives keep positive winding; imported paths retain their holes'
 * relative winding while keeping the largest contour positive, including after mirrors. */
export function shapePath(shape: Shape): string {
	if (shape.kind === 'path') {
		const angle = shape.rotation * Math.PI / 180;
		const scaleX = shape.width / 100 * (shape.mirrorX ? -1 : 1);
		const scaleY = shape.height / 100 * (shape.mirrorY ? -1 : 1);
		return pathText(positiveWinding(mapPath(parsePath(shape.path!), [
			Math.cos(angle) * scaleX, Math.sin(angle) * scaleX,
			-Math.sin(angle) * scaleY, Math.cos(angle) * scaleY, shape.x, shape.y,
		])));
	}
	if (shape.kind === 'circle') {
		// Four cubic Béziers approximate an ellipse. Reflection doesn't change an ellipse; omitting it
		// keeps winding positive, so overlapping same-layer objects cannot cancel each other out.
		const control = 50 * 0.5522847498307936;
		const curve = (points: number[][]) => points.map(([ xx, yy ]) =>
			coordinates(transform(shape, { x: xx!, y: yy! }, false))).join(' ');
		return `M ${curve([ [ 50, 0 ] ])} C ${curve([ [ 50, control ], [ control, 50 ], [ 0, 50 ],
			[ -control, 50 ], [ -50, control ], [ -50, 0 ], [ -50, -control ], [ -control, -50 ], [ 0, -50 ],
			[ control, -50 ], [ 50, -control ], [ 50, 0 ] ])} Z`;
	}
	let base: Point[];
	if (shape.kind === 'polygon') {
		base = shape.points!;
	} else if (shape.kind === 'triangle') {
		base = [ { x: 0, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 } ];
	} else {
		base = [ { x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 } ];
	}
	const points = base.map(point => transform(shape, point));
	if (signedArea(points) < 0) {
		points.reverse();
	}
	return `M ${points.map(coordinates).join(' L ')} Z`;
}

export function compileDrawing(value: unknown, limits = defaultLimits) {
	const drawing = parseDrawing(value, limits);
	const paths = [ 1, 2 ].map(layer => drawing.shapes.filter(shape => shape.layer === layer).map(shapePath).join(' '));
	if (paths[0]!.length + paths[1]!.length > limits.maxPathLength) {
		throw new DrawingError('图案路径过长，请减少图形或顶点');
	}
	return {
		drawing,
		badge: {
			color1: drawing.colors[0], color2: drawing.colors[1], color3: drawing.colors[2],
			flip: false,
			type: { path1: paths[0]!, path2: paths[1]! },
		},
	};
}

/** Convert canvas clicks to bounded local vertices. Clamp floating point edge error: a bounding
 * box extremum can otherwise become 50.00000000000001 and fail the strict wire validator. */
export function polygonFromCanvas(points: Point[], id: string, layer: 1 | 2): Shape {
	if (points.length < 3 || points.length > maxPoints) {
		throw new DrawingError(`多边形需要 3–${maxPoints} 个顶点`);
	}
	for (const point of points) { number(point.x, 0, 100); number(point.y, 0, 100); }
	const minX = Math.min(...points.map(point => point.x));
	const minY = Math.min(...points.map(point => point.y));
	const maxX = Math.max(...points.map(point => point.x));
	const maxY = Math.max(...points.map(point => point.y));
	const width = maxX - minX;
	const height = maxY - minY;
	if (width < 0.5 || height < 0.5) { throw new DrawingError('多边形宽高至少为 0.5'); }
	const centerX = (minX + maxX) / 2;
	const centerY = (minY + maxY) / 2;
	const bounded = (value: number) => Math.max(-50, Math.min(50, value));
	return {
		id, layer, kind: 'polygon', x: centerX, y: centerY, width, height,
		rotation: 0, mirrorX: false, mirrorY: false,
		points: points.map(point => ({ x: bounded((point.x - centerX) * 100 / width), y: bounded((point.y - centerY) * 100 / height) })),
	};
}

export function newDrawing(): Drawing {
	return {
		schemaVersion: 1,
		colors: [ '#15232e', '#55d6be', '#f5d58a' ],
		shapes: [ {
			id: 'first', kind: 'triangle', layer: 1, x: 50, y: 48, width: 58, height: 54,
			rotation: 0, mirrorX: false, mirrorY: false,
		}, {
			id: 'second', kind: 'circle', layer: 2, x: 50, y: 60, width: 17, height: 17,
			rotation: 0, mirrorX: false, mirrorY: false,
		} ],
	};
}
