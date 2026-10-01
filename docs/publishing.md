# Publishing to MCP directories

The npm package is published by the Release workflow. Directory listings are submitted by hand, once; most of them
then follow new npm versions on their own.

Files in the repository:

| File | For |
|---|---|
| `server.json` | The official MCP Registry. Its `version` must equal `package.json`'s (a test checks it). |
| `package.json` → `mcpName` | Proves to the MCP Registry that the npm package belongs to `io.github.clovis500c/figma-bridge`. |
| `glama.json` | Glama: claims the server for its maintainer. |
| `smithery.yaml` | Smithery: how to start the server locally (stdio, `npx`) and its optional `FIGMA_TOKEN`. |

## Official MCP Registry (registry.modelcontextprotocol.io)

Publish after the npm release of the same version, since the registry checks npm for `mcpName`.

1. Install the publisher: download `mcp-publisher` from the
   [registry releases](https://github.com/modelcontextprotocol/registry/releases) (or `brew install mcp-publisher`).
2. In the repository folder: `mcp-publisher login github` (sign in as Clovis500c; the `io.github.clovis500c/` prefix
   is tied to that account).
3. `mcp-publisher publish`. It reads `server.json`.
4. Check it: `curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.clovis500c/figma-bridge"`.

For each later release, bump `version` in both `package.json` and `server.json` (both `version` fields), release, then
run `mcp-publisher publish` again.

## GitHub MCP Registry

It lists servers from the official registry: nothing more to do after the step above.

## Glama (glama.ai/mcp/servers)

1. Sign in at glama.ai with GitHub and use **Add server** with the repository URL.
2. Glama reads `glama.json` and gives the maintainers listed there control of the listing. It runs its own checks
   (license, install, tools list) and shows the score on the server page.

## Smithery (smithery.ai)

1. Sign in with GitHub, **Publish server**, pick the repository.
2. Smithery reads `smithery.yaml`. Figma Bridge must run on the user's machine (it talks to the Figma desktop app),
   so choose the local (stdio) listing, not hosted deployment.

## LobeHub (lobehub.com/mcp)

1. Sign in, open **MCP Servers → Submit**, and give the repository URL.
2. LobeHub reads the README and `package.json`. Use the npx command from the README as the install command.

## Other directories

mcp.so, PulseMCP and Cline's MCP Marketplace take submissions through a form or a GitHub issue with the repository
URL. Use the short description from `server.json`.
