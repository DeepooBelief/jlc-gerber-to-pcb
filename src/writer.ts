import type { ApertureShape, ImportPlan, Point } from './model.js';
import { closedStrokeContours, explicitlyClosePolygon, hatchPolygon, roundedRectanglePercentage, simplifyClosedPolygon, strokePoints } from './geometry.js';
import { buildReconstructionIndex, copperShapeAtDrill, hasMaskAtDrill, isCopperFlashAtDrill, isPadDerivedFlash } from './reconstruction.js';

const MM_PER_MIL = 0.0254;

function mil(value: number): number {
	return value / MM_PER_MIL;
}

function isCopperLayer(layerId: number): boolean {
	return layerId === 1 || layerId === 2 || (layerId >= 15 && layerId <= 44);
}

function isHatchLayer(layerId: number): boolean {
	return isCopperLayer(layerId)
		|| [3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 56].includes(layerId)
		|| (layerId >= 71 && layerId <= 100);
}

function polygonSource(points: Point[]): TPCB_PolygonSourceArray {
	const closed = explicitlyClosePolygon(points);
	const source: TPCB_PolygonSourceArray = [];
	for (let index = 0; index < closed.length; index += 1) {
		if (index === 1)
			source.push('L');
		source.push(mil(closed[index].x), mil(closed[index].y));
	}
	return source;
}

function regularPolygon(center: Point, diameter: number, vertices: number, rotation = 0): Point[] {
	const points: Point[] = [];
	const radius = diameter / 2;
	for (let index = 0; index < vertices; index += 1) {
		const angle = (rotation + 360 * index / vertices) * Math.PI / 180;
		points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
	}
	return points;
}

function obroundPoints(center: Point, width: number, height: number): Point[] {
	const horizontal = width >= height;
	const radius = Math.min(width, height) / 2;
	const halfStraight = Math.abs(width - height) / 2;
	const points: Point[] = [];
	for (let index = 0; index < 24; index += 1) {
		const angle = 2 * Math.PI * index / 24;
		points.push({
			x: center.x + radius * Math.cos(angle) + (horizontal ? Math.sign(Math.cos(angle)) * halfStraight : 0),
			y: center.y + radius * Math.sin(angle) + (horizontal ? 0 : Math.sign(Math.sin(angle)) * halfStraight),
		});
	}
	return points;
}

function roundedRectanglePoints(center: Point, width: number, height: number, radius: number, rotation: number): Point[] {
	const clampedRadius = Math.min(radius, width / 2, height / 2);
	const cornerCenters = [
		{ x: width / 2 - clampedRadius, y: height / 2 - clampedRadius, start: 0 },
		{ x: -width / 2 + clampedRadius, y: height / 2 - clampedRadius, start: 90 },
		{ x: -width / 2 + clampedRadius, y: -height / 2 + clampedRadius, start: 180 },
		{ x: width / 2 - clampedRadius, y: -height / 2 + clampedRadius, start: 270 },
	];
	const rotationRadians = rotation * Math.PI / 180;
	const points: Point[] = [];
	for (const corner of cornerCenters) {
		for (let segment = 0; segment <= 5; segment += 1) {
			const angle = (corner.start + segment * 18) * Math.PI / 180;
			const localX = corner.x + clampedRadius * Math.cos(angle);
			const localY = corner.y + clampedRadius * Math.sin(angle);
			points.push({
				x: center.x + localX * Math.cos(rotationRadians) - localY * Math.sin(rotationRadians),
				y: center.y + localX * Math.sin(rotationRadians) + localY * Math.cos(rotationRadians),
			});
		}
	}
	return points;
}

function flashOutlinePoints(position: Point, shape: ApertureShape): Point[] {
	if (shape.kind === 'circle')
		return regularPolygon(position, shape.diameter, 64);
	if (shape.kind === 'rectangle') {
		return [
			{ x: position.x - shape.width / 2, y: position.y - shape.height / 2 },
			{ x: position.x + shape.width / 2, y: position.y - shape.height / 2 },
			{ x: position.x + shape.width / 2, y: position.y + shape.height / 2 },
			{ x: position.x - shape.width / 2, y: position.y + shape.height / 2 },
		];
	}
	if (shape.kind === 'roundedRectangle')
		return roundedRectanglePoints(position, shape.width, shape.height, shape.radius, shape.rotation);
	if (shape.kind === 'obround')
		return obroundPoints(position, shape.width, shape.height);
	return regularPolygon(position, shape.diameter, shape.vertices, shape.rotation);
}

function shapePolygon(position: Point, shape: ApertureShape): TPCB_PolygonSourceArray | undefined {
	if (shape.kind === 'circle')
		return ['CIRCLE', mil(position.x), mil(position.y), mil(shape.diameter / 2)];
	if (shape.kind === 'rectangle')
		return ['R', mil(position.x - shape.width / 2), mil(position.y - shape.height / 2), mil(shape.width), mil(shape.height), 0, 0];
	if (shape.kind === 'roundedRectangle')
		return polygonSource(flashOutlinePoints(position, shape));
	if (shape.kind === 'obround')
		return polygonSource(flashOutlinePoints(position, shape));
	return polygonSource(flashOutlinePoints(position, shape));
}

function padShape(shape: ApertureShape): TPCB_PrimitivePadShape {
	if (shape.kind === 'circle')
		return [EPCB_PrimitivePadShapeType.ELLIPSE, mil(shape.diameter), mil(shape.diameter)];
	if (shape.kind === 'rectangle')
		return [EPCB_PrimitivePadShapeType.RECTANGLE, mil(shape.width), mil(shape.height), 0];
	if (shape.kind === 'roundedRectangle')
		return [EPCB_PrimitivePadShapeType.RECTANGLE, mil(shape.width), mil(shape.height), roundedRectanglePercentage(shape.width, shape.height, shape.radius)];
	if (shape.kind === 'obround')
		return [EPCB_PrimitivePadShapeType.OBLONG, mil(shape.width), mil(shape.height)];
	return [EPCB_PrimitivePadShapeType.REGULAR_POLYGON, mil(shape.diameter), shape.vertices];
}

function shapeRotation(shape: ApertureShape): number {
	return shape.kind === 'polygon' || shape.kind === 'roundedRectangle' ? shape.rotation : 0;
}

function shapeOuterDiameter(shape: ApertureShape): number {
	if (shape.kind === 'circle' || shape.kind === 'polygon')
		return shape.diameter;
	return Math.max(shape.width, shape.height);
}

interface CreatedIds {
	lines: string[];
	arcs: string[];
	pads: string[];
	fills: string[];
	polylines: string[];
	vias: string[];
}

function primitiveId(primitive: IPCB_Primitive | undefined): string | undefined {
	return primitive?.getState_PrimitiveId();
}

async function deleteCreated(ids: string[], deleter: (ids: string | string[]) => Promise<boolean>): Promise<void> {
	if (!ids.length)
		return;
	try {
		if (await deleter(ids))
			return;
	}
	catch {}
	await Promise.allSettled(ids.map(id => deleter(id)));
}

async function rollback(created: CreatedIds): Promise<void> {
	await Promise.allSettled([
		deleteCreated(created.lines, ids => eda.pcb_PrimitiveLine.delete(ids)),
		deleteCreated(created.arcs, ids => eda.pcb_PrimitiveArc.delete(ids)),
		deleteCreated(created.pads, ids => eda.pcb_PrimitivePad.delete(ids)),
		deleteCreated(created.fills, ids => eda.pcb_PrimitiveFill.delete(ids)),
		deleteCreated(created.polylines, ids => eda.pcb_PrimitivePolyline.delete(ids)),
		deleteCreated(created.vias, ids => eda.pcb_PrimitiveVia.delete(ids)),
	]);
}

export interface WriteSummary {
	lines: number;
	arcs: number;
	pads: number;
	fills: number;
	regionFills: number;
	flashFills: number;
	convertedFills: number;
	hatchFallbackPrimitives: number;
	hatchFallbackLines: number;
	boardOutlineContours: number;
	linearizedArcs: number;
	skippedDerivedFlashes: number;
	skippedInnerCopperFlashes: number;
	throughHolePads: number;
	tentedVias: number;
	vias: number;
	simplifiedRegions: number;
	maximumSimplificationMicrometers: number;
}

async function createAbsoluteHatch(layerId: number, points: Point[], created: CreatedIds): Promise<number> {
	const segments = hatchPolygon(points);
	const batchSize = 100;
	for (let offset = 0; offset < segments.length; offset += batchSize) {
		const batch = segments.slice(offset, offset + batchSize);
		const results = await Promise.allSettled(batch.map(segment => eda.pcb_PrimitiveLine.create(
			'',
			layerId as TPCB_LayersOfLine,
			mil(segment.start.x),
			mil(segment.start.y),
			mil(segment.end.x),
			mil(segment.end.y),
			mil(segment.width),
			false,
		)));
		for (const result of results) {
			if (result.status === 'fulfilled') {
				const id = primitiveId(result.value);
				if (id)
					created.lines.push(id);
			}
		}
		const failure = results.find(result => result.status === 'rejected');
		if (failure?.status === 'rejected')
			throw failure.reason;
	}
	return segments.length;
}

async function createConvertedFill(layerId: number, polygon: IPCB_Polygon, created: CreatedIds): Promise<string | undefined> {
	const polyline = await eda.pcb_PrimitivePolyline.create('', layerId as TPCB_LayersOfLine, polygon, 0.1, false);
	const polylineId = primitiveId(polyline);
	if (polylineId)
		created.polylines.push(polylineId);
	if (!polyline)
		return undefined;
	let fillId: string | undefined;
	let conversionError: unknown;
	try {
		fillId = primitiveId(await polyline.convertToFill());
		if (fillId)
			created.fills.push(fillId);
	}
	catch (error) {
		conversionError = error;
	}
	if (polylineId) {
		try {
			if (await eda.pcb_PrimitivePolyline.delete(polylineId))
				created.polylines = created.polylines.filter(id => id !== polylineId);
		}
		catch {}
	}
	if (conversionError)
		throw conversionError;
	return fillId;
}

export async function writePlan(plan: ImportPlan): Promise<WriteSummary> {
	const created: CreatedIds = { lines: [], arcs: [], pads: [], fills: [], polylines: [], vias: [] };
	const reconstruction = buildReconstructionIndex(plan);
	let activeContext = '初始化导入';
	let simplifiedRegions = 0;
	let maximumSimplificationMicrometers = 0;
	let hatchFallbackPrimitives = 0;
	let hatchFallbackLines = 0;
	let convertedFills = 0;
	let regionFills = 0;
	let flashFills = 0;
	let boardOutlineContours = 0;
	let linearizedArcs = 0;
	let skippedDerivedFlashes = 0;
	let skippedInnerCopperFlashes = 0;
	let throughHolePads = 0;
	let tentedVias = 0;
	try {
		for (const layer of plan.layers) {
			if (layer.layerId === 11) {
				activeContext = `${layer.fileName}（EDA 板框层）`;
				const strokes = layer.result.primitives.filter(primitive => primitive.kind === 'stroke');
				const contours = [
					...closedStrokeContours(strokes),
					...layer.result.primitives.filter(primitive => primitive.kind === 'region').map(region => explicitlyClosePolygon(region.points)),
				];
				if (!contours.length && layer.result.primitives.length)
					throw new Error('未能从板框 Gerber 组装出闭合轮廓。');
				const lineWidth = Math.max(0.1, mil(strokes[0]?.width ?? 0.05));
				for (const contour of contours) {
					const polygon = eda.pcb_MathPolygon.createPolygon(polygonSource(contour));
					if (!polygon)
						throw new Error('无法创建闭合板框多边形。');
					const polyline = await eda.pcb_PrimitivePolyline.create('', 11, polygon, lineWidth, false);
					const id = primitiveId(polyline);
					if (!id)
						throw new Error('无法创建闭合板框折线。');
					created.polylines.push(id);
					boardOutlineContours += 1;
				}
				continue;
			}
			for (const [primitiveIndex, primitive] of layer.result.primitives.entries()) {
				activeContext = `${layer.fileName}（EDA 图层 ${layer.layerId}）第 ${primitiveIndex + 1} 个 ${primitive.kind} 图元`;
				if (primitive.kind === 'flash' && isCopperFlashAtDrill(reconstruction, layer.layerId, primitive.position)) {
					if (layer.layerId >= 15 && layer.layerId <= 44)
						skippedInnerCopperFlashes += 1;
					continue;
				}
				if (primitive.kind === 'flash' && isPadDerivedFlash(reconstruction, layer.layerId, primitive.position)) {
					skippedDerivedFlashes += 1;
					continue;
				}
				if (primitive.kind === 'stroke') {
					if (primitive.arcAngle !== undefined && !isCopperLayer(layer.layerId)) {
						const points = strokePoints(primitive);
						for (let index = 1; index < points.length; index += 1) {
							const id = primitiveId(await eda.pcb_PrimitiveLine.create('', layer.layerId as TPCB_LayersOfLine, mil(points[index - 1].x), mil(points[index - 1].y), mil(points[index].x), mil(points[index].y), Math.max(0.1, mil(primitive.width)), false));
							if (id)
								created.lines.push(id);
						}
						linearizedArcs += 1;
						continue;
					}
					const id = primitive.arcAngle === undefined
						? primitiveId(await eda.pcb_PrimitiveLine.create('', layer.layerId as TPCB_LayersOfLine, mil(primitive.start.x), mil(primitive.start.y), mil(primitive.end.x), mil(primitive.end.y), Math.max(0.1, mil(primitive.width)), false))
						: primitiveId(await eda.pcb_PrimitiveArc.create('', layer.layerId as TPCB_LayersOfLine, mil(primitive.start.x), mil(primitive.start.y), mil(primitive.end.x), mil(primitive.end.y), primitive.arcAngle, Math.max(0.1, mil(primitive.width)), 1, false));
					if (id)
						(primitive.arcAngle === undefined ? created.lines : created.arcs).push(id);
					continue;
				}
				if (primitive.kind === 'flash' && (layer.layerId === 1 || layer.layerId === 2)) {
					const id = primitiveId(await eda.pcb_PrimitivePad.create(layer.layerId as TPCB_LayersOfPad, '', mil(primitive.position.x), mil(primitive.position.y), shapeRotation(primitive.shape), padShape(primitive.shape), '', null, 0, 0, 0, false, 0, undefined, null, null, false));
					if (id)
						created.pads.push(id);
					continue;
				}
				let source: TPCB_PolygonSourceArray | undefined;
				let simplifiedRegionPoints: Point[] | undefined;
				if (primitive.kind === 'flash') {
					source = shapePolygon(primitive.position, primitive.shape);
				}
				else {
					const simplified = simplifyClosedPolygon(primitive.points);
					simplifiedRegionPoints = simplified.points;
					source = polygonSource(simplifiedRegionPoints);
					if (simplified.toleranceMm > 0) {
						simplifiedRegions += 1;
						maximumSimplificationMicrometers = Math.max(maximumSimplificationMicrometers, simplified.toleranceMm * 1000);
					}
				}
				if (!source)
					continue;
				const polygon = eda.pcb_MathPolygon.createPolygon(source);
				if (!polygon)
					throw new Error(`无法创建 ${layer.fileName} 中的多边形。`);
				let fillId: string | undefined;
				let fillError: unknown;
				try {
					fillId = primitiveId(isCopperLayer(layer.layerId)
						? await eda.pcb_PrimitiveFill.create(layer.layerId as TPCB_LayersOfFill, polygon, '')
						: await eda.pcb_PrimitiveFill.create(layer.layerId as TPCB_LayersOfFill, polygon));
				}
				catch (error) {
					fillError = error;
				}
				if (fillId) {
					created.fills.push(fillId);
					if (primitive.kind === 'region')
						regionFills += 1;
					else
						flashFills += 1;
					continue;
				}
				try {
					if (await createConvertedFill(layer.layerId, polygon, created)) {
						convertedFills += 1;
						if (primitive.kind === 'region')
							regionFills += 1;
						else
							flashFills += 1;
						continue;
					}
				}
				catch {}
				if (isHatchLayer(layer.layerId)) {
					const points = primitive.kind === 'flash'
						? flashOutlinePoints(primitive.position, primitive.shape)
						: simplifiedRegionPoints ?? primitive.points;
					const hatchLines = await createAbsoluteHatch(layer.layerId, points, created);
					if (hatchLines) {
						hatchFallbackPrimitives += 1;
						hatchFallbackLines += hatchLines;
						continue;
					}
				}
				const fillMessage = fillError instanceof Error ? fillError.message : '填充接口返回空结果';
				throw new Error(`普通填充失败，且当前图层无法完成绝对坐标扫描回退：${fillMessage}`);
			}
		}
		for (const drill of plan.drills) {
			for (const [hitIndex, hit] of drill.result.hits.entries()) {
				activeContext = `${drill.fileName} 第 ${hitIndex + 1} 个钻孔`;
				if (hit.plated === false) {
					const diameter = mil(hit.diameter);
					const id = primitiveId(await eda.pcb_PrimitivePad.create(12, '', mil(hit.position.x), mil(hit.position.y), 0, [EPCB_PrimitivePadShapeType.ELLIPSE, diameter, diameter], '', [EPCB_PrimitivePadHoleType.ROUND, diameter], 0, 0, 0, false, EPCB_PrimitivePadType.NORMAL, undefined, null, null, false));
					if (id) {
						created.pads.push(id);
						throughHolePads += 1;
					}
					continue;
				}
				const copperShape = copperShapeAtDrill(reconstruction, hit.position);
				const annularDiameter = copperShape
					? shapeOuterDiameter(copperShape)
					: Math.max(hit.diameter + 0.3, hit.diameter * 1.5);
				if (copperShape && hasMaskAtDrill(reconstruction, hit.position)) {
					const diameter = mil(hit.diameter);
					const id = primitiveId(await eda.pcb_PrimitivePad.create(12, '', mil(hit.position.x), mil(hit.position.y), shapeRotation(copperShape), padShape(copperShape), '', [EPCB_PrimitivePadHoleType.ROUND, diameter], 0, 0, 0, true, EPCB_PrimitivePadType.NORMAL, undefined, null, null, false));
					if (id)
						created.pads.push(id);
					continue;
				}
				const coverOilExpansion = -mil(annularDiameter / 2);
				const id = primitiveId(await eda.pcb_PrimitiveVia.create('', mil(hit.position.x), mil(hit.position.y), mil(hit.diameter), mil(annularDiameter), 0, null, {
					topSolderMask: coverOilExpansion,
					bottomSolderMask: coverOilExpansion,
				}, false));
				if (id) {
					created.vias.push(id);
					tentedVias += 1;
				}
			}
		}
	}
	catch (error) {
		await rollback(created);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${activeContext}：${message}`);
	}
	return {
		lines: created.lines.length,
		arcs: created.arcs.length,
		pads: created.pads.length,
		fills: created.fills.length,
		regionFills,
		flashFills,
		convertedFills,
		hatchFallbackPrimitives,
		hatchFallbackLines,
		boardOutlineContours,
		linearizedArcs,
		skippedDerivedFlashes,
		skippedInnerCopperFlashes,
		throughHolePads,
		tentedVias,
		vias: created.vias.length,
		simplifiedRegions,
		maximumSimplificationMicrometers,
	};
}
