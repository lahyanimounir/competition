# National WorldSkills Deployment Platform

A git-push-to-deploy platform for WorldSkills Web Technologies training. Competitors create
projects from framework templates (Static HTML/CSS/JS, Static + PHP, Node/Express, React, Laravel), push with git, and
get a live URL a few seconds later. Each repository gets its **own container**, its **own MySQL
database** and its **own subdomain**.

This README explains how to install it on **one server machine** and use it from **a second
machine** (a competitor or trainer laptop) on the same network.

---

## 1. How it works

```
 Machine B (competitor / trainer)                 Machine A (server, runs Docker)
 ┌───────────────────────────┐                    ┌──────────────────────────────────────────────┐
 │ Browser  → dashboard      │ ── HTTP :80 ─────► │ ws-platform  (dashboard, git server,          │
 │ git push → git remote     │                    │               build queue, reverse proxy)     │
 │ Browser  → live app URLs  │                    │   │ docker build / docker run                 │
 └───────────────────────────┘                    │   ▼                                           │
                                                  │ ws-app-<repo>-<deploy>  one container/repo    │
                                                  │ ws-mysql       one database + user per repo   │
                                                  │ ws-phpmyadmin  login with the repo's own user │
                                                  └──────────────────────────────────────────────┘
```

* Dashboard: `http://<SERVER-IP>.nip.io`
* Each app: `http://<subdomain>.<SERVER-IP>.nip.io`
* phpMyAdmin: `http://pma.<SERVER-IP>.nip.io`

[nip.io](https://nip.io) is a free wildcard DNS service: `anything.192.168.1.50.nip.io` resolves to
`192.168.1.50`. That gives every repository its own subdomain with zero DNS setup. Both machines
need internet access for DNS lookups (see [Offline networks](#9-offline-network-no-internet) otherwise).

The deploy pipeline on every `git push origin main`:

1. **Queued** – shown with queue position and an estimated wait.
2. **Building** – `docker build` of the pushed commit (install dependencies, build step, image).
3. The new container is started with `PORT`, `DB_*`, `APP_URL` and your custom env vars.
4. The platform waits until the app listens on `$PORT`, then switches traffic to it and removes the old
   container → **Running**.
5. If anything fails → **Failed** (with a Retry button and the full log). **The previous working
   deployment keeps serving.**

---

## 2. Requirements

### Machine A – the server (Windows **or** Linux)

| Need | Windows server | Linux server |
|---|---|---|
| Operating system | Windows 10/11 Pro/Home (64-bit), Windows Server 2022+ | Ubuntu 22.04/24.04, Debian 12, Fedora, RHEL/Rocky/Alma 9 (64-bit) |
| Docker | [Docker Desktop](https://www.docker.com/products/docker-desktop/) with the WSL 2 engine | Docker Engine + Compose v2 plugin (`get.docker.com` installs both) |
| RAM / CPU | 16 GB recommended (Docker Desktop itself uses ~2 GB) | 8 GB minimum, 16–32 GB for many competitors (see section 12) |
| Free TCP ports | **80** (or another) and **3306** – IIS, Skype, XAMPP/WAMP often take them | **80** and **3306** – apache2/nginx/mysql packages often take them |
| Internet | Docker images, npm/composer packages, nip.io DNS | same |

**Which one?** For a real competition with many competitors a **Linux server** is the better choice:
Docker runs natively (no virtual machine), uses less RAM, starts at boot without anyone logging in,
and the scripts are fully automatic. Windows is fine for a training room or a laptop.

### Machine B – competitor / trainer laptop

| Need | Notes |
|---|---|
| A modern browser | Chrome, Edge, Firefox |
| [Git](https://git-scm.com/downloads) | Only for competitors who push code (the Web IDE works without it) |
| Same network as Machine A | Same Wi-Fi / LAN |

Nothing else needs to be installed on Machine B (any OS).

---

## 3. Install on Machine A (the server)

Copy this whole folder to the server. Then follow **3A (Windows)** or **3B (Linux)**. Both scripts do
the same: check Docker, detect the server's LAN IP, generate a random admin code and MySQL password,
write `.env`, and optionally open the firewall and start everything.

### 3A. Windows server

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (keep *Use WSL 2 based
   engine* ticked), restart if asked, and start it once. In Docker Desktop *Settings → General*, tick
   **Start Docker Desktop when you sign in** so the platform comes back after a reboot.
2. Open **PowerShell as Administrator** in the project folder and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Firewall -Start
   ```

   * `-Firewall` opens TCP 80 and 3306 for Private/Domain networks (needs Administrator) and warns if
     your network is set to **Public** (other machines are then blocked – switch it to Private).
   * `-Start` runs `docker compose up -d --build`.
   * Other options: `-Ip 192.168.1.50` (if it picks the wrong IP), `-Port 8080` (if port 80 is taken),
     `-Force` (overwrite an existing `.env`).
3. Note the **Admin code** it prints (it is also in `.env`).

Without Administrator rights, run it without `-Firewall` and add the rules later as Administrator:

```powershell
New-NetFirewallRule -DisplayName "WorldSkills platform (HTTP)" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -Profile Private,Domain
New-NetFirewallRule -DisplayName "WorldSkills MySQL" -Direction Inbound -Protocol TCP -LocalPort 3306 -Action Allow -Profile Private,Domain
```

Windows notes: use the IPv4 address of the Wi-Fi/Ethernet adapter (`ipconfig`), not a `172.x`
WSL/Docker adapter – the script picks the adapter that has a default gateway. If the laptop sleeps,
the platform is unreachable: set *Power → Sleep: Never* while it serves a session.

### 3B. Linux server

1. Install Docker Engine + Compose (Ubuntu/Debian/Fedora/RHEL – one command), start it at boot and
   allow your user to use it:

   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo systemctl enable --now docker
   sudo usermod -aG docker $USER      # then log out and back in (or use sudo below)
   ```

2. In the project folder run:

   ```bash
   bash scripts/setup.sh --firewall --start
   ```

   * `--firewall` opens TCP 80 and 3306 in **ufw** (Ubuntu/Debian) or **firewalld** (Fedora/RHEL).
   * `--start` runs `docker compose up -d --build`.
   * Other options: `--ip 192.168.1.50`, `--port 8080`, `--force` (overwrite `.env`), `--help`.
3. Note the **Admin code** it prints (it is also in `.env`, readable only by you).

Linux notes:
* Copying the folder from Windows? Use `git`, `scp` or a zip – the scripts must keep Unix line
  endings (the included `.gitattributes` takes care of it with git). If `setup.sh` reports
  `$'\r': command not found`, run `sed -i 's/\r$//' scripts/setup.sh`.
* Ports 80/3306 taken: `sudo systemctl disable --now apache2 nginx mysql` (whatever the script
  reports), or use `--port 8080`.
* The platform restarts automatically after a reboot (Docker is enabled at boot and every container
  uses `restart: unless-stopped`).
* SELinux (Fedora/RHEL): the platform container needs the Docker socket, so `docker-compose.yml`
  sets `security_opt: [label:disable]` for it (only that container; ignored where SELinux is off).
  Nothing to do by hand.

### 3C. Manual `.env` (any OS)

Instead of the scripts you can copy `.env.example` to `.env` and edit it:

```ini
BASE_DOMAIN=192.168.1.50.nip.io     # <- your server IP + .nip.io
HTTP_PORT=80
ADMIN_CODE=48213957                 # the administrator's login code (digits only)
MYSQL_ROOT_PASSWORD=some-long-random-password
MYSQL_PORT=3306
BUILD_CONCURRENCY=2                 # parallel builds; others queue (see section 12)
NPM_MAXSOCKETS=                     # set to 1 if builds hang at "npm install"
IDLE_MINUTES=30                     # stop idle apps, wake on next request (0 = never)
```

then `docker compose up -d --build`.

> If the server's IP changes (e.g. DHCP), update `BASE_DOMAIN` and run `docker compose up -d` again.
> Give the server a fixed IP / DHCP reservation for competitions.

### 3D. Check it is running (both OS)

```bash
docker compose ps
docker compose logs -f platform
```

You should see `[platform] dashboard: http://192.168.1.50.nip.io`. The first start downloads images
and takes a few minutes. Open that address from Machine B to make sure the firewall lets it through.

### 3E. Pre-download build images (recommended, both OS)

The first deployment of each template downloads its base images. Do this once before a session so
competitors don't wait:

```bash
docker pull php:8.3-apache; docker pull node:20-alpine; docker pull node:20-slim; docker pull nginx:1.27-alpine; docker pull composer:2
```

(The same line works in PowerShell and bash.)

---

## 4. First login and setting up users (administrator)

1. On Machine A or B open `http://<SERVER-IP>.nip.io` (e.g. `http://192.168.1.50.nip.io`).
2. Enter the `ADMIN_CODE` from `.env`.
3. **Administration → Accounts → + New account**: create trainers and competitors.
   Each new account shows its **access code** – copy it and give it to the person. You can look it
   up again at any time in **Administration → Accounts** (see section 7).
   * Competitors get a 6-digit code, staff get 8 digits.
   * Competitors also get git credentials automatically; their git password is shown on
     their own dashboard the first time they log in.
4. Optional: **Trainer console → Announcements** to post instructions that every competitor sees.

---

## 5. Using it from Machine B (competitor)

### 5.1 Log in

Open `http://<SERVER-IP>.nip.io` in the browser and type your access code.

The dashboard shows: announcements, your git username, your **git password** (click **Show password** under *Git credentials* – it can be shown again any
time), your repositories, and a live **Recent pushes** feed with the commit messages of every
competitor's pushes (see 5.6).

### 5.2 Create a repository

**+ New repository** → choose a template → name it (e.g. `module-a`) → optional subdomain → Create.

The platform creates the git repository with starter code, a dedicated MySQL database and the
build setup. The status is **Awaiting first push**.

### 5.3 Clone, edit, push

Copy the **Git remote** from the repository card, then on Machine B:

```bash
git clone http://anna@192.168.1.50.nip.io/git/anna/module-a.git
```

When git asks for a password, paste the git password from your dashboard (Windows' Git Credential
Manager can remember it).

```bash
cd module-a
# ...edit files...
git add -A
git commit -m "My first change"
git push origin main
```

Watch the dashboard: **Queued → Building → Running**. Open the **Live URL**
(e.g. `http://module-a-anna.192.168.1.50.nip.io`).

No git? Use **Web IDE** on the repository card: edit files in the browser and click
**Commit & deploy** (Ctrl+S).

### 5.4 Logs, database, environment variables

| Button | What it does |
|---|---|
| **Logs** | Build output per deployment, or live application output (stdout/stderr) |
| **Database** | This repository's DB credentials, table browser, SQL box, link to phpMyAdmin |
| **Env vars** | Custom environment variables (e.g. `VITE_API_URL`, `API_KEY`); "Save & redeploy" applies them |
| **Deploy now / Retry deploy** | Rebuild the latest commit on `main` |
| **Edit subdomain** | Change the app's address (the app is redeployed) |
| **Delete** | Removes the repository, its containers and its database |

Every app automatically receives these environment variables:

| Variable | Value |
|---|---|
| `PORT` | Port the app must listen on (always read it, never hardcode) |
| `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | This repository's own database |
| `DATABASE_URL` | Same, as `mysql://user:pass@host:3306/db` |
| `APP_URL`, `PUBLIC_URL` | The app's public URL |

To connect from a desktop tool (HeidiSQL, DBeaver, VS Code) on Machine B use host
`<SERVER-IP>`, port `3306` and the repository's DB username/password.

### 5.5 Templates

| Template | What you get |
|---|---|
| **Static HTML / CSS / JS** | Plain files served by nginx – no PHP, no build step. `index.html`, `css/`, `js/`. Deploys in ~6 s. `/about` also serves `about.html`. `Dockerfile`, `README.md` and dot-files are not published. |
| **Static HTML/CSS/JS + PHP** | Apache + PHP 8.3, `pdo_mysql` + `pdo_sqlite`. Files in `public/`. |
| **Node.js / Express** | `server.js` reads `$PORT`, binds `0.0.0.0`, CORS on, REST starter, `mysql2` |
| **React (Vite)** | Real production build (`npm run build`) served by nginx – no dev server in production |
| **Laravel** | Latest Laravel, `.env.production` pre-filled with the repo's DB + generated `APP_KEY`, `php artisan migrate --force` on every deploy (a failing migration fails the deploy instead of being hidden) |

Pairing a React front end with an Express API: create both repositories, then on the React repo set
`VITE_API_URL=http://<api-subdomain>.<SERVER-IP>.nip.io` under **Env vars** and redeploy.

---

### 5.6 Recent pushes (everyone)

Every dashboard – competitors, trainers and administrators – has a **Recent pushes** feed that updates
every 5 seconds: who pushed, which repository, the short commit id, the **commit message** and the
deployment result. It lists `git push` and Web IDE commits (manual redeploys are not listed).
Only these details are shared: competitors still cannot open each other's code, databases, logs
or credentials. Write commit messages accordingly – everyone can read them.

---

## 6. Trainers

**Trainer console** (`#/trainer`):

* **Competitors** – everyone's repositories, deployment status, last push and **assessment status**
  (top line shows e.g. "4 of 12 assessed"; each row shows the status and how many of that competitor's
  repositories *you* have marked, e.g. "by you: 1 / 3 repos"). Click a competitor to:
  * open each live site, the **source code (read-only)** and the **database**;
  * read build and application logs;
  * see the full push/deployment history (click a commit to view the code at that commit);
  * mark **each repository** as assessed – see *Assessment marks* below;
  * **Reset access code** / **Rotate git password** (repositories are not affected);
  * **Manage repositories** – act on the competitor's dashboard (create/delete/redeploy) when needed.
* **Push feed** – the live feed of every competitor's push messages (larger version of 5.6).

**Assessment marks** (done / not done – **no score and no rank**):

* Marks are **per repository and per trainer**. On a competitor's page every repository card has a
  **Mark assessed by me** button (and **Remove my mark**). Several trainers can mark the same
  repository; each mark shows the trainer, the time and the **commit that was assessed** – click it to
  open the code exactly as it was then, even after the competitor pushes again.
* A trainer can only add or remove **their own** marks.
* The **competitor's status** is calculated automatically:

  | Status | Meaning |
  |---|---|
  | **Assessed** | every repository of the competitor has at least one trainer's mark |
  | **Partly assessed 1 / 3** | some repositories are marked |
  | **Not assessed** | none of the repositories is marked |
  | **No repositories** | the competitor has not created a repository yet |

* Marks are written to the audit log and are **never shown to competitors**. Deleting a repository
  deletes its marks (the status is recalculated); deleting a trainer account deletes that trainer's marks.
* **Announcements** – shown on every competitor's dashboard.

Trainer access is read-only for code: trainers do not push into a competitor's repository.

---

## 7. Administrators

**Administration** (`#/admin`):

* **Accounts** – create/delete competitors, trainers and admins; reset codes; rotate git passwords.
  The table **always shows every account's access code, git username and git password** with Copy
  buttons (only administrators can see this page; trainers and competitors cannot).
  * Codes and passwords are stored encrypted with the server secret (`/data/secret` inside the
    platform volume) – a copied `platform.db` alone does not reveal them. Back up the whole volume
    (section 8), not just the database, or the stored credentials cannot be decrypted.
  * Every time the Accounts table is opened, an entry `credentials.view` is written to the audit log.
  * Accounts created before this feature show *"not stored – reset code to view"*. Their **access
    codes can be recovered without changing them**: run
    `docker exec ws-platform node scripts/recover-codes.js` (a few seconds per competitor, ~4 min
    per staff account – it tries every possible code against the stored fingerprint). **Git
    passwords cannot be recovered** (long random strings): click **Rotate git** to issue a new one.
  * Competitors can also re-show their own git password on their dashboard at any time.
* **Timer** – the competition countdown, controlled **only by administrators**:
  * set a **title** (e.g. "Module A – Speed test") and a **duration** in minutes, then **Start**,
    **Pause / Resume**, **Reset** (optionally also clearing all extra time);
  * **+5 min / −5 min everyone** adjusts the running (or paused) timer for all competitors;
  * **Extra time per competitor**: +5 min, +10 min, *Other…* (any minutes, negative to remove) or
    **Clear**. Only that competitor's countdown is extended; the table shows each competitor's time left.
  * Every action is written to the audit log.

  Where the timer is shown:
  * **Public screen, no login:** `http://<SERVER-IP>.nip.io/timer` – put it full-screen (F11) on a
    projector/TV. Huge countdown with the title and status (*Not started / Running / Paused /
    Time is up*); it turns amber in the last 10 minutes and red at the end. Competitors with extra time
    are listed with their **own** countdown (only their name and extra minutes are shown).
  * **Each competitor's dashboard** shows their countdown, including their extra time
    ("Includes +10 min extra time for you").
  * All screens synchronise with the **server's clock**, so a laptop or TV with a wrong clock still
    shows the right time, and they keep counting if the network drops for a moment.
  * The timer does not block pushes when time is up (competitors can still push; the push history
    shows the time of every push).
* **Trainer locations** – set each trainer to **On the floor**, **In the marking room** or **Off duty**
  with one click (only administrators can change it; it is written to the audit log).
  The **public board** at `http://<SERVER-IP>.nip.io/board` shows who is where, **without login** –
  open it full-screen on a TV/projector in the room (F11). It refreshes every 5 seconds, shows a clock,
  and only ever shows trainer names and locations (no competitors, no other data). If the server
  cannot be reached it keeps the last view and says so.
* **Templates** – enable/disable templates. Templates live in `platform/templates/<id>/`
  (`template.json` + `files/`). Tokens such as `__WS_DB_NAME__`, `__WS_APP_URL__`, `__WS_APP_KEY__`
  are filled in per repository. After adding a template run `docker compose up -d --build`.
* **Infrastructure** – Docker/MySQL health, build queue, number of parallel build workers,
  idle scale-to-zero timeout, list of app containers.
* **Activity** – platform-wide deployment list and audit log (logins, pushes, deletes, resets…).

---

## 8. Day-to-day operations (Machine A)

These commands are the same in PowerShell (Windows) and bash (Linux), run in the project folder:

```bash
docker compose ps                 # status
docker compose logs -f platform   # platform log
docker compose stop               # stop everything (apps keep their data)
docker compose start              # start again
docker compose up -d --build      # apply .env or code changes
```

Data is kept in Docker volumes (`worldskills_platform-data` = git repos, logs, accounts;
`worldskills_mysql-data` = all databases). App containers are named `ws-app-*`.

Backup (same on Windows and Linux – writes `platform-data.tgz` and `mysql-backup.sql` into the
current folder):

```bash
docker run --rm -v worldskills_platform-data:/data -v "${PWD}:/backup" alpine tar czf /backup/platform-data.tgz -C /data .
docker exec ws-mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --all-databases > /tmp/mysql-backup.sql'
docker cp ws-mysql:/tmp/mysql-backup.sql mysql-backup.sql
```

(Do not use `docker exec ... > file.sql` in Windows PowerShell 5.1: it saves the dump as UTF-16 and
MySQL cannot restore it. The `docker cp` way above keeps the file byte-for-byte.)

Full reset (**deletes all repositories, accounts and databases**):

```powershell
# Windows (PowerShell)
docker compose down -v
docker ps -a --filter label=ws.repo -q | ForEach-Object { docker rm -f $_ }
```

```bash
# Linux (bash)
docker compose down -v
docker ps -a --filter label=ws.repo -q | xargs -r docker rm -f
```

---

## 9. Offline network (no internet)

nip.io needs DNS from the internet. On an isolated LAN:

* Pre-pull images (section 3.5) and create repositories while still online if possible.
* Point names at the server yourself. The hosts file (`C:\Windows\System32\drivers\etc\hosts`, edit as
  Administrator) has no wildcards, so add every name you use on **Machine B**:

  ```
  192.168.1.50  192.168.1.50.nip.io
  192.168.1.50  pma.192.168.1.50.nip.io
  192.168.1.50  module-a-anna.192.168.1.50.nip.io
  ```

* Better for many users: run a local DNS server (router, Pi-hole, dnsmasq) with a wildcard record
  `*.ws.lan → 192.168.1.50` and set `BASE_DOMAIN=ws.lan`.

npm/composer installs during builds still need internet unless you run a local package mirror.

---

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| Machine B can't open the dashboard | Firewall rule (3.4), network set to Private, both on the same LAN. Test `http://<SERVER-IP>` directly. |
| `xxx.nip.io` doesn't resolve | Some routers block DNS answers with private IPs ("DNS rebinding protection"). Use another DNS server on Machine B (e.g. 1.1.1.1) or the hosts-file method (section 9). |
| Pages under `*.nip.io` hang ~10 s or time out, but `http://<SERVER-IP>` works | The network uses **DNS64/NAT64** (common on phone hotspots and some ISP boxes): `Resolve-DnsName x.<IP>.nip.io` returns an IPv6 address like `64:ff9b::c0a8:6404` instead of your IPv4, and browsers try that first. Use a local DNS server with a wildcard record (section 9), the hosts file, or a DNS server without DNS64. Seen on the test network during the 200-user test (section 12). |
| Some competitors get "Too many wrong codes" | 10 **wrong** codes per minute from one IP lock that IP for a minute (correct logins never count, so a whole room behind one router is fine). Wait a minute. |
| Port 80 already in use | Set `HTTP_PORT=8080` in `.env`, run `docker compose up -d`, open `http://<SERVER-IP>.nip.io:8080`. Git remotes include the port automatically. |
| `git push` asks for a password repeatedly / 401 | Use the git username and the git password from the dashboard (**Show password**). An administrator can also read it in **Administration → Accounts**. Clear stale credentials: Windows *Credential Manager → Windows Credentials → git:http://…*. |
| Deployment **Failed** | Click **Logs** → Build output. The error is at the end, followed by the app's own output. The previous version is still live. Fix, commit, push (or **Retry deploy**). |
| "App did not start listening on $PORT" | Your app must listen on `process.env.PORT` / `$PORT` and on `0.0.0.0`, not `localhost`. |
| Laravel deploy fails at "Running migrations" | A migration has an error – this is intentional, errors are never hidden. Read the log, fix the migration, push again. |
| App page says "Starting…" | It was idle and is waking up (scale-to-zero); the page refreshes itself. |
| Copy buttons don't work | Browsers restrict clipboard on plain HTTP; select the text manually. |
| Platform logs `MySQL is not reachable` | `docker compose logs mysql`; first start of MySQL can take a minute. |

---

## 11. Project layout

```
docker-compose.yml        platform + MySQL + phpMyAdmin
.env.example              configuration template
scripts/setup.ps1         Windows server setup (Docker check, IP, secrets, firewall, start)
scripts/setup.sh          Linux server setup (same, for ufw/firewalld)
platform/
  Dockerfile              Node 22 + git + docker CLI
  src/server.js           HTTP entry: dashboard / API / git / subdomain proxy
  src/api.js              REST API (dashboard, trainer, admin)
  src/git.js              git smart-HTTP server (per-competitor namespaces)
  src/builder.js          build queue + zero-downtime deploys
  src/proxy.js            subdomain routing + scale-to-zero
  src/mysql.js            one database + one user per repository
  src/templates.js        template scaffolding
  public/                 dashboard web app (no build step)
  templates/              static-html, static-php, node-express, react-vite, laravel
```

### Security notes for local use

This setup is meant for a trusted training LAN. Traffic is plain HTTP (no TLS) and app containers
build arbitrary competitor code on the server's Docker engine. For an internet-facing deployment put
a TLS-terminating reverse proxy (e.g. Caddy/Traefik with a wildcard certificate) in front of port 80
and run the server on a dedicated machine.

Other isolation notes: every app container is on the same Docker network as MySQL and the
platform. Database access is isolated by MySQL users (each repo's user can only see its own
database – verified), but an app can technically open an HTTP connection to another app's
container by name. Competitor code is never run with access to the Docker socket.

---

## 12. Capacity: can it handle 200 competitors at the same time?

**Yes, on one machine like the test laptop, with the caveats below.** Measured on 2 October 2026 on
the development laptop (12 CPU threads, 16 GB RAM, Windows 11 + Docker Desktop), with 200
simulated competitors all acting at the **same moment** (script: one test client playing all 200).

| What all 200 did at once | Result |
|---|---|
| Log in | 200/200 OK, all within 2.5 s |
| Create a repository (git repo + own MySQL database + own MySQL user each) | 200/200 OK, slowest 25 s |
| `git clone` | 200/200 OK, slowest 24 s |
| `git push origin main` (deadline rush) | 200/200 accepted, nothing dropped |
| Build queue | 182 builds queued at peak; every competitor saw their queue position and an ETA (position 182 was told "~11 min"); **all 200 deployed and Running after 9 min** with 6 build workers |
| Dashboards open and polling every 4 s during all of the above | 27 000+ requests, median 26 ms, p95 0.2 s, **0 server errors** |
| RAM with 200 live sites | apps ≈ 2 GB total (~10 MB per static site), platform ≈ 200 MB, MySQL ≈ 380 MB |

The test was run twice. In the second run the test client talked to the server by IP (no DNS) to
separate the platform from the network:

| Opening all 200 live sites at the same instant | Result |
|---|---|
| Through the platform only (server IP + Host header) | **200/200 served their own page, all within 2.2 s** |
| DNS only: 200 different `*.nip.io` names looked up at once, on the test Wi-Fi | all resolved, but each took **40–58 s** |
| Browser-like (DNS + platform) | 101/200 within 10 s – the rest waited on DNS |

So the platform handles 200 competitors; on that network **public DNS (nip.io) was the bottleneck**.
Dashboard polling in the second run: 25 540 requests, 1 failed connection, median 26 ms (one
34 s outlier at the moment the test laptop itself was running 200 `git push` processes).

What limits you, in order:

1. **Build time during a rush.** Builds are queued, never dropped, but they take time. A static site
   builds in ~6 s, Node ~25 s, React ~50 s, Laravel ~1–2 min (5 min the very first time, while
   images download). With `BUILD_CONCURRENCY=2` (default) 200 React pushes take ≈ 200 × 50 s / 2 ≈ 80 min.
   Raise **Administration → Infrastructure → Concurrent builds** to about half your CPU threads
   (6 on a 12-thread machine, 8–12 on a server) before a competition.
2. **RAM for running apps.** Measured per running app (idle, after test traffic): Static HTML 10 MB,
   React 10 MB, PHP/Apache 12 MB, Node/Express 13 MB, Laravel 38 MB. Under real traffic Apache/PHP
   and Laravel start extra worker processes and grow (plan ~50–150 MB for a busy Laravel app).
   200 competitors × 3 apps of mixed types ≈ 5–15 GB plus build memory → a **32 GB RAM** server is
   comfortable; 16 GB works with scale-to-zero on (`IDLE_MINUTES`, stops apps nobody visited
   recently). Each app is capped at 1 GB.
3. **DNS.** With nip.io every device asks the internet for every app name. On the test network
   (DNS64/NAT64) a burst of 200 new names caused lookups to return an unusable IPv6 address and
   ~10 s timeouts – the platform itself was fine. **For 200 people use a local DNS server with a
   wildcard record** (section 9: router / Pi-hole / dnsmasq, `*.ws.lan → server IP`,
   `BASE_DOMAIN=ws.lan`). This also removes the internet dependency.
4. **Network.** One wired gigabit server is plenty; 200 laptops on one Wi-Fi access point is not –
   use several access points or wired tables.

Database: MySQL is started with `max_connections=2000` (default 151 would run out with hundreds of
apps holding connections).

---

## 13. Verification against the specification

The whole platform was tested end-to-end on 2 October 2026 with an automated script that creates
real accounts, pushes real code with git, and inspects the live sites (99 checks across all five templates). Final result:
**99/99 checks pass**. Summary per specification section:

| Specification requirement | Verified |
|---|---|
| Roles: competitor / trainer / admin, competitors cannot reach trainer/admin API | ✅ |
| 6-digit competitor codes (8-digit staff), git credentials auto-provisioned | ✅ |
| Credentials "shown once" | ⚠️ changed on purpose: administrators can now view all codes and git passwords any time (stored encrypted, every view audited) – see section 7 |
| Competitor A cannot see B's repositories, credentials, database or git namespace | ✅ |
| New repository from template → git repo with starter code + build setup, no manual CI | ✅ |
| `git push` → automatic build & deploy; states Awaiting / Queued / Building / Running / Failed + Retry | ✅ |
| Queue shows position and estimated wait | ✅ |
| Failed deploy keeps the previous version live; error + app output shown in the log | ✅ |
| Build log and application log viewers | ✅ |
| **Audit defect 1** – one database (and one MySQL user) per repository, never shared | ✅ each repo user sees only its own DB |
| **Audit defect 1** – migration errors surfaced, not swallowed | ✅ a broken Laravel migration fails the deploy, old version stays live |
| **Audit defect 2** – React returns 200 on its own domain (no 403) | ✅ |
| **Audit defect 3** – PHP template has `pdo_mysql` + `pdo_sqlite`, connects to its DB | ✅ |
| **Audit defect 4** – React serves a minified production bundle via nginx, no dev server/HMR | ✅ |
| Node: reads `$PORT`, binds 0.0.0.0, REST starter, CORS on | ✅ |
| Laravel: `.env.production` with own DB credentials + generated `APP_KEY`, migrations every deploy | ✅ |
| Env-vars UI per repository (reaches the app after redeploy; `PORT` cannot be overridden) | ✅ |
| Web IDE: edit, commit & deploy; path-traversal rejected | ✅ |
| Edit subdomain (reserved names refused), delete repository (container + DB removed) | ✅ |
| Trainer: all competitors, read-only source, database, logs, push history | ✅ |
| Trainer cannot push into a competitor's repo (403) | ✅ |
| Modules, countdown timer, rubrics and trainer scoring | ➖ removed on request (October 2026) – replaced by the live push feed (5.6) and per-repository, per-trainer assessment marks (section 6) |
| Rotate git password / reset access code (repos unaffected, old sessions logged out) | ✅ |
| Announcements, audit log (no credentials logged), infrastructure health, phpMyAdmin | ✅ |
| **TLS on every public URL** | ❌ not built in – plain HTTP on the LAN (see Security notes) |

---

## 14. Questions and answers

**Does it use GitLab (or GitHub / Gitea)?** No. The platform contains its own small git server
(`platform/src/git.js`, standard git "smart HTTP"). Competitors use normal `git clone` / `git push`
against the platform; repositories are stored in the `worldskills_platform-data` volume. There is no
GitLab-style web UI (merge requests, issues) – the dashboard's Web IDE, commit history and trainer
console replace it. Nothing needs to be installed besides Docker.

**Windows or Linux for the server?** Both are supported and tested (section 3). Linux is
recommended for competitions (native Docker, less RAM, starts at boot unattended); Windows with
Docker Desktop is fine for training rooms. Competitor/trainer machines can run any OS.

**Which template for a plain website?** *Static HTML / CSS / JS* – just files, no PHP, no build.

**Where are the competitors' database passwords?** In the dashboard (Database button) and injected
into the app as `DB_*` variables. They are never written to the audit log.

**Why were passwords "shown once" before, and why can old accounts not show them?** The
specification asked for credentials to be shown once, so the platform originally stored only one-way
hashes (it could check a code but never display it again). On request this was changed: codes and git
passwords are now also stored **encrypted** so administrators can always look them up. Accounts
created before this change have only the hash – click **Reset code** / **Rotate git** once and the new
values appear in the table.

---

## 15. Changes made during the October 2026 review

* **Removed modules, rubrics, countdown timer and trainer scoring** (dashboard, trainer console, API).
  The old database tables (`modules`, `assignments`, `rubric_criteria`, `assessments`,
  `assessment_scores`) are left in place, unused, so no data was deleted. Unknown `/api/...` paths now
  answer 404.
* **Competition timer:** Administration → Timer (title, duration, start/pause/resume/reset, ±5 min for
  everyone, extra time per competitor), public no-login screen at `/timer` (`GET /api/public/timer`),
  countdown on each competitor's dashboard; clocks synchronised to the server.
* **Trainer locations + public board:** Administration → Trainer locations (On the floor / In the
  marking room / Off duty) and a no-login board at `/board` for a screen in the room
  (`GET /api/public/board` returns only trainer names, locations and since-times).
* **Windows and Linux server setup.** New `scripts/setup.sh` for Linux (Docker checks, IP detection,
  secrets, `--firewall` for ufw/firewalld, `--start`); `scripts/setup.ps1` for Windows upgraded the same
  way (`-Firewall`, `-Start`, `-Force`, starts Docker Desktop if needed, port-conflict warning). Section 3
  now has separate Windows (3A) and Linux (3B) instructions. `docker-compose.yml` sets
  `security_opt: label:disable` on the platform so it works with SELinux. Backup commands in section 8
  fixed for Windows PowerShell (the old one produced an unusable UTF-16 dump). **Tested:** both scripts
  (Windows PowerShell 5.1 and Ubuntu), and a full install on a clean Linux Docker Engine with
  `setup.sh --start` where all five templates deployed from `git push` (PHP and Node connected to
  their databases, React production build, Laravel migrations).
* **Assessment marks per repository and per trainer** (no score, no rank): each trainer marks each
  repository; the mark stores the trainer, time and assessed commit; the competitor's status
  (Assessed / Partly assessed x/y / Not assessed) is derived from all repositories. Hidden from
  competitors. API: `PUT /api/repos/:id/assessment`. (An earlier single per-competitor mark was replaced
  by this; its unused columns `users.assessed_at/assessed_by` are left in place.)
* **Live "Recent pushes" feed for everyone** (competitor dashboard + trainer console → Push feed):
  every competitor's commit messages with deploy result, refreshed every 5 s (`GET /api/pushes`).
* **Credentials always visible to administrators** (Administration → Accounts: access code, git user,
  git password, Copy buttons). Stored AES-256-GCM-encrypted, views audited, admin-only. Competitors
  can re-show their own git password any time. The "new password" banner no longer keeps a plain-text
  copy in the database.
* **New template: Static HTML / CSS / JS** (nginx, no PHP, no build; internal files not published).
* **200-user readiness:** MySQL `max_connections` 151 → 2000; git password checks no longer block
  the server (asynchronous, briefly cached – a clone is several requests); login rate-limit now counts
  only wrong codes (a room of competitors behind one router could lock itself out before); template
  list cached instead of re-read from disk on every dashboard poll.
* **Dashboard fixes:** "Log out" button no longer shows on the login screen; repository-name field
  validation works in current browsers (its pattern was rejected by Chrome/Edge); Dockerfile syntax
  highlighting in the Web IDE (missing CodeMirror add-on); a build that hits the 20-minute limit now
  says "timed out" instead of "exit code null".
* **Trainer console crash fixed:** right after logging in as a trainer the page could show
  *"Cannot read properties of null (reading 'addEventListener')"*. Logging in navigates twice in a row
  and both pages rendered at the same time; navigations now run one at a time (only the newest one).
