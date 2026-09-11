import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExcellon } from '../src/excellon.ts';
import { isSupportedManufacturingFile, MANUFACTURING_FILE_EXTENSIONS } from '../src/files.ts';
import { closedStrokeContours, explicitlyClosePolygon, hatchPolygon, partitionClosedPolygon, rectanglePoints, roundedRectanglePercentage, simplifyClosedPolygon, strokePoints } from '../src/geometry.ts';
import { parseGerber } from '../src/gerber.ts';
import { copperLayerCountFromLayers, guessLayer, requiredCopperLayerCount } from '../src/layers.ts';
import { buildReconstructionIndex, copperShapeAtDrill, hasMaskAtDrill, isCopperFlashAtDrill, isDrilledPosition, isNativePadShape, isPadDerivedFlash, maskExpansionForPad } from '../src/reconstruction.ts';

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

test('keeps KiCad ViaDrill and ComponentDrill tool functions', () => {
	const result = parseExcellon(`M48
; #@! TF.FileFunction,Plated,1,6,PTH
; #@! TA.AperFunction,Plated,PTH,ViaDrill
T1C0.200
; #@! TA.AperFunction,Plated,PTH,ComponentDrill
T2C0.400
%
T1
X10.0Y20.0
T2
X30.0Y40.0
M30`);
	assert.equal(result.hits[0].drillFunction, 'ViaDrill');
	assert.equal(result.hits[1].drillFunction, 'ComponentDrill');
});

test('keeps Gerber X2 aperture functions on flashes', () => {
	const result = parseGerber(`%FSLAX46Y46*%
%MOMM*%
%TA.AperFunction,ViaPad*%
%ADD10C,0.450000*%
%TD*%
%TA.AperFunction,SMDPad,CuDef*%
%ADD11R,0.600000X0.300000*%
%TD*%
D10*
X1000000Y2000000D03*
D11*
X3000000Y4000000D03*
M02*`);
	const flashes = result.primitives.filter(primitive => primitive.kind === 'flash');
	assert.equal(flashes[0].apertureFunction, 'ViaPad');
	assert.equal(flashes[1].apertureFunction, 'SMDPad');
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

test('parses the JLCEDA Rect aperture macro convention with rotation', () => {
	const result = parseGerber(`%FSLAX45Y45*%
%MOMM*%
%AMRect*21,1,$1,$2,0,0,$3*%
%ADD10Rect,0.45X0.5X60.0*%
D10*
X10000000Y-11000000D03*
M02*`);
	assert.equal(result.warnings.length, 0);
	assert.deepEqual(result.primitives[0], {
		kind: 'flash',
		position: { x: 100, y: -110 },
		shape: { kind: 'rectangle', width: 0.45, height: 0.5, rotation: 60 },
	});
});

test('parses the KiCad RotRect aperture macro convention', () => {
	const result = parseGerber(`%FSLAX46Y46*%
%MOMM*%
%AMRotRect*21,1,$1,$2,0,0,$3*%
%ADD28RotRect,0.450000X0.500000X60.000000*%
D28*
X114760000Y-108902295D03*
M02*`);
	assert.equal(result.warnings.length, 0);
	const flash = result.primitives[0];
	assert.equal(flash.kind, 'flash');
	assert.deepEqual(flash.shape, { kind: 'roundedRectangle', width: 0.45, height: 0.5, radius: 0, rotation: 60 });
});

test('parses a KiCad FreePoly outline macro and its aperture rotation', () => {
	const result = parseGerber(`%FSLAX46Y46*%
%MOMM*%
%AMFreePoly0*
4,1,4,-0.2,-0.1,0.2,-0.1,0.2,0.1,-0.2,0.1,-0.2,-0.1,$1*%
%ADD21FreePoly0,270.000000*%
D21*
X1000000Y2000000D03*
M02*`);
	assert.equal(result.warnings.length, 0);
	const flash = result.primitives[0];
	assert.equal(flash.kind, 'flash');
	assert.deepEqual(flash.shape, {
		kind: 'customPolygon',
		points: [
			{ x: -0.2, y: -0.1 },
			{ x: 0.2, y: -0.1 },
			{ x: 0.2, y: 0.1 },
			{ x: -0.2, y: 0.1 },
			{ x: -0.2, y: -0.1 },
		],
		rotation: 270,
	});
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
	const smdMaskFlash = plan.layers[1].result.primitives[0];
	const throughHoleMaskFlash = plan.layers[1].result.primitives[1];
	const smdPasteFlash = plan.layers[2].result.primitives[0];
	assert.equal(smdMaskFlash.kind, 'flash');
	assert.equal(throughHoleMaskFlash.kind, 'flash');
	assert.equal(smdPasteFlash.kind, 'flash');
	assert.equal(isPadDerivedFlash(index, 5, smdMaskFlash), false);
	assert.equal(isPadDerivedFlash(index, 5, throughHoleMaskFlash), true);
	assert.equal(isPadDerivedFlash(index, 7, smdPasteFlash), false);
	assert.equal(isDrilledPosition(index, smdPosition), false);
	assert.equal(isDrilledPosition(index, throughHolePosition), true);
	assert.equal(isCopperFlashAtDrill(index, 15, { kind: 'flash', position: throughHolePosition, shape: circle }), true);
	assert.equal(isCopperFlashAtDrill(index, 15, { kind: 'flash', position: smdPosition, shape: circle }), false);
	assert.equal(isCopperFlashAtDrill(index, 5, { kind: 'flash', position: throughHolePosition, shape: circle }), false);
	assert.equal(hasMaskAtDrill(index, throughHolePosition), true);
	assert.equal(hasMaskAtDrill(index, viaPosition), false);
	assert.deepEqual(copperShapeAtDrill(index, viaPosition), circle);
});

test('preserves an SMD pad overlapping a ViaDrill while skipping only the ViaPad flashes', () => {
	const position = { x: 103.15, y: -106.4 };
	const smdShape = { kind: 'rectangle' as const, width: 0.6, height: 0.3 };
	const viaShape = { kind: 'circle' as const, diameter: 0.45 };
	const maskShape = { kind: 'rectangle' as const, width: 0.6, height: 0.3 };
	const pasteShape = { kind: 'rectangle' as const, width: 0.464, height: 0.212 };
	const smdFlash = { kind: 'flash' as const, position, shape: smdShape, apertureFunction: 'SMDPad' };
	const viaFlash = { kind: 'flash' as const, position, shape: viaShape, apertureFunction: 'ViaPad' };
	const maskFlash = { kind: 'flash' as const, position, shape: maskShape };
	const pasteFlash = { kind: 'flash' as const, position, shape: pasteShape };
	const plan = {
		layers: [
			{ fileName: 'top.gtl', layerId: 1, result: { warnings: [], primitives: [smdFlash, viaFlash] } },
			{ fileName: 'inner.g1', layerId: 15, result: { warnings: [], primitives: [viaFlash] } },
			{ fileName: 'mask.gts', layerId: 5, result: { warnings: [], primitives: [maskFlash] } },
			{ fileName: 'paste.gtp', layerId: 7, result: { warnings: [], primitives: [pasteFlash] } },
		],
		drills: [{ fileName: 'pth.drl', result: { warnings: [], hits: [
			{ position, diameter: 0.2, plated: true, drillFunction: 'ViaDrill' },
		] } }],
		warnings: [],
	};
	const index = buildReconstructionIndex(plan);
	assert.equal(isCopperFlashAtDrill(index, 1, smdFlash), false);
	assert.equal(isCopperFlashAtDrill(index, 1, viaFlash), true);
	assert.equal(isCopperFlashAtDrill(index, 1, { ...smdFlash, apertureFunction: 'Conductor' }), false);
	assert.equal(isCopperFlashAtDrill(index, 15, viaFlash), true);
	assert.deepEqual(copperShapeAtDrill(index, position, 'ViaDrill'), viaShape);
	assert.equal(maskExpansionForPad(index, 1, position, smdShape), 0);
	assert.equal(isPadDerivedFlash(index, 5, maskFlash), false);
	assert.equal(isPadDerivedFlash(index, 7, pasteFlash), false);
});

test('keeps FreePoly copper, mask, and paste flashes as exact polygon graphics', () => {
	const position = { x: 101.33, y: -110.87 };
	const customPolygon = {
		kind: 'customPolygon' as const,
		points: [
			{ x: -0.2, y: -0.1 },
			{ x: 0.2, y: -0.1 },
			{ x: 0.2, y: 0.1 },
			{ x: -0.2, y: 0.1 },
		],
		rotation: 270,
	};
	const plan = {
		layers: [
			{ fileName: 'bottom.gbl', layerId: 2, result: { warnings: [], primitives: [{ kind: 'flash' as const, position, shape: customPolygon }] } },
			{ fileName: 'mask.gbs', layerId: 6, result: { warnings: [], primitives: [{ kind: 'flash' as const, position, shape: customPolygon }] } },
			{ fileName: 'paste.gbp', layerId: 8, result: { warnings: [], primitives: [{ kind: 'flash' as const, position, shape: customPolygon }] } },
		],
		drills: [],
		warnings: [],
	};
	const index = buildReconstructionIndex(plan);
	assert.equal(isNativePadShape(customPolygon), false);
	const maskFlash = plan.layers[1].result.primitives[0];
	const pasteFlash = plan.layers[2].result.primitives[0];
	assert.equal(maskFlash.kind, 'flash');
	assert.equal(pasteFlash.kind, 'flash');
	assert.equal(isPadDerivedFlash(index, 6, maskFlash), false);
	assert.equal(isPadDerivedFlash(index, 8, pasteFlash), false);
});

test('writes axis-aligned rectangle graphics around the Gerber flash center', () => {
	const points = rectanglePoints(
		{ x: 114.25, y: -107 },
		1.2,
		0.5144,
	);
	assert.deepEqual(points, [
		{ x: 113.65, y: -106.7428 },
		{ x: 114.85, y: -106.7428 },
		{ x: 114.85, y: -107.2572 },
		{ x: 113.65, y: -107.2572 },
	]);
});

test('maps common Protel and KiCad layer names', () => {
	assert.equal(guessLayer('board.GTL').layerId, 1);
	assert.equal(guessLayer('board-B.Mask.gbr').layerId, 6);
	assert.equal(guessLayer('board-Edge_Cuts.gbr').layerId, 11);
	assert.deepEqual(guessLayer('REF_EVM-CuTop.gbr', 'Copper,L1,Top'), { layerId: 1, label: '顶层铜', confident: true });
	assert.deepEqual(guessLayer('REF_EVM-CuIn1.gbr', 'Copper,L2,Inr'), { layerId: 15, label: '内层 1', confident: true });
	assert.deepEqual(guessLayer('REF_EVM-CuIn2.gbr', 'Copper,L3,Inr'), { layerId: 16, label: '内层 2', confident: true });
	assert.deepEqual(guessLayer('REF_EVM-CuBottom.gbr', 'Copper,L4,Bot'), { layerId: 2, label: '底层铜', confident: true });
	assert.deepEqual(guessLayer('OpenRX-Gemini-In4_Cu.g4'), { layerId: 18, label: '内层 4', confident: true });
});

test('accepts every supported inner-copper extension and derives the required stackup', () => {
	assert.equal(isSupportedManufacturingFile('OpenRX-Gemini-In4_Cu.g4'), true);
	assert.equal(isSupportedManufacturingFile('legacy-plane.gp30'), true);
	assert.equal(MANUFACTURING_FILE_EXTENSIONS.includes('.g4'), true);
	const plan = {
		layers: [
			{ fileName: 'top.gtl', layerId: 1, result: { fileFunction: 'Copper,L1,Top', warnings: [], primitives: [] } },
			{ fileName: 'inner4.g4', layerId: 18, result: { fileFunction: 'Copper,L5,Inr', warnings: [], primitives: [] } },
			{ fileName: 'bottom.gbl', layerId: 2, result: { fileFunction: 'Copper,L6,Bot', warnings: [], primitives: [] } },
		],
		drills: [],
		warnings: [],
	};
	assert.equal(requiredCopperLayerCount(plan), 6);
	assert.equal(copperLayerCountFromLayers([
		{ id: 1, type: 'SIGNAL', layerStatus: 1 },
		{ id: 2, type: 'SIGNAL', layerStatus: 2 },
		{ id: 15, type: 'PLANE', layerStatus: 1 },
		{ id: 16, type: 'SIGNAL', layerStatus: 1 },
		{ id: 17, type: 'SIGNAL', layerStatus: 2 },
		{ id: 18, type: 'SIGNAL', layerStatus: 1 },
		{ id: 19, type: 'SIGNAL', layerStatus: 0 },
		{ id: 3, type: 'SILKSCREEN', layerStatus: 1 },
	]), 6);
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

test('losslessly partitions a dense detailed region into adjoining EDA-sized polygons', () => {
	const points = Array.from({ length: 2400 }, (_, index) => {
		const angle = 2 * Math.PI * index / 2400;
		const radius = index % 2 ? 10.02 : 10;
		return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
	});
	points.push(points[0]);
	assert.throws(() => simplifyClosedPolygon(points), /无法安全降至 900 个以内/);

	const area = (polygon: typeof points) => Math.abs(polygon.reduce((sum, point, index) => {
		const next = polygon[(index + 1) % polygon.length];
		return sum + point.x * next.y - next.x * point.y;
	}, 0) / 2);
	const parts = partitionClosedPolygon(points);
	assert.ok(parts.length > 1);
	assert.ok(parts.every(part => part.length <= 900));
	assert.ok(Math.abs(parts.reduce((sum, part) => sum + area(part), 0) - area(points)) / area(points) < 1e-8);
});
