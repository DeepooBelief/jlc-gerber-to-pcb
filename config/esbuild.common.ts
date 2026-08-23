import type esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

export default {
	entryPoints: {
		index: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
	},
	entryNames: '[name]',
	assetNames: '[name]',
	bundle: true, // 用于内部方法调用，请勿修改
	minify: false, // 用于内部方法调用，请勿修改
	loader: {},
	outdir: fileURLToPath(new URL('../dist/', import.meta.url)),
	sourcemap: undefined,
	platform: 'browser', // 用于内部方法调用，请勿修改
	format: 'iife', // 用于内部方法调用，请勿修改
	globalName: 'edaEsbuildExportName', // 用于内部方法调用，请勿修改
	treeShaking: true,
	ignoreAnnotations: true,
	define: {},
	external: [],
} satisfies Parameters<(typeof esbuild)['build']>[0];
