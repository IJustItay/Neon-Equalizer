import { defineConfig } from 'vite';

// Content-Security-Policy for the packaged (file://) app. Injected only on
// `vite build` — the dev server is skipped because Vite's HMR client needs
// inline scripts + eval. The renderer has no inline <script>, no eval, and no
// inline event handlers, so script-src can stay locked to 'self'.
//   - script-src 'self'        → blocks injected/remote script execution (the main XSS→RCE path)
//   - style-src 'unsafe-inline'→ runtime inline styles + Google Fonts CSS
//   - connect/img/frame https: → squiglink fetches, measurement images, reviewer + UsyTrace iframes
//   - worker-src 'self' blob:  → bundled AutoEQ worker
//   - object-src 'none', base-uri 'self' → defense-in-depth
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "frame-src https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function cspPlugin() {
  return {
    name: 'inject-csp-meta',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        // ctx.server is only defined for the dev server — skip CSP there.
        if (ctx.server) return html;
        const meta = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`;
        return html.replace('</head>', `  ${meta}\n  </head>`);
      },
    },
  };
}

export default defineConfig({
  root: '.',
  base: './',
  plugins: [cspPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
});
