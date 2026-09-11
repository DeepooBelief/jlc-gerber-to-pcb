import type { ImportPlan } from './model.js';

const LAYER = {
	top: 1,
	bottom: 2,
	topSilk: 3,
	bottomSilk: 4,
	topMask: 5,
	bottomMask: 6,
	topPaste: 7,
	bottomPaste: 8,
	outline: 11,
	mechanical: 14,
	inner1: 15,
} as const;

export interface LayerGuess {
	layerId: number;
	label: string;
	confident: boolean;
}

function fromFileFunction(fileFunction?: string): LayerGuess | undefined {
	if (!fileFunction)
		return undefined;
	const value = fileFunction.toLowerCase();
	const copper = /^copper,l(\d+),(top|bot|inr)/i.exec(fileFunction);
	if (copper?.[2].toLowerCase() === 'top')
		return { layerId: LAYER.top, label: '顶层铜', confident: true };
	if (copper?.[2].toLowerCase() === 'bot')
		return { layerId: LAYER.bottom, label: '底层铜', confident: true };
	if (copper?.[2].toLowerCase() === 'inr') {
		const physicalLayer = Number(copper[1]);
		return { layerId: LAYER.inner1 + Math.max(0, physicalLayer - 2), label: `内层 ${Math.max(1, physicalLayer - 1)}`, confident: true };
	}
	if (value.includes('legend,top'))
		return { layerId: LAYER.topSilk, label: '顶层丝印', confident: true };
	if (value.includes('legend,bot'))
		return { layerId: LAYER.bottomSilk, label: '底层丝印', confident: true };
	if (value.includes('soldermask,top'))
		return { layerId: LAYER.topMask, label: '顶层阻焊', confident: true };
	if (value.includes('soldermask,bot'))
		return { layerId: LAYER.bottomMask, label: '底层阻焊', confident: true };
	if (value.includes('paste,top'))
		return { layerId: LAYER.topPaste, label: '顶层焊膏', confident: true };
	if (value.includes('paste,bot'))
		return { layerId: LAYER.bottomPaste, label: '底层焊膏', confident: true };
	if (value.includes('profile'))
		return { layerId: LAYER.outline, label: '板框', confident: true };
	return undefined;
}

export function guessLayer(fileName: string, fileFunction?: string): LayerGuess {
	const attributed = fromFileFunction(fileFunction);
	if (attributed)
		return attributed;
	const name = fileName.toLowerCase();
	if (/\.(?:gtl|cmp|top)$/.test(name) || /(?:^|[._-])(?:f[._-]?cu|top[._-]?copper|cu[._-]?top)/.test(name))
		return { layerId: LAYER.top, label: '顶层铜', confident: true };
	if (/\.(?:gbl|sol|bot)$/.test(name) || /(?:^|[._-])(?:b[._-]?cu|bottom[._-]?copper|cu[._-]?bottom)/.test(name))
		return { layerId: LAYER.bottom, label: '底层铜', confident: true };
	if (/\.(?:gto|plc)$/.test(name) || /(?:^|[._-])f[._-]?(?:silk|legend)/.test(name))
		return { layerId: LAYER.topSilk, label: '顶层丝印', confident: true };
	if (/\.(?:gbo|pls)$/.test(name) || /(?:^|[._-])b[._-]?(?:silk|legend)/.test(name))
		return { layerId: LAYER.bottomSilk, label: '底层丝印', confident: true };
	if (/\.(?:gts|stc)$/.test(name) || /(?:^|[._-])f[._-]?mask/.test(name))
		return { layerId: LAYER.topMask, label: '顶层阻焊', confident: true };
	if (/\.(?:gbs|sts)$/.test(name) || /(?:^|[._-])b[._-]?mask/.test(name))
		return { layerId: LAYER.bottomMask, label: '底层阻焊', confident: true };
	if (/\.gtp$/.test(name) || /(?:^|[._-])f[._-]?paste/.test(name))
		return { layerId: LAYER.topPaste, label: '顶层焊膏', confident: true };
	if (/\.gbp$/.test(name) || /(?:^|[._-])b[._-]?paste/.test(name))
		return { layerId: LAYER.bottomPaste, label: '底层焊膏', confident: true };
	if (/\.(?:gko|gm1|gml|dim)$/.test(name) || /edge[._-]?cuts|board[._-]?outline|profile/.test(name))
		return { layerId: LAYER.outline, label: '板框', confident: true };
	const inner = /\.(?:g|gp)(\d{1,2})$/.exec(name) ?? /(?:cu[._-]?in|inner|in)(\d{1,2})/.exec(name);
	if (inner)
		return { layerId: LAYER.inner1 + Math.max(0, Number(inner[1]) - 1), label: `内层 ${inner[1]}`, confident: true };
	return { layerId: LAYER.mechanical, label: '机械层（自动猜测）', confident: false };
}

export function isDrillFile(fileName: string): boolean {
	return /\.(?:drl|drd|xln|tap|exc|txt)$/.test(fileName.toLowerCase()) || /drill|pth|npth/i.test(fileName);
}

export function requiredCopperLayerCount(plan: ImportPlan): TPCB_NumberOfCopperLayers {
	let required = 2;
	for (const layer of plan.layers) {
		const attributedLayer = /^copper,l(\d+),(?:top|bot|inr)/i.exec(layer.result.fileFunction ?? '');
		if (attributedLayer)
			required = Math.max(required, Number(attributedLayer[1]));
		if (layer.layerId >= LAYER.inner1 && layer.layerId <= 44)
			required = Math.max(required, layer.layerId - LAYER.inner1 + 3);
	}
	const supported = Math.min(32, Math.max(2, Math.ceil(required / 2) * 2));
	return supported as TPCB_NumberOfCopperLayers;
}

export function copperLayerCountFromLayers(layers: Array<{ id: number; type?: string; layerStatus?: number }>): number {
	return new Set(layers
		.filter(layer => layer.layerStatus !== 0)
		.filter(layer => layer.type === 'SIGNAL' || layer.type === 'PLANE')
		.map(layer => layer.id)
		.filter(layerId => layerId === LAYER.top || layerId === LAYER.bottom || (layerId >= LAYER.inner1 && layerId <= 44))).size;
}
