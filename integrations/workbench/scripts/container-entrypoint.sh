#!/bin/sh
set -eu
umask 077

# exec preserves stdio framing and lets Docker's init forward signals to Node.
# No shell expansion of caller arguments and no npm wrapper in an MCP stream.
case "${1:-cli}" in
  cli)
    if [ "$#" -gt 0 ]; then shift; fi
    exec node /opt/rea-workbench/bin/workbench.mjs "$@"
    ;;
  mcp)
    shift
    exec node /opt/rea-workbench/bin/workbench-mcp.mjs "$@"
    ;;
  memory-mcp)
    shift
    exec node /opt/rea-workbench/bin/memory-mcp.mjs "$@"
    ;;
  rea)
    shift
    exec node /opt/rea-workbench/node_modules/rea-agents/scripts/rea.mjs "$@"
    ;;
  *)
    exec node /opt/rea-workbench/bin/workbench.mjs "$@"
    ;;
esac
