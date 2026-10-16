# AGENTS.md

This document describes the project and the conventions for working in this repository. It is
written for both AI agents and human collaborators, and it is the entry point: read it before
making changes.

---

## Project Overview

**拾忆 (qzone-memory)** is a cross-platform desktop / mobile tool that archives QQ Zone
feeds, photos, videos and interaction records to the local machine.

- **Tech stack**: Tauri 2 + Rust backend; Vue 3 + TypeScript + Vite + PrimeVue 4 + Pinia
  frontend; SQLite local storage
- **Target platforms**: Windows / macOS / Linux desktop, plus Android and iOS
- **License**: GPLv3

## Architecture

### Data source and its hard limits

Archiving is based on QQ Zone's **mobile interaction list API**
(`mobile.qzone.qq.com/get_feeds`). That endpoint returns interaction notifications for the
current account — new feeds from friends, likes, comments, replies, messages — and the
application reconstructs original feed content from them.

Three sources are merged: the currently visible feed API, desktop personal interaction
history (`feeds3_html_more`, scope=1), and the mobile interaction list. Legacy
`feeds2_html_pav_all` is used only when the desktop route is unsupported (404/405), not
as a retry after WAF or an authentication failure. Desktop history uses a separate
`history-desktop-v1` checkpoint containing only numeric pagination fields; never persist
advertising cookies or authentication fields from `externparam`. Scope=0 is a friends
stream and must not be substituted for personal recovery. Records are merged by feed ID,
QQ number and event time. A completed desktop scan does not prove the supplementary
mobile channel completed: a mobile WAF response retains partial status and cooldown.

**Feeds that were never liked or commented on cannot be recovered**, because they never appear
in the interaction list. This is a property of the upstream API, not a limitation of the code.
Never present archive results as complete or as a substitute for a server-side backup.

### Login

- **QR code** — drives QQ Zone's mobile scan-to-login flow; the password is never handled.
- **Web login** (desktop only) — opens an independent window with the QQ login page and reads
  credentials through the WebView cookie API.

Login credentials live in Rust memory while the app runs. Login IPC returns only the QQ
account identity; nickname and bounded avatar lookup use native `get_login_user` without
returning cookies or derived tokens to JavaScript. Only the minimal restorable session is
persisted: on supported desktop platforms it goes into the operating system credential
store (macOS Keychain / Windows Credential Manager / Linux Secret Service), or an authenticated
AES-GCM ciphertext file in Android's no-backup directory with a non-exportable Android Keystore
key. Android vault commands are called through the Rust native bridge, never frontend IPC.
**Credentials must never be written to SQLite, frontend storage, console output or logs.**

Reading persisted QQ credentials is provisional: `get_login_status` returns `restored`, not
`success`. The frontend confirms the session through native profile lookup before displaying
a logged-in identity. Explicit QQ authentication failures clear the displayed identity;
network failures and HTTP 501 use an unverified state and retain the saved credentials.
Focus and visible foreground checks revalidate the session with throttling. These checks
must never delete local archives or recovery checkpoints.

### License layer

The application includes a commercial activation layer. It is split in two:

- `src-tauri/license-core/` — pure verification logic: token parsing, Ed25519 signature
  checking, expiry, grace period, replay and clock-rollback rules. It deliberately has **no
  Tauri dependency** so it can be unit-tested on its own, which is why it is a separate crate.
- `src-tauri/src/license.rs` — the integration layer: device identity, credential storage, HTTP
  calls to the activation server, and the command guards.

Command guards run as the first statement of each command: `require_archive_access()` for
anything that writes, archives, or talks to Tencent's servers; `require_read_access()` for
local browsing, search and export.

**The client-side check is a UX layer, not a security boundary.** This client is GPLv3 and its
source is public — anyone can build a variant with the guard removed. What cannot be forged is
the server-signed token. Accordingly:

- Never describe the local check as protection in user-facing text or documentation.
- Never make a user's *existing local data* depend on licence state. A lapsed or revoked licence
  may restrict starting new archive runs; it must never lock someone out of archives they
  already have on disk.

### Client updates

The client checks for updates at startup and every six hours while visible. New releases show
their notes before the user starts an in-app package download. Optional background package
downloads are disabled by default. Downloading never installs or silently replaces the app.
The user opens the downloaded package and completes the system installer. Android uses a narrow
FileProvider and the OS unknown-app-source permission; iOS retains the external download path.

- **Manifest**: `GET <server>/api/v1/update/latest`, returning `version` / `notes` / `pub_date` /
  `download_page` / `platforms`. **204 means "no update"** — either nothing is published or the
  reported client version is already current.
- Native Rust selects the current `platforms` package. New manifests include `size`, `sha256`
  and `file_name`. Downloads validate length, SHA-256 when supplied, and package type. Older
  HTTPS manifests without a digest remain compatible. This is transport/file integrity checking,
  not minisign verification or unattended installation.
- The manifest request runs in Rust, with a 10-second timeout and a 512 KiB response limit.
  It accepts no endpoint argument or QQ credentials from the frontend; WebView CSP stays narrow.
- Deployment constants — the update endpoint, the fallback download page, the licence server
  address and the embedded verification public key — are **not** written into the source. They are
  read at build time by `src-tauri/build.rs` and generated into `qza_config.rs`. Resolution order:
  compile-time environment variable (`QZA_UPDATE_ENDPOINT`, `QZA_DOWNLOAD_PAGE`,
  `QZA_LICENSE_SERVER`, `QZA_LICENSE_PUBLIC_KEY`) → `src-tauri/qza.config.local.json` (untracked,
  holds a machine's real values) → `src-tauri/qza.config.json` (tracked, holds placeholders).
  The public repository ships placeholders, so a clone builds and runs but cannot activate. When
  all four resolve to placeholders `build.rs` emits a warning and sets `CONFIG_IS_PLACEHOLDER`, and
  the licence layer surfaces "本构建未配置授权服务器" instead of letting the user guess at a generic
  network error. Publishing a real build means supplying `qza.config.local.json` on the build
  machine; never commit one.

Server side, `QZA_DOWNLOAD_PAGE` remains a fallback. Published file digests are streamed and
cached without a database schema migration. Publishing does not require minisign signatures.
Release steps: [docs/RELEASE-AUTO-UPDATE.md](docs/RELEASE-AUTO-UPDATE.md).
Release notes format and wording: [docs/RELEASE-NOTES.md](docs/RELEASE-NOTES.md). One source file
feeds the in-app update dialog, the GitHub release body, `CHANGELOG.md` and the README line; never
edit those four by hand, the next release overwrites them.

### Frontend design system

All styling flows through `src/styles/tokens.css`, which is the single source of design
variables for the whole app. Non-negotiable rules:

- **No hardcoded colours, radii, spacing or shadows.** Use the tokens. The only tolerated
  exception is documented in place with a comment explaining why (currently: the QR code
  canvas, which must stay white or it stops scanning).
- **Use the primitives in `src/components/ui/`** — `SectionCard`, `EmptyState`,
  `SkeletonBlock`, `StatTile`, `ToastHost` — instead of re-styling containers per page.
- **Page styles live in that component's own `<style scoped>`.** There is no global page
  stylesheet, and there should not be one again.
- **Icons come from `lucide-vue-next`**, imported by name, `:stroke-width="1.8"`. The remaining
  `pi pi-*` usages are PrimeVue `Button` `icon` props; do not add new ones.
- **Every data surface implements loading / empty / error states.** Empty states must explain
  *why* there is nothing and offer a next step.
- **Never fabricate data or progress.** If the backend does not provide a total, show an
  indeterminate indicator rather than an invented percentage. If nothing has loaded yet, show a
  skeleton rather than a zero.

`docs/UI-REFACTOR-SPEC.md` holds the full contract, including the responsive requirements.

## Project Structure

```
├── docs/                   # Design and refactor contracts
├── src/                    # Vue frontend
│   ├── views/              # Page components
│   │   ├── DashboardView   # Overview: stats, interaction ranking, memory hero
│   │   ├── ArchivesView    # Feed timeline: browse, search, export, delete
│   │   ├── MediaView       # Media timeline grouped by year
│   │   ├── LibraryView     # Albums / photos / videos / guestbook / favorites
│   │   ├── ContactsView    # Contacts and per-contact comment threads
│   │   ├── TasksView       # Archiving tasks, progress and skip recovery
│   │   ├── RecycleBinView  # Album recycle bin recovery
│   │   ├── SettingsView    # Appearance, account, data, about
│   │   └── ActivationView  # Licence activation gate
│   ├── components/         # Shared components
│   │   └── ui/             # Design-system primitives
│   ├── composables/        # Composition functions (useToast)
│   ├── stores/             # Pinia: app, auth, archive, license, recycle
│   ├── utils/              # Backend bindings and helpers
│   ├── layouts/            # AppShell: sidebar + toolbar + content
│   ├── router/             # Vue Router configuration
│   └── styles/             # tokens.css + base.css (nothing else)
├── src-tauri/              # Rust backend
│   ├── license-core/       # Licence verification logic, independently unit-tested
│   └── src/
│       ├── main.rs         # Entry point
│       ├── lib.rs          # Tauri command registration and setup
│       ├── license.rs      # Device identity, credentials, HTTP, command guards
│       ├── media_http.rs   # Credential-safe media requests (domain allowlist)
│       ├── qlogin.rs       # QQ login (QR code + web)
│       ├── qzone.rs        # QQ Zone API client
│       ├── archive.rs      # Archiving engine + database
│       └── updater.rs      # Update manifest endpoint and download page
└── src-tauri/capabilities/ # Tauri permission configuration
```

## Development

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) 1.77+
- [Node.js](https://nodejs.org/) 20+
- Windows: [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (bundled with
  Windows 10+)
- Android: [Android Studio](https://developer.android.com/studio) + Android SDK + NDK

### Commands

```bash
npm install                 # install frontend dependencies
npm run tauri dev           # desktop development
npm run build               # type-check + build the frontend
npm run tauri:build:windows # Windows NSIS installer
npm run tauri android dev   # Android development
```

```bash
cargo fmt --check           # Rust formatting
cargo check                 # Rust type check
cargo test                  # run tests, including license-core
```

## Verification

Before submitting a change, run what applies:

- **Frontend**: `npm run build` (runs `vue-tsc --noEmit && vite build`)
- **Rust**: `cargo fmt --check` and `cargo check`
- **Licence logic**: `cargo test --manifest-path src-tauri/license-core/Cargo.toml`
- **Documentation site**: `npm --prefix website run build`

A change is not done until these pass. If you cannot run them — for example because the
environment lacks a linker or a GUI — say so explicitly rather than implying verification
happened.

## Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- **Format**: `type(scope): summary`
- **Types**: `feat`, `fix`, `docs`, `refactor`, `test`, `ci`, `chore`
- **Summary**: one concise sentence in the imperative mood, no more than 72 characters
- **Example**: `feat(archive): support incremental sync`

## Branching

- Create short-lived branches from the latest `main`.
- Naming: `docs/<topic>`, `feat/<topic>`, `fix/<topic>`, `ci/<topic>`.
- **Do not push directly to `main`**; all changes go through Pull Request review.

## Pull Request

- One PR addresses one clearly defined issue.
- Title follows Conventional Commits.
- Description explains motivation, changes, verification commands, and risks or migration
  impact.
- Link related issues; user-visible changes should include screenshots or a recording.
- Before merging, all required checks must pass, and the PR must not contain unrelated
  formatting or generated files.

## Security and Safety Notes

- Only archive content from accounts you own or are authorised to archive.
- Do not switch the QQ client account while archiving; it risks account freezing.
- When rate-limit prompts appear frequently, continue at a later time — the app supports
  resumable archiving.
- QQ video signatures expire; re-archiving refreshes the URLs.
- Data lives in the application data directory by default. Recommend users back up important
  material separately.
- Login credentials must never be logged, written to SQLite or plain files, or added to
  frontend persistence. Desktop persistence goes through the OS credential store only, and must
  be cleared on logout or full app-data deletion.
- Do not add analytics, telemetry, remote uploads or third-party tracking without the user's
  explicit consent.

## Scope of this fork

This repository is a GPLv3 derivative of
[Gaoshu705/QzoneArchive](https://github.com/Gaoshu705/QzoneArchive). Upstream authors, the
referenced projects, and Tencent do not endorse or warrant this fork. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Disclaimer

This software is a local tool for organising and backing up personal QQ Zone material. It is not
affiliated with, authorised by, or partnered with Tencent, QQ, QQ Zone, or any related entity.
Users should operate within the scope of their legal authorisation and assume all usage risks.
See the in-app "Disclaimer and Usage Notes" for details.

## Additional Resources

- Contribution workflow: [CONTRIBUTING.md](CONTRIBUTING.md)
- UI contract: [docs/UI-REFACTOR-SPEC.md](docs/UI-REFACTOR-SPEC.md)
- Project README: [README.md](README.md)
- License: [LICENSE](LICENSE)
