import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { ImportProgress } from '../src/progress.ts';

// Execute the actual shipped iframe script, including its timer and RPC handling.
async function progressWindow(initialElapsedMs = 0) {
	const html = readFileSync(new URL('../iframe/progress.html', import.meta.url), 'utf8');
	const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
	let now = 0;
	let timer: () => void = () => {};
	let poll: () => Promise<void> = async () => {};
	let state = { percent: 10, detail: '开始', revision: 1, elapsedMs: initialElapsedMs };
	const elements: Record<string, { textContent?: string; value?: number }> = {};
	vm.runInNewContext(script, {
		performance: { now: () => now },
		document: { getElementById: (id: string) => elements[id] ??= {} },
		eda: { sys_MessageBus: { rpcCall: async (topic: string) => {
			if (topic === 'gerber-import-progress-discover-v2')
				return 'gerber-import-progress-snapshot-test';
			assert.equal(topic, 'gerber-import-progress-snapshot-test');
			return state;
		} } },
		setTimeout: (callback: typeof poll) => { poll = callback; },
		setInterval: (callback: typeof timer) => { timer = callback; return 1; },
		clearInterval: () => {},
		window: { addEventListener: () => {} },
	});
	await new Promise(resolve => setImmediate(resolve));
	return {
		elements,
		at(time: number) { now = time; timer(); },
		async receive(next: typeof state) { state = next; await poll(); timer(); },
	};
}

test('delayed snapshots cannot rewind elapsed time or repeatedly discard local elapsed intervals', async () => {
	const window = await progressWindow();
	window.at(5000);
	assert.equal(window.elements.elapsed.textContent, '已用时 0 分 5 秒');
	await window.receive({ percent: 20, detail: '迟到的状态', revision: 2, elapsedMs: 1000 });
	assert.equal(window.elements.elapsed.textContent, '已用时 0 分 5 秒');
	window.at(6000);
	await window.receive({ percent: 30, detail: '下一状态', revision: 3, elapsedMs: 2000 });
	assert.equal(window.elements.elapsed.textContent, '已用时 0 分 6 秒');
	window.at(7000);
	assert.equal(window.elements.elapsed.textContent, '已用时 0 分 7 秒');
	await window.receive({ percent: 5, detail: '旧状态', revision: 1, elapsedMs: 0 });
	assert.equal(window.elements.elapsed.textContent, '已用时 0 分 7 秒');
	assert.equal(window.elements.percent.textContent, '30%');
	assert.equal(window.elements.detail.textContent, '下一状态');
});

test('reopened window starts from active elapsed time and repeated snapshots do not reset its clock', async () => {
	const window = await progressWindow(2000);
	window.at(0);
	assert.equal(window.elements.elapsed.textContent, '已用时 0 分 2 秒');
	window.at(3000);
	await window.receive({ percent: 10, detail: '开始', revision: 1, elapsedMs: 2000 });
	assert.equal(window.elements.elapsed.textContent, '已用时 0 分 5 秒');
	window.at(4000);
	assert.equal(window.elements.elapsed.textContent, '已用时 0 分 6 秒');
});

test('package-path window connects to the active import across preview pause and consecutive imports', async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'eda');
	const services = new Map<string, () => unknown>();
	const requests: string[] = [];
	const messages: string[] = [];
	const windows: Array<{
		elements: Record<string, { textContent?: string; value?: number }>;
		poll: () => Promise<void>;
		tick: () => void;
		hide: () => void;
	}> = [];
	let now = 1000;
	const bus = {
		rpcService(topic: string, callback: () => unknown) {
			assert.ok(!services.has(topic), 'service must not be registered twice');
			services.set(topic, callback);
		},
		async rpcCall(topic: string) {
			requests.push(topic);
			assert.ok(services.has(topic));
			return services.get(topic)!();
		},
	};
	Object.defineProperty(globalThis, 'eda', { configurable: true, value: {
		sys_MessageBus: bus,
		sys_Message: { showToastMessage: (message: string) => messages.push(message) },
		sys_IFrame: {
			async openIFrame(path: string) {
				// Simulate exact package-entry lookup, so URL query strings cannot pass.
				assert.equal(path, '/iframe/progress.html');
				const html = readFileSync(new URL(`..${path}`, import.meta.url), 'utf8');
				const window = { elements: {} as Record<string, { textContent?: string; value?: number }>, poll: async () => {}, tick: () => {}, hide: () => {} };
				windows.push(window);
				vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
					performance: { now: () => now },
					document: { getElementById: (id: string) => window.elements[id] ??= {} },
					eda: { sys_MessageBus: bus },
					setTimeout: (callback: () => Promise<void>) => { window.poll = callback; },
					setInterval: (callback: () => void) => { window.tick = callback; return 1; },
					clearInterval: () => {},
					window: { addEventListener: (_event: string, callback: () => void) => { window.hide = callback; } },
				});
				return true;
			},
			async closeIFrame() { windows.at(-1)?.hide(); return true; },
		},
	} });
	try {
		const first = new ImportProgress(() => now);
		await first.update(5, '解析文件', true);
		assert.equal(windows[0].elements.percent.textContent, '5%');
		now = 2000;
		await first.update(35, '处理顶层', true);
		await windows[0].poll();
		assert.equal(windows[0].elements.percent.textContent, '35%');
		const firstTopic = requests.at(-1);
		now = 3000;
		await first.close();
		now = 13000;
		await first.update(40, '确认后继续', true);
		windows[1].tick();
		assert.equal(windows[1].elements.elapsed.textContent, '已用时 0 分 2 秒');
		assert.equal(windows[1].elements.percent.textContent, '40%');
		assert.equal(requests.at(-1), firstTopic);
		await first.close();
		const second = new ImportProgress(() => now);
		await second.update(1, '新任务', true);
		assert.equal(windows[2].elements.percent.textContent, '1%');
		assert.notEqual(requests.at(-1), firstTopic);
		const requestCount = requests.length;
		await windows[0].poll();
		assert.equal(requests.length, requestCount, 'closed window must stop polling');
		assert.deepEqual(messages, []);
		await second.close();
	}
	finally {
		if (previous)
			Object.defineProperty(globalThis, 'eda', previous);
		else
			Reflect.deleteProperty(globalThis, 'eda');
	}
});
