# BuildWarden Web

This package builds the same BuildWarden React application for two browser deployments:

- `pnpm build` creates the static hosted client in `dist` for Vercel.
- `pnpm build:embedded` writes the same client to `../desktop/out/web` for the desktop host.

The hosted deployment has no API routes, functions, database, analytics, or relay. After pairing, the browser connects directly to the running BuildWarden desktop through its Tailscale Serve HTTPS and WebSocket endpoint. Vercel serves only static HTML, CSS, and JavaScript.

The production deployment is available at [https://buildwarden-app.vercel.app](https://buildwarden-app.vercel.app/), but it is optional. You can host the contents of `dist` on any static web server and use any domain you control. The server must provide HTTPS and route unknown application paths to `index.html`; add that deployment's exact origin under **Hosted website origins** in BuildWarden before pairing it.

## Deploy to Vercel

1. Import the BuildWarden repository as a Vercel project.
2. Set **Root Directory** to `apps/web`.
3. Keep **Include source files outside of the Root Directory in the Build Step** enabled. The web app depends on `packages/renderer`, `packages/shared`, and the root pnpm lockfile.
4. Leave the detected build settings in place; `vercel.json` defines the install command, build command, output directory, SPA rewrite, cache policy, and security headers.
5. Assign a stable production or custom HTTPS domain. Preview domains are not trusted automatically.
6. Deploy. No environment variables are required.

Vercel follows the explicit pnpm workspace dependencies, so changes to this package or its shared renderer/contracts trigger an affected deployment. Desktop-only main-process changes do not need to rebuild the static site.

## Connect a BuildWarden Host

1. Install and sign in to Tailscale on the desktop host and the viewing phone/computer.
2. In the BuildWarden desktop app, open **Settings → Network → Remote access**.
3. Enable **Remote Access** and **Expose to tailnet**. Wait for a verified `https://<device>.<tailnet>.ts.net` endpoint.
4. Add the deployed site's exact origin—`https://buildwarden-app.vercel.app` for the production deployment—under **Hosted website origins** and save it.
5. Choose **Hosted website**, select that origin, choose the desired scopes, and create a pairing code.
6. Scan the QR code or open the generated link on the tailnet device. The host and pairing code are carried in the URL fragment, which is removed before any network request and is not sent to Vercel.

The resulting origin-bound bearer is stored in IndexedDB in that browser profile. Only one host is active at a time. **Disconnect** revokes the host session; **Change host** revokes it when reachable and then clears the saved connection.

The BuildWarden desktop app and Tailscale must be running whenever the hosted client is used. The hosted site cannot wake or proxy to an offline host.

## Local development

Run the hosted shell locally:

```bash
pnpm --filter @buildwarden/web dev
```

For local cross-origin testing, add the exact loopback Vite origin (normally `http://localhost:5173`) to the desktop allowlist. Production host URLs must be verified Tailscale HTTPS `.ts.net` endpoints.
