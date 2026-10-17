import type { DrillHit } from './model.js';

/** Excellon angles are absolute; EasyEDA holeRotation is relative to the pad. */
export async function createDrilledPad(
	hit: DrillHit,
	padRotation: number,
	pad: TPCB_PrimitivePadShape,
	metallization: boolean,
	maskExpansion: IPCB_PrimitiveSolderMaskAndPasteMaskExpansion,
): Promise<IPCB_PrimitivePad | undefined> {
	const diameter = hit.diameter / 0.0254;
	const hole: TPCB_PrimitivePadHole = hit.slot
		? [EPCB_PrimitivePadHoleType.SLOT, diameter, hit.slot.length / 0.0254]
		: [EPCB_PrimitivePadHoleType.ROUND, diameter];
	const holeRotation = hit.slot ? ((hit.slot.rotation - padRotation) % 360 + 540) % 360 - 180 : 0;
	return eda.pcb_PrimitivePad.create(
		12,
		'',
		hit.position.x / 0.0254,
		hit.position.y / 0.0254,
		padRotation,
		pad,
		'',
		hole,
		0,
		0,
		holeRotation,
		metallization,
		EPCB_PrimitivePadType.NORMAL,
		undefined,
		maskExpansion,
		null,
		false,
	);
}

/** Keep Gerber mask graphics independent of the NPTH pad's default rules. */
export async function createNonPlatedHole(hit: DrillHit): Promise<IPCB_PrimitivePad | undefined> {
	const diameter = hit.diameter / 0.0254;
	const slotLength = hit.slot?.length === undefined ? undefined : hit.slot.length / 0.0254;
	const rotation = hit.slot?.rotation ?? 0;
	const pad: TPCB_PrimitivePadShape = slotLength === undefined
		? [EPCB_PrimitivePadShapeType.ELLIPSE, diameter, diameter]
		: [EPCB_PrimitivePadShapeType.OBLONG, slotLength, diameter];
	const closedMaskExpansion = -(slotLength ?? diameter) / 2;
	return createDrilledPad(
		hit,
		rotation,
		pad,
		false,
		{ topSolderMask: closedMaskExpansion, bottomSolderMask: closedMaskExpansion },
	);
}
