# GitHub App Token for NanoClaw PR Automation

## Setup (one-time)

1. Create GitHub App at `Settings → Developer settings → GitHub Apps`
2. Permissions: Contents (rw), Pull requests (rw), Checks (rw), Metadata (r)
3. Install to `kenans/nanoclaw-github-copilot` repo
4. Note down: **App ID**, **Installation ID**, download **Private Key (.pem)**

## Usage

### Linux/macOS
```bash
export GITHUB_APP_ID="12345"
export GITHUB_APP_KEY_FILE="/path/to/nanoclaw-bot.pem"
export GITHUB_INSTALL_ID="67890"

# Get token (valid 1 hour)
export GH_TOKEN=$(./scripts/get-github-app-token.sh)

# Use with gh CLI
gh pr create --title "fix: xxx" --base main --head feat/branch

# Use with git
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/kenans/nanoclaw-github-copilot.git"
git push origin feat/branch
```

### Windows (PowerShell)
```powershell
$env:GITHUB_APP_ID = "12345"
$env:GITHUB_APP_KEY_FILE = "C:\path\to\nanoclaw-bot.pem"
$env:GITHUB_INSTALL_ID = "67890"

# Get token
$env:GH_TOKEN = & bash scripts/get-github-app-token.sh
# Or use the PowerShell equivalent (TODO)
```

### As git credential helper
```bash
git config credential.helper '!f() { echo "password=$(./scripts/get-github-app-token.sh)"; echo "username=x-access-token"; }; f'
```

## Why GitHub App instead of PAT?
- Independent bot identity (`app-name[bot]`) — PRs don't pollute personal account
- Higher rate limits (5,000 + 50/repo vs 5,000 flat)
- Fine-grained permissions
- Auto-rotating tokens (1hr expiry)
- GitHub is more tolerant of App automation vs personal account automation
