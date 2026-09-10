import type { ApertureShape, GerberParseResult, Point } from './model.js';

interface CoordinateFormat {
	zero: 'L' | 'T';
	abs: boolean;
	xInteger: number;
	xDecimal: number;
	yInteger: number;
	yDecimal: number;
}

interface ParserState {
	unitScale: number;
	format: CoordinateFormat;
	x: number;
	y: number;
	aperture?: number;
	operation?: 1 | 2 | 3;
	interpolation: 'linear' | 'cw' | 'ccw';
	region: boolean;
	regionPoints: Point[];
	dark: boolean;
}

const DEFAULT_FORMAT: CoordinateFormat = {
	zero: 'L',
	abs: true,
	xInteger: 2,
	xDecimal: 4,
	yInteger: 2,
	yDecimal: 4,
};

interface OutlineMacro {
	points: Point[];
	rotationExpression: string;
}

function parseOutlineMacros(source: string): Map<string, OutlineMacro> {
	const result = new Map<string, OutlineMacro>();
	for (const match of source.matchAll(/%AM([A-Za-z_]\w*)\*([\s\S]*?)\*%/g)) {
		const outline = match[2].split('*').map(command => command.trim()).find(command => command.startsWith('4,1,'));
		if (!outline)
			continue;
		const fields = outline.split(',').map(field => field.trim());
		const coordinateFields = fields.slice(3, -1);
		if (coordinateFields.length < 6 || coordinateFields.length % 2 !== 0)
			continue;
		const coordinates = coordinateFields.map(Number);
		if (coordinates.some(value => !Number.isFinite(value)))
			continue;
		const points: Point[] = [];
		for (let index = 0; index < coordinates.length; index += 2)
			points.push({ x: coordinates[index], y: coordinates[index + 1] });
		result.set(match[1].toUpperCase(), { points, rotationExpression: fields.at(-1) ?? '0' });
	}
	return result;
}

function macroRotation(expression: string, parameters: number[]): number | undefined {
	const constant = Number(expression);
	if (Number.isFinite(constant))
		return constant;
	const parameter = /^\$(\d+)(?:([+-])([\d.]+))?$/.exec(expression);
	if (!parameter)
		return undefined;
	const value = parameters[Number(parameter[1]) - 1];
	if (!Number.isFinite(value))
		return undefined;
	const offset = Number(parameter[3] ?? 0) * (parameter[2] === '-' ? -1 : 1);
	return value + offset;
}

function tokenize(source: string): string[] {
	const tokens: string[] = [];
	let buffer = '';
	for (const character of source.replaceAll('\r', '').replaceAll('\n', '')) {
		if (character === '%') {
			if (buffer.trim())
				tokens.push(buffer.trim());
			buffer = '';
			continue;
		}
		if (character === '*') {
			if (buffer.trim())
				tokens.push(buffer.trim());
			buffer = '';
			continue;
		}
		buffer += character;
	}
	if (buffer.trim())
		tokens.push(buffer.trim());
	return tokens;
}

function coordinate(raw: string, integer: number, decimal: number, zero: 'L' | 'T'): number {
	if (raw.includes('.'))
		return Number(raw);
	const negative = raw.startsWith('-');
	const unsigned = raw.replace(/^[+-]/, '');
	const length = integer + decimal;
	const padded = zero === 'L' ? unsigned.padStart(length, '0') : unsigned.padEnd(length, '0');
	const result = Number(padded) / 10 ** decimal;
	return negative ? -result : result;
}

function parseAperture(command: string, unitScale: number, outlineMacros: Map<string, OutlineMacro>): [number, ApertureShape] | undefined {
	const match = /^ADD(\d+)([A-Z]\w*),(.+)$/i.exec(command);
	if (!match)
		return undefined;
	const code = Number(match[1]);
	const shape = match[2].toUpperCase();
	const rawValues = match[3].split(/[X,]/i).map(Number);
	if (rawValues.some(value => !Number.isFinite(value)))
		return undefined;
	const values = rawValues.map(value => value * unitScale);
	if (shape === 'C')
		return [code, { kind: 'circle', diameter: values[0] }];
	if (shape === 'R')
		return [code, { kind: 'rectangle', width: values[0], height: values[1] ?? values[0] }];
	if (shape === 'O')
		return [code, { kind: 'obround', width: values[0], height: values[1] ?? values[0] }];
	if (shape === 'P') {
		return [code, {
			kind: 'polygon',
			diameter: values[0],
			vertices: Math.max(3, Math.round(rawValues[1] || 6)),
			rotation: rawValues[2] || 0,
		}];
	}
	if (shape === 'ROTRECT' && rawValues.length >= 3) {
		return [code, {
			kind: 'roundedRectangle',
			width: values[0],
			height: values[1],
			radius: 0,
			rotation: rawValues[2],
		}];
	}
	const outlineMacro = outlineMacros.get(shape);
	if (outlineMacro) {
		const rotation = macroRotation(outlineMacro.rotationExpression, rawValues);
		if (rotation !== undefined) {
			return [code, {
				kind: 'customPolygon',
				points: outlineMacro.points.map(point => ({ x: point.x * unitScale, y: point.y * unitScale })),
				rotation,
			}];
		}
	}
	if (shape === 'ROUNDRECT' && rawValues.length >= 5) {
		const compactJlcEda = rawValues.length < 9;
		const radius = compactJlcEda ? values[0] / 2 : values[0];
		const corners = rawValues.length >= 9
			? [
					{ x: values[1], y: values[2] },
					{ x: values[3], y: values[4] },
					{ x: values[5], y: values[6] },
					{ x: values[7], y: values[8] },
				]
			: [
					{ x: values[1], y: values[2] },
					{ x: values[3], y: values[4] },
					{ x: -values[1], y: -values[2] },
					{ x: -values[3], y: -values[4] },
				];
		return [code, {
			kind: 'roundedRectangle',
			width: Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) + radius * 2,
			height: Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y) + radius * 2,
			radius,
			rotation: Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * 180 / Math.PI,
		}];
	}
	return undefined;
}

function apertureWidth(shape: ApertureShape): number {
	if (shape.kind === 'circle' || shape.kind === 'polygon')
		return shape.diameter;
	if (shape.kind === 'customPolygon') {
		const xs = shape.points.map(point => point.x);
		const ys = shape.points.map(point => point.y);
		return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
	}
	return Math.min(shape.width, shape.height);
}

function arcAngle(start: Point, end: Point, center: Point, clockwise: boolean): number {
	const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
	const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
	let sweep = endAngle - startAngle;
	if (clockwise) {
		while (sweep >= 0) sweep -= Math.PI * 2;
	}
	else {
		while (sweep <= 0) sweep += Math.PI * 2;
	}
	return sweep * 180 / Math.PI;
}

function arcPoints(start: Point, end: Point, center: Point, clockwise: boolean): Point[] {
	const sweep = arcAngle(start, end, center, clockwise) * Math.PI / 180;
	const radius = Math.hypot(start.x - center.x, start.y - center.y);
	const segmentCount = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
	const initial = Math.atan2(start.y - center.y, start.x - center.x);
	const points: Point[] = [];
	for (let index = 1; index <= segmentCount; index += 1) {
		const angle = initial + sweep * index / segmentCount;
		points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
	}
	points[points.length - 1] = end;
	return points;
}

export function parseGerber(source: string): GerberParseResult {
	const primitives: GerberParseResult['primitives'] = [];
	const warnings: string[] = [];
	const apertures = new Map<number, ApertureShape>();
	const outlineMacros = parseOutlineMacros(source);
	const state: ParserState = {
		unitScale: 1,
		format: { ...DEFAULT_FORMAT },
		x: 0,
		y: 0,
		interpolation: 'linear',
		region: false,
		regionPoints: [],
		dark: true,
	};
	let fileFunction: string | undefined;

	for (const rawCommand of tokenize(source)) {
		const command = rawCommand.trim();
		if (!command || /^G0?4/i.test(command))
			continue;

		const fs = /^FS([LT])([AI])X(\d)(\d)Y(\d)(\d)/i.exec(command);
		if (fs) {
			state.format = {
				zero: fs[1].toUpperCase() as 'L' | 'T',
				abs: fs[2].toUpperCase() === 'A',
				xInteger: Number(fs[3]),
				xDecimal: Number(fs[4]),
				yInteger: Number(fs[5]),
				yDecimal: Number(fs[6]),
			};
			continue;
		}
		if (/^MOIN$/i.test(command)) {
			state.unitScale = 25.4;
			continue;
		}
		if (/^MOMM$/i.test(command)) {
			state.unitScale = 1;
			continue;
		}
		const aperture = parseAperture(command, state.unitScale, outlineMacros);
		if (aperture) {
			apertures.set(...aperture);
			continue;
		}
		if (/^AM/i.test(command)) {
			if (!/^AM(?:ROUNDRECT|ROTRECT)$/i.test(command) && !outlineMacros.has(command.slice(2).toUpperCase()))
				warnings.push(`检测到暂不支持的自定义孔径宏 ${command.slice(2) || '(未命名)'}。`);
			continue;
		}
		const fileAttribute = /^TF\.FileFunction,(.+)$/i.exec(command);
		if (fileAttribute) {
			fileFunction = fileAttribute[1];
			continue;
		}
		// X2 attributes may contain reference designators such as Y1 or X1.
		// They are metadata, never coordinate commands.
		if (/^T[AFO]\.|^TD$/i.test(command))
			continue;
		if (/^LPD$/i.test(command)) {
			state.dark = true;
			continue;
		}
		if (/^LPC$/i.test(command)) {
			state.dark = false;
			warnings.push('检测到负片/清除极性（LPC）；清除图形不会写入，结果需人工核对。');
			continue;
		}
		if (/^SR/i.test(command) && !/^SR$/i.test(command)) {
			warnings.push('检测到步进重复（SR）；首版未展开重复阵列。');
			continue;
		}

		if (/G0?1(?=\D|$)/i.test(command))
			state.interpolation = 'linear';
		if (/G0?2(?=\D|$)/i.test(command))
			state.interpolation = 'cw';
		if (/G0?3(?=\D|$)/i.test(command))
			state.interpolation = 'ccw';
		if (/G90/i.test(command))
			state.format.abs = true;
		if (/G91/i.test(command))
			state.format.abs = false;
		if (/G36/i.test(command)) {
			state.region = true;
			state.regionPoints = [];
			continue;
		}
		if (/G37/i.test(command)) {
			if (state.dark && state.regionPoints.length >= 3)
				primitives.push({ kind: 'region', points: state.regionPoints });
			state.region = false;
			state.regionPoints = [];
			continue;
		}

		const standaloneD = /^(?:G54)?D(\d+)$/i.exec(command);
		if (standaloneD) {
			const d = Number(standaloneD[1]);
			if (d >= 10)
				state.aperture = d;
			else if (d >= 1 && d <= 3)
				state.operation = d as 1 | 2 | 3;
			continue;
		}

		const operationMatch = /D0?([123])(?:$|\D)/i.exec(`${command} `);
		if (operationMatch)
			state.operation = Number(operationMatch[1]) as 1 | 2 | 3;
		const apertureMatch = /D(\d{2,})/i.exec(command);
		if (apertureMatch && !/[XY]/i.test(command)) {
			state.aperture = Number(apertureMatch[1]);
			continue;
		}

		const xMatch = /X([+-]?\d*\.?\d+)/i.exec(command);
		const yMatch = /Y([+-]?\d*\.?\d+)/i.exec(command);
		const iMatch = /I([+-]?\d*\.?\d+)/i.exec(command);
		const jMatch = /J([+-]?\d*\.?\d+)/i.exec(command);
		// D01/D02/D03 are modal, but a modal D03 must only flash when the
		// current command actually supplies a coordinate. Attribute commands
		// such as %TO/%TD between aperture blocks otherwise duplicate the last
		// flash, sometimes after the aperture has changed.
		if (!xMatch && !yMatch)
			continue;

		const previous = { x: state.x, y: state.y };
		const parsedX = xMatch ? coordinate(xMatch[1], state.format.xInteger, state.format.xDecimal, state.format.zero) * state.unitScale : undefined;
		const parsedY = yMatch ? coordinate(yMatch[1], state.format.yInteger, state.format.yDecimal, state.format.zero) * state.unitScale : undefined;
		state.x = parsedX === undefined ? state.x : (state.format.abs ? parsedX : state.x + parsedX);
		state.y = parsedY === undefined ? state.y : (state.format.abs ? parsedY : state.y + parsedY);
		const next = { x: state.x, y: state.y };

		if (state.operation === 2) {
			if (state.region) {
				if (state.regionPoints.length >= 3)
					warnings.push('检测到包含多个轮廓的 Gerber 区域；当前仅保留最后一个轮廓。');
				state.regionPoints = [next];
			}
			continue;
		}
		if (!state.dark)
			continue;
		if (state.region && state.operation === 1) {
			if (state.interpolation === 'linear') {
				state.regionPoints.push(next);
			}
			else {
				const offset = {
					x: iMatch ? coordinate(iMatch[1], state.format.xInteger, state.format.xDecimal, state.format.zero) * state.unitScale : 0,
					y: jMatch ? coordinate(jMatch[1], state.format.yInteger, state.format.yDecimal, state.format.zero) * state.unitScale : 0,
				};
				const center = { x: previous.x + offset.x, y: previous.y + offset.y };
				state.regionPoints.push(...arcPoints(previous, next, center, state.interpolation === 'cw'));
			}
			continue;
		}
		const selected = state.aperture === undefined ? undefined : apertures.get(state.aperture);
		if (!selected) {
			warnings.push(`图形引用了未定义孔径 D${state.aperture ?? '?'}，已跳过。`);
			continue;
		}
		if (state.operation === 3) {
			primitives.push({ kind: 'flash', position: next, shape: selected });
			continue;
		}
		if (state.operation !== 1)
			continue;

		if (state.interpolation === 'linear') {
			primitives.push({ kind: 'stroke', start: previous, end: next, width: apertureWidth(selected) });
			continue;
		}
		const offset = {
			x: iMatch ? coordinate(iMatch[1], state.format.xInteger, state.format.xDecimal, state.format.zero) * state.unitScale : 0,
			y: jMatch ? coordinate(jMatch[1], state.format.yInteger, state.format.yDecimal, state.format.zero) * state.unitScale : 0,
		};
		const center = { x: previous.x + offset.x, y: previous.y + offset.y };
		const clockwise = state.interpolation === 'cw';
		primitives.push({
			kind: 'stroke',
			start: previous,
			end: next,
			width: apertureWidth(selected),
			arcAngle: arcAngle(previous, next, center, clockwise),
			arcCenter: center,
		});
	}

	return { fileFunction, primitives, warnings: [...new Set(warnings)] };
}
