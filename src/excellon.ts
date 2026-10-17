import type { DrillParseResult } from './model.js';

function parseCoordinate(raw: string, metric: boolean): number {
	if (raw.includes('.'))
		return Number(raw) * (metric ? 1 : 25.4);
	const divisor = metric ? 1000 : 10000;
	return Number(raw) / divisor * (metric ? 1 : 25.4);
}

function coordinatePoint(raw: string, current: { x: number; y: number }, metric: boolean): { x: number; y: number } | undefined {
	const xMatch = /X([+-]?\d*\.?\d+)/.exec(raw);
	const yMatch = /Y([+-]?\d*\.?\d+)/.exec(raw);
	if (!xMatch && !yMatch)
		return undefined;
	return {
		x: xMatch ? parseCoordinate(xMatch[1], metric) : current.x,
		y: yMatch ? parseCoordinate(yMatch[1], metric) : current.y,
	};
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
	let motion: 'drill' | 'rapid' | 'linear' = 'drill';
	let routing = false;
	let routeStart: { x: number; y: number } | undefined;
	const plated = /TF\.FileFunction,NonPlated/i.test(source)
		? false
		: /TF\.FileFunction,Plated/i.test(source) ? true : undefined;
	const addHit = (position: { x: number; y: number }, slotEnd?: { x: number; y: number }): void => {
		const tool = currentTool === undefined ? undefined : tools.get(currentTool);
		if (!tool) {
			warnings.push(`钻孔坐标引用了未定义刀具 T${currentTool ?? '?'}，已跳过。`);
			return;
		}
		if (!slotEnd) {
			hits.push({
				position,
				diameter: tool.diameter,
				plated,
				...(tool.drillFunction ? { drillFunction: tool.drillFunction } : {}),
			});
			return;
		}
		const travel = Math.hypot(slotEnd.x - position.x, slotEnd.y - position.y);
		if (travel < 1e-9) {
			addHit(position);
			return;
		}
		hits.push({
			position: { x: (position.x + slotEnd.x) / 2, y: (position.y + slotEnd.y) / 2 },
			diameter: tool.diameter,
			slot: {
				length: Math.round((travel + tool.diameter) * 1e9) / 1e9,
				rotation: Math.atan2(slotEnd.y - position.y, slotEnd.x - position.x) * 180 / Math.PI,
			},
			plated,
			...(tool.drillFunction ? { drillFunction: tool.drillFunction } : {}),
		});
	};

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
		if (line.includes('G85')) {
			const [before, after = ''] = line.split('G85', 2);
			const start = coordinatePoint(before, { x, y }, metric) ?? { x, y };
			const end = coordinatePoint(after, start, metric);
			if (!end) {
				warnings.push('检测到缺少终点坐标的 Excellon G85 槽孔，已跳过。');
				continue;
			}
			addHit(start, end);
			x = end.x;
			y = end.y;
			continue;
		}
		if (/^G0?5(?:$|\D)/.test(line))
			motion = 'drill';
		else if (/^G0?0(?:$|[XY])/.test(line))
			motion = 'rapid';
		else if (/^G0?1(?:$|[XY])/.test(line))
			motion = 'linear';
		if (/^M15(?:$|\D)/.test(line)) {
			routing = true;
			routeStart = { x, y };
			continue;
		}
		if (/^M16(?:$|\D)/.test(line)) {
			routing = false;
			routeStart = undefined;
			continue;
		}
		if (routing && /^G0?[23](?:$|[XY])/.test(line)) {
			warnings.push('检测到带圆弧的 Excellon 路由槽（G02/G03），当前仅支持直槽，已跳过该段。');
			continue;
		}
		const previous = { x, y };
		const point = coordinatePoint(line, previous, metric);
		if (!point)
			continue;
		x = point.x;
		y = point.y;
		if (motion === 'rapid') {
			routeStart = point;
			continue;
		}
		if (motion === 'linear' && routing) {
			addHit(routeStart ?? previous, point);
			routeStart = point;
			continue;
		}
		if (motion === 'drill')
			addHit(point);
	}
	return { hits, plated, warnings: [...new Set(warnings)] };
}
