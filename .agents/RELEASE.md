# Release & Packaging Conventions (multi-agent)

> **Audience:** the agents working this fork (Kenan VM Claw, Kenan Rpi5 Claw,
> any future agent). Read this **before** merging, building, or packaging a
> release.
>
> **Why this file exists (2026-06-25):** we shipped tarballs with **different
> names and different commit SHAs for the same release** — one agent packed
> from the **feature-branch HEAD** (`fb2cb979`, pre-merge), the other from
> **`main` after the squash-merge** (`084778c3`). A squash-merge creates a
> *new* commit on `main`, so the branch SHA never equals the deployed SHA. The
> package must carry the SHA that actually ships. Owner asked: pick one way,
> write it down where everyone reads it.
>
> **Location note:** this lives in `.agents/` (matches owner's "dotfolder like
> `.claude`/`.github`" ask). Our fork's `main` has no `.agents/` of its own;
> upstream has only a `.agents/skills` symlink, which this file does not
> collide with — so adding files here never causes an upstream merge conflict.

---

## 0. Golden rule: ONE agent owns a given merge/release. Coordinate first.

Before you `git merge` / `npm pack` / deploy, post in the channel: **"I'm
taking the merge+pack for PR #N"**. Wait ~10s for objection. If the other agent
already claimed it, you do the **review/verify** half, not a second merge. Two
agents must never both merge the same PR or both pack the same release. (This
doc itself was almost the third duplicate — don't.)

## 1. Merge style: **squash, via the PR** (not local `--no-ff`)

- Merge through the GitHub PR using **Squash and merge**. One PR = one commit
  on `main`, titled `<type>(scope): summary (#N)`.
- Do **not** `git merge --no-ff <branch>` locally and push — it bypasses the
  PR, double-merges when the other agent squashes, and produces divergent
  history.
- After squash-merge: delete the branch.
- If the PR was already squash-merged, do **not** also push a local merge of
  the same branch. Verify `git diff <pr-squash> <your-local>` is empty and drop
  your local merge.

## 2. Build from a clean, merged `main` (never a feature branch)

> ⚠️ **Remote-alias footgun:** the fork remote is named DIFFERENTLY per machine
> — on VM it's `origin`, on Rpi5 it's `origin-dev`. Both point at the SAME
> canonical fork org: **`kenansun-dev/nanoclaw-github-copilot`**. Match on that
> full org/repo path, NOT the bare repo name: Rpi5 also has a stale
> `kenans/nanoclaw-github-copilot` remote (`kenans-vm`) that a bare-name regex
> wrongly picks first. And NEVER pull `main` from the `qwibitai/nanoclaw`
> upstream — that's the pollution this convention prevents. The resolver below
> self-checks; if it can't find the canonical fork, stop and fix your remotes.

```bash
# Resolve the remote that points at the canonical fork (org-qualified, not bare name).
FORK=$(git remote -v | awk '/kenansun-dev\/nanoclaw-github-copilot.*\(fetch\)/{print $1; exit}')
if [ -z "$FORK" ]; then echo "ERROR: no kenansun-dev fork remote — fix git remotes"; exit 1; fi
echo "fork remote = $FORK"   # VM: origin   |   Rpi5: origin-dev
git checkout main && git pull --ff-only "$FORK" main
git status --porcelain          # MUST be empty — no stray prettier reformats
git log --oneline -1            # this main short-SHA goes in the filename
npm ci                          # lockfile-exact, not `npm install`
npm run build                   # tsc + container sync; 0 errors required
npx tsc --noEmit                # 0 errors
npm test                        # all green before packaging
```

- **Always pack from `main`, after the PR is merged.** The SHA in the filename
  must be the squash-merge commit that landed on `main`, not the branch HEAD.
- If `git diff --stat <prev-main>..main -- container/` is non-empty, the
  consumer also needs a **docker rebuild** — say so in the handoff message.
- Never pack with a dirty working tree.

## 3. Package: **`npm pack` only**, then rename to the canonical format

- Use `npm pack` (honors `files[]` whitelist + produces the required
  `package/` prefix that `npm install -g <tgz>` expects). Never hand-roll `tar`.
- Inner runner `node_modules` are installed by the **postinstall hook**
  (`scripts/postinstall.mjs`) at install time, so they are NOT in the tarball —
  this is correct. Do **not** hand-add them to `files[]` or stuff them in
  before packing (that's what made the two tarballs differ in size).
- **Rename the npm-pack output to the canonical filename:**

  ```
  nanoclaw-<track>-<YYYYMMDD>-<main-sha8>.tgz
  ```

  - `<track>`: `v2` for the current v2 line (bump when the release line changes).
  - `<YYYYMMDD>`: pack date, local time (date first → sorts chronologically).
  - `<main-sha8>`: first 8 chars of the **`main` HEAD** commit (§2).

  Example: `nanoclaw-v2-20260625-084778c3.tgz`

## 4. Verify, then record in `.agents/RELEASES.log`

```bash
tar -tzf <tgz> | head -2        # must show `package/...` prefix
sha256sum <tgz>                 # transfer-integrity check + handoff message
```

> ⚠️ **`npm pack` is NOT byte-reproducible.** It bakes file mtimes into the
> gzip, so the same `main` commit packed twice — even on the same machine,
> seconds apart — yields a **different tgz sha256** while the contents (file
> list + sizes) are identical. Verified 2026-06-25: `084778c3` packed three
> times gave `3e1d6c62`, `19c8670f`, `7fcaccee` — all same content. So the tgz
> sha256 is a **transfer-integrity checksum only** (did the bytes arrive intact
> / unswapped), NOT a build-identity or "is my tree clean" signal. The build
> identity is **`main` short-sha + content manifest** (`tar -tzf` file list +
> sizes), not the tgz sha256. Don't treat a differing tgz sha for the same
> `main` as "dirty tree" — that's expected.

Append **one line** per packed-and-handed-off tarball (newest at bottom) so
both agents can see what was shipped and re-verify integrity on receipt:

```
<ISO-date>  v<version>  main=<short-sha>  sha256=<tgz-sha256>  by=<agent>
```

The **`main` short-sha is the build identity**; the tgz sha256 is for transfer
integrity only (see the npm-pack note above). To check two tarballs are the
same build, compare `main`-sha + `tar -tzf <tgz> | sort` (file list + sizes),
not the tgz sha256 — those differ on every pack and that's normal.

## 5. Deliver + deploy

- **Discord handoff:** copy the tgz into `~/.openclaw/workspace/tmp/` (the
  `MEDIA:` path validator rejects bare `/tmp/`). Post the `MEDIA:` line + the
  sha256 + the install command.
- **Deploy:** `nanoclaw update --package <tgz>` (or `npm install -g <tgz>`).
- **Then verify, don't assume:** one spawn-and-respond test, not just
  `nanoclaw --version`. On Windows specifically, after a few cron/heartbeat
  tasks confirm `(Get-Process node).Count` is not climbing (the leak the
  2026-06-24 release fixes).
- **After a `-g` install, check inner runner deps exist** (`container/
  agent-runner-ghc/node_modules/@github/copilot-sdk` and the `agent-runner`
  one). If postinstall didn't complete them, `cd` into each and
  `npm install --omit=dev`.

## Ownership (per kenan, 2026-04-27)

- **Rpi5 Claw** owns deploy + tarball packaging by default.
- **VM Claw** owns code by default; only packs when kenan explicitly hands the
  deploy/pack lane over (Rpi5 down/busy).
- Whoever packs follows this file. One package per release, one agreed name.

---

## TL;DR checklist

1. Claim the merge/pack in channel; one agent only.
2. Squash-merge via the PR; delete branch. No local `--no-ff` push.
3. Clean **merged `main`** (not a feature branch): `npm ci`, build, tsc, test — all green, tree clean.
4. `npm pack`, then rename → `nanoclaw-<track>-<YYYYMMDD>-<main-sha8>.tgz`. Don't hand-add inner `node_modules`.
5. `tar -tzf` check `package/` prefix; `sha256sum`; append one line to `.agents/RELEASES.log`.
6. Copy to `~/.openclaw/workspace/tmp/`, post `MEDIA:` + sha256 + install cmd. Deploy, then spawn-verify.
