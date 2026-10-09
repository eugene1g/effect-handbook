#!/bin/bash
# usage: fetch.sh <task-id> <url>   — fetches a handbook URL, logs it, prints the body
TASK="$1"; URL="$2"
case "$URL" in
  https://eugene1g.github.io/effect-handbook/*) ;;
  *) echo "fetch.sh: only https://eugene1g.github.io/effect-handbook/ URLs are allowed" >&2; exit 2 ;;
esac
BODY=$(curl -sL --max-time 30 "$URL")
WORDS=$(printf '%s' "$BODY" | wc -w | tr -d ' ')
mkdir -p "/agent/workspace/agent-eval/$TASK"
printf '%s\t%s\t%s\n' "$(date +%s)" "$WORDS" "$URL" >> "/agent/workspace/agent-eval/$TASK/fetches.tsv"
printf '%s' "$BODY"
