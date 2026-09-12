export type ReportProgress = (completed: number, total: number, detail: string, force?: boolean) => Promise<void>;

const WINDOW_ID = 'gerber-import-progress';
const SNAPSHOT_TOPIC = 'gerber-import-progress-snapshot';
let snapshot = { percent: 0, detail: '准备导入', startedAt: 0, updatedAt: 0 };
let serviceRegistered = false;

/** Throttle bridge calls, and yield so the host can paint before expensive work. */
export class ImportProgress {
	private lastUpdate = 0;
	private windowAttempted = false;
	private startedAt = Date.now();

	async update(percent: number, detail: string, force = false): Promise<void> {
		if (!force && Date.now() - this.lastUpdate < 150)
			return;
		this.lastUpdate = Date.now();
		snapshot = { percent: Math.max(0, Math.min(99, percent)), detail, startedAt: this.startedAt, updatedAt: Date.now() };
		if (!this.windowAttempted) {
			this.windowAttempted = true;
			try {
				if (!serviceRegistered) {
					eda.sys_MessageBus.rpcService(SNAPSHOT_TOPIC, () => snapshot);
					serviceRegistered = true;
				}
				const opened = await eda.sys_IFrame.openIFrame('/iframe/progress.html', 560, 340, WINDOW_ID, {
					title: 'Gerber 转 PCB · 导入进度',
					minimizeButton: true,
					grayscaleMask: false,
				});
				if (!opened)
					throw new Error('进度窗口未打开');
			}
			catch {
				try {
					eda.sys_Message.showToastMessage('独立进度窗口未能打开，导入仍在继续，结束后会显示结果。');
				}
				catch {}
			}
		}
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}

	async close(): Promise<void> {
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
