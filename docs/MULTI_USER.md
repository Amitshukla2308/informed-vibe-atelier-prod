# Multi-user setup (Cloudflare tunnel recipe)

The default install runs single-host on localhost. To bring on a co-founder who isn't on your machine, expose Atelier to the public internet via Cloudflare's free tunnel and use Atelier's invite flow.

## Prerequisites

- A Cloudflare account (free tier is fine).
- `cloudflared` installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

## One-shot tunnel (development)

```bash
# Atelier is running on :5174
cloudflared tunnel --url http://localhost:5174
```

cloudflared prints a `*.trycloudflare.com` URL. Anyone with that URL hits your local Atelier.

This is fine for trying multi-user with a co-founder. The URL changes every time you run the command and the tunnel only lasts as long as the process.

## Persistent tunnel (recommended)

```bash
cloudflared tunnel login                                # one-time auth
cloudflared tunnel create informed-vibe-atelier         # creates a tunnel
cloudflared tunnel route dns informed-vibe-atelier <your-subdomain>.<your-domain>
cloudflared tunnel run informed-vibe-atelier
```

Now `https://<your-subdomain>.<your-domain>` routes to your local install.

## Sending an invite

Inside Atelier (logged in as the host):

1. Settings → Invites → "Generate invite"
2. Copy the URL — it looks like `https://<your-domain>/invite/<token>`
3. Send it to your co-founder.

The invite token is single-use, expires after 7 days, and creates a new user record bound to a fresh `data/users/<uid>/` directory. Each user provides their own provider creds via Settings → Providers — host's keys are never used for co-founder sessions.

## Auth model

See [AUTH_MODEL.md](./AUTH_MODEL.md) for the full γ-design (token rotation, cookie scope, session lifetime, password recovery).

## Limitations

- Cloudflare's free tier limits and ToS apply. Don't run a commercial service over `*.trycloudflare.com`.
- The host machine must be running for any user to use the install. Wake-on-LAN is your friend.
- ttyd over a tunnel works but adds latency. v0.1 sidecar will improve this.
