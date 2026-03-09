# pty

Persistent terminal sessions. Run a process, detach, reconnect later. From anywhere, locally and over SSH.

Uses [@xterm/headless](https://github.com/xtermjs/xterm.js/tree/master/headless) internally.

## Install

```sh
git clone https://github.com/myobie/pty.git
cd pty
npm install
npm link
```

## Usage

```sh
pty run myserver -- node server.js    # start a session and attach
pty run -d myserver -- node server.js # start in the background

pty list                              # show active sessions
pty attach myserver                   # reconnect
pty peek myserver                     # print current screen and exit
pty peek -f myserver                  # follow output read-only

pty restart myserver                  # restart an exited session
pty kill myserver                     # terminate a session
```

Detach with `Ctrl+\`. (Press `Ctrl+\` twice to send it through to the process.)

## Tab Completion

```sh
brew install bash-completion  # required for bash; zsh works out of the box
npm run install-completions
```

## License

MIT
