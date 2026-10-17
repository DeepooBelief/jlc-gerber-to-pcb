export type ReportProgress = (completed: number, total: number, detail: string, force?: boolean) => Promise<void>;

const WINDOW_ID = 'gerber-import-progress';
const DISCOVERY_TOPIC = 'gerber-import-progress-discover-v2';
const TOPIC_INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let nextSession = 0;
let activeTopic: string | undefined;
const discoveryBuses = new WeakSet<object>();

interface ProgressSnapshot {
	percent: number;
	detail: string;
	elapsedMs: number;
	updatedAt: number;
	revision: number;
}

function monotonicNow(): number {
	return globalThis.performance?.now() ?? Date.now();
}

/** Throttle bridge calls, and yield so the host can paint before expensive work. */
export class ImportProgress {
	private lastUpdate = 0;
	private lastPercent = 0;
	private windowAttempted = false;
	private elapsedMs = 0;
	private resumedAt: number | undefined;
	private readonly now: () => number;
	private readonly topic = `gerber-import-progress-snapshot-${TOPIC_INSTANCE}-${++nextSession}`;
	private serviceRegistered = false;
	private snapshot: ProgressSnapshot = { percent: 0, detail: '准备导入', elapsedMs: 0, updatedAt: 0, revision: 0 };

	constructor(now: () => number = monotonicNow) {
		this.now = now;
	}

	async update(percent: number, detail: string, force = false): Promise<void> {
		const now = this.now();
		if (!force && now - this.lastUpdate < 150)
			return;
		this.lastUpdate = now;
		if (this.resumedAt === undefined)
			this.resumedAt = now;
		this.lastPercent = Math.max(this.lastPercent, Math.max(0, Math.min(99, percent)));
		this.snapshot = {
			percent: this.lastPercent,
			detail,
			elapsedMs: this.elapsedMs + Math.max(0, now - this.resumedAt),
			updatedAt: now,
			revision: this.snapshot.revision + 1,
		};
		if (!this.windowAttempted) {
			this.windowAttempted = true;
			try {
				const bus = eda.sys_MessageBus;
				if (!discoveryBuses.has(bus)) {
					bus.rpcService(DISCOVERY_TOPIC, () => activeTopic);
					discoveryBuses.add(bus);
				}
				if (!this.serviceRegistered) {
					bus.rpcService(this.topic, () => this.snapshot);
					this.serviceRegistered = true;
				}
				activeTopic = this.topic;
				// openIFrame resolves a package entry, not a URL with query parameters.
				const opened = await eda.sys_IFrame.openIFrame('/iframe/progress.html', 560, 340, WINDOW_ID, {
					title: 'Gerber 转 PCB · 导入进度',
					minimizeButton: true,
					grayscaleMask: false,
				});
				if (!opened)
					throw new Error('进度窗口未打开');
			}
			catch (error) {
				try {
					const reason = error instanceof Error ? error.message : String(error);
					eda.sys_Message.showToastMessage(`独立进度窗口未能打开，导入仍在继续，结束后会显示结果。原因：${reason}`);
				}
				catch {}
			}
		}
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}

	async close(): Promise<void> {
		if (activeTopic === this.topic)
			activeTopic = undefined;
		const now = this.now();
		if (this.resumedAt !== undefined) {
			this.elapsedMs += Math.max(0, now - this.resumedAt);
			this.resumedAt = undefined;
			this.snapshot = {
				...this.snapshot,
				elapsedMs: this.elapsedMs,
				updatedAt: now,
				revision: this.snapshot.revision + 1,
			};
		}
		if (this.windowAttempted) {
			try {
				await eda.sys_IFrame.closeIFrame(WINDOW_ID);
			}
			catch {}
		}
		this.windowAttempted = false;
		this.lastUpdate = 0;
	}
}
