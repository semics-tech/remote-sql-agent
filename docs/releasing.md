# Releasing

Three distribution routes come out of one tag: npm, container registries, and
GitHub Releases. `.github/workflows/release.yml` drives all of them, and
nothing publishes until the tagged commit has passed lint, typecheck, unit
tests and `pnpm audit --audit-level high`.

## What gets published

| Route | Artefact | Who it is for |
|---|---|---|
| npm | `@remote-sql-agent/protocol` | Anyone building against the wire contract |
| npm | `@remote-sql-agent/worker` | Hosts that already run Node 24 |
| Docker Hub | `semics/remote-sql-agent` | Running the control plane |
| GHCR | `ghcr.io/semics-tech/remote-sql-agent/control-plane` | The same image, same digest |
| Release | `rsagent-worker-{linux-x64,win-x64.exe,darwin-arm64}` | Hosts with nothing installed |
| Release | `rsagent-worker-<version>-win-x64.zip` | Windows service install via `install.ps1` |
| Release | `rsagent-worker-<version>-linux-x64.tar.gz` | systemd install |
| Release | `rsagent-worker-<version>.mjs` | The bare bundle |
| Release | `SHA256SUMS` | Verifying any of the above |

The server and dashboard are not published to npm. They ship as the container
image, which is why their `package.json` files are `private`.

## Cutting a release

```bash
pnpm release:version 0.2.0      # or 0.2.0-rc.1
```

That writes one version to every manifest and to `WORKER_VERSION` in
`packages/worker/src/index.ts`. Versions move in lockstep: the worker, the
control plane and the protocol are one system speaking one wire format to
itself, and the release job refuses to publish if any of them disagrees with
the tag.

Then:

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a heading for this
   version.
2. Read the diff and commit.
3. `git tag v0.2.0 && git push origin v0.2.0`.

### Prereleases

A version containing a hyphen is treated as a prerelease throughout:

- npm publishes it under the `next` dist-tag, so `npm install` keeps returning
  the last stable release
- Docker gets the exact version tag only — `latest` and `<major>.<minor>` do
  not move
- The GitHub release is marked as a prerelease

**Cut an `-rc.1` before the first stable release of anything.** A publish
pipeline that has never run is not a publish pipeline that works, and npm
versions cannot be reused after they are unpublished.

## Secrets the workflow needs

| Secret | Used by | Notes |
|---|---|---|
| `DOCKERHUB_USERNAME` | container job | |
| `DOCKERHUB_TOKEN` | container job | A Docker Hub **access token**, not the account password |

There is deliberately **no `NPM_TOKEN`**. npm publishing uses trusted
publishing: the workflow's `id-token: write` permission mints a short-lived
OIDC token that npm exchanges for publish rights, scoped to this repository and
this workflow file. Nothing long-lived exists in the repository to leak,
expire, or forget to rotate, and provenance is generated automatically as a
side effect.

`GITHUB_TOKEN` is supplied automatically and covers GHCR and the release
upload.

### The bootstrap problem

Trusted publishing is configured **per package, on a package that already
exists**. A package that has never been published has no settings page to
configure, so OIDC cannot perform a package's first publish. This is a known
chicken-and-egg in npm's design, not something wrong with this setup.

So each new package name needs one manual publish, once, ever:

```bash
npm login                       # interactive, 2FA; no token is stored anywhere

cd "$(mktemp -d)"
for pkg in protocol worker; do
  mkdir -p "$pkg" && cd "$pkg"
  cat > package.json <<JSON
{
  "name": "@remote-sql-agent/$pkg",
  "version": "0.0.0",
  "description": "Placeholder to enable trusted publishing. See https://github.com/semics-tech/remote-sql-agent",
  "license": "Apache-2.0"
}
JSON
  npm publish --access public
  cd ..
done
```

`0.0.0` on purpose: it is below any real release, it is published from a
scratch directory so nothing in this repository is touched, and it means every
version anyone actually installs was published by CI with provenance. Deprecate
it once the first real release is out:

```bash
npm deprecate "@remote-sql-agent/protocol@0.0.0" "Placeholder. Use 0.1.0 or later."
npm deprecate "@remote-sql-agent/worker@0.0.0"   "Placeholder. Use 0.1.0 or later."
```

### Configuring the trusted publisher

On npmjs.com, for **each** of the two packages — Settings → Trusted Publisher:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `semics-tech` |
| Repository | `remote-sql-agent` |
| Workflow filename | `release.yml` |
| Environment | leave empty |
| Allowed actions | `npm publish` |

The workflow filename is matched exactly, so **renaming
`.github/workflows/release.yml` breaks publishing** until both packages are
updated to match. Adding a third published package means repeating this for it;
until then its release job will fail with a 404, which is what an
unauthenticated publish looks like.

Requires pnpm 10.20 or later — pnpm implements the OIDC exchange itself, and
this repository pins `pnpm@10.23.0` via `packageManager`.

A manual `workflow_dispatch` run defaults to `dry_run: true`: it builds
everything, including the executables, and publishes nothing. That is the way
to test a change to this workflow.

## Why the executables are built on three runners

`build:sea` embeds the Node runtime that is executing it, then injects the
bundled worker with `postject`. Injecting into a runtime downloaded for another
platform does work, but the macOS result then has to be re-signed with tooling
only macOS has — and an unsigned binary being installed as a service on a
database server is exactly what a security review should refuse. So the release
matrix builds each target on its own OS.

The signature applied is ad-hoc (`codesign --sign -`). It makes the binary
runnable on macOS; it does not make it trusted. Distribution signing and
notarisation are a separate, credential-bearing step that this project does not
do yet.

Each build runs the binary it produced with `--rsagent-selftest` before
uploading it. A failed injection leaves behind a perfectly healthy copy of
`node`, which looks entirely correct until someone tries to use it.

## Verifying a published artefact

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify rsagent-worker-linux-x64 --repo semics-tech/remote-sql-agent
```

npm packages carry provenance, visible on the package page. The container image
has a build attestation pushed to GHCR:

```bash
gh attestation verify oci://ghcr.io/semics-tech/remote-sql-agent/control-plane:0.2.0 \
  --repo semics-tech/remote-sql-agent
```

## Before the first publish

1. Create the `@remote-sql-agent` npm organisation
2. Bootstrap-publish the two `0.0.0` placeholders, as above
3. Configure a trusted publisher on each package
4. Create the Docker Hub repository `semics/remote-sql-agent`, and add
   `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`
5. Run the Release workflow manually with `dry_run: true` and read the output.
   `workflow_dispatch` only fires from the default branch, so this cannot be
   tested from a pull request
6. Cut `v0.1.0-rc.1` and install it from each of the three routes on a machine
   that has never built this repository

Step 6 is not optional ceremony. A publish pipeline that has never run is not a
publish pipeline that works, and **npm versions cannot be reused** — an
unpublished version number is spent for good.
