/** Numeric-only SVG path parser, shared by the browser importer and server compiler.
 * XML, attributes, URLs and CSS never enter the badge's path attributes. */
export interface SvgPoint { x: number; y: number }
export interface PathCommand { kind: 'M' | 'L' | 'C' | 'Q' | 'Z'; points: SvgPoint[] }
export type Matrix = [ number, number, number, number, number, number ];
export const identity: Matrix = [ 1, 0, 0, 1, 0, 0 ];
const maxCommands = 4096;
const maxCoordinate = 1000000;

export class SvgPathError extends Error {}

function finite(value: number) {
	if (!Number.isFinite(value) || Math.abs(value) > maxCoordinate) {
		throw new SvgPathError('SVG 坐标过大或不是有限数值');
	}
	return value;
}

class Scanner {
	private index = 0;
	private readonly numeric = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
	private readonly source;

	constructor(source: string) { this.source = source; }

	private skip() {
		while (/[\t\n\r ,]/.test(this.source[this.index] ?? '') && this.index < this.source.length) { ++this.index; }
	}

	get done() { this.skip(); return this.index === this.source.length; }

	command() {
		this.skip();
		const value = this.source[this.index];
		if (value !== undefined && /[a-z]/i.test(value)) { ++this.index; return value; }
		return null;
	}

	number(flag = false) {
		this.skip();
		if (flag) {
			const value = this.source[this.index++];
			if (value !== '0' && value !== '1') { throw new SvgPathError('SVG 弧线标志只能是 0 或 1'); }
			return Number(value);
		}
		this.numeric.lastIndex = this.index;
		const match = this.numeric.exec(this.source);
		if (!match) { throw new SvgPathError('SVG 路径参数缺失或含有非法字符'); }
		this.index = this.numeric.lastIndex;
		return finite(Number(match[0]));
	}
}

/** SVG endpoint-to-center conversion, with arcs split into at most four cubic Béziers.
 * Reference: SVG 2 implementation notes, B.2.4 / B.2.5. */
function arc(start: SvgPoint, end: SvgPoint, radiusX: number, radiusY: number,
	rotation: number, large: number, sweep: number): PathCommand[] {
	if (start.x === end.x && start.y === end.y) { return []; }
	if (radiusX === 0 || radiusY === 0) { return [ { kind: 'L', points: [ end ] } ]; }
	let rx = Math.abs(radiusX);
	let ry = Math.abs(radiusY);
	const angle = rotation % 360 * Math.PI / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const dx = (start.x - end.x) / 2;
	const dy = (start.y - end.y) / 2;
	const xx = cos * dx + sin * dy;
	const yy = -sin * dx + cos * dy;
	const ratio = (xx / rx) ** 2 + (yy / ry) ** 2;
	if (ratio > 1) { const scale = Math.sqrt(ratio); rx *= scale; ry *= scale; }
	const denominator = rx ** 2 * yy ** 2 + ry ** 2 * xx ** 2;
	const numerator = rx ** 2 * ry ** 2 - denominator;
	const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
	const cx = factor * rx * yy / ry;
	const cy = -factor * ry * xx / rx;
	const center = {
		x: cos * cx - sin * cy + (start.x + end.x) / 2,
		y: sin * cx + cos * cy + (start.y + end.y) / 2,
	};
	const ux = (xx - cx) / rx;
	const uy = (yy - cy) / ry;
	const vx = (-xx - cx) / rx;
	const vy = (-yy - cy) / ry;
	let theta = Math.atan2(uy, ux);
	let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
	if (!sweep && delta > 0) { delta -= Math.PI * 2; }
	if (sweep && delta < 0) { delta += Math.PI * 2; }
	if (![ rx, ry, center.x, center.y, theta, delta ].every(Number.isFinite)) {
		throw new SvgPathError('SVG 弧线退化或坐标过大');
	}
	const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
	const step = delta / pieces;
	const project = (xx: number, yy: number): SvgPoint => ({
		x: center.x + cos * rx * xx - sin * ry * yy,
		y: center.y + sin * rx * xx + cos * ry * yy,
	});
	const result: PathCommand[] = [];
	for (let index = 0; index < pieces; ++index) {
		const next = theta + step;
		const alpha = 4 / 3 * Math.tan(step / 4);
		result.push({
			kind: 'C',
			points: [
				project(Math.cos(theta) - alpha * Math.sin(theta), Math.sin(theta) + alpha * Math.cos(theta)),
				project(Math.cos(next) + alpha * Math.sin(next), Math.sin(next) - alpha * Math.cos(next)),
				index === pieces - 1 ? end : project(Math.cos(next), Math.sin(next)),
			],
		});
		theta = next;
	}
	return result;
}

export function parsePath(source: string): PathCommand[] {
	if (source.length === 0 || source.length > 131072) { throw new SvgPathError('SVG 路径为空或过长'); }
	const scanner = new Scanner(source);
	const output: PathCommand[] = [];
	let command = '';
	let point: SvgPoint = { x: 0, y: 0 };
	let start = point;
	let cubic: SvgPoint | null = null;
	let quadratic: SvgPoint | null = null;
	let moved = false;
	const append = (kind: PathCommand['kind'], points: SvgPoint[]) => {
		if (output.length >= maxCommands) { throw new SvgPathError('SVG 路径过于复杂，请简化后再导入'); }
		for (const point of points) { finite(point.x); finite(point.y); }
		output.push({ kind, points });
	};
	while (!scanner.done) {
		command = scanner.command() ?? command;
		const upper = command.toUpperCase();
		const relative = command !== upper;
		if (!'MLHVCSQTAZ'.includes(upper) || command === '' || (!moved && upper !== 'M')) {
			throw new SvgPathError('SVG 路径必须以 M 开始，且仅含标准路径指令');
		}
		if (upper === 'Z') {
			append('Z', []); point = start; cubic = null; quadratic = null; command = '';
			continue;
		}
		// Explicit drawing commands may follow Z. Start a new contour at the closed start point
		// so canonical winding reversal never drops those valid SVG segments.
		if (upper !== 'M' && output.at(-1)?.kind === 'Z') { append('M', [ point ]); start = point; }
		const lengths: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
		const values = Array.from({ length: lengths[upper]! }, (_value, index) =>
			scanner.number(upper === 'A' && (index === 3 || index === 4)));
		const pair = (index: number): SvgPoint => ({
			x: values[index]! + (relative ? point.x : 0),
			y: values[index + 1]! + (relative ? point.y : 0),
		});
		let end: SvgPoint;
		let nextCubic: SvgPoint | null = null;
		let nextQuadratic: SvgPoint | null = null;
		if (upper === 'M' || upper === 'L' || upper === 'T') {
			end = pair(0);
			if (upper === 'T') {
				nextQuadratic = quadratic ? { x: 2 * point.x - quadratic.x, y: 2 * point.y - quadratic.y } : point;
				append('Q', [ nextQuadratic, end ]);
			} else {
				append(upper, [ end ]);
				if (upper === 'M') { start = end; moved = true; command = relative ? 'l' : 'L'; }
			}
		} else if (upper === 'H' || upper === 'V') {
			end = upper === 'H'
				? { x: values[0]! + (relative ? point.x : 0), y: point.y }
				: { x: point.x, y: values[0]! + (relative ? point.y : 0) };
			append('L', [ end ]);
		} else if (upper === 'C' || upper === 'S') {
			const first = upper === 'C' ? pair(0) : cubic ? { x: 2 * point.x - cubic.x, y: 2 * point.y - cubic.y } : point;
			nextCubic = pair(upper === 'C' ? 2 : 0);
			end = pair(upper === 'C' ? 4 : 2);
			append('C', [ first, nextCubic, end ]);
		} else if (upper === 'Q') {
			nextQuadratic = pair(0); end = pair(2);
			append('Q', [ nextQuadratic, end ]);
		} else {
			end = pair(5);
			for (const segment of arc(point, end, values[0]!, values[1]!, values[2]!, values[3]!, values[4]!)) {
				append(segment.kind, segment.points);
			}
		}
		point = end; cubic = nextCubic; quadratic = nextQuadratic;
	}
	if (!output.some(command => command.kind !== 'M' && command.kind !== 'Z')) {
		throw new SvgPathError('SVG 路径没有可绘制的线段');
	}
	return output;
}

export function pathText(path: PathCommand[]) {
	const round = (value: number) => Math.round(finite(value) * 1000) / 1000;
	return path.map(command => command.kind +
		(command.points.length ? ' ' + command.points.map(point => `${round(point.x)} ${round(point.y)}`).join(' ') : '')).join(' ');
}

export function multiply(aa: Matrix, bb: Matrix): Matrix {
	return [
		aa[0] * bb[0] + aa[2] * bb[1], aa[1] * bb[0] + aa[3] * bb[1],
		aa[0] * bb[2] + aa[2] * bb[3], aa[1] * bb[2] + aa[3] * bb[3],
		aa[0] * bb[4] + aa[2] * bb[5] + aa[4], aa[1] * bb[4] + aa[3] * bb[5] + aa[5],
	];
}

export function mapPath(path: PathCommand[], matrix: Matrix): PathCommand[] {
	return path.map(command => ({
		kind: command.kind,
		points: command.points.map(point => ({
			x: finite(matrix[0] * point.x + matrix[2] * point.y + matrix[4]),
			y: finite(matrix[1] * point.x + matrix[3] * point.y + matrix[5]),
		})),
	}));
}

export function parseTransform(source: string): Matrix {
	let matrix = identity;
	let position = 0;
	let transforms = 0;
	const pattern = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)\s*,?/y;
	while (position < source.length && source.slice(position).trim() !== '') {
		if (++transforms > 128) { throw new SvgPathError('SVG transform 过于复杂'); }
		pattern.lastIndex = position;
		const match = pattern.exec(source);
		if (!match) { throw new SvgPathError('不支持的 SVG transform，请先转换为路径'); }
		position = pattern.lastIndex;
		const scanner = new Scanner(match[2]!);
		const values: number[] = [];
		while (!scanner.done) {
			if (values.length === 6) { throw new SvgPathError('SVG transform 参数过多'); }
			values.push(scanner.number());
		}
		const first = values[0]!;
		const angle = first % 360 * Math.PI / 180;
		let next: Matrix;
		switch (match[1]) {
			case 'matrix':
				if (values.length !== 6) { throw new SvgPathError('matrix 需要六个参数'); }
				next = values as Matrix;
				break;
			case 'translate':
				if (values.length < 1 || values.length > 2) { throw new SvgPathError('translate 参数不合法'); }
				next = [ 1, 0, 0, 1, first, values[1] ?? 0 ];
				break;
			case 'scale':
				if (values.length < 1 || values.length > 2) { throw new SvgPathError('scale 参数不合法'); }
				next = [ first, 0, 0, values[1] ?? first, 0, 0 ];
				break;
			case 'rotate': {
				if (values.length !== 1 && values.length !== 3) { throw new SvgPathError('rotate 参数不合法'); }
				const xx = values[1] ?? 0;
				const yy = values[2] ?? 0;
				next = multiply(multiply([ 1, 0, 0, 1, xx, yy ],
					[ Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0 ]), [ 1, 0, 0, 1, -xx, -yy ]);
				break;
			}
			default:
				if (values.length !== 1) { throw new SvgPathError('skew 参数不合法'); }
				next = match[1] === 'skewX' ? [ 1, 0, Math.tan(angle), 1, 0, 0 ] : [ 1, Math.tan(angle), 0, 1, 0, 0 ];
		}
		matrix = multiply(matrix, next);
		if (!matrix.every(Number.isFinite)) { throw new SvgPathError('SVG transform 超出范围'); }
	}
	return matrix;
}

/** Reverse every subpath together so a path's holes retain their relative winding. */
function reversePath(path: PathCommand[]): PathCommand[] {
	const output: PathCommand[] = [];
	let segments: { command: PathCommand; start: SvgPoint }[] = [];
	let start: SvgPoint | null = null;
	let point: SvgPoint = { x: 0, y: 0 };
	const flush = (closed = false) => {
		if (start === null) { return; }
		output.push({ kind: 'M', points: [ point ] });
		for (const { command, start } of segments.reverse()) {
			const controls = command.points.slice(0, -1).reverse();
			output.push({ kind: command.kind, points: [ ...controls, start ] });
		}
		if (closed) { output.push({ kind: 'Z', points: [] }); }
		start = null; segments = [];
	};
	for (const command of path) {
		if (command.kind === 'M') { flush(); start = command.points[0]!; point = start; }
		else if (command.kind === 'Z') { flush(true); }
		else {
			segments.push({ command, start: point });
			point = command.points.at(-1)!;
		}
	}
	flush();
	return output;
}

/** Largest contour determines the outer winding; reversing the whole path preserves its holes.
 * This also keeps reflected imports from cancelling ordinary shapes in a merged native layer. */
export function positiveWinding(path: PathCommand[]): PathCommand[] {
	let area = 0;
	let largest = 0;
	let start: SvgPoint = { x: 0, y: 0 };
	let point = start;
	const line = (end: SvgPoint) => { area += point.x * end.y - end.x * point.y; point = end; };
	const finish = () => {
		line(start);
		if (Math.abs(area) > Math.abs(largest)) { largest = area; }
		area = 0;
	};
	for (const command of path) {
		if (command.kind === 'M') { finish(); start = command.points[0]!; point = start; }
		else if (command.kind === 'Z') { finish(); point = start; }
		else if (command.kind === 'L') { line(command.points[0]!); }
		else {
			const origin = point;
			for (let step = 1; step <= 12; ++step) {
				const tt = step / 12;
				const inverse = 1 - tt;
				const weights = command.kind === 'C'
					? [ inverse ** 3, 3 * inverse ** 2 * tt, 3 * inverse * tt ** 2, tt ** 3 ]
					: [ inverse ** 2, 2 * inverse * tt, tt ** 2 ];
				const points = [ origin, ...command.points ];
				line({
					x: points.reduce((value, point, index) => value + point.x * weights[index]!, 0),
					y: points.reduce((value, point, index) => value + point.y * weights[index]!, 0),
				});
			}
		}
	}
	finish();
	return largest < 0 ? reversePath(path) : path;
}
