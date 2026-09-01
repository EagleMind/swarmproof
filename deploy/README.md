# Deploying a hosted engine

What is actually running behind
`https://swarmproof-api.hassen-ben-mbarek.workers.dev`, and how to rebuild it.

You do not need any of this to use swarmproof. `npm start` gives you the same
engine on your own machine with no ceilings. This directory is for standing up
a *shared* one, where the operator's address is the one in every swarm a caller
asks about — which is the whole reason the front door exists.

---

## The shape

```
caller
  │  no key, no signup
  ▼
Cloudflare Worker  (worker-api/)         rate limit · request caps · 60s cache
  │  x-engine-secret
  ▼
nginx :8443 on EC2  (deploy/nginx-engine.conf)     rejects anything unsigned
  │
  ▼
engine :8080, loopback only, in Docker   the actual BitTorrent client
```

Three properties are load-bearing, and each is easy to undo by accident:

**The engine never faces the internet.** It publishes to `127.0.0.1:8080`
inside the instance. A container started without the `127.0.0.1:` prefix is a
torrent client anyone who finds the port can drive, on your address.

**The origin accepts only Cloudflare, and only signed.** Port 8443 is open to
Cloudflare's [published IPv4 ranges](https://www.cloudflare.com/ips-v4) and
nothing else, and nginx rejects any request without the shared secret. The
security group alone is not enough — it cannot distinguish your Worker from
any other Cloudflare customer's.

**The Worker's `ORIGIN_URL` is a hostname, not an IP.** A Workers subrequest to
a bare IP literal fails with Cloudflare error 1003. Use the EC2 public DNS name.

---

## Standing one up

```bash
# 1. Instance. Any container host with a real network stack works; EC2 is
#    what this is written against.
aws ec2 run-instances \
  --image-id <al2023-ami> --instance-type t3.small \
  --key-name <your-key> --security-group-ids <sg> \
  --user-data file://deploy/ec2-user-data.sh
```

Give it an Elastic IP. Without one the public DNS name changes on every
stop/start, and the Worker's `ORIGIN_URL` silently stops resolving to your box.

```bash
# 2. Security group: SSH from you, 8443 from Cloudflare only.
curl -s https://www.cloudflare.com/ips-v4    # 15 CIDRs, all of them
```

```bash
# 3. The shared secret, on both ends.
openssl rand -hex 32                          # generate once
#   → REPLACE_WITH_SHARED_SECRET in deploy/nginx-engine.conf on the box
#   → wrangler secret put ORIGIN_SECRET --config worker-api/wrangler.jsonc
```

```bash
# 4. Front door.
npm run api:deploy
```

Set `ORIGIN_URL` in `worker-api/wrangler.jsonc` to your instance's public DNS
name first.

---

## Operating it

The engine's state — DHT routing table, peer cache — lives in the
`engine-state` Docker volume and survives the container being replaced. It is
all rebuildable, so there is nothing here worth backing up; a fresh box costs a
slower first decision and nothing else.

```bash
sudo docker logs swarmproof --tail 50      # engine
sudo docker restart swarmproof             # safe: state is on the volume
sudo tail -f /var/log/nginx/access.log      # what the front door forwarded
```

**If you lock yourself out of SSH**, the security group pins one address and
home IPs move. Re-add yours:

```bash
aws ec2 authorize-security-group-ingress --group-id <sg> \
  --protocol tcp --port 22 --cidr "$(curl -s https://checkip.amazonaws.com)/32"
```

**Cloudflare's IP ranges change.** Not often, but they do. A front door that
starts returning `502` with a healthy engine behind it is the symptom; re-run
step 2 against the current list.

---

## What it costs

Not free, and worth knowing before you point traffic at it. On an AWS account
past its first 12 months, roughly:

| | |
|---|---|
| t3.small, 24/7 | ~$15/mo |
| Public IPv4 address | ~$3.60/mo |
| 20 GB gp3 | ~$1.60/mo |
| Egress | 100 GB/mo free, then $0.09/GB |

Egress is the line that moves. The discovery endpoints are cheap — a ranking is
a few hundred KB of DHT and tracker chatter — which is precisely why the hosted
front door refuses `/v1/play` and `/v1/stream`. Streaming measured ~2.7 MB/s
would clear the entire free allowance in about ten hours.

**Check your provider's AUP before you commit.** The engine joins swarms for
whatever infohash a caller names, and plenty of hosts terminate accounts over
BitTorrent traffic regardless of what the content actually is.
