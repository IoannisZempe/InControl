# Security Policy

## Security Model

InControl is a local-first control plane for your AI coding agents:

1. **Pairing-Token Authentication (`~/.incontrol/config.json`)**
   - On first start, a 192-bit random pairing token is generated and saved with `0600` permissions in `~/.incontrol/config.json` (or overridden via `INCONTROL_TOKEN`).
   - All non-loopback requests (e.g. from your phone or another laptop over LAN/Tailscale) must present this token via the QR pairing URL (`/?token=...`), `Authorization: Bearer <token>`, or the `HttpOnly; SameSite=Strict` session cookie set during pairing.
   - Run `incontrol token --rotate` at any time to invalidate existing paired devices.
2. **Localhost Modes**
   - By default, loopback (`127.0.0.1` / `::1`) connections are trusted so local IDE hooks and CLI wrappers work out of the box.
   - On shared machines, pass `--strict` (`incontrol start --strict`) to require the pairing token on localhost as well.
   - If you only use the Mac panel and don't want LAN access, pass `--local-only` (`incontrol start --local-only`) to bind strictly to `127.0.0.1`.
3. **Browser Origin & DNS Rebinding Protection**
   - Cross-origin requests from third-party websites are rejected (`403 Forbidden`), and `Host` headers are validated against known local/LAN/Tailscale addresses.

## Reporting a Vulnerability

Please **do not open a public issue.** Report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/IoannisZempe/InControl/security/advisories/new).

We aim to acknowledge reports within 72 hours.
