import antfu from '@antfu/eslint-config';

export default antfu({
	stylistic: {
		indent: 'tab',
		quotes: 'single',
		semi: true,
	},

	typescript: true,

	ignores: ['build/dist/', 'coverage/', 'dist/', 'node_modules/', 'tests/', '.eslintcache', 'debug.log'],

	rules: {
		'no-console': ['warn', { allow: ['log', 'warn', 'error'] }],
	},
});
