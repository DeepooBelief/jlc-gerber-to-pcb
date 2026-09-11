import type { Point, Stroke } from './model.js';
import earcut, { deviation as earcutDeviation } from 'earcut';

function samePoint(left: Point, right: Point): boolean {
	return left.x === right.x && left.y === right.y;
}

function pointDistance(left: Point, right: Point): number {
	return Math.hypot(left.x - right.x, left.y - right.y);
}

export function rectanglePoints(center: Point, width: number, height: number, rotation = 0): Point[] {
	const rotationRadians = rotation * Math.PI / 180;
	return [
		{ x: -width / 2, y: height / 2 },
		{ x: width / 2, y: height / 2 },
		{ x: width / 2, y: -height / 2 },
		{ x: -width / 2, y: -height / 2 },
	].map(point => ({
		x: center.x + point.x * Math.cos(rotationRadians) - point.y * Math.sin(rotationRadians),
		y: center.y + point.x * Math.sin(rotationRadians) + point.y * Math.cos(rotationRadians),
	}));
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

function polygonArea(points: Point[]): number {
	let area = 0;
	for (let index = 0; index < points.length; index += 1) {
		const next = points[(index + 1) % points.length];
		area += points[index].x * next.y - next.x * points[index].y;
	}
	return area / 2;
}

function edgeKey(left: number, right: number): string {
	return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function boundaryOfTriangleGroup(points: Point[], triangles: number[], triangleGroup: number[], winding: number): Point[] {
	const edges = new Map<string, { count: number; left: number; right: number }>();
	for (const triangleIndex of triangleGroup) {
		const offset = triangleIndex * 3;
		const indices = [triangles[offset], triangles[offset + 1], triangles[offset + 2]];
		for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
			const left = indices[edgeIndex];
			const right = indices[(edgeIndex + 1) % 3];
			const key = edgeKey(left, right);
			const existing = edges.get(key);
			if (existing)
				existing.count += 1;
			else
				edges.set(key, { count: 1, left, right });
		}
	}

	const boundaryEdges = [...edges.values()].filter(edge => edge.count === 1);
	const neighbours = new Map<number, number[]>();
	for (const edge of boundaryEdges) {
		neighbours.set(edge.left, [...(neighbours.get(edge.left) ?? []), edge.right]);
		neighbours.set(edge.right, [...(neighbours.get(edge.right) ?? []), edge.left]);
	}
	if (!boundaryEdges.length || [...neighbours.values()].some(vertices => vertices.length !== 2))
		throw new Error('三角剖分分组没有形成单一闭合边界。');

	const start = boundaryEdges[0].left;
	let previous = start;
	let current = boundaryEdges[0].right;
	const boundary = [start];
	while (current !== start && boundary.length <= boundaryEdges.length) {
		boundary.push(current);
		const candidates = neighbours.get(current)!;
		const next = candidates[0] === previous ? candidates[1] : candidates[0];
		previous = current;
		current = next;
	}
	if (current !== start || boundary.length !== boundaryEdges.length)
		throw new Error('三角剖分分组包含多个边界环。');

	const result = boundary.map(index => points[index]);
	if (Math.sign(polygonArea(result)) !== winding)
		result.reverse();
	return result;
}

/**
 * Splits a simple closed polygon into solid, exactly adjoining polygons that
 * fit the EDA polygon vertex budget. No geometric simplification is applied.
 */
export function partitionClosedPolygon(points: Point[], maximumVertices = 900): Point[][] {
	if (maximumVertices < 3)
		throw new Error('多边形顶点上限不能小于 3。');
	const normalized = simplifyAtTolerance(normalizeClosedPolygon(points), 0);
	if (normalized.length < 3)
		throw new Error('区域轮廓少于 3 个有效顶点。');
	if (normalized.length <= maximumVertices)
		return [normalized];

	const vertices = normalized.flatMap(point => [point.x, point.y]);
	const triangles = earcut(vertices, null, 2);
	const deviation = earcutDeviation(vertices, null, 2, triangles);
	if (triangles.length < 3 || triangles.length % 3 !== 0 || deviation > 1e-8)
		throw new Error(`区域三角剖分未通过面积校验（相对误差 ${deviation}）。`);

	const triangleCount = triangles.length / 3;
	const owners = new Map<string, number[]>();
	for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
		const offset = triangleIndex * 3;
		const indices = [triangles[offset], triangles[offset + 1], triangles[offset + 2]];
		for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
			const key = edgeKey(indices[edgeIndex], indices[(edgeIndex + 1) % 3]);
			owners.set(key, [...(owners.get(key) ?? []), triangleIndex]);
		}
	}
	if ([...owners.values()].some(edgeOwners => edgeOwners.length > 2))
		throw new Error('区域三角剖分产生了非流形边。');

	const adjacent = Array.from({ length: triangleCount }, () => new Set<number>());
	for (const edgeOwners of owners.values()) {
		if (edgeOwners.length !== 2)
			continue;
		adjacent[edgeOwners[0]].add(edgeOwners[1]);
		adjacent[edgeOwners[1]].add(edgeOwners[0]);
	}

	const maximumTriangles = maximumVertices - 2;
	const parent = new Int32Array(triangleCount).fill(-2);
	parent[0] = -1;
	const traversal = [0];
	for (let cursor = 0; cursor < traversal.length; cursor += 1) {
		const triangleIndex = traversal[cursor];
		for (const neighbour of adjacent[triangleIndex]) {
			if (parent[neighbour] !== -2)
				continue;
			parent[neighbour] = triangleIndex;
			traversal.push(neighbour);
		}
	}
	if (traversal.length !== triangleCount)
		throw new Error('区域三角剖分没有形成连通图。');

	// A simple polygon's triangle-dual graph is a tree. Process it from the
	// leaves upward so every emitted group is connected and nearly full,
	// avoiding the many tiny islands produced by arbitrary breadth-first cuts.
	const remainders: Array<number[] | undefined> = Array.from({ length: triangleCount });
	const triangleGroups: number[][] = [];
	for (let traversalIndex = traversal.length - 1; traversalIndex >= 0; traversalIndex -= 1) {
		const triangleIndex = traversal[traversalIndex];
		const remainder = [triangleIndex];
		for (const neighbour of adjacent[triangleIndex]) {
			if (parent[neighbour] !== triangleIndex)
				continue;
			const childRemainder = remainders[neighbour]!;
			if (remainder.length + childRemainder.length <= maximumTriangles)
				remainder.push(...childRemainder);
			else
				triangleGroups.push(childRemainder);
		}
		remainders[triangleIndex] = remainder;
	}
	triangleGroups.push(remainders[0]!);

	const winding = Math.sign(polygonArea(normalized));
	const result = triangleGroups.map(group => boundaryOfTriangleGroup(normalized, triangles, group, winding));
	if (result.some(part => part.length > maximumVertices))
		throw new Error('拆分后的区域仍超过 EDA 多边形顶点上限。');
	const originalArea = Math.abs(polygonArea(normalized));
	const partitionedArea = result.reduce((sum, part) => sum + Math.abs(polygonArea(part)), 0);
	const relativeAreaError = originalArea === 0 ? Number.POSITIVE_INFINITY : Math.abs(partitionedArea - originalArea) / originalArea;
	if (relativeAreaError > 1e-8)
		throw new Error(`拆分后的区域未通过面积校验（相对误差 ${relativeAreaError}）。`);
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
	let tolerance = Math.min(0.000001, maximumToleranceMm);
	while (tolerance > 0) {
		simplified = simplifyAtTolerance(normalized, tolerance);
		if (simplified.length <= maximumVertices)
			return { points: simplified, originalVertices: normalized.length, toleranceMm: tolerance };
		if (tolerance === maximumToleranceMm)
			break;
		tolerance = Math.min(tolerance * 2, maximumToleranceMm);
	}
	throw new Error(`区域轮廓有 ${normalized.length} 个顶点，在最大 ${maximumToleranceMm * 1000} µm 容差下仍无法安全降至 ${maximumVertices} 个以内。`);
}
