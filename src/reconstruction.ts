import type { ApertureShape, ImportPlan, Point } from './model.js';

const POSITION_TOLERANCE_MM = 0.005;

interface PositionedShape {
	layerId: number;
	position: Point;
	shape: ApertureShape;
}

interface LayerPosition {
	layerId: number;
	position: Point;
}

export interface ReconstructionIndex {
	drillPositions: Point[];
	copperFlashes: PositionedShape[];
	maskPositions: LayerPosition[];
}

function samePosition(left: Point, right: Point): boolean {
	return Math.hypot(left.x - right.x, left.y - right.y) <= POSITION_TOLERANCE_MM;
}

export function buildReconstructionIndex(plan: ImportPlan): ReconstructionIndex {
	const index: ReconstructionIndex = {
		drillPositions: [],
		copperFlashes: [],
		maskPositions: [],
	};
	for (const drill of plan.drills) {
		for (const hit of drill.result.hits)
			index.drillPositions.push(hit.position);
	}
	for (const layer of plan.layers) {
		for (const primitive of layer.result.primitives) {
			if (primitive.kind !== 'flash')
				continue;
			if (layer.layerId === 1 || layer.layerId === 2)
				index.copperFlashes.push({ layerId: layer.layerId, position: primitive.position, shape: primitive.shape });
			if (layer.layerId === 5 || layer.layerId === 6)
				index.maskPositions.push({ layerId: layer.layerId, position: primitive.position });
		}
	}
	return index;
}

export function isDrilledPosition(index: ReconstructionIndex, position: Point): boolean {
	return index.drillPositions.some(candidate => samePosition(candidate, position));
}

export function isCopperFlashAtDrill(index: ReconstructionIndex, layerId: number, position: Point): boolean {
	const copperLayer = layerId === 1 || layerId === 2 || (layerId >= 15 && layerId <= 44);
	return copperLayer && isDrilledPosition(index, position);
}

export function copperShapeAtDrill(index: ReconstructionIndex, position: Point): ApertureShape | undefined {
	return index.copperFlashes.find(candidate => candidate.layerId === 1 && samePosition(candidate.position, position))?.shape
		?? index.copperFlashes.find(candidate => candidate.layerId === 2 && samePosition(candidate.position, position))?.shape;
}

export function hasMaskAtDrill(index: ReconstructionIndex, position: Point): boolean {
	return index.maskPositions.some(candidate => samePosition(candidate.position, position));
}

export function isPadDerivedFlash(index: ReconstructionIndex, layerId: number, position: Point): boolean {
	const copperLayer = layerId === 5 || layerId === 7
		? 1
		: layerId === 6 || layerId === 8 ? 2 : undefined;
	return copperLayer !== undefined
		&& index.copperFlashes.some(candidate => candidate.layerId === copperLayer && samePosition(candidate.position, position));
}
