#!/bin/sh
# jobdesk first run on macOS / Linux (ONB-1, ONB-5). Installs only what's missing, each with its
# official installer, then checks everything. Safe to run again.
#   sh wrapper/install.sh            # bun + Python (+ pypdf)
#   sh wrapper/install.sh --latex    # also Tectonic, to make PDFs
set -e
cd "$(dirname "$0")/.."
has() { command -v "$1" >/dev/null 2>&1; }
say() { printf '%s\n' "$*"; }
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

if ! has bun; then
  say "Installing bun (runs jobdesk)..."
  curl -fsSL https://bun.sh/install | bash >/dev/null
fi

# The tools need Python 3.10 or newer. A Mac's own python3 is 3.9, so look past the first one.
pick_python() {
  for c in "$JOBDESK_PYTHON" python3 python3.13 python3.12 python3.11 python3.10 python \
    "$HOME/.local/bin/python3" /opt/homebrew/bin/python3 /usr/local/bin/python3 \
    "$HOME/miniforge3/bin/python3" "$HOME/miniconda3/bin/python3" "$HOME/anaconda3/bin/python3"; do
    [ -n "$c" ] || continue
    if "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

PY=$(pick_python) || PY=""
if [ -z "$PY" ]; then
  if ! has uv; then
    say "Installing uv (installs Python for you)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
  fi
  say "Installing Python 3.12 (yours is missing or older than 3.10)..."
  uv python install 3.12 --default >/dev/null 2>&1 || uv python install 3.12 >/dev/null
  PY=$(pick_python) || PY=$(uv python find 3.12)
fi

if ! "$PY" -c "import pypdf" >/dev/null 2>&1; then
  say "Installing pypdf (reads PDF resumes)..."
  "$PY" -m pip install --user --quiet pypdf 2>/dev/null \
    || "$PY" -m pip install --quiet pypdf 2>/dev/null \
    || uv pip install --system --break-system-packages --python "$PY" --quiet pypdf 2>/dev/null \
    || say "Couldn't install pypdf. PDF resumes need it: $PY -m pip install pypdf"
fi

if [ "$1" = "--latex" ] && ! has tectonic && ! has xelatex && ! has lualatex; then
  say "Installing Tectonic (makes PDFs)..."
  (mkdir -p "$HOME/.local/bin" && cd "$HOME/.local/bin" && curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh >/dev/null)
fi

say ""
bun run wrapper/bin/jobdesk.ts doctor
say ""
say "Next: bun run wrapper/bin/jobdesk.ts start"
say "It opens the dashboard, and setup happens there."
