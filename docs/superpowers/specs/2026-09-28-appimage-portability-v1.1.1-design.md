# AppImage Portability and v1.1.1 Release Design

## Goal

Publish a traceable `v1.1.1` patch release with complete platform assets while fixing the Linux AppImage launcher permissions, lowering the Linux glibc baseline, and correcting the archive fallbacks reported in issue #8. The release must fail before publication if the AppImage contains an inaccessible launcher or cannot start in the AppImage catalog's sandbox model.

## Confirmed failure

The `v1.1.0` AppImage was built with Tauri CLI 2.11.4 on GitHub's `ubuntu-latest`, which resolved to Ubuntu 24.04. The AppImage catalog test found two independent problems:

1. Tauri's x86_64 AppImage helper was cached with mode `0770`; after the GTK hook renamed it, `AppRun.wrapped` was not executable by a different user. Firejail mounts the image as root and starts it as an unprivileged user, producing `Permission denied`.
2. Building on Ubuntu 24.04 linked the application against glibc 2.39, excluding older supported Linux distributions.

The application source and archived user data are not implicated in either failure.

## Release approach

Create a new `v1.1.1` release instead of replacing the existing `v1.1.0` asset. All supported platform packages are rebuilt so the application version remains consistent across Windows, macOS, Linux, Android, iOS, and NixOS. Existing release assets remain immutable and auditable.

Changes travel through a short-lived `ci/appimage-portability-v1.1.1` branch and a reviewed pull request before merging to `main`. The release tag is created only from the merged `main` commit.

## Linux build changes

The Linux CI jobs use `ubuntu-22.04` explicitly instead of `ubuntu-latest`. This establishes a glibc 2.35 build baseline rather than inheriting the newer runner image.

Before `tauri build`, CI downloads the architecture-specific Tauri `AppRun` helper into the Tauri tool cache and applies mode `0755`. Tauri reuses this cached helper, and linuxdeploy may rename it to `AppRun.wrapped` without losing world-execute permission.

The workaround is narrowly scoped to the known upstream defect and can be removed after the Tauri bundler ships and the project adopts a verified fix.

## Packaging verification

The Linux job installs `squashfs-tools` and runs a repository script against the generated AppImage. The script:

- verifies that the file is a type-2 AppImage and obtains its SquashFS offset;
- lists the embedded filesystem without mounting it;
- requires `AppRun` and, when present, `AppRun.wrapped` to be executable by owner, group, and others (`0755` or an equivalent mode with all execute bits);
- rejects a required glibc symbol newer than `GLIBC_2.35`;
- extracts the image and starts it under an isolated X display long enough to verify that the process does not immediately exit with a launcher error.

The release workflow uploads no Linux package when any verification fails. The same verification runs in the normal CI build so regressions are detected before tagging.

## Versioning and assets

Update application and package metadata from `1.1.0` to `1.1.1`, including the JavaScript package files, Tauri configuration, Rust package metadata and lockfile, mobile project metadata, and Nix hashes only where the dependency graph requires it.

The release must contain the same platform coverage as `v1.1.0`:

- Windows x64 installer;
- macOS Apple Silicon and Intel disk images;
- Linux x86_64 AppImage, Debian package, and RPM package;
- Android universal APK;
- unsigned iOS arm64 IPA;
- NixOS x86_64 archive.

Release notes describe the Linux packaging correction and the archive fallback changes. The local database schema and existing user data format remain unchanged.

## Archive fallback update

The mobile interaction endpoint may return a Tencent WAF 501 page even while authenticated desktop endpoints remain usable. This exact response is treated as an unavailable optional interaction channel after current visible moments and legacy history have been attempted; it no longer discards successful desktop-channel work or marks the entire task as failed.

Legacy history parsing requires the current account nickname to distinguish the account's original post text from notification text. When the visible-moment response cannot provide that nickname, the archive task resolves the owner UIN through `cgi_get_portrait.fcg` before parsing history cards. If the nickname still cannot be established, the history channel reports a specific safety error instead of silently counting scanned cards while writing zero rows.

## GitHub and AppImage catalog follow-up

After every release asset is present and its checksum is reported by GitHub, download and independently inspect the published AppImage rather than relying only on the workflow artifact.

The AppImage catalog pull request is then retriggered or updated so its automation downloads `v1.1.1`. A concise PR comment should state that the launcher permission and glibc baseline were corrected and link to the new release. Replying to the notification email itself is unnecessary because it is only a GitHub notification transport.

## Failure handling

- If Ubuntu 22.04 cannot satisfy the current WebKit dependency, the release stops; it does not silently fall back to Ubuntu 24.04. A dedicated older-runtime container is the fallback design.
- If the upstream Tauri fix becomes available during implementation, the explicit cache workaround remains until the produced AppImage passes the permission check.
- If any platform build fails, `v1.1.1` remains unpublished rather than presenting an incomplete asset set as a finished release.
- Existing `v1.1.0` assets are never deleted or overwritten.

## Acceptance criteria

1. Local static checks and repository tests pass.
2. CI proves `AppRun` and `AppRun.wrapped` are executable by an unrelated user.
3. The AppImage requires no glibc symbol newer than 2.35.
4. The application survives the automated Linux launch smoke test and creates a window or remains running without a launcher error.
5. `main` contains the reviewed fix and identifies itself as version `1.1.1`.
6. GitHub Release `v1.1.1` contains the complete expected platform asset set.
7. The published AppImage passes an independent post-release inspection and the AppImage catalog check is retriggered.
