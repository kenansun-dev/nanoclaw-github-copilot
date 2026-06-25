# Release Packaging Convention

> Single source of truth for how we build, name, and hand off `.tgz` packages.
> Both agents (Rpi5 Claw + VM Claw) read this on `git pull`. If you change the
> convention, update this file in the same PR.

## Why this exists

We were producing tarballs with **different names and different commit SHAs**
for the "same" release (e.g. `nanoclaw-v2-fb2cb979-...` vs
`nanoclaw-v2-084778c3-...`). Root cause: one agent packed from the **feature
branch HEAD** (pre-merge) and the other from **main after the squash-merge**.
A squash-merge creates a *new* commit on `main`, so the branch SHA never equals
the deployed SHA. The package SHA must match what actually ships.

## The rules

1. **Always pack from `main`, after the PR is merged.** Never pack from a
   feature branch. The SHA in the filename must be the squash-merge commit that
   landed on `main`.

   ```bash
   git checkout main
   git pull origin-dev main
   git log --oneline -1        # this short SHA goes in the filename
   ```

2. **Build before packing** (no stale `dist/`):

   ```bash
   npm run build               # tsc + container sync; 0 errors required
   ```

   If `git diff --stat <prev-main>..main -- container/` is non-empty, the
   consumer also needs a docker rebuild — note that in the handoff message.

3. **Pack with `npm pack`, never hand-rolled `tar`.** npm pack honors the
   `files[]` whitelist and produces the required `package/` prefix that
   `npm install -g <tgz>` expects.

   ```bash
   npm pack --pack-destination /tmp/
   ```

4. **Filename format** (rename the npm-pack output):

   ```
   nanoclaw-<track>-<YYYYMMDD>-<main-sha8>.tgz
   ```

   - `<track>`: `v2` for the current v2 line (bump when the release line changes).
   - `<YYYYMMDD>`: pack date in local time.
   - `<main-sha8>`: first 8 chars of the `main` HEAD commit (rule 1).

   Example: `nanoclaw-v2-084778c3-20260625.tgz`

5. **Verify before handing off:**

   ```bash
   tar -tzf <tgz> | head -2    # must show `package/...` prefix
   sha256sum <tgz>             # paste in the handoff message
   ```

6. **Delivery path on Discord:** copy into `~/.openclaw/workspace/tmp/` (the
   `MEDIA:` path validator rejects `/tmp/`). Post the `MEDIA:` line + the
   sha256 + the install command.

## Ownership (per kenan, 2026-04-27)

- **Rpi5 Claw** owns deploy + tarball packaging by default.
- **VM Claw** owns code by default; only packs when kenan explicitly hands the
  deploy/pack lane over (Rpi5 down/busy).
- Whoever packs follows this file. One package per release, one agreed name.

## Quick reference (the whole flow)

```bash
cd ~/gitrepos/nanoclaw-github-copilot
git checkout main && git pull origin-dev main
SHA=$(git rev-parse --short=8 HEAD)
npm run build
npm pack --pack-destination /tmp/
cp /tmp/nanoclaw-github-copilot-*.tgz \
   ~/.openclaw/workspace/tmp/nanoclaw-v2-${SHA}-$(date +%Y%m%d).tgz
tar -tzf ~/.openclaw/workspace/tmp/nanoclaw-v2-${SHA}-*.tgz | head -2
sha256sum ~/.openclaw/workspace/tmp/nanoclaw-v2-${SHA}-*.tgz
```
