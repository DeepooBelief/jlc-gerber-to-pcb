import type { Point, Stroke } from './model.js';

function samePoint(left: Point, right: Point): boolean {
	return left.x === right.x && left.y === right.y;
}

function pointDistance(left: Point, right: Point): number {
	return Math.hypot(left.x - right.x, left.y - right.y);
}

export function strokePoints(stroke: Stroke, maximumArcStepDegrees = 10): Point[] {
	if (stroke.arcAngle === undefined || !stroke.arcCenter)
		return [stroke.start, stroke.end];
	const segments = Math.max(2, Math.ceil(Math.abs(stroke.arcAngle) / maximumArcStepDegrees));
	const startAngle = Math.atan2(stroke.start.y - stroke.arcCenter.y, stroke.start.x - stroke.arcCenter.x);
	const radius = pointDistance(stroke.start, stroke.arcCenter);
	const sweep = stroke.arcAngle * Math.PI / 180;
	const points = Array.from({ length: segments + 1 }, (_, index) => {
		const angle = startAngle + sweep * index / segments;
		return {
			x: stroke.arcCenter!.x + radius * Math.cos(angle),
			y: stroke.arcCenter!.y + radius * Math.sin(angle),
		};
	});
	points[0] = stroke.start;
	points[points.length - 1] = stroke.end;
	return points;
}

export function closedStrokeContours(strokes: Stroke[], toleranceMm = 0.005): Point[][] {
	const contours: Point[][] = [];
	let chain: Point[] = [];
	const finish = () => {
		if (chain.length >= 4 && pointDistance(chain[0], chain.at(-1)!) <= toleranceMm) {
			chain[chain.length - 1] = { ...chain[0] };
			contours.push(explicitlyClosePolygon(chain));
		}
		chain = [];
	};
	for (const stroke of strokes) {
		const segment = strokePoints(stroke);
		if (!chain.length) {
			chain = segment;
			continue;
		}
		if (pointDistance(chain.at(-1)!, segment[0]) > toleranceMm)
			finish();
		chain.push(...(chain.length ? segment.slice(1) : segment));
	}
	finish();
	return contours;
}

export function explicitlyClosePolygon(points: Point[]): Point[] {
	const result: Point[] = [];
	for (const point of points) {
		if (!result.length || !samePoint(result.at(-1)!, point))
			result.push(point);
	}
	if (result.length > 1 && samePoint(result[0], result.at(-1)!))
		result.pop();
	if (result.length >= 3)
		result.push({ ...result[0] });
	return result;
}

export function roundedRectanglePercentage(width: number, height: number, radius: number): number {
	return Math.max(0, Math.min(100, 200 * radius / Math.min(width, height)));
}

function normalizeClosedPolygon(points: Point[]): Point[] {
	const result = explicitlyClosePolygon(points);
	if (result.length > 1)
		result.pop();
	return result;
}

function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
	const deltaX = end.x - start.x;
	const deltaY = end.y - start.y;
	if (deltaX === 0 && deltaY === 0)
		return Math.hypot(point.x - start.x, point.y - start.y);
	const projection = Math.max(0, Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / (deltaX ** 2 + deltaY ** 2)));
	return Math.hypot(point.x - (start.x + projection * deltaX), point.y - (start.y + projection * deltaY));
}

function simplifyOpen(points: Point[], tolerance: number): Point[] {
	if (points.length <= 2)
		return points;
	let furthestIndex = 0;
	let furthestDistance = 0;
	for (let index = 1; index < points.length - 1; index += 1) {
		const distance = pointToSegmentDistance(points[index], points[0], points.at(-1)!);
		if (distance > furthestDistance) {
			furthestDistance = distance;
			furthestIndex = index;
		}
	}
	if (furthestDistance <= tolerance)
		return [points[0], points.at(-1)!];
	const left = simplifyOpen(points.slice(0, furthestIndex + 1), tolerance);
	const right = simplifyOpen(points.slice(furthestIndex), tolerance);
	return [...left.slice(0, -1), ...right];
}

function simplifyAtTolerance(points: Point[], tolerance: number): Point[] {
	if (points.length <= 3)
		return points;
	let splitIndex = 1;
	let furthestDistance = 0;
	for (let index = 1; index < points.length; index += 1) {
		const distance = Math.hypot(points[index].x - points[0].x, points[index].y - points[0].y);
		if (distance > furthestDistance) {
			furthestDistance = distance;
			splitIndex = index;
		}
	}
	const firstHalf = simplifyOpen(points.slice(0, splitIndex + 1), tolerance);
	const secondHalf = simplifyOpen([...points.slice(splitIndex), points[0]], tolerance);
	return [...firstHalf.slice(0, -1), ...secondHalf.slice(0, -1)];
}

export interface SimplifiedPolygon {
	points: Point[];
	originalVertices: number;
	toleranceMm: number;
}

export interface HatchSegment {
	start: Point;
	end: Point;
	width: number;
}

export function hatchPolygon(points: Point[], lineWidth = 0.04, pitch = 0.032): HatchSegment[] {
	const halfWidth = lineWidth / 2;
	const minimumY = Math.min(...points.map(point => point.y));
	const maximumY = Math.max(...points.map(point => point.y));
	const segments: HatchSegment[] = [];
	for (let y = minimumY + halfWidth; y <= maximumY - halfWidth + 1e-9; y += pitch) {
		const intersections: number[] = [];
		for (let index = 0; index < points.length; index += 1) {
			const start = points[index];
			const end = points[(index + 1) % points.length];
			if (!((start.y <= y && end.y > y) || (end.y <= y && start.y > y)))
				continue;
			intersections.push(start.x + (y - start.y) * (end.x - start.x) / (end.y - start.y));
		}
		intersections.sort((a, b) => a - b);
		for (let index = 0; index + 1 < intersections.length; index += 2) {
			const left = intersections[index] + halfWidth;
			const right = intersections[index + 1] - halfWidth;
			if (right - left < 0.002)
				continue;
			segments.push({ start: { x: left, y }, end: { x: right, y }, width: lineWidth });
		}
	}
	return segments;
}

export function simplifyClosedPolygon(points: Point[], maximumVertices = 900, maximumToleranceMm = 0.005): SimplifiedPolygon {
	const normalized = normalizeClosedPolygon(points);
	if (normalized.length < 3)
		throw new Error('区域轮廓少于 3 个有效顶点。');
	let simplified = simplifyAtTolerance(normalized, 0);
	if (simplified.length <= maximumVertices)
		return { points: simplified, originalVertices: normalized.length, toleranceMm: 0 };
	let tolerance = 0.000001;
	while (tolerance <= maximumToleranceMm) {
		simplified = simplifyAtTolerance(normalized, tolerance);
		if (simplified.length <= maximumVertices)
			return { points: simplified, originalVertices: normalized.length, toleranceMm: tolerance };
		tolerance *= 2;
	}
	throw new Error(`区域轮廓有 ${normalized.length} 个顶点，在最大 ${maximumToleranceMm * 1000} µm 容差下仍无法安全降至 ${maximumVertices} 个以内。`);
}
