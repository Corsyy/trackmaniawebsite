name: Update Data (TOTD + Weekly Shorts)

on:
  workflow_dispatch:
  schedule:
    # 18:00 UTC = 1:00 PM EST (no DST auto-switch)
    - cron: "0 18 * * *"

concurrency:
  group: update-data
  cancel-in-progress: true

jobs:
  update:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    env:
      PUBLIC_DIR: .
      DEBUG: "0"

      # ===== REQUIRED for Weekly Shorts names + live leaderboard =====
      REFRESH_TOKEN: ${{ secrets.NADEO_REFRESH_TOKEN }}
      CLIENT_ID: ${{ secrets.TM_CLIENT_ID }}
      CLIENT_SECRET: ${{ secrets.TM_CLIENT_SECRET }}

      # Optional: helps discovery if the campaign name differs slightly
      # WS_MATCH: "weekly shorts"

      # Optional (BEST): pin the campaign so it can never pick the wrong one
      # WS_CLUB_ID: ${{ secrets.WS_CLUB_ID }}
      # WS_CAMPAIGN_ID: ${{ secrets.WS_CAMPAIGN_ID }}

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Run TOTD fetcher
        run: |
          echo "Running TOTD fetcher..."
          node -v
          node scripts/totd-fetcher.js
          echo ""
          echo "TOTD outputs:"
          ls -R data/totd || true
          ls -l totd.json || true

      - name: Run Weekly Shorts updater
        run: |
          echo "Running Weekly Shorts updater..."
          node -v
          node scripts/weekly-shorts-update.js
          echo ""
          echo "Weekly Shorts outputs:"
          ls -R data/weekly-shorts || true
          echo ""
          echo "Weeks index preview:"
          cat data/weekly-shorts/weeks.json || true

      - name: Compute combined content hash
        id: newhash
        shell: bash
        run: |
          set -euo pipefail
          tmplist=$(mktemp)

          # TOTD outputs
          if [ -f totd.json ]; then
            echo "totd.json" >> "$tmplist"
          fi
          if [ -d data/totd ]; then
            find data/totd -type f -name '*.json' -print0 | sort -z | xargs -0 -I{} echo "{}" >> "$tmplist"
          fi

          # Weekly Shorts outputs
          if [ -d data/weekly-shorts ]; then
            find data/weekly-shorts -type f -name '*.json' -print0 | sort -z | xargs -0 -I{} echo "{}" >> "$tmplist"
          fi

          if [ -s "$tmplist" ]; then
            HASH=$(xargs -a "$tmplist" -I{} sha256sum "{}" | sort | sha256sum | cut -d' ' -f1)
          else
            HASH="none"
          fi

          echo "new=$HASH" >> "$GITHUB_OUTPUT"

      - name: Read previous combined hash (if any)
        id: prevhash
        shell: bash
        run: |
          PREV=$(git show HEAD:.data.hash 2>/dev/null || true)
          echo "prev=${PREV:-none}" >> "$GITHUB_OUTPUT"

      - name: Commit updated data (only if changed)
        if: steps.newhash.outputs.new != steps.prevhash.outputs.prev
        shell: bash
        run: |
          echo "${{ steps.newhash.outputs.new }}" > .data.hash

          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

          # Stage BOTH sets of outputs
          git add .data.hash totd.json data/totd/*.json data/weekly-shorts/**/*.json 2>/dev/null || true

          if ! git diff --cached --quiet; then
            echo "Changes detected — committing updates."
            git commit -m "data: refresh TOTD + Weekly Shorts [skip ci]"
            git pull --rebase origin "${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}" || true
            git push
          else
            echo "No staged changes."
          fi

      - name: No changes — skip
        if: steps.newhash.outputs.new == steps.prevhash.outputs.prev
        run: echo "No content changes detected; nothing to push."
