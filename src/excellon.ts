import type { DrillParseResult } from './model.js';

function parseCoordinate(raw: string, metric: boolean): number {
	if (raw.includes('.'))
		return Number(raw) * (metric ? 1 : 25.4);
	const divisor = metric ? 1000 : 10000;
	return Number(raw) / divisor * (metric ? 1 : 25.4);
}

export function parseExcellon(source: string): DrillParseResult {
	const hits: DrillParseResult['hits'] = [];
	const warnings: string[] = [];
	const tools = new Map<number, { diameter: number; drillFunction?: string }>();
	let metric = true;
	let currentTool: number | undefined;
	let pendingDrillFunction: string | undefined;
	let x = 0;
	let y = 0;
	const plated = /TF\.FileFunction,NonPlated/i.test(source)
		? false
		: /TF\.FileFunction,Plated/i.test(source) ? true : undefined;

	for (const rawLine of source.replaceAll('\r', '').split(/[\n*]+/)) {
		const line = rawLine.trim().toUpperCase();
		if (!line)
			continue;
		const toolFunction = /TA\.APERFUNCTION,[^\r\n]*,(VIADRILL|COMPONENTDRILL)(?:,|$)/i.exec(line);
		if (toolFunction) {
			pendingDrillFunction = toolFunction[1] === 'VIADRILL' ? 'ViaDrill' : 'ComponentDrill';
			continue;
		}
		if (line.startsWith(';'))
			continue;
		if (line.includes('METRIC') || line === 'M71') {
			metric = true;
			continue;
		}
		if (line.includes('INCH') || line === 'M72') {
			metric = false;
			continue;
		}
		const definition = /^T(\d+)C([0-9.]+)/.exec(line);
		if (definition) {
			tools.set(Number(definition[1]), {
				diameter: Number(definition[2]) * (metric ? 1 : 25.4),
				...(pendingDrillFunction ? { drillFunction: pendingDrillFunction } : {}),
			});
			pendingDrillFunction = undefined;
			continue;
		}
		const selection = /^T(\d+)$/.exec(line);
		if (selection) {
			currentTool = Number(selection[1]);
			continue;
		}
		if (/G85/.test(line)) {
			warnings.push('检测到 Excellon 槽孔（G85）；首版仅导入槽孔端点，需人工修正。');
		}
		const xMatch = /X([+-]?\d*\.?\d+)/.exec(line);
		const yMatch = /Y([+-]?\d*\.?\d+)/.exec(line);
		if (!xMatch && !yMatch)
			continue;
		if (xMatch)
			x = parseCoordinate(xMatch[1], metric);
		if (yMatch)
			y = parseCoordinate(yMatch[1], metric);
		const tool = currentTool === undefined ? undefined : tools.get(currentTool);
		if (!tool) {
			warnings.push(`钻孔坐标引用了未定义刀具 T${currentTool ?? '?'}，已跳过。`);
			continue;
		}
		hits.push({
			position: { x, y },
			diameter: tool.diameter,
			plated,
			...(tool.drillFunction ? { drillFunction: tool.drillFunction } : {}),
		});
	}
	return { hits, plated, warnings: [...new Set(warnings)] };
}
