import type { Point, Stroke } from '../src/model.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { closedStrokeContours, connectedStrokeComponents } from '../src/geometry.ts';

function line(start: Point, end: Point): Stroke {
	return { kind: 'stroke', start, end, width: 0.1 };
}

function square(x = 0): Stroke[] {
	return [
		line({ x, y: 0 }, { x: x + 10, y: 0 }),
		line({ x: x + 10, y: 10 }, { x, y: 10 }),
		line({ x, y: 0 }, { x, y: 10 }),
		line({ x: x + 10, y: 0 }, { x: x + 10, y: 10 }),
	];
}

test('joins shuffled and reversed board strokes, including reversed arcs', () => {
	const strokes = square();
	strokes[1] = { ...strokes[1], start: { x: 0, y: 10 }, end: { x: 10, y: 10 }, arcCenter: { x: 5, y: 10 }, arcAngle: -180 };
	const [loop] = closedStrokeContours(strokes);
	assert.deepEqual(loop[0], loop.at(-1));
	assert.ok(loop.some(p => p.y > 14.9));
	assert.equal(loop.length, 22);
	assert.deepEqual(strokes[1].start, { x: 0, y: 10 });
});

test('keeps independent contours separate and snaps only within tolerance', () => {
	const outer = square();
	outer[3].start = { x: 10.0001, y: 0 };
	const inner = square(30);
	const loops = closedStrokeContours([outer[0], inner[0], ...outer.slice(1), ...inner.slice(1)]);
	assert.equal(loops.length, 2);
	for (const loop of loops)
		assert.deepEqual(loop[0], loop.at(-1));
});

test('does not silently discard an open outline beside a valid contour', () => {
	assert.throws(() => closedStrokeContours([...square(), line({ x: 30, y: 0 }, { x: 31, y: 0 })]), /缺口/);
	const broken = square();
	broken[3].start = { x: 10.01, y: 0 };
	assert.throws(() => closedStrokeContours(broken), /缺口/);
});

test('separates a closed board outline from disconnected open mechanical paths', () => {
	const openPath = [
		line({ x: 3, y: 3 }, { x: 4, y: 3 }),
		line({ x: 4, y: 3 }, { x: 4, y: 4 }),
	];
	const components = connectedStrokeComponents([...square(), ...openPath]);
	assert.equal(components.length, 2);
	assert.equal(closedStrokeContours(components[0]).length, 1);
	assert.throws(() => closedStrokeContours(components[1]), /缺口/);
});

test('rejects ambiguous outline branches', () => {
	assert.throws(() => closedStrokeContours([...square(), line({ x: 10, y: 0 }, { x: 12, y: 0 })]), /分叉/);
});

test('ignores zero-length D01 strokes before and within a closed outline', () => {
	const edges = square();
	const expected = closedStrokeContours(edges);
	const dot = line({ x: 0, y: 0 }, { x: 0, y: 0 });
	assert.deepEqual(closedStrokeContours([dot, edges[0], dot, ...edges.slice(1)]), expected);
	assert.deepEqual(closedStrokeContours([dot]), []);
});

test('preserves a full circle whose arc endpoints coincide', () => {
	const circle: Stroke = {
		kind: 'stroke', start: { x: 1, y: 0 }, end: { x: 1, y: 0 },
		arcCenter: { x: 0, y: 0 }, arcAngle: 360, width: 0.1,
	};
	const [loop] = closedStrokeContours([circle]);
	assert.equal(loop.length, 37);
	assert.deepEqual(loop[0], loop.at(-1));
	assert.ok(loop.some(point => point.x < -0.99));
});
