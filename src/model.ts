export interface Point {
	x: number;
	y: number;
}

export type ApertureShape
	= | { kind: 'circle'; diameter: number }
		| { kind: 'rectangle'; width: number; height: number }
		| { kind: 'roundedRectangle'; width: number; height: number; radius: number; rotation: number }
		| { kind: 'obround'; width: number; height: number }
		| { kind: 'polygon'; diameter: number; vertices: number; rotation: number };

export interface Stroke {
	kind: 'stroke';
	start: Point;
	end: Point;
	width: number;
	arcAngle?: number;
	arcCenter?: Point;
}

export interface Flash {
	kind: 'flash';
	position: Point;
	shape: ApertureShape;
}

export interface Region {
	kind: 'region';
	points: Point[];
}

export type GerberPrimitive = Stroke | Flash | Region;

export interface GerberParseResult {
	fileFunction?: string;
	primitives: GerberPrimitive[];
	warnings: string[];
}

export interface DrillHit {
	position: Point;
	diameter: number;
	plated?: boolean;
}

export interface DrillParseResult {
	hits: DrillHit[];
	plated?: boolean;
	warnings: string[];
}

export interface ImportLayer {
	fileName: string;
	layerId: number;
	result: GerberParseResult;
}

export interface ImportPlan {
	layers: ImportLayer[];
	drills: Array<{ fileName: string; result: DrillParseResult }>;
	warnings: string[];
}
