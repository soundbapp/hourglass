import { defineConfig, type Plugin } from 'vite';

/**
 * The single-file build.
 *
 * Produces one `.html` that runs from the filesystem with a double-click: no
 * server, no sibling asset folder, nothing to install. That is possible here
 * only because every texture in the level is synthesised at runtime from noise
 * rather than loaded — there is no image, audio or model file to inline in the
 * first place, so "the whole game" really is one script.
 *
 * The inlining itself has one trap worth naming, because it fails loudly in a
 * way that looks like a compiler bug. `String.prototype.replace` interprets
 * `$&`, `` $` `` and `$1` inside a *string* replacement as substitution
 * patterns, and minified JavaScript is full of `$` identifiers. Passing the
 * code as a string silently corrupts the bundle into something that will not
 * parse. The replacement must be a function, which disables that handling
 * entirely.
 */

/** Rewrites the emitted HTML to carry the bundle inline, and drops the chunk. */
function inlineBundle(): Plugin {
  return {
    name: 'hourglass-inline-bundle',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlName = Object.keys(bundle).find((name) => name.endsWith('.html'));
      const chunkName = Object.keys(bundle).find((name) => {
        const entry = bundle[name];
        return entry !== undefined && entry.type === 'chunk' && entry.isEntry;
      });

      if (htmlName === undefined || chunkName === undefined) {
        this.error('standalone build expected exactly one HTML file and one entry chunk');
      }

      const html = bundle[htmlName];
      const chunk = bundle[chunkName];
      if (html === undefined || html.type !== 'asset' || chunk === undefined || chunk.type !== 'chunk') {
        this.error('standalone build found the wrong kind of output');
      }

      // A literal `</script` can only occur inside a string or a regular
      // expression in valid JavaScript, where the backslash is an inert escape.
      const code = chunk.code.replaceAll('</script', String.raw`<\/script`);
      const source = typeof html.source === 'string' ? html.source : new TextDecoder().decode(html.source);

      const tag = new RegExp(`<script[^>]*src="[^"]*${chunkName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*></script>`);
      if (!tag.test(source)) {
        this.error(`standalone build could not find the script tag for ${chunkName}`);
      }

      // Function replacement, not string: see the note at the top of this file.
      html.source = source.replace(tag, () => `<script type="module">\n${code}\n</script>`);
      html.fileName = 'hourglass.html';
      delete bundle[chunkName];
    },
  };
}

export default defineConfig({
  appType: 'spa',
  plugins: [inlineBundle()],
  build: {
    target: 'es2022',
    outDir: 'dist-standalone',
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 4096,
    // Everything in one chunk, and no asset left beside the page.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'hourglass.js',
      },
    },
  },
});
