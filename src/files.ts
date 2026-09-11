const INNER_COPPER_EXTENSIONS = Array.from({ length: 30 }, (_, index) => [`.g${index + 1}`, `.gp${index + 1}`]).flat();

export const MANUFACTURING_FILE_EXTENSIONS = [
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
	...INNER_COPPER_EXTENSIONS,
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

export function isSupportedManufacturingFile(fileName: string): boolean {
	const lowerName = fileName.toLowerCase();
	return !lowerName.endsWith('.zip') && MANUFACTURING_FILE_EXTENSIONS.some(extension => lowerName.endsWith(extension));
}
