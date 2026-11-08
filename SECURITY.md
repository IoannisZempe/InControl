# Security Policy

## Current security model

The InControl hub listens on `0.0.0.0:4747` so that phones and other devices on your network can reach it. **v0.x has no authentication.** Anyone who can reach that port can see your agents' status and send them replies, including approving tool calls. Until pairing-token auth lands:

- Run the hub only on networks you trust, or bind it to a private overlay network such as Tailscale.
- Do not expose port 4747 to the public internet or port-forward it.
- Be careful with `--gate-bash`: approving from the panel lets the command run.

## Reporting a vulnerability

Please **do not open a public issue.** Report it privately here: https://github.com/IoannisZempe/InControl/security/advisories/new

We aim to acknowledge reports within 72 hours.
