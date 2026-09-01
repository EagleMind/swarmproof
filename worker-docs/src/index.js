'use strict'

import { openapi } from './openapi.js'

/**
 * Publishes the engine's API reference.
 *
 * Deliberately its own Worker, separate from the control plane. They fail
 * differently and are read by different people: the control plane is on a
 * client's critical path and carries KV and a Durable Object, while this is a
 * static document that should stay up when the control plane is being
 * redeployed. Sharing a Worker would couple a docs typo to a production
 * deploy of the thing clients depend on.
 *
 * It holds no state and never proxies the API. There is nothing to call here.
 */

const SPEC = JSON.stringify(openapi, null, 2)

/**
 * Scalar renders the reference from the spec.
 *
 * The alternative was hand-rolling a renderer to avoid a third-party script.
 * Not worth it: this page documents software whose whole value is being
 * verifiable, and a bespoke half-renderer that quietly drops a field is worse
 * than a well-known one. The spec at /openapi.json is the source of truth and
 * is fully usable on its own — curl it, feed it to a generator, or point any
 * other viewer at it if you would rather not load the script.
 */
const page = origin => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>swarmproof API</title>
<meta name="description" content="Rank candidate BitTorrent swarms and prove them by asking a peer for the torrent.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>🛰️</text></svg>">
<style>
  body { margin: 0; }
  .banner {
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 10px 16px; background: #0f172a; color: #e2e8f0;
    border-bottom: 1px solid #1e293b;
  }
  .banner strong { color: #fff; }
  .banner code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #1e293b; padding: 1px 5px; border-radius: 4px;
  }
  .banner a { color: #7dd3fc; }
</style>
</head>
<body>
<div class="banner">
  <strong>Live at <code>swarmproof-api.hassen-ben-mbarek.workers.dev</code></strong>
  — no key, no signup. Rate-limited to 60 requests a minute because every call
  puts one real machine into a real swarm; the streaming routes are self-host
  only. Run your own with <code>npm start</code> for no ceilings.
  <a href="/openapi.json">openapi.json</a>
</div>
<script id="api-reference" data-url="${origin}/openapi.json"></script>
<script>
  var configuration = { theme: 'deepSpace', hideDownloadButton: false }
  document.getElementById('api-reference').dataset.configuration = JSON.stringify(configuration)
</script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`

const CORS = { 'Access-Control-Allow-Origin': '*' }

export default {
  async fetch (request) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } })
    }

    // The spec is the artefact worth depending on, so it is served on its own
    // and cached: generators and CI fetch this, not the HTML.
    if (url.pathname === '/openapi.json') {
      return new Response(SPEC, {
        headers: {
          ...CORS,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300'
        }
      })
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(page(url.origin), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
      })
    }

    return Response.redirect(`${url.origin}/`, 302)
  }
}
