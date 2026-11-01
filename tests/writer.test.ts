import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { parseGerber } from '../src/gerber.ts';

// Exercise the production writer, including routing and rollback, with EDA API stubs.
const compiled = await build({ entryPoints: [new URL('../src/writer.ts', import.meta.url).pathname.replace(/^\/(?=[A-Z]:)/i, '')], bundle: true, write: false, format: 'esm', platform: 'node' });
const { writePlan } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

async function withEda(run, options = {}) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'eda');
	const calls = { lines: [], paths: [], deletedPaths: [], deletedLines: [] };
	let count = 0;
	const primitive = id => ({ getState_PrimitiveId: () => id });
	const eda = {
		pcb_Layer: { getTheNumberOfCopperLayers: async () => 4 },
		pcb_MathPolygon: { createPolygon: source => ({ source }) },
		pcb_PrimitiveLine: {
			create: async (...args) => {
				assert.ok([1, 2, 15, 16].includes(args[1]), 'Non-copper paths must not call the routed line API');
				calls.lines.push(args);
				return primitive(`line-${calls.lines.length}`);
			},
			delete: async ids => { calls.deletedLines.push(...(Array.isArray(ids) ? ids : [ids])); return true; },
		},
		pcb_PrimitivePolyline: {
			create: async (...args) => {
				count += 1;
				if (count === options.failPathAt)
					return undefined;
				calls.paths.push(args);
				return { ...primitive(`path-${count}`), convertToFill: async () => { throw new Error('Fill conversion unavailable'); } };
			},
			delete: async ids => { calls.deletedPaths.push(...(Array.isArray(ids) ? ids : [ids])); return true; },
		},
		pcb_PrimitiveFill: { create: async () => { throw new Error('Fill unavailable'); }, delete: async () => true },
	};
	Object.defineProperty(globalThis, 'eda', { configurable: true, value: eda });
	try { await run(calls); }
	finally {
		if (previous)
			Object.defineProperty(globalThis, 'eda', previous);
		else
			Reflect.deleteProperty(globalThis, 'eda');
	}
}

function plan(layerId, primitives) {
	return { layers: [{ fileName: 'synthetic.gbr', layerId, result: { primitives, warnings: [] } }], drills: [], warnings: [] };
}

const line = { kind: 'stroke', start: { x: 10, y: -20 }, end: { x: 11, y: -20 }, width: 0.12 };

test('silkscreen semicircles use open graphic paths, preserving endpoints and width', async () => {
	const gerber = '%FSLAX46Y46*%%MOMM*%%ADD10C,0.12*%D10*X11200000Y-20000000D02*G75*G02*X8800000Y-20000000I-1200000J0D01*G02*X11200000Y-20000000I1200000J0D01*M02*';
	const parsed = parseGerber(gerber);
	assert.equal(parsed.primitives.length, 2);
	for (const layerId of [3, 4]) {
		await withEda(async calls => {
			const result = await writePlan(plan(layerId, parsed.primitives));
			assert.equal(calls.lines.length, 0);
			assert.equal(calls.paths.length, 2);
			assert.equal(result.linearizedArcs, 2);
			assert.equal(result.lines, 36);
			for (let i = 0; i < 2; i++) {
				const args = calls.paths[i];
				const source = args[2].source;
				assert.equal(args[1], layerId);
				assert.equal(args[3], 0.12 / 0.0254);
				assert.equal(source[2], 'L');
				assert.equal(source.length, 39);
				const arc = parsed.primitives[i];
				assert.deepEqual(source.slice(0, 2), [arc.start.x / 0.0254, arc.start.y / 0.0254]);
				assert.deepEqual(source.slice(-2), [arc.end.x / 0.0254, arc.end.y / 0.0254]);
				assert.notDeepEqual(source.slice(0, 2), source.slice(-2), 'Do not add a diameter to the semicircle');
			}
		});
	}
});

test('non-copper straight artwork uses polylines while copper tracks retain the line API', async () => {
	for (const layerId of [1, 2, 15, 16, 3, 4, 5, 6, 7, 8, 14]) {
		await withEda(async calls => {
			const result = await writePlan(plan(layerId, [line]));
			assert.equal(result.lines, 1);
			const copper = [1, 2, 15, 16].includes(layerId);
			assert.equal(calls.lines.length, copper ? 1 : 0);
			assert.equal(calls.paths.length, copper ? 0 : 1);
			if (!copper)
				assert.deepEqual(calls.paths[0][2].source, [10 / 0.0254, -20 / 0.0254, 'L', 11 / 0.0254, -20 / 0.0254]);
		});
	}
});

test('a later graphic creation failure rolls back all previously created graphic paths', async () => {
	await withEda(async calls => {
		await assert.rejects(writePlan(plan(4, [line, line])), /第 2 个 stroke.*非铜层图形折线/);
		assert.deepEqual(calls.deletedPaths, ['path-1']);
	}, { failPathAt: 2 });
});

test('non-copper hatch fallback also avoids the routed line API', async () => {
	await withEda(async calls => {
		const region = { kind: 'region', points: [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 0.1 }, { x: 0, y: 0.1 }] };
		const result = await writePlan(plan(5, [region]));
		assert.equal(result.hatchFallbackPrimitives, 1);
		assert.ok(result.hatchFallbackLines > 0);
		assert.equal(calls.lines.length, 0);
		assert.equal(calls.paths.length, result.hatchFallbackLines + 1);
		assert.deepEqual(calls.deletedPaths, ['path-1']);
	});
});
