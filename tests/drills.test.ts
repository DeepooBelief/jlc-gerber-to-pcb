import assert from 'node:assert/strict';
import test from 'node:test';
import { createDrilledPad, createNonPlatedHole } from '../src/drills.ts';

test('NPTH preserves hole coordinates and diameter but closes automatic masks on both sides', async () => {
	const calls: unknown[][] = [];
	const mocks = {
		eda: { pcb_PrimitivePad: { create: async (...args: unknown[]) => { calls.push(args); return undefined; } } },
		EPCB_PrimitivePadShapeType: { ELLIPSE: 'ELLIPSE', OBLONG: 'OBLONG' },
		EPCB_PrimitivePadHoleType: { ROUND: 'ROUND', SLOT: 'SLOT' },
		EPCB_PrimitivePadType: { NORMAL: 0 },
	};
	const previous = new Map(Object.keys(mocks).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(mocks))
		Object.defineProperty(globalThis, key, { configurable: true, value });
	try {
		for (const diameter of [0.6, 1.2]) {
			await createNonPlatedHole({ position: { x: 139.46, y: -84.62 }, diameter, plated: false });
			const args = calls.at(-1)!;
			assert.equal(args[0], 12);
			assert.equal(args[2], 139.46 / 0.0254);
			assert.equal(args[3], -84.62 / 0.0254);
			assert.deepEqual(args[7], ['ROUND', diameter / 0.0254]);
			assert.equal(args[11], false);
			assert.deepEqual(args[14], { topSolderMask: -diameter / 0.0254 / 2, bottomSolderMask: -diameter / 0.0254 / 2 });
		}
		await createNonPlatedHole({
			position: { x: 10, y: 20 },
			diameter: 0.4,
			slot: { length: 1.4, rotation: -90 },
			plated: false,
		});
		const slotArgs = calls.at(-1)!;
		assert.equal(slotArgs[4], -90);
		assert.deepEqual(slotArgs[5], ['OBLONG', 1.4 / 0.0254, 0.4 / 0.0254]);
		assert.deepEqual(slotArgs[7], ['SLOT', 0.4 / 0.0254, 1.4 / 0.0254]);
		assert.equal(slotArgs[10], 0);
		assert.equal(slotArgs[11], false);
		assert.deepEqual(slotArgs[14], {
			topSolderMask: -1.4 / 0.0254 / 2,
			bottomSolderMask: -1.4 / 0.0254 / 2,
		});
	}
	finally {
		for (const [key, descriptor] of previous) {
			if (descriptor)
				Object.defineProperty(globalThis, key, descriptor);
			else
				Reflect.deleteProperty(globalThis, key);
		}
	}
});

test('PTH and NPTH API parameters preserve absolute slot endpoints independently of pad rotation', async () => {
	const calls: unknown[][] = [];
	const mocks = {
		eda: { pcb_PrimitivePad: { create: async (...args: unknown[]) => { calls.push(args); return undefined; } } },
		EPCB_PrimitivePadHoleType: { ROUND: 'ROUND', SLOT: 'SLOT' },
		EPCB_PrimitivePadType: { NORMAL: 0 },
	};
	const previous = new Map(Object.keys(mocks).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(mocks))
		Object.defineProperty(globalThis, key, { configurable: true, value });
	try {
		const cases = [
			{ pad: 45, slot: 90, relative: 45 },
			{ pad: 90, slot: 0, relative: -90 },
			{ pad: -90, slot: -90, relative: 0 },
			{ pad: 0, slot: 45, relative: 45 },
			{ pad: 270, slot: -90, relative: 0 },
			{ pad: 405, slot: 45, relative: 0 },
			{ pad: -135, slot: 45, relative: -180 },
		];
		for (const metallization of [true, false]) {
			for (const entry of cases) {
				const hit = { position: { x: 10, y: -20 }, diameter: 0.4, slot: { length: 1.4, rotation: entry.slot } };
				await createDrilledPad(hit, entry.pad, ['ELLIPSE', 80, 80] as TPCB_PrimitivePadShape, metallization, {});
				const args = calls.at(-1)!;
				assert.equal(args[4], entry.pad);
				assert.equal(args[10], entry.relative);
				assert.equal(args[11], metallization);
				assert.deepEqual(args[7], ['SLOT', 0.4 / 0.0254, 1.4 / 0.0254]);
				const actualAngle = (Number(args[4]) + Number(args[10])) * Math.PI / 180;
				const expectedAngle = entry.slot * Math.PI / 180;
				// Reconstruct both end-circle centers from the host API's relative rotation.
				for (const direction of [-1, 1]) {
					const halfTravel = direction * (hit.slot.length - hit.diameter) / 2;
					assert.ok(Math.abs(Number(args[2]) * 0.0254 + halfTravel * Math.cos(actualAngle)
						- (hit.position.x + halfTravel * Math.cos(expectedAngle))) < 1e-9);
					assert.ok(Math.abs(Number(args[3]) * 0.0254 + halfTravel * Math.sin(actualAngle)
						- (hit.position.y + halfTravel * Math.sin(expectedAngle))) < 1e-9);
				}
			}
		}
		await createDrilledPad({ position: { x: 1, y: 2 }, diameter: 0.8 }, 45, ['ELLIPSE', 80, 80] as TPCB_PrimitivePadShape, true, {});
		assert.deepEqual(calls.at(-1)![7], ['ROUND', 0.8 / 0.0254]);
		assert.equal(calls.at(-1)![10], 0);
	}
	finally {
		for (const [key, descriptor] of previous) {
			if (descriptor)
				Object.defineProperty(globalThis, key, descriptor);
			else
				Reflect.deleteProperty(globalThis, key);
		}
	}
});
