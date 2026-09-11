import type { ImportPlan } from './model.js';
import JSZip from 'jszip';
import extensionConfig from '../extension.json' with { type: 'json' };
import { parseExcellon } from './excellon.js';
import { isSupportedManufacturingFile, MANUFACTURING_FILE_EXTENSIONS } from './files.js';
import { parseGerber } from './gerber.js';
import { guessLayer, isDrillFile, requiredCopperLayerCount } from './layers.js';
import { writePlan } from './writer.js';

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
			if (!isSupportedManufacturingFile(leafName))
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
		'重要：本操作只会追加图元，不会检查或清除当前 PCB 的已有内容。请只在空白 PCB 中导入，否则会产生重叠图形和重复钻孔。',
		'',
		'即将把以下内容写入当前 PCB（坐标按原文件保留）：',
		'',
		...layerLines,
		...drillLines,
		'',
		`目标铜层数：${requiredCopperLayerCount(plan)}；当前 PCB 层数不足时会在写入前自动扩展，不会自动减少已有叠层。`,
		...(warningLines.length ? ['', '注意：', ...warningLines] : []),
		...(hiddenWarnings ? [`• 另有 ${hiddenWarnings} 条警告`] : []),
		'',
		'Gerber 不含原理图、器件型号、封装归属或真实网络名；钻孔将按无网络通孔过孔重建。',
	].join('\n');
}

export async function importGerber(): Promise<void> {
	try {
		const selected = await eda.sys_FileSystem.openReadFileDialog(MANUFACTURING_FILE_EXTENSIONS, true);
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
		let revealedCopperLayers = false;
		try {
			const copperLayers = [...new Set(plan.layers.map(layer => layer.layerId)
				.filter(layerId => layerId === 1 || layerId === 2 || (layerId >= 15 && layerId <= 44)))];
			if (copperLayers.length) {
				revealedCopperLayers = await eda.pcb_Layer.setLayerVisible(copperLayers as TPCB_LayersInTheSelectable[]);
				await eda.pcb_Layer.setInactiveLayerDisplayMode(EPCB_InactiveLayerDisplayMode.NORMAL_BRIGHTNESS);
			}
		}
		catch {}
		eda.sys_Dialog.showInformationMessage([
			'导入完成。',
			'',
			`直线：${result.lines}`,
			`圆弧：${result.arcs}`,
			`焊盘：${result.pads}`,
			`填充：${result.fills}`,
			`区域填充：${result.regionFills}`,
			`Flash 填充：${result.flashFills}`,
			`PCB 铜层数：${result.copperLayerCountBefore} → ${result.copperLayerCountAfter}${result.copperLayerCountAfter > result.copperLayerCountBefore ? '（已自动扩展）' : ''}`,
			...(revealedCopperLayers ? ['已将全部导入铜层设为可见，并恢复非激活层正常显示。'] : []),
			...(result.boardOutlineContours ? [`闭合板框轮廓：${result.boardOutlineContours}`] : []),
			...(result.linearizedArcs ? [`为保证导出而折线化的非铜层圆弧：${result.linearizedArcs}`] : []),
			...(result.convertedFills ? [`其中闭合折线转换填充：${result.convertedFills}`] : []),
			...(result.hatchFallbackPrimitives ? [`绝对坐标扫描填充：${result.hatchFallbackPrimitives} 个图元 / ${result.hatchFallbackLines} 条线`] : []),
			...(result.skippedDerivedFlashes ? [`由通孔焊盘精确派生、未重复写入的阻焊 flash：${result.skippedDerivedFlashes}`] : []),
			...(result.skippedInnerCopperFlashes ? [`由过孔/多层焊盘自动派生、未重复写入的内层铜 flash：${result.skippedInnerCopperFlashes}`] : []),
			...(result.throughHolePads ? [`通孔焊盘：${result.throughHolePads}`] : []),
			...(result.tentedVias ? [`已关闭本体自动阻焊开窗的过孔：${result.tentedVias}`] : []),
			`过孔：${result.vias}`,
			...(result.simplifiedRegions ? [`安全简化区域：${result.simplifiedRegions}（最大容差 ${result.maximumSimplificationMicrometers.toFixed(3)} µm）`] : []),
			...(result.partitionedRegions ? [`无损拆分超限区域：${result.partitionedRegions} 个 Gerber 区域 → ${result.partitionedRegionParts} 个闭合子区域`] : []),
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
		'支持：RS-274X 常用 C/R/O/P 孔径、KiCad RoundRect/RotRect/单轮廓 FreePoly、直线、圆弧、区域，以及 Excellon 圆孔。',
		'',
		'限制：其它复合孔径宏、负片清除、步进重复、槽孔和网络/器件语义尚不能完整恢复。',
	].join('\n'), '关于 Gerber 转 PCB');
}
