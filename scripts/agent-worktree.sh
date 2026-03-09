#!/usr/bin/env bash
# agent-worktree.sh — Git worktree manager for parallel Claude Code sessions
#
# Usage:
#   ./agent-worktree.sh setup <feature-slug> [workstreams...]
#   ./agent-worktree.sh teardown <feature-slug>
#   ./agent-worktree.sh status
#
# Examples:
#   ./agent-worktree.sh setup user-auth backend frontend
#   ./agent-worktree.sh setup auth-refactor backend frontend tests ai
#   ./agent-worktree.sh teardown user-auth
#   ./agent-worktree.sh status

set -euo pipefail

# Resolve repo root (works from any subdirectory)
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "ERROR: Not inside a git repository"
    exit 1
}

# Worktrees go in a sibling directory to avoid polluting the repo
WORKTREE_BASE="$(dirname "$REPO_ROOT")/.agent-worktrees"

DEFAULT_WORKSTREAMS=("backend" "frontend" "tests")

usage() {
    cat <<'EOF'
agent-worktree.sh — Git worktree manager for parallel Claude Code sessions

COMMANDS:
  setup <slug> [streams...]   Create feature branch + worktrees
  teardown <slug>             Remove worktrees + clean branches
  status                      Show all active worktrees

ARGUMENTS:
  slug        Feature name slug (e.g., user-auth, auth-refactor)
  streams     Workstream names (default: backend frontend tests)

EXAMPLES:
  ./agent-worktree.sh setup user-auth backend frontend
  ./agent-worktree.sh setup auth-refactor backend frontend tests ai
  ./agent-worktree.sh teardown user-auth
  ./agent-worktree.sh status

WORKTREE LOCATIONS:
  Each worktree is created at:
    <repo-parent>/.agent-worktrees/<slug>-<stream>/

  Point each Claude Code instance at its worktree directory.
EOF
    exit 0
}

cmd_setup() {
    local slug="$1"; shift
    local workstreams=("${@:-${DEFAULT_WORKSTREAMS[@]}}")

    # Use provided streams or defaults
    if [ ${#workstreams[@]} -eq 0 ]; then
        workstreams=("${DEFAULT_WORKSTREAMS[@]}")
    fi

    local base_branch
    base_branch="$(git rev-parse --abbrev-ref HEAD)"

    echo "=== Agent Worktree Setup ==="
    echo "Feature:     $slug"
    echo "Base branch: $base_branch"
    echo "Workstreams: ${workstreams[*]}"
    echo "Worktree dir: $WORKTREE_BASE"
    echo ""

    # Create worktree base directory
    mkdir -p "$WORKTREE_BASE"

    # Create feature branch if it doesn't exist
    if git show-ref --verify --quiet "refs/heads/feature/$slug"; then
        echo "[skip] feature/$slug already exists"
    else
        git branch "feature/$slug" "$base_branch"
        echo "[created] branch feature/$slug from $base_branch"
    fi

    # Create agent branches + worktrees
    for stream in "${workstreams[@]}"; do
        local branch="agent/${slug}-${stream}"
        local worktree_path="${WORKTREE_BASE}/${slug}-${stream}"

        if [ -d "$worktree_path" ]; then
            echo "[skip] worktree already exists: $worktree_path"
            continue
        fi

        # Create branch from feature branch, then add worktree
        if git show-ref --verify --quiet "refs/heads/$branch"; then
            git worktree add "$worktree_path" "$branch"
            echo "[created] worktree $worktree_path (existing branch $branch)"
        else
            git worktree add -b "$branch" "$worktree_path" "feature/$slug"
            echo "[created] worktree $worktree_path (new branch $branch)"
        fi
    done

    echo ""
    echo "=== Ready ==="
    echo ""
    echo "Launch Claude Code instances pointing at:"
    for stream in "${workstreams[@]}"; do
        echo "  ${stream}: cd ${WORKTREE_BASE}/${slug}-${stream}"
    done
    echo ""
    echo "Each instance has full repo access on its own branch."
    echo "When done: ./agent-worktree.sh teardown $slug"
}

cmd_teardown() {
    local slug="$1"

    echo "=== Agent Worktree Teardown: $slug ==="

    # Find and remove worktrees matching this slug
    local found=0
    for dir in "$WORKTREE_BASE/${slug}-"*/; do
        [ -d "$dir" ] || continue
        found=1

        local stream
        stream="$(basename "$dir")"
        local branch="agent/${stream}"

        echo "[removing] worktree $dir"
        git worktree remove "$dir" --force 2>/dev/null || {
            echo "[warn] force-removing $dir"
            git worktree remove "$dir" --force 2>/dev/null || rm -rf "$dir"
        }

        # Delete the agent branch if it exists and is fully merged
        if git show-ref --verify --quiet "refs/heads/$branch"; then
            if git branch -d "$branch" 2>/dev/null; then
                echo "[deleted] branch $branch (merged)"
            else
                echo "[kept] branch $branch (unmerged — delete manually with git branch -D)"
            fi
        fi
    done

    if [ "$found" -eq 0 ]; then
        echo "No worktrees found for slug: $slug"
        echo "Active worktrees:"
        git worktree list
        return 1
    fi

    # Prune stale worktree references
    git worktree prune
    echo ""
    echo "[done] Worktrees removed. Feature branch feature/$slug preserved."
    echo "To delete the feature branch: git branch -d feature/$slug"
}

cmd_status() {
    echo "=== Active Git Worktrees ==="
    git worktree list
    echo ""

    if [ -d "$WORKTREE_BASE" ]; then
        echo "=== Agent Worktree Directory ==="
        for dir in "$WORKTREE_BASE"/*/; do
            [ -d "$dir" ] || continue
            local branch
            branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
            local status
            status="$(git -C "$dir" status --short 2>/dev/null | wc -l)"
            echo "  $(basename "$dir"): branch=$branch, uncommitted=$status"
        done
    else
        echo "No agent worktrees directory found."
    fi
}

# --- Main ---
[ $# -eq 0 ] && usage

case "${1:-}" in
    setup)
        [ $# -lt 2 ] && { echo "ERROR: setup requires a feature slug"; exit 1; }
        shift
        cmd_setup "$@"
        ;;
    teardown)
        [ $# -lt 2 ] && { echo "ERROR: teardown requires a feature slug"; exit 1; }
        cmd_teardown "$2"
        ;;
    status)
        cmd_status
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        echo "ERROR: Unknown command '$1'"
        usage
        ;;
esac
