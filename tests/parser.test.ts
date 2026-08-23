import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExcellon } from '../src/excellon.ts';
import { closedStrokeContours, explicitlyClosePolygon, hatchPolygon, roundedRectanglePercentage, simplifyClosedPolygon, strokePoints } from '../src/geometry.ts';
import { parseGerber } from '../src/gerber.ts';
import { guessLayer } from '../src/layers.ts';
import { buildReconstructionIndex, copperShapeAtDrill, hasMaskAtDrill, isCopperFlashAtDrill, isDrilledPosition, isPadDerivedFlash } from '../src/reconstruction.ts';

test('parses RS-274X lines, flashes, regions, and metric coordinates', () => {
	const source = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.200*%
%ADD11R,1.000X2.000*%
D10*
X000000Y000000D02*
X010000Y000000D01*
D11*
X005000Y005000D03*
G36*
X000000Y000000D02*
X010000Y000000D01*
X010000Y010000D01*
X000000Y010000D01*
G37*
M02*`;
	const result = parseGerber(source);
	assert.equal(result.primitives.length, 3);
	assert.deepEqual(result.primitives.map(primitive => primitive.kind), ['stroke', 'flash', 'region']);
	const stroke = result.primitives[0];
	assert.equal(stroke.kind, 'stroke');
	assert.equal(stroke.end.x, 1);
	assert.equal(stroke.width, 0.2);
	const region = result.primitives[2];
	assert.equal(region.kind, 'region');
	assert.deepEqual(region.points[0], { x: 0, y: 0 });
	assert.equal(region.points.length, 4);
});

test('parses Excellon tool diameters and hits', () => {
	const result = parseExcellon(`M48
METRIC,TZ
T01C0.800
%
T01
X010000Y020000
X015000Y025000
M30`);
	assert.equal(result.hits.length, 2);
	assert.equal(result.plated, undefined);
	assert.deepEqual(result.hits[0], { position: { x: 10, y: 20 }, diameter: 0.8, plated: undefined });
});

test('parses the KiCad RoundRect aperture macro convention', () => {
	const result = parseGerber(`%FSLAX46Y46*%
%MOMM*%
%AMRoundRect*0 KiCad rounded rectangle*%
%ADD10RoundRect,0.250000X-0.250000X-0.475000X0.250000X-0.475000X0.250000X0.475000X-0.250000X0.475000X0*%
D10*
X1000000Y2000000D03*
M02*`);
	assert.equal(result.warnings.length, 0);
	const flash = result.primitives[0];
	assert.equal(flash.kind, 'flash');
	assert.deepEqual(flash.shape, { kind: 'roundedRectangle', width: 1, height: 1.45, radius: 0.25, rotation: 0 });
});

test('keeps the effective KiCad pad rotation encoded by RoundRect corners', () => {
	const result = parseGerber(`%FSLAX46Y46*%
%MOMM*%
%ADD10RoundRect,0.200000X-0.053033X0.335876X-0.335876X0.053033X0.053033X-0.335876X0.335876X-0.053033X0*%
D10*
X107923363Y-96886637D03*
M02*`);
	const flash = result.primitives[0];
	assert.equal(flash.kind, 'flash');
	assert.equal(flash.shape.kind, 'roundedRectangle');
	assert.ok(Math.abs(flash.shape.rotation - (-135)) < 0.001);
});

test('parses the compact JLCEDA RoundRect aperture macro convention', () => {
	const result = parseGerber(`%FSLAX45Y45*%
%MOMM*%
%AMRoundRect*1,1,$1,$2,$3*%
%ADD10RoundRect,0.09843X-0.45079X0.67579X0.45079X0.67579*%
D10*
X1000000Y-9000000D03*
M02*`);
	assert.equal(result.warnings.length, 0);
	const flash = result.primitives[0];
	assert.equal(flash.kind, 'flash');
	assert.equal(flash.shape.kind, 'roundedRectangle');
	assert.ok(Math.abs(flash.shape.width - 1.00001) < 0.000001);
	assert.ok(Math.abs(flash.shape.height - 1.45001) < 0.000001);
	assert.ok(Math.abs(flash.shape.radius - 0.049215) < 0.000001);
	assert.ok(Math.abs(flash.shape.rotation) < 0.000001);
});

test('converts physical rounded-rectangle radius to the percentage expected by EDA', () => {
	assert.equal(roundedRectanglePercentage(1, 1.45, 0.25), 50);
	assert.equal(roundedRectanglePercentage(0.4, 0.4, 0.2), 100);
});

test('parses a JLCEDA region before any aperture is selected', () => {
	const result = parseGerber(`%FSLAX45Y45*%
%MOMM*%
%ADD10C,0.2032*%
G36*
G01X5915660Y-4993640D02*
G01X5915660Y-4734560D01*
G01X6682740Y-4734560D01*
G01X6682740Y-4993640D01*
G01X5915660Y-4993640D01*
G37*
M02*`);
	assert.equal(result.warnings.length, 0);
	assert.equal(result.primitives.length, 1);
	assert.equal(result.primitives[0].kind, 'region');
});

test('does not repeat modal flashes on X2 attribute or aperture commands', () => {
	const result = parseGerber(`%FSLAX46Y46*%
%MOMM*%
%ADD10R,1.000X1.400*%
%ADD11P,1.000X4X45*%
D10*
%TO.C,C1*%
X1000000Y2000000D03*
%TD*%
D11*
%TO.C,Y1*%
X3000000Y4000000D03*
%TD*%
M02*`);
	const flashes = result.primitives.filter(primitive => primitive.kind === 'flash');
	assert.equal(flashes.length, 2);
	assert.deepEqual(flashes.map(flash => flash.position), [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
});

test('hatches asymmetric polygons directly in absolute coordinates', () => {
	const segments = hatchPolygon([
		{ x: 10, y: -20 },
		{ x: 14, y: -20 },
		{ x: 10, y: -18 },
	]);
	assert.ok(segments.length > 10);
	assert.ok(segments[0].end.x - segments[0].start.x > segments.at(-1)!.end.x - segments.at(-1)!.start.x);
	assert.ok(segments.every(segment => segment.start.y >= -20 && segment.start.y <= -18));
	assert.ok(segments.every(segment => segment.start.x >= 10 && segment.end.x <= 14));
});

test('explicitly closes point-list polygons after removing duplicate vertices', () => {
	const closed = explicitlyClosePolygon([
		{ x: 1, y: 2 },
		{ x: 4, y: 2 },
		{ x: 4, y: 6 },
		{ x: 1, y: 6 },
		{ x: 1, y: 2 },
	]);
	assert.equal(closed.length, 5);
	assert.deepEqual(closed[0], closed.at(-1));
});

test('linearizes Gerber arcs and assembles one closed board contour', () => {
	const arc = {
		kind: 'stroke' as const,
		start: { x: 1, y: 0 },
		end: { x: -1, y: 0 },
		width: 0.05,
		arcAngle: 180,
		arcCenter: { x: 0, y: 0 },
	};
	const sampled = strokePoints(arc);
	assert.equal(sampled.length, 19);
	assert.deepEqual(sampled[0], arc.start);
	assert.deepEqual(sampled.at(-1), arc.end);

	const contours = closedStrokeContours([
		{ kind: 'stroke', start: { x: 0, y: 0 }, end: { x: 2, y: 0 }, width: 0.05 },
		{ kind: 'stroke', start: { x: 2, y: 0 }, end: { x: 2, y: 1 }, width: 0.05 },
		{ kind: 'stroke', start: { x: 2, y: 1 }, end: { x: 0, y: 1 }, width: 0.05 },
		{ kind: 'stroke', start: { x: 0, y: 1 }, end: { x: 0, y: 0 }, width: 0.05 },
	]);
	assert.equal(contours.length, 1);
	assert.equal(contours[0].length, 5);
	assert.deepEqual(contours[0][0], contours[0].at(-1));
});

test('classifies native pads, through-hole pads, and tented vias from manufacturing layers', () => {
	const smdPosition = { x: 10, y: -20 };
	const throughHolePosition = { x: 30, y: -40 };
	const viaPosition = { x: 50, y: -60 };
	const circle = { kind: 'circle' as const, diameter: 0.6 };
	const plan = {
		layers: [
			{ fileName: 'top.gbr', layerId: 1, result: { warnings: [], primitives: [
				{ kind: 'flash' as const, position: smdPosition, shape: circle },
				{ kind: 'flash' as const, position: throughHolePosition, shape: circle },
				{ kind: 'flash' as const, position: viaPosition, shape: circle },
			] } },
			{ fileName: 'mask.gbr', layerId: 5, result: { warnings: [], primitives: [
				{ kind: 'flash' as const, position: smdPosition, shape: circle },
				{ kind: 'flash' as const, position: throughHolePosition, shape: circle },
			] } },
			{ fileName: 'paste.gbr', layerId: 7, result: { warnings: [], primitives: [
				{ kind: 'flash' as const, position: smdPosition, shape: circle },
			] } },
		],
		drills: [{ fileName: 'pth.drl', result: { warnings: [], hits: [
			{ position: throughHolePosition, diameter: 1, plated: true },
			{ position: viaPosition, diameter: 0.3, plated: true },
		] } }],
		warnings: [],
	};
	const index = buildReconstructionIndex(plan);
	assert.equal(isPadDerivedFlash(index, 5, smdPosition), true);
	assert.equal(isPadDerivedFlash(index, 7, smdPosition), true);
	assert.equal(isDrilledPosition(index, smdPosition), false);
	assert.equal(isDrilledPosition(index, throughHolePosition), true);
	assert.equal(isCopperFlashAtDrill(index, 15, throughHolePosition), true);
	assert.equal(isCopperFlashAtDrill(index, 15, smdPosition), false);
	assert.equal(isCopperFlashAtDrill(index, 5, throughHolePosition), false);
	assert.equal(hasMaskAtDrill(index, throughHolePosition), true);
	assert.equal(hasMaskAtDrill(index, viaPosition), false);
	assert.deepEqual(copperShapeAtDrill(index, viaPosition), circle);
});

test('maps common Protel and KiCad layer names', () => {
	assert.equal(guessLayer('board.GTL').layerId, 1);
	assert.equal(guessLayer('board-B.Mask.gbr').layerId, 6);
	assert.equal(guessLayer('board-Edge_Cuts.gbr').layerId, 11);
	assert.deepEqual(guessLayer('REF_EVM-CuTop.gbr', 'Copper,L1,Top'), { layerId: 1, label: '顶层铜', confident: true });
	assert.deepEqual(guessLayer('REF_EVM-CuIn1.gbr', 'Copper,L2,Inr'), { layerId: 15, label: '内层 1', confident: true });
	assert.deepEqual(guessLayer('REF_EVM-CuIn2.gbr', 'Copper,L3,Inr'), { layerId: 16, label: '内层 2', confident: true });
	assert.deepEqual(guessLayer('REF_EVM-CuBottom.gbr', 'Copper,L4,Bot'), { layerId: 2, label: '底层铜', confident: true });
});

test('safely reduces very dense closed regions below the EDA fill budget', () => {
	const points = Array.from({ length: 1200 }, (_, index) => {
		const angle = 2 * Math.PI * index / 1200;
		return { x: 10 * Math.cos(angle), y: 10 * Math.sin(angle) };
	});
	points.push(points[0]);
	const result = simplifyClosedPolygon(points);
	assert.ok(result.points.length <= 900);
	assert.ok(result.toleranceMm <= 0.005);
});
