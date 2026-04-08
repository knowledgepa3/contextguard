# ContextGuard Release Runbook

The end-to-end steps for cutting a new release of `contextguard-ai` on
npm. Written after the `0.2.0-sprint1` release (2026-04-07) so the next
one takes 10 minutes instead of 2 hours of discovery.

---

## 0. When to use this

Use this runbook **every time** you publish a new version to npm. Even
patch releases. It is short on purpose.

Do NOT use this runbook for:
- Internal-only testing builds (just `npm run build`, don't tag or publish)
- Security patches that need to skip the CHANGELOG step (there's a
  shorter emergency path in §10)

---

## 1. Prerequisites (one-time setup per machine)

### 1.1 npm account

Published as **`knowledgepa3`**. If you need to log in from a new
machine (or this shell lost its credentials):

```bash
cd venture-forge/contextguard
npm login --auth-type=web
```

`--auth-type=web` opens the browser OAuth flow. Sign in at
<https://www.npmjs.com/login> when prompted. 2FA is on the account —
approve the code on your phone. After success:

```bash
npm whoami    # should print: knowledgepa3
```

Credentials are cached in `~/.npmrc`. Don't commit that file anywhere.

### 1.2 git access

Remote is `https://github.com/knowledgepa3/contextguard.git`. Clone or
push access must be working — test with `git status` and
`git fetch origin`.

### 1.3 Node + tooling

- Node 18 or newer (package.json enforces `>=18.0.0`)
- `npm` that ships with Node is fine
- `tsc` comes from devDependencies via `npm install`

---

## 2. Version policy

ContextGuard follows semver with sprint milestone pre-releases:

| Version shape         | When to use                                                     |
|-----------------------|-----------------------------------------------------------------|
| `0.X.Y`               | Stable release. Default install gets this.                     |
| `0.X.Y-sprintN`       | Sprint milestone on the road to `0.X.0`. Published to `next`.  |
| `0.X.Y-alpha.N`       | Experimental / unstable. Published to `next` or a custom tag.  |
| `0.X.Z` (Z > 0)       | Patch: bug fix on the current stable line, no new features.    |

Rules:

1. Minor bump (`0.1 → 0.2`) for **any new feature** that changes the
   public API or adds a new capability users can opt into. Revive was
   a minor bump.
2. Patch bump (`0.2.0 → 0.2.1`) for **bug fixes only** that do not
   change the API shape. The `--out` parser fix alone would have been
   a patch.
3. Pre-release suffix (`-sprintN`) **always goes to `npm publish --tag
   next`**, never `latest`. This keeps the "plain install" experience
   stable for existing users while shipping milestones for people who
   want to try them.
4. Drop the pre-release suffix **only when the full minor is done**.
   `0.2.0-sprint1` → `0.2.0-sprint2` → `0.2.0` (final).
5. Keep `REVIVE_VERSION` in `src/revive/index.ts` in sync with
   `package.json`. (Sprint 3 cleanup: read it from package.json at
   runtime instead of hardcoding.)

---

## 3. Pre-release checklist

Do these **before** you touch `package.json`. Stop on the first red.

```bash
cd venture-forge/contextguard

# 3.1 Clean working tree
git status --short         # should be empty
git rev-parse HEAD          # note this, it's the base you're releasing from

# 3.2 Strict type check
npx tsc --noEmit            # must exit 0

# 3.3 Clean build from scratch
rm -rf dist
npm run build               # must exit 0

# 3.4 Regression: recall suite (synthetic fixtures)
node dist/revive/eval/recallSuite.js
# must report: "All fixtures passed" and anchor recall 100%

# 3.5 Real-session smoke test (catches extraction drift, ghost anchors,
# and any performance regression on large input)
node dist/cli.js revive \
  "C:/Users/knowl/.claude/debug/revive-smoke-2026-04-07/session.jsonl" \
  --sparkling --out /tmp/release-smoke.compact.jsonl --json \
  | grep -E '"chainGrade"|"chainApproved"|"lostByWeight"'
# must show: "chainGrade": "A", "chainApproved": true,
# and lost { high: 0, moderate: 0, low: 0 }
```

If any step fails — **stop**. Diagnose, fix, commit the fix as its own
commit, then restart the checklist. Do not bundle a "fix this so we can
release" patch into the release commit itself — it makes the git
history confusing.

---

## 4. Write the release

### 4.1 Pick the version

Decide per §2 (version policy). Write the target version on a sticky
note or scratch file — you'll type it several times in the next steps.

For this guide the placeholder is `$VERSION` (e.g. `0.2.0-sprint2`).

### 4.2 Bump `package.json`

Edit `package.json` and change the `"version"` field to `$VERSION`.
Nothing else. Don't touch dependencies or scripts.

### 4.3 Regenerate the lockfile

```bash
npm install --package-lock-only
```

This syncs `package-lock.json` with the new `package.json` version
without actually installing or changing any dependencies. Verify:

```bash
node -e "const l=require('./package-lock.json'); \
  console.log('lock:', l.name, l.version); \
  const p=require('./package.json'); \
  console.log('pkg:', p.name, p.version);"
```

Both should print the same name (`contextguard-ai`) and version.

### 4.4 Update `CHANGELOG.md`

Add a new section at the top, under the heading, **above** the previous
entry:

```markdown
## [$VERSION] — YYYY-MM-DD

Brief 1–2 sentence summary of the release theme.

### Added
- New capability 1
- New capability 2

### Fixed
- Bug A (with root cause reference to a docs/ file if applicable)
- Bug B

### Changed
- API shape change, deprecation, etc.

### Known
- Sprint N+1 residuals still pending
- Known limitation X that ships unfixed
```

Every entry should be specific enough that a user reading only the
CHANGELOG understands what to expect. Reference docs (e.g.
`docs/SPRINT-2-DRIFT-DIAGNOSIS.md`) for deep root-cause discussions
instead of inlining them.

### 4.5 Keep `REVIVE_VERSION` in sync

Edit `src/revive/index.ts`:

```ts
const REVIVE_VERSION = '$VERSION';
```

(Sprint 3 TODO: make this read `package.json` at runtime so we don't
have to remember.)

### 4.6 Final build + verification

```bash
npx tsc --noEmit           # still must be clean
npm run build              # still must be clean
node dist/revive/eval/recallSuite.js   # still must pass
```

---

## 5. Commit + tag

### 5.1 Commit

```bash
git add package.json package-lock.json CHANGELOG.md src/revive/index.ts
git status --short          # sanity: should be these 4 files only

git commit -m "Release $VERSION — <one-line theme>

<3-6 line body describing the main changes, matching the CHANGELOG top
entry. Reference commit hashes for the features being shipped if they
landed in earlier commits.>

Co-Authored-By: <if AI-assisted>"
```

### 5.2 Tag

Use **annotated** tags (`-a`) not lightweight. Annotated tags carry
author, date, and message metadata, which matters for reproducible
releases.

```bash
git tag -a v$VERSION -m "<brief tag message matching commit theme>"
```

### 5.3 Push commit + tag

```bash
git push origin master
git push origin v$VERSION
```

Confirm on GitHub that the tag exists at
<https://github.com/knowledgepa3/contextguard/releases/tag/v$VERSION>.

---

## 6. Dry-run the publish

**Always dry-run first.** It takes 2 seconds and catches 90% of
avoidable mistakes.

```bash
npm publish --dry-run
```

Things to verify in the output:

1. `name: contextguard-ai` (not `contextguard`)
2. `version: $VERSION` (matches what you wrote)
3. `filename: contextguard-ai-$VERSION.tgz`
4. Total files: roughly the same order of magnitude as last release
   (last was 103). A 10× change means something is wrong with the
   `files` field in `package.json` or `.npmignore`.
5. Package size roughly the same (last was 100 KB). A 10× jump means
   you're accidentally shipping `node_modules`, `dist` tests, or
   `.contextguard/` manifests.
6. No source files under `src/` in the file list (only `dist/`,
   `README.md`, `LICENSE`, `package.json`). If you see `src/`, the
   `files` field is wrong.

Abort the release if anything looks off.

---

## 7. Publish

For **pre-release** versions (`-sprintN`, `-alpha.N`):

```bash
npm publish --tag next
```

For **stable** versions (no pre-release suffix):

```bash
npm publish           # defaults to --tag latest
```

Post-publish, verify:

```bash
npm view contextguard-ai versions    # should include the new version
npm view contextguard-ai dist-tags   # should show: latest = X, next = $VERSION
```

---

## 8. Post-publish smoke test

Install the freshly published version in a scratch directory and run a
real command.

```bash
mkdir -p /tmp/cg-release-check && cd /tmp/cg-release-check
npm init -y >/dev/null
npm install contextguard-ai@next      # or contextguard-ai for stable

npx contextguard-ai --help             # should print the CLI help
npx contextguard-ai revive \
  "C:/Users/knowl/.claude/debug/revive-smoke-2026-04-07/session.jsonl" \
  --sparkling --out /tmp/cg-release-check/smoke.compact.jsonl --json \
  | grep '"chainGrade"'
# must print: "chainGrade": "A"

cd - && rm -rf /tmp/cg-release-check
```

If this fails after the publish succeeded, the tarball is broken. See
§9 (rollback).

---

## 9. Rollback / unpublish

npm strongly discourages unpublishing, and you only have a 72-hour
window where it's allowed at all. **Prefer publishing a follow-up
patch** over unpublishing.

### 9.1 Deprecate a broken version (preferred)

```bash
npm deprecate contextguard-ai@$VERSION \
  "Broken release — use contextguard-ai@$NEWVERSION instead"
```

Then immediately cut a new patch release via the full runbook.
`npm install contextguard-ai` will still succeed but users see a
deprecation warning.

### 9.2 Actual unpublish (last resort, <72h only)

```bash
npm unpublish contextguard-ai@$VERSION
```

You **cannot** republish the same version number after unpublishing.
You must bump to a new version. This also requires a GitHub tag
cleanup:

```bash
git tag -d v$VERSION
git push origin :refs/tags/v$VERSION
```

### 9.3 Git-only rollback (release committed but not published)

If you caught the problem after commit but before `npm publish`:

```bash
git reset --hard HEAD~1           # destructive — only if not pushed
# OR
git revert HEAD && git push       # safe, creates a revert commit
git push origin :refs/tags/v$VERSION     # only if tag was pushed
git tag -d v$VERSION
```

---

## 10. Emergency patch path (security only)

For urgent security fixes where the full CHANGELOG + runbook is
overkill:

1. Fix the bug. Test it. Commit it with a normal "fix: …" commit.
2. Bump patch version (`0.2.1 → 0.2.2`).
3. Minimal CHANGELOG: `## [0.2.2] — YYYY-MM-DD` + one line "Fixes CVE-X
   / security issue in Y".
4. Commit as `Security: bump to 0.2.2 for <one-line>`.
5. Tag + push.
6. `npm publish` (no `--tag next` — security fixes go to `latest`).
7. Then **after** shipping, write up the full root cause and file it
   under `docs/`.

Skipping steps 3.4 and 3.5 of the checklist is acceptable only if you
have direct unit tests proving the fix works and nothing else broke.

---

## 11. Release notes on GitHub (optional but recommended)

After `npm publish`, mirror the CHANGELOG entry to a GitHub Release:

1. Go to <https://github.com/knowledgepa3/contextguard/releases/new>
2. Choose the tag you just pushed
3. Title: `ContextGuard $VERSION — <theme>`
4. Description: paste the CHANGELOG entry for this version
5. If this is a sprint milestone (`-sprintN`), check **"Set as a
   pre-release"**
6. Publish release

GitHub Releases show up on the repo homepage and give users a single
place to see what changed release-to-release. They are distinct from
the npm registry view.

---

## 12. Checklist — tear-off short version

```
[ ] 1. Clean working tree, current HEAD noted
[ ] 2. npx tsc --noEmit               → exit 0
[ ] 3. rm -rf dist && npm run build   → exit 0
[ ] 4. Recall suite                   → 100% anchors, Grade A on all
[ ] 5. Real-session smoke             → Grade A, 0 lost
[ ] 6. Bump package.json version
[ ] 7. npm install --package-lock-only
[ ] 8. Update CHANGELOG.md (top entry)
[ ] 9. Update REVIVE_VERSION in src/revive/index.ts
[ ] 10. Final tsc + build + recall
[ ] 11. git add the 4 files
[ ] 12. git commit -m "Release $VERSION — …"
[ ] 13. git tag -a v$VERSION
[ ] 14. git push origin master
[ ] 15. git push origin v$VERSION
[ ] 16. npm publish --dry-run          → verify name/version/size/files
[ ] 17. npm publish --tag next    (pre-release)
        OR
        npm publish                    (stable)
[ ] 18. npm view contextguard-ai dist-tags  → verify
[ ] 19. Install in scratch dir + run revive → Grade A
[ ] 20. Create GitHub Release (optional)
```

Tape that to the wall. Release day becomes a 15-minute ritual instead
of a 2-hour archaeology expedition.
