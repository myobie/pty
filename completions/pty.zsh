#compdef pty
# Zsh completion for pty
# Place in your fpath or source directly

_pty() {
  local session_dir="${PTY_SESSION_DIR:-${HOME}/.local/state/pty}"

  _pty_sessions() {
    local -a sessions
    if [[ -d "${session_dir}" ]]; then
      sessions=(${session_dir}/*.json(N:t:r))
    fi
    _describe 'session' sessions
  }

  local -a commands
  commands=(
    'run:Create a session and attach'
    'attach:Attach to an existing session'
    'peek:Print current screen or follow output'
    'send:Send text or keys to a session'
    'kill:Kill or remove a session'
    'list:List active sessions'
    'restart:Restart an exited session'
    'help:Show usage information'
  )

  _arguments -C \
    '1:command:->command' \
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case ${words[1]} in
        attach|a)
          _arguments \
            '(-r --auto-restart)'{-r,--auto-restart}'[Auto-restart if exited]' \
            '1:session:_pty_sessions'
          ;;
        peek)
          _arguments \
            '(-f --follow)'{-f,--follow}'[Follow output read-only]' \
            '1:session:_pty_sessions'
          ;;
        send)
          _arguments \
            '1:session:_pty_sessions' \
            '*--seq[Send a sequence item]:value:'
          ;;
        kill|restart)
          _arguments '1:session:_pty_sessions'
          ;;
        run)
          # After --, fall back to normal (command + file) completion
          local -i i
          for (( i=1; i <= $#words; i++ )); do
            if [[ "${words[$i]}" == "--" ]]; then
              shift $i words
              (( CURRENT -= i ))
              _normal
              return
            fi
          done
          _arguments \
            '(-d --detach)'{-d,--detach}'[Create in background]' \
            '(-a --attach)'{-a,--attach}'[Attach if already running]' \
            '1:name:'
          ;;
      esac
      ;;
  esac
}

_pty "$@"
