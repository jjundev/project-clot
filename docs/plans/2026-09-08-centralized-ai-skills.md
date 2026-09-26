# Centralized AI Skills (SSOT) Setup & Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a Git-tracked Single Source of Truth directory (`~/.ai-skills`) containing updated Superpowers (v6.3.0), Caveman (v2.6.0), and all existing custom skills, symlinked to Claude Code, Codex, and Gemini/Antigravity skill paths.

**Architecture:** Centralized repository pattern with POSIX filesystem symbolic links (`ln -s`). All AI agents resolve their global skills through symlinks pointing to `~/.ai-skills`, ensuring single-command updates (`git pull` or `sync-upstream.sh`) apply instantly everywhere.

**Tech Stack:** Bash, Git, Agent Skills Standard (`SKILL.md` with YAML frontmatter), POSIX Symlinks

## Global Constraints

- **Zero Data Loss**: Existing user custom skills (`ask-dc`, `write-dc`, `ajou-bb`, `hwp-to-pdf`, `moebius-loop`, `toss-investment`, `wattly-install`, `wattly-run`, `concept-explain`, `audio-stt`, etc.) must be 100% preserved.
- **Defensive Backup**: Existing `~/.gemini/config/skills`, `~/.claude/skills`, and `~/.codex/skills` directories must be backed up as timestamped `.bak_<YYYYMMDD_HHMMSS>` folders before replacing them with symlinks.
- **Pin Upstream Releases**: Superpowers pinned to release `v6.3.0` (`obra/superpowers`), Caveman pinned to release `v2.6.0` (`JuliusBrussee/caveman`).
- **Idempotency & Reversibility**: Each task must be independently verifiable and cleanly rollbackable by repointing or restoring backed up directories.

---

### Task 1: Initialize Centralized Skills Repository and Consolidate Existing Skills

**Files:**
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/` (Git repository)
- Copy: `/Users/hyunjun_macbook_pro/.gemini/config/skills/*` -> `/Users/hyunjun_macbook_pro/.ai-skills/`

**Interfaces:**
- Consumes: Existing skill files in `/Users/hyunjun_macbook_pro/.gemini/config/skills/`
- Produces: Initialized Git repository at `/Users/hyunjun_macbook_pro/.ai-skills/` containing initial commit of all existing skills

- [x] **Step 1: Create directory and initialize Git**

```bash
mkdir -p /Users/hyunjun_macbook_pro/.ai-skills
cd /Users/hyunjun_macbook_pro/.ai-skills
git init
git branch -M main
```

- [x] **Step 2: Copy all existing skills from Gemini/Antigravity into centralized directory**

```bash
cp -R /Users/hyunjun_macbook_pro/.gemini/config/skills/* /Users/hyunjun_macbook_pro/.ai-skills/
```

- [x] **Step 3: Verify all skills and custom scripts copied cleanly**

```bash
# Verify key custom skills are present
ls -d /Users/hyunjun_macbook_pro/.ai-skills/ask-dc \
      /Users/hyunjun_macbook_pro/.ai-skills/write-dc \
      /Users/hyunjun_macbook_pro/.ai-skills/ajou-bb \
      /Users/hyunjun_macbook_pro/.ai-skills/hwp-to-pdf \
      /Users/hyunjun_macbook_pro/.ai-skills/moebius-loop \
      /Users/hyunjun_macbook_pro/.ai-skills/toss-investment
```
Expected: All paths exist without error.

- [x] **Step 4: Create baseline Git commit**

```bash
cd /Users/hyunjun_macbook_pro/.ai-skills
git add -A
git commit -m "feat: initialize centralized ai-skills repository with existing skills"
```

---

### Task 2: Install Caveman v2.6.0 Skills

**Files:**
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/caveman/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/cavecrew/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/caveman-commit/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/caveman-review/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/caveman-compress/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/caveman-stats/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/caveman-help/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/investigate-first/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/lean-build/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/surgical-patch/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/safe-refactor/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/migration/`
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/verify-and-stop/`

**Interfaces:**
- Consumes: GitHub release tag `v2.6.0` from `JuliusBrussee/caveman`
- Produces: Caveman skills in `/Users/hyunjun_macbook_pro/.ai-skills/`

- [x] **Step 1: Shallow clone Caveman v2.6.0 into a temporary staging folder**

```bash
rm -rf /tmp/caveman-v2.6.0
git clone --depth 1 --branch v2.6.0 https://github.com/JuliusBrussee/caveman.git /tmp/caveman-v2.6.0
```

- [x] **Step 2: Copy skills from Caveman repository into `~/.ai-skills`**

```bash
cp -R /tmp/caveman-v2.6.0/skills/* /Users/hyunjun_macbook_pro/.ai-skills/
# Clean up temporary clone
rm -rf /tmp/caveman-v2.6.0
```

- [x] **Step 3: Verify Caveman skills and frontmatter**

```bash
ls -d /Users/hyunjun_macbook_pro/.ai-skills/caveman \
      /Users/hyunjun_macbook_pro/.ai-skills/cavecrew \
      /Users/hyunjun_macbook_pro/.ai-skills/caveman-commit \
      /Users/hyunjun_macbook_pro/.ai-skills/caveman-review \
      /Users/hyunjun_macbook_pro/.ai-skills/investigate-first \
      /Users/hyunjun_macbook_pro/.ai-skills/surgical-patch
head -n 6 /Users/hyunjun_macbook_pro/.ai-skills/caveman/SKILL.md
```
Expected: All directories exist and `caveman/SKILL.md` displays `name: caveman`.

- [x] **Step 4: Commit Caveman skills to Git**

```bash
cd /Users/hyunjun_macbook_pro/.ai-skills
git add -A
git commit -m "feat: add caveman v2.6.0 skills"
```

---

### Task 3: Upgrade Superpowers Skills to v6.3.0

**Files:**
- Modify: `/Users/hyunjun_macbook_pro/.ai-skills/writing-plans/`
- Modify: `/Users/hyunjun_macbook_pro/.ai-skills/subagent-driven-development/`
- Modify: `/Users/hyunjun_macbook_pro/.ai-skills/executing-plans/`
- Modify: `/Users/hyunjun_macbook_pro/.ai-skills/using-git-worktrees/`
- Modify: `/Users/hyunjun_macbook_pro/.ai-skills/finishing-a-development-branch/`
- Modify: `/Users/hyunjun_macbook_pro/.ai-skills/requesting-code-review/`
- Modify: `/Users/hyunjun_macbook_pro/.ai-skills/receiving-code-review/`
- Modify: `/Users/hyunjun_macbook_pro/.ai-skills/dispatching-parallel-agents/`
- Add/Update: `/Users/hyunjun_macbook_pro/.ai-skills/brainstorming/`
- Add/Update: `/Users/hyunjun_macbook_pro/.ai-skills/test-driven-development/`
- Add/Update: `/Users/hyunjun_macbook_pro/.ai-skills/systematic-debugging/`
- Add/Update: `/Users/hyunjun_macbook_pro/.ai-skills/writing-skills/`
- Add/Update: `/Users/hyunjun_macbook_pro/.ai-skills/verification-before-completion/`

**Interfaces:**
- Consumes: GitHub release tag `v6.3.0` from `obra/superpowers`
- Produces: Fully updated Superpowers v6.3.0 skills in `/Users/hyunjun_macbook_pro/.ai-skills/`

- [x] **Step 1: Shallow clone Superpowers v6.3.0 into a temporary staging folder**

```bash
rm -rf /tmp/superpowers-v6.3.0
git clone --depth 1 --branch v6.3.0 https://github.com/obra/superpowers.git /tmp/superpowers-v6.3.0
```

- [x] **Step 2: Copy updated Superpowers skills into `~/.ai-skills`**

```bash
cp -R /tmp/superpowers-v6.3.0/skills/* /Users/hyunjun_macbook_pro/.ai-skills/
# Maintain alias compatibility if existing skills used abbreviated names like tdd or diagnosing-bugs
cp -R /tmp/superpowers-v6.3.0/skills/test-driven-development/* /Users/hyunjun_macbook_pro/.ai-skills/tdd/ 2>/dev/null || true
cp -R /tmp/superpowers-v6.3.0/skills/systematic-debugging/* /Users/hyunjun_macbook_pro/.ai-skills/diagnosing-bugs/ 2>/dev/null || true
# Clean up temporary clone
rm -rf /tmp/superpowers-v6.3.0
```

- [x] **Step 3: Verify v6.3.0 markers in upgraded skills**

```bash
# Check for plan-scoped workspace / resume fix loop in subagent-driven-development
grep -E "re-review-prompt|circuit breaker|plan-scoped" /Users/hyunjun_macbook_pro/.ai-skills/subagent-driven-development/SKILL.md
```
Expected: Match found for resume-based fix loop or re-review-prompt.

- [x] **Step 4: Commit Superpowers v6.3.0 upgrade to Git**

```bash
cd /Users/hyunjun_macbook_pro/.ai-skills
git add -A
git commit -m "feat: upgrade superpowers to v6.3.0"
```

---

### Task 4: Create Upstream Sync Script (`sync-upstream.sh`)

**Files:**
- Create: `/Users/hyunjun_macbook_pro/.ai-skills/sync-upstream.sh`

**Interfaces:**
- Consumes: Network connectivity to GitHub
- Produces: Executable automation script to pull future updates for Superpowers and Caveman into `~/.ai-skills`

- [x] **Step 1: Write `sync-upstream.sh`**

```bash
cat << 'EOF' > /Users/hyunjun_macbook_pro/.ai-skills/sync-upstream.sh
#!/usr/bin/env bash
set -euo pipefail

SKILLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="/tmp/ai-skills-sync-$$"
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "=== Syncing Superpowers ==="
git clone --depth 1 https://github.com/obra/superpowers.git "$TMP_DIR/superpowers"
cp -R "$TMP_DIR/superpowers/skills/"* "$SKILLS_DIR/"
if [ -d "$SKILLS_DIR/tdd" ]; then
  cp -R "$TMP_DIR/superpowers/skills/test-driven-development/"* "$SKILLS_DIR/tdd/"
fi
if [ -d "$SKILLS_DIR/diagnosing-bugs" ]; then
  cp -R "$TMP_DIR/superpowers/skills/systematic-debugging/"* "$SKILLS_DIR/diagnosing-bugs/"
fi

echo "=== Syncing Caveman ==="
git clone --depth 1 https://github.com/JuliusBrussee/caveman.git "$TMP_DIR/caveman"
cp -R "$TMP_DIR/caveman/skills/"* "$SKILLS_DIR/"

echo "=== Committing changes ==="
cd "$SKILLS_DIR"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "chore: auto-sync upstream skills on $(date +'%Y-%m-%d %H:%M:%S')"
  echo "✅ Skills updated and committed to Git."
else
  echo "✨ All skills are already up-to-date."
fi
EOF
chmod +x /Users/hyunjun_macbook_pro/.ai-skills/sync-upstream.sh
```

- [x] **Step 2: Verify script syntax**

```bash
bash -n /Users/hyunjun_macbook_pro/.ai-skills/sync-upstream.sh
```
Expected: Exits 0 with no syntax errors.

- [x] **Step 3: Commit script to Git**

```bash
cd /Users/hyunjun_macbook_pro/.ai-skills
git add sync-upstream.sh
git commit -m "feat: add sync-upstream.sh script"
```

---

### Task 5: Backup Existing Agent Skills and Establish Symlinks

**Files:**
- Backup: `/Users/hyunjun_macbook_pro/.gemini/config/skills` -> `/Users/hyunjun_macbook_pro/.gemini/config/skills.bak_<timestamp>`
- Backup: `/Users/hyunjun_macbook_pro/.claude/skills` -> `/Users/hyunjun_macbook_pro/.claude/skills.bak_<timestamp>`
- Backup: `/Users/hyunjun_macbook_pro/.codex/skills` -> `/Users/hyunjun_macbook_pro/.codex/skills.bak_<timestamp>`
- Symlink: `/Users/hyunjun_macbook_pro/.gemini/config/skills` -> `/Users/hyunjun_macbook_pro/.ai-skills`
- Symlink: `/Users/hyunjun_macbook_pro/.claude/skills` -> `/Users/hyunjun_macbook_pro/.ai-skills`
- Symlink: `/Users/hyunjun_macbook_pro/.codex/skills` -> `/Users/hyunjun_macbook_pro/.ai-skills`

**Interfaces:**
- Consumes: Target directory paths in `~/.gemini/config`, `~/.claude`, `~/.codex`
- Produces: Live symbolic links pointing to `/Users/hyunjun_macbook_pro/.ai-skills`

- [x] **Step 1: Backup and link Gemini / Antigravity skills**

```bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
if [ -d /Users/hyunjun_macbook_pro/.gemini/config/skills ] && [ ! -L /Users/hyunjun_macbook_pro/.gemini/config/skills ]; then
  mv /Users/hyunjun_macbook_pro/.gemini/config/skills "/Users/hyunjun_macbook_pro/.gemini/config/skills.bak_${TIMESTAMP}"
fi
rm -f /Users/hyunjun_macbook_pro/.gemini/config/skills
ln -s /Users/hyunjun_macbook_pro/.ai-skills /Users/hyunjun_macbook_pro/.gemini/config/skills
```

- [x] **Step 2: Backup and link Claude Code skills**

```bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p /Users/hyunjun_macbook_pro/.claude
if [ -d /Users/hyunjun_macbook_pro/.claude/skills ] && [ ! -L /Users/hyunjun_macbook_pro/.claude/skills ]; then
  mv /Users/hyunjun_macbook_pro/.claude/skills "/Users/hyunjun_macbook_pro/.claude/skills.bak_${TIMESTAMP}"
fi
rm -f /Users/hyunjun_macbook_pro/.claude/skills
ln -s /Users/hyunjun_macbook_pro/.ai-skills /Users/hyunjun_macbook_pro/.claude/skills
```

- [x] **Step 3: Backup and link Codex skills**

```bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p /Users/hyunjun_macbook_pro/.codex
if [ -d /Users/hyunjun_macbook_pro/.codex/skills ] && [ ! -L /Users/hyunjun_macbook_pro/.codex/skills ]; then
  mv /Users/hyunjun_macbook_pro/.codex/skills "/Users/hyunjun_macbook_pro/.codex/skills.bak_${TIMESTAMP}"
fi
rm -f /Users/hyunjun_macbook_pro/.codex/skills
ln -s /Users/hyunjun_macbook_pro/.ai-skills /Users/hyunjun_macbook_pro/.codex/skills
```

- [x] **Step 4: Verify symlinks and resolution across all three harnesses**

```bash
ls -ld /Users/hyunjun_macbook_pro/.gemini/config/skills \
       /Users/hyunjun_macbook_pro/.claude/skills \
       /Users/hyunjun_macbook_pro/.codex/skills
```
Expected: All three output lines show `-> /Users/hyunjun_macbook_pro/.ai-skills`.

- [x] **Step 5: Verify critical skills accessible via symlinks**

```bash
test -f /Users/hyunjun_macbook_pro/.gemini/config/skills/ask-dc/SKILL.md && echo "Gemini ask-dc: OK"
test -f /Users/hyunjun_macbook_pro/.gemini/config/skills/caveman/SKILL.md && echo "Gemini caveman: OK"
test -f /Users/hyunjun_macbook_pro/.claude/skills/caveman/SKILL.md && echo "Claude caveman: OK"
test -f /Users/hyunjun_macbook_pro/.codex/skills/caveman/SKILL.md && echo "Codex caveman: OK"
test -f /Users/hyunjun_macbook_pro/.claude/skills/subagent-driven-development/SKILL.md && echo "Claude SDD: OK"
```
Expected: All tests pass and output "OK".
