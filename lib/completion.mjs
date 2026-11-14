// Shell completion scripts for dev-diagnosis, generated from the same
// command and option lists the parser uses — so a new flag can never
// be completable but unparseable (or parseable but uncompletable)
// without a test failing. ripgrep ships static scripts in complete/;
// generating them on demand from the spec is the same idea without
// the drift: there is no static copy to go stale. The bin derives
// KNOWN_COMMANDS / KNOWN_OPTIONS from this spec, so the spec is the
// single source of truth; the --help text is checked against it in
// test/completion.test.mjs.
//
// Usage: dev-diagnosis completion <bash|zsh|fish>
// Install, e.g.: dev-diagnosis completion bash > ~/.bash_completion.d/dev-diagnosis

export const SHELLS = ['bash', 'zsh', 'fish'];

// Short descriptions, shown by zsh and fish next to the name.
export const COMMAND_DESCRIPTIONS = {
  all: 'Run every check that has what it needs',
  context: 'Find the files an AI agent should not read',
  path: 'Diagnose why a CLI command is missing',
  cache: 'Time one build command cold and warm',
  flakes: 'Rank flaky tests from JUnit XML',
  setup: 'One-command install for agents',
  doctor: 'Check this installation is healthy',
  completion: 'Print a shell completion script',
};

export const OPTION_DESCRIPTIONS = {
  '--json': 'machine-readable output',
  '-j': 'machine-readable output',
  '--fix': 'write the .aiignore suggestions',
  '--help': 'show this help',
  '-h': 'show this help',
  '--version': 'print the version',
  '-v': 'print the version',
  '--mcp': 'serve the checks as an MCP server',
  '--dry-run': 'show what would be written, without writing',
  '--check': 'report which agents are wired, without writing',
  '--skill-generate': 'write a Claude Agent Skills SKILL.md',
  '--global': 'write the skill to ~/.claude/skills',
  '--project': 'write the skill to ./.claude/skills',
  '--command': 'command for the path check',
  '--flakes': 'directory of JUnit runs for the flakes check',
  '--cache-dir': 'cache directory to time',
  '--cwd': 'directory to run the build command in',
  '--sandbox': 'restrict --mcp to paths under this directory',
  '--root': 'alias for --sandbox',
  '--top': 'show only the N highest-ranked items',
  '--runs': 'time the build N times cold and warm',
  '--report': 'also write this run as a Markdown report file',
  '--changed': 'scan only the files changed in git',
};

// Options each command accepts, besides the command itself. The
// completion command takes a shell name, not options.
export const COMMAND_OPTIONS = {
  all: ['--command', '--flakes', '--fix', '--dry-run', '--changed', '--report', '--json', '-j', '--top', '--runs', '--cache-dir', '--cwd', '--help', '-h', '--version', '-v'],
  context: ['--json', '-j', '--fix', '--dry-run', '--changed', '--help', '-h', '--version', '-v'],
  path: ['--json', '-j', '--help', '-h', '--version', '-v'],
  cache: ['--json', '-j', '--cache-dir', '--cwd', '--runs', '--help', '-h', '--version', '-v'],
  flakes: ['--json', '-j', '--top', '--help', '-h', '--version', '-v'],
  setup: ['--dry-run', '--check', '--help', '-h', '--version', '-v'],
  doctor: ['--json', '-j', '--help', '-h', '--version', '-v'],
  completion: ['--help', '-h', '--version', '-v'],
};

// Options valid with no command (a bare path means `all <path>`).
export const GLOBAL_OPTIONS = [
  '--json', '-j', '--fix', '--dry-run', '--changed', '--report', '--top', '--runs', '--command',
  '--flakes', '--cache-dir', '--cwd', '--mcp', '--sandbox', '--root',
  '--skill-generate', '--global', '--project', '--help', '-h', '--version', '-v',
];

// Value-taking options, and what zsh should complete for their value:
// '' means a plain value (no completion), '_files' a file,
// '_files -/' a directory.
export const VALUE_COMPLETIONS = {
  '--command': '',
  '--flakes': '_files -/',
  '--cache-dir': '_files -/',
  '--cwd': '_files -/',
  '--sandbox': '_files -/',
  '--root': '_files -/',
  '--top': '',
  '--runs': '',
  '--report': '_files',
};

export const VALUE_OPTIONS = new Set(Object.keys(VALUE_COMPLETIONS));

export function knownCommands() {
  return Object.keys(COMMAND_OPTIONS);
}

export function knownOptions() {
  const all = new Set(GLOBAL_OPTIONS);
  for (const options of Object.values(COMMAND_OPTIONS)) {
    for (const option of options) all.add(option);
  }
  return [...all].sort();
}

// Returns the script for `shell`, or null for an unknown shell.
export function generateCompletion(shell) {
  if (shell === 'bash') return bashScript();
  if (shell === 'zsh') return zshScript();
  if (shell === 'fish') return fishScript();
  return null;
}

function escapeSingleQuotes(text) {
  return text.replace(/'/g, "'\\''");
}

function bashScript() {
  const commands = knownCommands().join(' ');
  const globalOpts = GLOBAL_OPTIONS.join(' ');
  const valueOpts = [...VALUE_OPTIONS].join('|');
  const perCommand = Object.entries(COMMAND_OPTIONS)
    .map(([command, options]) => `      ${command}) opts="${options.join(' ')}" ;;`)
    .join('\n');
  return `# bash completion for dev-diagnosis. Generated by \`dev-diagnosis completion bash\`.
# Install: dev-diagnosis completion bash > ~/.bash_completion.d/dev-diagnosis
# or: source <(dev-diagnosis completion bash)
_dev_diagnosis() {
  local cur prev cmd i word
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  # The first non-option word is the command; a value-taking option
  # swallows the word after it, and everything after -- is a build
  # command, not something to complete.
  cmd=""
  for (( i=1; i < COMP_CWORD; i++ )); do
    word="\${COMP_WORDS[i]}"
    case "$word" in
      --) return 0 ;;
      ${valueOpts}) i=$((i + 1)); continue ;;
      --*) ;;
      *) cmd="$word"; break ;;
    esac
  done
  # After a value-taking option, complete filenames (the -o default
  # below) instead of option names.
  case "$prev" in
    ${valueOpts}) return 0 ;;
  esac
  # The completion command takes a shell name.
  if [[ "$cmd" == "completion" ]]; then
    COMPREPLY=( $(compgen -W "${SHELLS.join(' ')}" -- "$cur") )
    return 0
  fi
  if [[ "$cur" == -* ]]; then
    local opts="${globalOpts}"
    case "$cmd" in
${perCommand}
    esac
    COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
    return 0
  fi
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands} ${globalOpts}" -- "$cur") )
    return 0
  fi
  return 0
}
complete -o default -F _dev_diagnosis dev-diagnosis
`;
}

// One _arguments spec per option: '--json[description]' for a flag,
// '--top[description]:N:' for a value with no completion,
// '--report[description]:file:_files' for a file value.
function zshOptSpec(option) {
  const description = OPTION_DESCRIPTIONS[option] ?? '';
  if (!VALUE_OPTIONS.has(option)) return `'${option}[${description}]'`;
  const completion = VALUE_COMPLETIONS[option];
  const label = option === '--top' ? 'N' : option === '--report' ? 'file' : 'value';
  return completion
    ? `'${option}[${description}]:${label}:${completion}'`
    : `'${option}[${description}]:${label}:'`;
}

// Positional argument each command takes, for zsh only (bash falls
// back to filename completion, fish completes files by default).
const ZSH_POSITIONALS = {
  all: `'1:path:_files -/'`,
  context: `'1:path:_files -/'`,
  path: `'1:command:'`,
  cache: null,
  flakes: `'1:runs directory:_files -/'`,
  setup: null,
  doctor: null,
  completion: `'1:shell:(bash zsh fish)'`,
};

function zshScript() {
  const commands = Object.entries(COMMAND_DESCRIPTIONS)
    .map(([name, description]) => `    '${name}:${escapeSingleQuotes(description)}'`)
    .join('\n');
  const globalSpecs = GLOBAL_OPTIONS.map((option) => `    ${zshOptSpec(option)} \\`).join('\n');
  const perCommand = Object.entries(COMMAND_OPTIONS)
    .map(([command, options]) => {
      const specs = options.map((option) => `      ${zshOptSpec(option)} \\`).join('\n');
      const positional = ZSH_POSITIONALS[command];
      const positionalLine = positional ? `\n      ${positional} \\` : '';
      return `        ${command}) _arguments \\\n${specs}${positionalLine}\n          && return 0 ;;`;
    })
    .join('\n');
  return `#compdef dev-diagnosis
# zsh completion for dev-diagnosis. Generated by \`dev-diagnosis completion zsh\`.
# Install: dev-diagnosis completion zsh > ~/.zsh/completions/_dev-diagnosis
# (and make sure ~/.zsh/completions is on your fpath before compinit)
_dev_diagnosis() {
  local -a commands
  commands=(
${commands}
  )
  _arguments -C \\
${globalSpecs}
    '1: :->command' \\
    '*:: :->args' \\
    && return 0
  case "$state" in
    command)
      _describe -t commands 'dev-diagnosis command' commands
      ;;
    args)
      case "$line[1]" in
${perCommand}
      esac
      ;;
  esac
}
_dev_diagnosis "$@"
`;
}

function fishScript() {
  const lines = [
    '# fish completion for dev-diagnosis. Generated by `dev-diagnosis completion fish`.',
    '# Install: dev-diagnosis completion fish > ~/.config/fish/completions/dev-diagnosis.fish',
  ];
  const allCommands = knownCommands().join(' ');
  for (const [name, description] of Object.entries(COMMAND_DESCRIPTIONS)) {
    lines.push(`complete -c dev-diagnosis -n '__fish_use_subcommand' -a '${name}' -d '${escapeSingleQuotes(description)}'`);
  }
  // Options valid before any command (a bare path means `all <path>`).
  const noCommand = `not __fish_seen_subcommand_from ${allCommands}`;
  for (const option of GLOBAL_OPTIONS) {
    lines.push(fishOptLine(option, noCommand));
  }
  for (const [command, options] of Object.entries(COMMAND_OPTIONS)) {
    const condition = `__fish_seen_subcommand_from ${command}`;
    if (command === 'completion') {
      lines.push(`complete -c dev-diagnosis -n '${condition}' -a 'bash zsh fish' -d 'shell to print completions for'`);
    }
    for (const option of options) {
      lines.push(fishOptLine(option, condition));
    }
  }
  return `${lines.join('\n')}\n`;
}

function fishOptLine(option, condition) {
  const description = OPTION_DESCRIPTIONS[option] ?? '';
  const flag = option.startsWith('--') ? `-l ${option.slice(2)}` : `-s ${option.slice(1)}`;
  const value = VALUE_OPTIONS.has(option) ? ' -r' : '';
  return `complete -c dev-diagnosis -n '${condition}' ${flag}${value} -d '${escapeSingleQuotes(description)}'`;
}
