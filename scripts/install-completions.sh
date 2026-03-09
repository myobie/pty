#!/bin/sh
# Install shell completions for pty.
# Run automatically by postinstall or manually via: npm run install-completions

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPLETIONS_DIR="$SCRIPT_DIR/../completions"

# Bash completions via Homebrew
for dir in /opt/homebrew/etc/bash_completion.d /usr/local/etc/bash_completion.d; do
  if [ -d "$dir" ]; then
    ln -sf "$COMPLETIONS_DIR/pty.bash" "$dir/pty"
    echo "Bash completions installed: $dir/pty"
    break
  fi
done

# Zsh completions via Homebrew
for dir in /opt/homebrew/share/zsh/site-functions /usr/local/share/zsh/site-functions; do
  if [ -d "$dir" ]; then
    ln -sf "$COMPLETIONS_DIR/pty.zsh" "$dir/_pty"
    echo "Zsh completions installed: $dir/_pty"
    break
  fi
done
