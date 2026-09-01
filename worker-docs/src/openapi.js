'use strict'

/**
 * OpenAPI description of the swarmproof engine API (server.js).
 *
 * Two servers, and the difference between them is not cosmetic. The hosted
 * one is a Cloudflare Worker in front of a single engine instance, and it
 * bounds what a caller may ask for — request rate, candidates per request,
 * peer budget — because that traffic costs one machine real bandwidth and
 * puts its address in every swarm asked about. A self-hosted engine has none
 * of those ceilings, and the streaming routes exist only there: file bytes
 * are not relayed through the edge.
 *
 * So the hosted URL is the right default for *judging* swarms, and running
 * your own is the answer for anything that moves data. Limits that apply to
 * only one of them are marked **Hosted** in the route descriptions.
 *
 * Kept hand-written rather than generated. The interesting part of this API
 * is what the verdicts mean, and that is prose a generator cannot infer from
 * a route handler.
 */

const VERDICT_DESCRIPTION = `What was actually established about the swarm.

- \`verified\` — a peer served the real torrent. \`ut_metadata\` checks
  SHA1(info) against the infohash before returning, so this is the only
  value here that cannot be faked or mistaken.
- \`reachable\` — peer addresses were found, none served metadata.
- \`claimed\` — trackers report a swarm, no address was obtained.
- \`none\` — no signal anywhere.

**\`claimed\` is not \`none\`.** Some healthy swarms have no reachable DHT
presence at all — measured, Ubuntu's returns zero peers at every window up to
15s while Sintel saturates at 202 by 900ms — and a tracker scrape returns
counts with no addresses to verify against. Absence of proof is not proof of
absence; render \`claimed\` as its own state rather than as dead.`

const candidateSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'Display name, from the magnet\'s dn= or the infohash prefix.' },
    infoHash: { type: 'string', pattern: '^[a-f0-9]{40}$' },
    magnetURI: { type: 'string' },
    verdict: { type: 'string', enum: ['verified', 'reachable', 'claimed', 'none'], nullable: true, description: VERDICT_DESCRIPTION },
    verified: { type: 'boolean', nullable: true, description: 'Convenience for `verdict === "verified"`.' },
    score: { type: 'integer', description: 'Weighted health. Ordering within a verdict tier only — never a liveness signal on its own. Damped to a tenth when `refuted` is true.' },
    refuted: {
      type: 'boolean',
      nullable: true,
      description: `A real sample of peers was asked and **none of them had this torrent** — with the
budget intact, so this is not a timeout.

This is the one field that separates a live swarm from an infohash people
merely announce to. The all-zero placeholder hash routinely reports more
observed peers than a genuine film and can never serve a byte; measured, 1128
peers against Sintel's 381. Neither seeder counts nor peer counts tell them
apart. Asking does.

Three conditions must all hold, and each rejects a mitigation that fails on
real swarms: verification actually ran, it did not time out, and at least five
peers were tried. A refuted candidate sorts *below* \`claimed\` — having looked
and found nothing is a worse sign than not having looked.`
    },
    rawScore: { type: 'integer', nullable: true, description: 'The score before any refutation damping, so the adjustment is auditable and a caller who disagrees with the policy can reconstruct the original.' },
    source: { type: 'string', enum: ['probed', 'shared'], description: '`shared` means the answer came from the control plane rather than a fresh probe.' },
    claimed: {
      type: 'object',
      description: 'What trackers report. Unverified by construction: a scrape returns counts and no addresses.',
      properties: {
        seeders: { type: 'integer' },
        leechers: { type: 'integer' }
      }
    },
    observed: {
      type: 'object',
      description: 'What was actually seen on the wire.',
      properties: {
        peers: { type: 'integer', description: 'Distinct peer addresses obtained.' },
        dhtCount: { type: 'integer', description: 'Addresses the DHT lookup returned.' }
      }
    },
    weighting: {
      type: 'object',
      description: 'How the score departed from the raw counts, so a ranking that disagrees with "more seeders wins" is explainable.',
      properties: {
        peerWeight: { type: 'number', nullable: true },
        locality: { type: 'number', nullable: true, description: '1.0 on the open internet; higher when peers are rack-local.' }
      }
    },
    meta: {
      type: 'object',
      nullable: true,
      description: 'Present only when `verdict` is `verified`. This is the torrent itself, proven against the infohash.',
      properties: {
        name: { type: 'string' },
        size: { type: 'integer', format: 'int64', description: 'Total bytes.' },
        files: { type: 'integer' },
        paths: { type: 'array', items: { type: 'string' }, description: 'File paths, capped at 100.' }
      }
    },
    verifyMs: { type: 'integer', nullable: true, description: 'Time spent on the metadata attempt. Null when none was made.' },
    verifyTimedOut: { type: 'boolean', nullable: true, description: 'True when `deadlineMs` expired first. A `reachable` that ran out of budget is a weaker claim than one where every peer was asked and refused — do not count it as evidence of a dead swarm.' },
    error: { type: 'string', nullable: true }
  }
}

const inputProperties = {
  input: {
    type: 'string',
    description: 'Newline-separated magnet links and/or 40-character infohashes. What a human pastes.',
    example: 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'
  },
  candidates: {
    type: 'array',
    description: 'Pre-built candidates, when you already have the parts.',
    items: {
      type: 'object',
      required: ['infoHash'],
      properties: {
        infoHash: { type: 'string', pattern: '^[a-f0-9]{40}$' },
        magnetURI: { type: 'string' },
        trackers: { type: 'array', items: { type: 'string' } },
        label: { type: 'string' }
      }
    }
  },
  presets: { type: 'boolean', description: 'Use the bundled Blender Foundation fixtures (CC-BY). Handy for checking your install.' }
}

const requestBody = (extra = {}, description = 'Supply exactly one of `input`, `candidates` or `presets`.') => ({
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        description,
        properties: { ...inputProperties, ...extra }
      },
      examples: {
        magnet: { summary: 'A magnet link', value: { input: 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel' } },
        several: { summary: 'Several candidates for one title', value: { input: '08ada5a7a6183aae1e09d831df6748d566095a10\ndd8255ecdc7ca55fb0bbf81323d87062db1f6d1c' } },
        fixtures: { summary: 'The bundled fixtures', value: { presets: true } }
      }
    }
  }
})

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'swarmproof engine API',
    version: '2.0.0',
    summary: 'Rank candidate BitTorrent swarms, and prove them by asking a peer for the torrent.',
    description: `Given candidates you already have — magnets, infohashes, alternate releases of
one title — this ranks the swarms and, on \`/v1/assess\`, verifies them by
completing a real handshake and pulling metadata.

It does **not** tell you what exists or find a title by name. That is a
catalogue; this is the discovery layer underneath one. You bring the infohash.

> **Looking for the crawler?** swarmproof also has a BEP 51 DHT crawler that
> harvests infohashes and resolves their names at ~630/minute — but it has no
> endpoint here, on purpose. It is a long-running process that writes a local
> SQLite index, not a request/response API, and nothing below reads that index.
> It runs from the CLI (\`npm run crawl\`) on a machine you control, and it is
> not part of the hosted deployment. See
> [the crawler section of the README](https://github.com/EagleMind/swarmproof#the-crawler)
> and §8 of ARCHITECTURE.md.

### The engine runs on your machine

**There is no hosted endpoint.** An engine is a BitTorrent client: it opens TCP
connections to strangers, and whoever runs it is the address in the swarm. So
you run it, and these routes answer on your own \`localhost\`.

\`\`\`bash
npm install && npm start

curl -X POST http://127.0.0.1:8080/v1/assess \\
  -H 'content-type: application/json' \\
  -d '{"input":"magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10"}'
\`\`\`

This did run as a public API for a period, behind a Worker that added rate
limits and request caps. That front door is in \`worker-api/\` and the runbook
is in \`deploy/\`; it was taken down because a shared engine puts its operator
into every swarm a stranger names. The ceilings described below are marked
**Hosted** and apply only if you stand one up yourself.

### What a hosted deployment limits, and why

An engine is a BitTorrent client. Every request makes a real machine open real
connections to strangers, and the address that joins the swarm belongs to
whoever runs it — here, that is one t3.small paying for your query. Hence:

| Limit | Value |
|---|---|
| Requests per IP | 60 per minute, then \`429\` |
| Candidates per request | 20 |
| \`maxPeers\` ceiling | 60 |
| \`deadlineMs\` ceiling | 30000 |
| Identical repeat queries | served from a 60s edge cache (\`x-cache: HIT\`) |
| \`/v1/play\`, \`/v1/stream\` | \`501\` — not relayed through the edge |

None of these exist on a self-hosted engine. If you are sweeping a catalogue
of any size, run your own — it is the same software, and the limits above are
about protecting one shared box, not about gating a feature.

The 60-second cache is not a compromise on accuracy: swarm health moves on the
order of minutes, and the engine's own shared-health tier treats anything under
two minutes as \`fresh\`.

### Calling it

No auth, no API key, no versioned header — the version is in the path. Every
JSON response carries \`Access-Control-Allow-Origin: *\` and \`OPTIONS\` is
answered, so a browser page can call either endpoint directly.

On a self-hosted engine an unknown path returns \`404\` with an \`endpoints\`
array listing everything below, which makes it self-describing even offline.

Self-hosting note: it binds \`127.0.0.1:8080\`, and \`ENGINE_PORT\` /
\`ENGINE_HOST\` move it. Binding anything other than loopback additionally
requires \`ENGINE_ALLOW_PUBLIC=1\`, because a reachable engine is a torrent
client whoever finds the port can drive — they choose the infohash and your
address joins the swarm. Put a proxy in front if you expose it.

### Claims versus proof

The single most important thing to understand here. \`claimed.seeders\` comes
from a tracker scrape — a count, with no addresses, that nothing checks.
Measured against the live network, an infohash that has never existed reported
45 seeders and 459 leechers, because hundreds of clients announce to that
placeholder hash, and it out-**scored** a torrent that streams.

So \`score\` orders candidates; it does not tell you a torrent is alive. Only
\`verdict\` does.`,
    license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' }
  },

  servers: [
    {
      url: 'http://127.0.0.1:8080',
      description: 'Your own engine (npm start). There is no hosted alternative — a public engine puts its operator into every swarm a caller names.'
    }
  ],

  tags: [
    { name: 'Discovery', description: 'Rank and verify candidate swarms.' },
    { name: 'Streaming', description: 'Play the winner and read the bytes.' },
    { name: 'Service', description: 'Liveness and fixtures.' }
  ],

  paths: {
    '/v1/assess': {
      post: {
        tags: ['Discovery'],
        summary: 'Rank and verify',
        description: `The one most callers want. Ranks the candidates, then asks their peers for
the torrent and returns a verdict per candidate.

Results are sorted by verdict tier first and score second, so nothing unproven
can outrank something proven, and nothing loses its score.

**Timing.** This opens real TCP connections. Cold, with no learned peer
addresses, verifying one candidate measured ~7.6s; warm it is often under 2s.
Peers are tried \`concurrency\` at a time and the whole verification is capped
by \`deadlineMs\`. Use \`/v1/probe\` when you need a fast answer and this when
you need a true one.`,
        operationId: 'assess',
        requestBody: requestBody({
          verify: { type: 'boolean', default: true, description: 'False skips the metadata step, leaving a verdict of at best `reachable`.' },
          maxPeers: { type: 'integer', default: 40, description: 'Peer addresses to try per candidate. DHT-sourced peers measured 13% TCP-connect cold, so a small budget is close to a coin flip.' },
          deadlineMs: { type: 'integer', default: 20000, description: 'Overall verification budget. 0 disables it.' },
          concurrency: { type: 'integer', default: 6, description: 'Peers attempted at once per candidate. The ceiling on wasted connections to a dead swarm.' }
        }),
        responses: {
          200: {
            description: 'Ranked and verified, best first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    elapsedMs: { type: 'integer' },
                    candidates: { type: 'array', items: candidateSchema }
                  }
                },
                example: {
                  elapsedMs: 7666,
                  candidates: [
                    {
                      label: 'Sintel',
                      infoHash: '08ada5a7a6183aae1e09d831df6748d566095a10',
                      verdict: 'verified',
                      verified: true,
                      score: 2038,
                      source: 'probed',
                      claimed: { seeders: 118, leechers: 50 },
                      observed: { peers: 127, dhtCount: 202 },
                      weighting: { peerWeight: 202, locality: 1 },
                      meta: { name: 'Sintel', size: 129302391, files: 11, paths: ['Sintel/Sintel.mp4'] },
                      verifyMs: 7415,
                      verifyTimedOut: false,
                      error: null
                    },
                    {
                      label: '00000000',
                      infoHash: '0000000000000000000000000000000000000000',
                      verdict: 'claimed',
                      verified: false,
                      score: 901,
                      source: 'probed',
                      claimed: { seeders: 45, leechers: 451 },
                      observed: { peers: 0, dhtCount: 0 },
                      meta: null,
                      verifyMs: null,
                      verifyTimedOut: false,
                      error: null
                    }
                  ]
                }
              }
            }
          },
          400: { $ref: '#/components/responses/BadRequest' },
          429: { $ref: '#/components/responses/RateLimited' }
        }
      }
    },

    '/v1/probe': {
      post: {
        tags: ['Discovery'],
        summary: 'Rank only',
        description: 'Tracker scrape plus a DHT lookup, no metadata fetch. About 1s. `verdict` is null — use `/v1/assess` if you need one.',
        operationId: 'probe',
        requestBody: requestBody(),
        responses: {
          200: {
            description: 'Ranked by score, best first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    elapsedMs: { type: 'integer' },
                    candidates: { type: 'array', items: candidateSchema }
                  }
                }
              }
            }
          },
          400: { $ref: '#/components/responses/BadRequest' },
          429: { $ref: '#/components/responses/RateLimited' }
        }
      }
    },

    '/v1/play': {
      post: {
        tags: ['Streaming'],
        summary: 'Start streaming the best candidate',
        description: `Returns immediately with 202 — ranking plus metadata takes seconds. Poll
\`/v1/status\` until \`status\` is \`playing\`, then read \`/v1/stream\`.

The ranked list doubles as the failover order: if the chosen swarm stalls, the
next candidate is already selected.`,
        operationId: 'play',
        requestBody: requestBody(),
        responses: {
          202: {
            description: 'Accepted; ranking has begun.',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { accepted: { type: 'array', items: { type: 'string' } } } }
              }
            }
          },
          400: { $ref: '#/components/responses/BadRequest' },
          501: { $ref: '#/components/responses/NotHosted' }
        }
      }
    },

    '/v1/status': {
      get: {
        tags: ['Streaming'],
        summary: 'Engine state',
        operationId: 'status',
        responses: {
          200: {
            description: 'Current state.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['idle', 'ranking', 'starting', 'playing', 'error'] },
                    error: { type: 'string', nullable: true },
                    decisionMs: { type: 'integer', nullable: true, description: 'How long ranking took.' },
                    requested: { type: 'array', items: { type: 'string' } },
                    elapsedMs: { type: 'integer', nullable: true },
                    cloud: { type: 'string', nullable: true, description: 'Control-plane endpoint, when one is configured.' },
                    file: {
                      type: 'object',
                      nullable: true,
                      properties: { name: { type: 'string' }, length: { type: 'integer', format: 'int64' } }
                    },
                    torrent: {
                      type: 'object',
                      nullable: true,
                      properties: {
                        infoHash: { type: 'string' },
                        peers: { type: 'integer', description: 'Peers currently connected.' },
                        downloaded: { type: 'integer', format: 'int64' },
                        progress: { type: 'number' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    '/v1/stream': {
      get: {
        tags: ['Streaming'],
        summary: 'The bytes',
        description: `Supports HTTP Range, so it seeks. Point \`mpv\`, VLC or a \`<video>\` tag at it.

Bytes are released only once their piece hash verifies against the
infohash-anchored metadata, so anything read here is the real file.

A Range request also reprioritises the piece scheduler around the requested
offset, so seeking is a hint to the downloader and not only a read.

**Only \`bytes=start-\` and \`bytes=start-end\` are parsed.** A suffix range
(\`bytes=-500\`) does not match, and the response is a \`206\` covering the
whole file rather than the last 500 bytes. Ask for an explicit start offset.`,
        operationId: 'stream',
        parameters: [
          { name: 'Range', in: 'header', required: false, schema: { type: 'string' }, example: 'bytes=0-262143' }
        ],
        responses: {
          200: {
            description: 'The whole file. No `Range` was sent.',
            headers: {
              'Accept-Ranges': { schema: { type: 'string' }, description: 'Always `bytes`.' },
              'Content-Type': { schema: { type: 'string' }, description: 'Guessed from the file name; `application/octet-stream` when unknown.' }
            },
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
          },
          206: {
            description: 'Partial content.',
            headers: {
              'Content-Range': { schema: { type: 'string' }, description: '`bytes <start>-<end>/<total>`.' },
              'Accept-Ranges': { schema: { type: 'string' }, description: 'Always `bytes`.' }
            },
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
          },
          416: {
            description: 'The requested range starts past the end of the file, or is inverted.',
            headers: {
              'Content-Range': { schema: { type: 'string' }, description: '`bytes */<total>`, so a client can learn the length it should have asked within.' }
            }
          },
          503: {
            description: `Nothing is playing yet — no file has been selected. Body is \`Not ready yet\`.

This is the response between \`POST /v1/play\` and \`status: "playing"\`, so
poll \`/v1/status\` rather than treating it as an error.`
          },
          501: { $ref: '#/components/responses/NotHosted' }
        }
      }
    },

    '/v1/presets': {
      get: {
        tags: ['Service'],
        summary: 'Bundled fixtures',
        description: `Blender Foundation open movies (CC-BY), whose relative health is known in
advance — so a ranking that disagrees is a bug in the scorer rather than a
quiet swarm.

These are fixtures, not a catalogue. They exist so there is always something
real and freely redistributable to point a probe at.`,
        operationId: 'presets',
        responses: {
          200: {
            description: 'The fixture list.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    presets: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          label: { type: 'string' },
                          year: { type: 'integer' },
                          infoHash: { type: 'string', pattern: '^[a-f0-9]{40}$' }
                        }
                      }
                    }
                  }
                },
                example: {
                  presets: [
                    { id: 'sintel', label: 'Sintel', year: 2010, infoHash: '08ada5a7a6183aae1e09d831df6748d566095a10' },
                    { id: 'bbb', label: 'Big Buck Bunny', year: 2008, infoHash: 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c' },
                    { id: 'cosmos', label: 'Cosmos Laundromat', year: 2015, infoHash: 'c9e15763f722f23e98a29decdfae341b98d53056' },
                    { id: 'tos', label: 'Tears of Steel', year: 2012, infoHash: '209c8226b299b308beaf2b9cd3fb49212dbd13ec' }
                  ]
                }
              }
            }
          }
        }
      }
    },

    '/healthz': {
      get: {
        tags: ['Service'],
        summary: 'Liveness',
        description: 'Cheap by design: answering must not require building a DHT.',
        operationId: 'healthz',
        responses: {
          200: {
            description: 'Alive.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    status: { type: 'string' },
                    scout: { type: 'boolean', description: 'Whether the DHT client has been built yet. It is created lazily on first use.' }
                  }
                }
              }
            }
          }
        }
      }
    }
  },

  components: {
    responses: {
      RateLimited: {
        description: `**Hosted only.** More than 60 requests in a minute from one address.
Retry after the window, or run your own engine — it has no limit.`,
        headers: {
          'Retry-After': { schema: { type: 'string' }, description: 'Seconds to wait.' }
        },
        content: {
          'application/json': {
            schema: { type: 'object', properties: { error: { type: 'string' }, detail: { type: 'string' } } },
            example: { error: 'rate limit exceeded' }
          }
        }
      },
      NotHosted: {
        description: `**Hosted only.** This route moves file bytes and is not relayed through the
edge — it would put a media stream on Cloudflare's network for content fetched
from strangers, and it defeats the point of a peer-to-peer transfer. Run your
own engine and the route works normally.`,
        content: {
          'application/json': {
            schema: { type: 'object', properties: { error: { type: 'string' }, detail: { type: 'string' } } },
            example: { error: 'not available through the hosted API' }
          }
        }
      },
      BadRequest: {
        description: `Malformed body, or no usable candidate in it. Every failure here is a
single \`error\` string; nothing partially succeeds.

Bodies over 1 MB are not read: the request stream is destroyed the moment the
limit is passed, so expect a dropped connection rather than a tidy \`400\`.
This is a control API that takes magnets, not an upload endpoint.`,
        content: {
          'application/json': {
            schema: { type: 'object', properties: { error: { type: 'string' } } },
            examples: {
              noInfohash: { summary: 'A magnet with no infohash', value: { error: 'Magnet link has no xt=urn:btih: infohash' } },
              notAMagnet: { summary: 'Neither a magnet nor an infohash', value: { error: 'Not a magnet link or a 40-character infohash' } },
              empty: { summary: 'Nothing to work with', value: { error: 'Send { input } with a magnet link or infohash, or { candidates }' } },
              badJson: { summary: 'Unparseable body', value: { error: 'body is not valid JSON' } }
            }
          }
        }
      }
    }
  }
}

export default openapi
