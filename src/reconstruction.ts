import type { ApertureShape, DrillHit, Flash, ImportPlan, Point } from './model.js';

const POSITION_TOLERANCE_MM = 0.005;
const SHAPE_TOLERANCE_MM = 0.002;
const ANGLE_TOLERANCE_DEGREES = 0.01;

interface PositionedShape {
	layerId: number;
	position: Point;
	shape: ApertureShape;
	apertureFunction?: string;
}

export interface ReconstructionIndex {
	drillHits: DrillHit[];
	drillPositions: Point[];
	copperFlashes: PositionedShape[];
	maskFlashes: PositionedShape[];
}

function samePosition(left: Point, right: Point): boolean {
	return Math.hypot(left.x - right.x, left.y - right.y) <= POSITION_TOLERANCE_MM;
}

function sameNumber(left: number, right: number, tolerance = SHAPE_TOLERANCE_MM): boolean {
	return Math.abs(left - right) <= tolerance;
}

function sameAngle(left: number, right: number): boolean {
	const delta = ((left - right + 540) % 360) - 180;
	return Math.abs(delta) <= ANGLE_TOLERANCE_DEGREES;
}

function hasApertureFunction(candidate: { apertureFunction?: string }, expected: string): boolean {
	return candidate.apertureFunction?.toLowerCase() === expected.toLowerCase();
}

function maskExpansionBetween(copper: ApertureShape, mask: ApertureShape): number | undefined {
	if (copper.kind === 'circle' && mask.kind === 'circle') {
		return (mask.diameter - copper.diameter) / 2;
	}
	if (copper.kind === 'polygon' && mask.kind === 'polygon'
		&& copper.vertices === mask.vertices && sameAngle(copper.rotation, mask.rotation)) {
		return (mask.diameter - copper.diameter) / 2;
	}
	if (copper.kind === 'rectangle' && mask.kind === 'rectangle'
		&& sameAngle(copper.rotation ?? 0, mask.rotation ?? 0)) {
		const xExpansion = (mask.width - copper.width) / 2;
		const yExpansion = (mask.height - copper.height) / 2;
		return sameNumber(xExpansion, yExpansion) ? (xExpansion + yExpansion) / 2 : undefined;
	}
	if (copper.kind === 'obround' && mask.kind === 'obround') {
		const xExpansion = (mask.width - copper.width) / 2;
		const yExpansion = (mask.height - copper.height) / 2;
		return sameNumber(xExpansion, yExpansion) ? (xExpansion + yExpansion) / 2 : undefined;
	}
	if (copper.kind === 'roundedRectangle' && mask.kind === 'roundedRectangle'
		&& sameAngle(copper.rotation, mask.rotation)) {
		const xExpansion = (mask.width - copper.width) / 2;
		const yExpansion = (mask.height - copper.height) / 2;
		const expansion = (xExpansion + yExpansion) / 2;
		return sameNumber(xExpansion, yExpansion) && sameNumber(mask.radius, Math.max(0, copper.radius + expansion))
			? expansion
			: undefined;
	}
	return undefined;
}

export function buildReconstructionIndex(plan: ImportPlan): ReconstructionIndex {
	const index: ReconstructionIndex = {
		drillHits: [],
		drillPositions: [],
		copperFlashes: [],
		maskFlashes: [],
	};
	for (const drill of plan.drills) {
		for (const hit of drill.result.hits) {
			index.drillHits.push(hit);
			index.drillPositions.push(hit.position);
		}
	}
	for (const layer of plan.layers) {
		for (const primitive of layer.result.primitives) {
			if (primitive.kind !== 'flash')
				continue;
			const positioned = {
				layerId: layer.layerId,
				position: primitive.position,
				shape: primitive.shape,
				...(primitive.apertureFunction ? { apertureFunction: primitive.apertureFunction } : {}),
			};
			if (layer.layerId === 1 || layer.layerId === 2)
				index.copperFlashes.push(positioned);
			if (layer.layerId === 5 || layer.layerId === 6)
				index.maskFlashes.push(positioned);
		}
	}
	return index;
}

export function isDrilledPosition(index: ReconstructionIndex, position: Point): boolean {
	return index.drillPositions.some(candidate => samePosition(candidate, position));
}

export function isCopperFlashAtDrill(index: ReconstructionIndex, layerId: number, flash: Flash): boolean {
	const copperLayer = layerId === 1 || layerId === 2 || (layerId >= 15 && layerId <= 44);
	if (!copperLayer || !isDrilledPosition(index, flash.position))
		return false;
	if (flash.apertureFunction)
		return hasApertureFunction(flash, 'ViaPad') || hasApertureFunction(flash, 'ComponentPad');
	// Files without X2 attributes retain the legacy coordinate-based fallback.
	return true;
}

export function copperShapeAtDrill(index: ReconstructionIndex, position: Point, drillFunction?: string): ApertureShape | undefined {
	const candidates = index.copperFlashes.filter(candidate => samePosition(candidate.position, position));
	const desiredApertureFunction = drillFunction?.toLowerCase() === 'viadrill'
		? 'ViaPad'
		: drillFunction?.toLowerCase() === 'componentdrill' ? 'ComponentPad' : undefined;
	if (desiredApertureFunction)
		return candidates.find(candidate => hasApertureFunction(candidate, desiredApertureFunction))?.shape;
	return candidates.find(candidate => candidate.layerId === 1 && hasApertureFunction(candidate, 'ViaPad'))?.shape
		?? candidates.find(candidate => candidate.layerId === 2 && hasApertureFunction(candidate, 'ViaPad'))?.shape
		?? candidates.find(candidate => candidate.layerId === 1)?.shape
		?? candidates.find(candidate => candidate.layerId === 2)?.shape;
}

export function hasMaskAtDrill(index: ReconstructionIndex, position: Point): boolean {
	return index.maskFlashes.some(candidate => samePosition(candidate.position, position));
}

export function isNativePadShape(shape: ApertureShape): boolean {
	// EasyEDA Pro currently rejects KiCad FreePoly outlines passed to the
	// complex-polygon pad API. Keep those flashes as exact polygon graphics;
	// their separate mask/paste flashes must therefore be preserved as well.
	return shape.kind !== 'customPolygon';
}

export function maskExpansionForPad(index: ReconstructionIndex, copperLayerId: 1 | 2, position: Point, copperShape: ApertureShape): number | undefined {
	const maskLayerId = copperLayerId === 1 ? 5 : 6;
	for (const candidate of index.maskFlashes) {
		if (candidate.layerId !== maskLayerId || !samePosition(candidate.position, position))
			continue;
		const expansion = maskExpansionBetween(copperShape, candidate.shape);
		if (expansion !== undefined)
			return expansion;
	}
	return undefined;
}

export function isPadDerivedFlash(index: ReconstructionIndex, layerId: number, flash: Flash): boolean {
	// Surface-mount copper flashes are written as graphics so that EasyEDA does
	// not synthesize mask/paste geometry. Only mask openings that will be
	// recreated by an actual through-hole pad may be omitted here.
	const copperLayer = layerId === 5 ? 1 : layerId === 6 ? 2 : undefined;
	if (copperLayer === undefined)
		return false;
	const hasNativeThroughHolePad = index.drillHits.some((hit) => {
		if (!samePosition(hit.position, flash.position))
			return false;
		const drillFunction = hit.drillFunction?.toLowerCase();
		if (drillFunction === 'viadrill')
			return false;
		if (drillFunction === 'componentdrill')
			return true;
		return copperShapeAtDrill(index, hit.position) !== undefined && hasMaskAtDrill(index, hit.position);
	});
	if (!hasNativeThroughHolePad)
		return false;
	return index.copperFlashes.some(candidate => candidate.layerId === copperLayer
		&& samePosition(candidate.position, flash.position)
		&& !hasApertureFunction(candidate, 'ViaPad')
		&& isNativePadShape(candidate.shape)
		&& maskExpansionBetween(candidate.shape, flash.shape) !== undefined);
}
