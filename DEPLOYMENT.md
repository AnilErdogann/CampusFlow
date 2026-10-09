# CampusFlow installation and shared accounts

## Windows PC

For developers building a Windows installer, install Python 3.11+ and Inno Setup 6, then run `scripts\build_windows.ps1` in PowerShell. It creates `dist\CampusFlow-Setup.exe` and copies the same installer to `downloads\CampusFlow-Setup.exe`. The installer is per-user, adds Start menu and optional desktop shortcuts, and leaves `%LOCALAPPDATA%\CampusFlow` data in place if the app is uninstalled.

The download page is `http://127.0.0.1:8765/download` when the app is running. It serves `downloads\CampusFlow-Setup.exe`; after building, restart the source server if it was already running. A public link is available only after this app is deployed to an HTTPS host and the installer file is copied to that host's `downloads` folder.

For source use without building the installer, extract the CampusFlow ZIP and double-click `start.bat` (or the **CampusFlow Kontrol Paneli** desktop shortcut). The panel starts the server, displays its health and recent logs, and provides stop/restart and browser buttons. Closing the panel leaves the server running; use the panel's **Durdur** button to stop the process it started.

### Free temporary access from outside your Wi-Fi

For a small pilot without buying a domain or opening router ports, start CampusFlow on your PC and run `scripts\start_public_demo.ps1` in PowerShell. The script downloads the official Cloudflare Tunnel executable to `%LOCALAPPDATA%\CampusFlow\tools` if needed, checks its Windows signature, and opens a temporary HTTPS Quick Tunnel to the PC app. Open the generated `trycloudflare.com` address on phones and share that same address with testers. Their accounts and app data are stored in the PC's `%LOCALAPPDATA%\CampusFlow\campusflow.db`.

This is a temporary test link, not an always-on hosting service: the PC, internet connection, app, and PowerShell tunnel window must stay open. Cloudflare gives the link a new random address when the tunnel restarts, and anyone with the link can reach the public login and account-creation screens. Account data still requires login. Do not share the database or `%LOCALAPPDATA%\CampusFlow\.env`, and back both up. Do not enable router port forwarding; the tunnel connects outward from the PC. Cloudflare Quick Tunnels have no uptime guarantee and are intended for development/testing. For a stable public address and continuous use, move the app to a persistent HTTPS host.

The SQLite database and `.env` are stored in `%LOCALAPPDATA%\CampusFlow`. Logging out, closing the browser, and restarting the server do not delete account data. The first launch copies a project-folder database and secret there when no profile copy exists; the originals stay in place as a backup. Back up `campusflow.db` and `.env` together. Never share them: they contain account records and the secret used to protect stored AI credentials.

## One account across PC, Android, and iPhone

Local SQLite is for one PC. To receive messages and see the same account on all devices, host one CampusFlow server over HTTPS and have every device open that same address. The included Docker setup uses PostgreSQL with a named persistent volume and Caddy for HTTPS. It needs a public domain with DNS pointed at the server, ports 80 and 443 open, and Docker Compose installed.

1. Copy `.env.example` to `.env`.
2. Set `CAMPUSFLOW_DOMAIN`, a long random `SECRET_KEY`, and a long random hexadecimal `POSTGRES_PASSWORD` in `.env`. The PostgreSQL password must contain only letters and numbers because it is also used in the connection URL.
3. Run `docker compose up --build -d` on the server. Caddy requests the HTTPS certificate automatically after the domain resolves to that server.
4. Open `https://your-domain` on every device and sign into the same CampusFlow account.

The PostgreSQL volume survives container restarts. Back it up regularly with `docker compose exec -T db pg_dump -U campusflow campusflow > campusflow-backup.sql`.

### Move an existing PC account to the shared server

Stop the local CampusFlow server and make a backup copy of `campusflow.db`. Start the Docker setup with an empty PostgreSQL database, then from the project folder run this in PowerShell (replace the example password):

```powershell
$env:CAMPUSFLOW_MIGRATION_DATABASE_URL = "postgresql+psycopg://campusflow:YOUR_HEX_PASSWORD@localhost:5432/campusflow"
python -m pip install "psycopg[binary]>=3.2,<4"
python scripts/migrate_sqlite_to_postgres.py .\campusflow.db
Remove-Item Env:CAMPUSFLOW_MIGRATION_DATABASE_URL
```

The migration tool refuses to copy into a PostgreSQL database that already contains CampusFlow data. It leaves the SQLite file untouched. Keep the backup and `.env` until you have checked that your account, PDFs, notes, settings, and chats appear on the hosted app.

## Android

After the HTTPS server is running, open its address in Chrome on Android. Use Chrome's **Install app** or **Add to Home screen** action. CampusFlow's manifest and app icon are included in the web app; the install opens in a standalone app window. The server must remain online for account data, AI requests, and messages.

## iPhone and iPad

After the HTTPS server is running, open its address in Safari. Tap **Share → Add to Home Screen**, enable **Open as Web App**, then tap **Add**. This installs the CampusFlow web app on that device. The server must remain online for account data, AI requests, and messages.

The Android and iOS packages are installable web apps (PWAs), not APK/IPA binaries. This keeps one account and one codebase across all three platforms. A store-distributed native Android APK or signed iOS IPA is a separate release project; it is not produced by this Windows build.

### Testing on a phone before publishing

For a quick layout/API check on a trusted private Wi-Fi network, start the source app with `.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8765`, find the PC's Wi-Fi IPv4 address with `ipconfig`, and open `http://PC-IP:8765` on the phone. This checks responsive layout and app flows, but HTTP on a LAN address cannot install the PWA. Do not expose this development server to the public internet. For installation testing, deploy to a domain with HTTPS, then use Chrome on Android or Safari on iPhone as described above.

Each standalone Windows installation stores its own account database on that computer. To use one account and receive messages between devices, every device must use the same deployed HTTPS server; the local EXE is not a cloud-hosted account service. Local AI in the desktop package still needs Ollama installed separately. Cloud AI needs a provider API key configured by the user.

## AI memory

The local default is `qwen2.5:3b`; Ollama context is limited to 12K tokens and released shortly after use. The previous 14B default is automatically changed to 3B when those settings are next loaded, and the old model is unloaded from RAM when Ollama is reachable. This lowers memory use substantially while keeping PDF summaries local. Larger local models can still be selected in AI settings if the computer has enough RAM. Cloud AI needs an API key and the user's explicit permission to send PDF text.

## Public deployment with Railway

Railway is the selected host for a shared public CampusFlow server. It provides a generated HTTPS address, so a separate domain purchase is optional. Use one Railway web service and one managed PostgreSQL service; the database keeps accounts, PDFs, notes, and messages shared across devices. The `railway.json` health check and Dockerfile port are configured for this host. PostgreSQL connection URLs from the provider are converted to the installed psycopg 3 driver automatically.

Railway Hobby starts at USD 5/month and resource use above the included amount is billed separately. A Railway account and a payment method are needed to keep the production service running. Confirm the current price on [Railway's pricing page](https://docs.railway.com/pricing) before enabling billing.

1. Install the Railway CLI from PowerShell with `npm install --global @railway/cli`, then run `railway login`.
2. In the Railway dashboard, create a project, add a PostgreSQL service, and add an empty web service named `campusflow`.
3. Before deploying, set the app service variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}` (replace `Postgres` if the database service has a different name) and `SECRET_KEY`. To preserve your existing account and encrypted AI keys, use the `SECRET_KEY` value in `%LOCALAPPDATA%\CampusFlow\.env`; if starting with a new account, generate a long random value with `python -c "import secrets; print(secrets.token_urlsafe(48))"`. Keep it private and unchanged across deployments.
4. In PowerShell, open this project folder, run `railway link` and select the project and `campusflow` service, then run `railway up` to upload and deploy the app.
5. To move your existing account and files, temporarily enable public access on the Railway PostgreSQL service and copy its `DATABASE_PUBLIC_URL`. In PowerShell, run `$env:CAMPUSFLOW_MIGRATION_DATABASE_URL = Read-Host 'Paste DATABASE_PUBLIC_URL'`, then `\.venv\Scripts\python.exe scripts\migrate_sqlite_to_postgres.py "$env:LOCALAPPDATA\CampusFlow\campusflow.db"`, then `Remove-Item Env:CAMPUSFLOW_MIGRATION_DATABASE_URL`. The migration refuses a database that already contains records. Disable public database access after the copy finishes. Back up the local database first and keep it until the hosted account, PDFs, notes, and messages are checked.
6. In the app service's Settings → Networking, generate a Railway domain. Wait for the `/health` check to succeed; then open the generated HTTPS address on PC, Android, and iPhone and use the same account.

The upload excludes `.env` and local SQLite files through `.gitignore`, and includes `downloads/CampusFlow-Setup.exe` so the hosted download page can offer the Windows installer. Verify `/api/downloads/windows` reports `available: true` after deployment. For later updates, run `railway up` again from this folder.
