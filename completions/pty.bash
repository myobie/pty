# Bash completion for pty
# Source this file or copy to /etc/bash_completion.d/pty

_pty() {
  local cur prev commands
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  commands="run attach peek send kill list restart help"

  # Complete subcommand
  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${commands}" -- "${cur}"))
    return
  fi

  # Complete session names for commands that take them
  case "${COMP_WORDS[1]}" in
    attach|a|peek|send|kill|restart)
      local session_dir="${PTY_SESSION_DIR:-${HOME}/.local/state/pty}"
      if [[ -d "${session_dir}" ]]; then
        local names
        names=$(ls "${session_dir}"/*.json 2>/dev/null | xargs -I{} basename {} .json)
        COMPREPLY=($(compgen -W "${names}" -- "${cur}"))
      fi
      ;;
  esac
}

complete -F _pty pty
