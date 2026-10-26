import { build } from 'esbuild';

// Workspace packages ship TypeScript source, so they are bundled in; npm packages stay external.
await build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    logLevel: 'info',
    plugins: [
        {
            name: 'externalize-npm',
            setup(b) {
                b.onResolve({ filter: /^[^./]/ }, (args) => {
                    if (args.kind === 'entry-point' || args.path.startsWith('@lyfestyle/'))
                        return undefined;
                    return { path: args.path, external: true };
                });
            },
        },
    ],
});
