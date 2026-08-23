import type { ImportPlan } from './model.js';
import JSZip from 'jszip';
import extensionConfig from '../extension.json' with { type: 'json' };
import { parseExcellon } from './excellon.js';
import { parseGerber } from './gerber.js';
import { guessLayer, isDrillFile } from './layers.js';
import { writePlan } from './writer.js';

const EXTENSIONS = [
	'.zip',
	'.gbr',
	'.ger',
	'.pho',
	'.art',
	'.gtl',
	'.gbl',
	'.gto',
	'.gbo',
	'.gts',
	'.gbs',
	'.gtp',
	'.gbp',
	'.gko',
	'.gm1',
	'.gml',
	'.g1',
	'.g2',
	'.g3',
	'.cmp',
	'.sol',
	'.plc',
	'.pls',
	'.stc',
	'.sts',
	'.drl',
	'.drd',
	'.xln',
	'.tap',
	'.exc',
	'.txt',
];

interface NamedText {
	name: string;
	text: string;
}

export function activate(_status?: 'onStartupFinished', _arg?: string): void {}

function confirmation(content: string): Promise<boolean> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showConfirmationMessage(content, 'Gerber 转 PCB', '写入当前 PCB', '取消', resolve);
	});
}

async function expandFiles(files: File[]): Promise<NamedText[]> {
	const expanded: NamedText[] = [];
	for (const file of files) {
		if (!file.name.toLowerCase().endsWith('.zip')) {
			expanded.push({ name: file.name, text: await file.text() });
			continue;
		}
		const zip = await JSZip.loadAsync(await file.arrayBuffer());
		for (const entry of Object.values(zip.files)) {
			if (entry.dir || entry.name.startsWith('__MACOSX/'))
				continue;
			const leafName = entry.name.split('/').at(-1) ?? entry.name;
			if (!EXTENSIONS.some(extension => leafName.toLowerCase().endsWith(extension)) || leafName.toLowerCase().endsWith('.zip'))
				continue;
			expanded.push({ name: leafName, text: await entry.async('text') });
		}
	}
	return expanded;
}

function looksLikeGerber(text: string): boolean {
	return /%FS[LT][AI]X\d\dY\d\d\*%/i.test(text) || /%ADD\d+[CROP]/i.test(text);
}

function looksLikeExcellon(text: string): boolean {
	return /M48/i.test(text) && /T\d+C[0-9.]+/i.test(text);
}

function createPlan(files: NamedText[]): ImportPlan {
	const plan: ImportPlan = { layers: [], drills: [], warnings: [] };
	for (const file of files) {
		if (isDrillFile(file.name) || looksLikeExcellon(file.text)) {
			const result = parseExcellon(file.text);
			plan.drills.push({ fileName: file.name, result });
			plan.warnings.push(...result.warnings.map(warning => `${file.name}: ${warning}`));
			continue;
		}
		if (!looksLikeGerber(file.text)) {
			plan.warnings.push(`${file.name}: 无法识别为 RS-274X Gerber 或 Excellon，已跳过。`);
			continue;
		}
		const result = parseGerber(file.text);
		const guess = guessLayer(file.name, result.fileFunction);
		plan.layers.push({ fileName: file.name, layerId: guess.layerId, result });
		plan.warnings.push(...result.warnings.map(warning => `${file.name}: ${warning}`));
		if (!guess.confident)
			plan.warnings.push(`${file.name}: 无法可靠判断图层，暂映射到机械层。`);
	}
	plan.warnings = [...new Set(plan.warnings)];
	return plan;
}

function preview(plan: ImportPlan): string {
	const layerLines = plan.layers.map((layer) => {
		const guess = guessLayer(layer.fileName, layer.result.fileFunction);
		const counts = layer.result.primitives.reduce((value, primitive) => {
			value[primitive.kind] += 1;
			return value;
		}, { stroke: 0, flash: 0, region: 0 });
		return `• ${layer.fileName} → ${guess.label}: 线/弧 ${counts.stroke}，闪光 ${counts.flash}，区域 ${counts.region}`;
	});
	const drillLines = plan.drills.map((drill) => {
		const kind = drill.result.plated === false ? '非金属化孔' : '通孔过孔';
		return `• ${drill.fileName} → ${kind}: ${drill.result.hits.length}`;
	});
	const warningLines = plan.warnings.slice(0, 8).map(warning => `• ${warning}`);
	const hiddenWarnings = Math.max(0, plan.warnings.length - warningLines.length);
	return [
		'即将把以下内容写入当前 PCB（坐标按原文件保留）：',
		'',
		...layerLines,
		...drillLines,
		...(warningLines.length ? ['', '注意：', ...warningLines] : []),
		...(hiddenWarnings ? [`• 另有 ${hiddenWarnings} 条警告`] : []),
		'',
		'Gerber 不含原理图、器件型号、封装归属或真实网络名；钻孔将按无网络通孔过孔重建。',
	].join('\n');
}

export async function importGerber(): Promise<void> {
	try {
		const selected = await eda.sys_FileSystem.openReadFileDialog(EXTENSIONS, true);
		if (!selected?.length)
			return;
		const files = await expandFiles(selected);
		const plan = createPlan(files);
		if (!plan.layers.length && !plan.drills.some(drill => drill.result.hits.length)) {
			eda.sys_Dialog.showInformationMessage(`没有发现可导入的图形。\n\n${plan.warnings.join('\n')}`, 'Gerber 转 PCB');
			return;
		}
		if (!await confirmation(preview(plan)))
			return;
		eda.sys_Message.showToastMessage('正在重建 PCB 图元，请稍候…');
		const result = await writePlan(plan);
		eda.sys_Dialog.showInformationMessage([
			'导入完成。',
			'',
			`直线：${result.lines}`,
			`圆弧：${result.arcs}`,
			`焊盘：${result.pads}`,
			`填充：${result.fills}`,
			`区域填充：${result.regionFills}`,
			`Flash 填充：${result.flashFills}`,
			...(result.boardOutlineContours ? [`闭合板框轮廓：${result.boardOutlineContours}`] : []),
			...(result.linearizedArcs ? [`为保证导出而折线化的非铜层圆弧：${result.linearizedArcs}`] : []),
			...(result.convertedFills ? [`其中闭合折线转换填充：${result.convertedFills}`] : []),
			...(result.hatchFallbackPrimitives ? [`绝对坐标扫描填充：${result.hatchFallbackPrimitives} 个图元 / ${result.hatchFallbackLines} 条线`] : []),
			...(result.skippedDerivedFlashes ? [`由原生焊盘自动派生、未重复写入的阻焊/锡膏 flash：${result.skippedDerivedFlashes}`] : []),
			...(result.skippedInnerCopperFlashes ? [`由过孔/多层焊盘自动派生、未重复写入的内层铜 flash：${result.skippedInnerCopperFlashes}`] : []),
			...(result.throughHolePads ? [`通孔焊盘：${result.throughHolePads}`] : []),
			...(result.tentedVias ? [`盖油过孔：${result.tentedVias}`] : []),
			`过孔：${result.vias}`,
			...(result.simplifiedRegions ? [`安全简化区域：${result.simplifiedRegions}（最大容差 ${result.maximumSimplificationMicrometers.toFixed(3)} µm）`] : []),
			...(result.boardOutlineContours ? ['', '请使用“一键导出”确认 EDA 已将闭合 Polyline 识别为板框；公开扩展 API 暂无原生 BoardOutline 创建接口。'] : []),
			'',
			'请务必执行 DRC，并与原 Gerber 叠图核对后再用于生产。',
		].join('\n'), 'Gerber 转 PCB');
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		eda.sys_Dialog.showInformationMessage(`导入失败；本次已创建的图元已尝试回滚。\n\n${message}`, 'Gerber 转 PCB');
	}
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage([
		`Gerber 转 PCB v${extensionConfig.version}`,
		'',
		'支持：RS-274X 常用 C/R/O/P 孔径、KiCad RoundRect、直线、圆弧、区域，以及 Excellon 圆孔。',
		'',
		'限制：其它孔径宏、负片清除、步进重复、槽孔和网络/器件语义尚不能完整恢复。',
	].join('\n'), '关于 Gerber 转 PCB');
}
