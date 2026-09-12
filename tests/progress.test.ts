import assert from 'node:assert/strict';
import test from 'node:test';
import { ImportProgress } from '../src/progress.ts';

test('dialog receives the latest snapshot after loading and closes before reopening', async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'eda');
	let readSnapshot: (() => { percent: number; detail: string }) | undefined;
	const events: string[] = [];
	let nativeAccesses = 0;
	Object.defineProperty(globalThis, 'eda', { configurable: true, value: {
		sys_MessageBus: { rpcService: (_topic: string, callback: typeof readSnapshot) => { readSnapshot = callback; } },
		sys_IFrame: {
			openIFrame: async (path: string) => { events.push(path); return true; },
			closeIFrame: async () => {
				await new Promise(resolve => setTimeout(resolve, 1));
				events.push('closed');
				return true;
			},
		},
		get sys_LoadingAndProgressBar() {
			nativeAccesses += 1;
			throw new Error('Native progress must not be used');
		},
	} });
	try {
		const progress = new ImportProgress();
		await progress.update(5, '解析文件', true);
		await progress.update(35, '顶层 · 无损拆分 3/8', true);
		assert.equal(readSnapshot?.().detail, '顶层 · 无损拆分 3/8');
		assert.equal(readSnapshot?.().percent, 35);
		await progress.update(40, '限流刷新');
		assert.equal(readSnapshot?.().percent, 35);
		await progress.update(100, '整理统计', true);
		assert.equal(readSnapshot?.().percent, 99);
		assert.equal(events.length, 1);
		await progress.close();
		await progress.update(40, '写入钻孔', true);
		assert.deepEqual(events, ['/iframe/progress.html', 'closed', '/iframe/progress.html']);
		await progress.close();
		assert.equal(nativeAccesses, 0);
	}
	finally {
		if (previous)
			Object.defineProperty(globalThis, 'eda', previous);
		else
			Reflect.deleteProperty(globalThis, 'eda');
	}
});

test('missing dialog API does not fall back to locking native progress', async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'eda');
	const updates: number[] = [];
	let closed = 0;
	Object.defineProperty(globalThis, 'eda', { configurable: true, value: {
		sys_LoadingAndProgressBar: {
			showProgressBar: (value: number) => updates.push(value),
			destroyProgressBar: () => { closed += 1; },
		},
	} });
	try {
		const progress = new ImportProgress();
		await progress.update(-5, '开始', true);
		await progress.update(20, '限流刷新');
		await progress.update(100, '整理统计', true);
		assert.deepEqual(updates, []);
		await progress.close();
		assert.equal(closed, 0);
		await progress.update(15, '确认后重新显示');
		assert.deepEqual(updates, []);
	}
	finally {
		if (previous)
			Object.defineProperty(globalThis, 'eda', previous);
		else
			Reflect.deleteProperty(globalThis, 'eda');
	}
});

test('unavailable progress API cannot interrupt the import', async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'eda');
	Object.defineProperty(globalThis, 'eda', { configurable: true, value: {
		sys_IFrame: {
			openIFrame: async () => { throw new Error('bridge unavailable'); },
			closeIFrame: async () => { throw new Error('bridge unavailable'); },
		},
		sys_LoadingAndProgressBar: {
			showProgressBar: () => { throw new Error('bridge unavailable'); },
			destroyProgressBar: () => { throw new Error('bridge unavailable'); },
		},
	} });
	try {
		const progress = new ImportProgress();
		await assert.doesNotReject(progress.update(50, '正在写入', true));
		await assert.doesNotReject(progress.close());
	}
	finally {
		if (previous)
			Object.defineProperty(globalThis, 'eda', previous);
		else
			Reflect.deleteProperty(globalThis, 'eda');
	}
});
