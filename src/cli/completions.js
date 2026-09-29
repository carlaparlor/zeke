// `zeke completions <shell>` — generated from the live command list, so it
// cannot drift from the actual CLI.

import { COMMANDS, GLOBAL_SPEC } from "./main.js";

const SHELLS = ["bash", "zsh", "fish"];

/**
 * @param {{flags: any, positional: string[]}} ctx
 * @returns {Promise<number>}
 */
export async function completionsCommand({ positional }) {
  const shell = positional[0];
  if (!shell || !SHELLS.includes(shell)) {
    process.stdout.write(`usage: zeke completions <${SHELLS.join("|")}>\n`);
    return shell ? 2 : 0;
  }

  const commands = Object.keys(COMMANDS);
  const flags = Object.entries(GLOBAL_SPEC)
    .filter(([, spec]) => spec.type === "boolean" || spec.type === "string")
    .map(([name, spec]) => ({ long: `--${name}`, short: spec.alias ? `-${spec.alias}` : null }));

  process.stdout.write(render(shell, commands, flags));
  return 0;
}

function render(shell, commands, flags) {
  if (shell === "fish") {
    const lines = [
      `# zeke fish completions — generated, do not edit`,
      ...commands.map((name) => `complete -c zeke -f -n "__fish_use_subcommand" -a "${name}" -d "${name}"`),
      ...flags.map((flag) => `complete -c zeke -l "${flag.long.slice(2)}"${flag.short ? ` -s "${flag.short.slice(1)}"` : ""}`),
      `complete -c zeke -l profile -xa "default fast deep"`,
      `complete -c zeke -l output -xa "text json stream-json"`,
      "",
    ];
    return lines.join("\n");
  }

  const wordlist = [...commands, ...flags.map((f) => f.long)].join(" ");
  if (shell === "zsh") {
    return `#compdef zeke
# zeke zsh completions — generated, do not edit

_zeke() {
  local -a commands flags
  commands=(${commands.map((c) => `'${c}'`).join(" ")})
  flags=(${flags.map((f) => `'${f.long}'`).join(" ")})
  _arguments -C \\
    '1: :->cmds' \\
    '*:: :->args'
  case $state in
    cmds) _values 'zeke command' $commands ;;
    *) _values 'zeke flag' $flags
       _values 'profile' default fast deep
       _values 'output' text json stream-json ;;
  esac
}
_zeke "$@"
`;
  }

  return `# zeke bash completions — generated, do not edit
_zeke_completions() {
  local cur words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  words="${wordlist}"
  if [[ "\${COMP_CWORD}" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${words}" -- "\${cur}") )
  else
    case "\${cur}" in
      --profile) COMPREPLY=( $(compgen -W "default fast deep" -- "\${COMP_WORDS[COMP_CWORD-1]}") ) ;;
      --output)  COMPREPLY=( $(compgen -W "text json stream-json" -- "\${COMP_WORDS[COMP_CWORD-1]}") ) ;;
      --resume)  COMPREPLY=( $(compgen -W "$(zeke sessions 2>/dev/null | awk 'NR>1 {print $1}')" -- "\${cur}") ) ;;
      *)         COMPREPLY=( $(compgen -f -- "\${cur}") ) ;;
    esac
  fi
}
complete -F _zeke_completions zeke
`;
}
