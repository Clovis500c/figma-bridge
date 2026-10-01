# Comments and versions (optional)

Two tools use Figma's REST API instead of the plugin: `comments` and `versions`. They are off until you give Figma
Bridge a personal access token. Everything else works without one.

## Setup

1. In Figma: **Settings → Security → Personal access tokens → Generate new token**, with the scopes
   `file_content:read`, `file_comments:write` and `file_versions:read`.
2. Add it to the Figma Bridge entry of your AI client:

   ```json
   "FigmaBridge": {
     "command": "npx",
     "args": ["-y", "@clovis500c/figma-bridge"],
     "env": { "FIGMA_TOKEN": "figd_…" }
   }
   ```

   For Codex, add `env = { FIGMA_TOKEN = "figd_…" }` under `[mcp_servers.FigmaBridge]`.
3. Restart the client.

Without a token, both tools answer with these steps (`NO_TOKEN`).

## Which file

The file key comes from the connected file: the development plugin can read it (`figma.fileKey`, enabled by
`enablePrivatePluginApi` in the manifest). If the plugin can't read it, or for another file, pass `fileUrl`: the
file's link (**Share → Copy link**) or its key. With several files connected, `file` picks which one as for any
tool.

## comments

| Action | Parameters | Result |
|---|---|---|
| `list` (default) | `includeResolved?` | Open threads, oldest first: id, number, author, message (Markdown), date, the pinned layer (`nodeId`, plus its name and page when the file is open in the plugin), replies. |
| `post` | `message`, `nodeId?`, `x?`, `y?` | A comment pinned to a layer (offset inside it), or on the file. |
| `reply` | `commentId`, `message` | A reply in the thread. |
| `resolve` | `commentId`, `message?` | Figma's API cannot resolve comments: this replies "✓ Resolved" (or `message`), and the user clicks Resolve. |
| `delete` | `commentId` | Deletes a comment written with the same token. |

Example: *"Read the open comments, fix what they ask for, then reply to each one."*

## versions

| Action | Parameters | Result |
|---|---|---|
| `list` (default) | `limit?` | Saved versions, newest first: id, date, label, description, author. |
| `diff` | `versionId`, `toVersionId?`, `nodeId?`, `limit?` | What changed between `versionId` and now (or `toVersionId`). |

The diff compares the layer trees of both versions, matching layers by their name path (`Card/Title`, with `#2` for
duplicates):

- **added** and **removed** list the topmost layers that appear or disappear (their children aren't repeated);
- **changed** lists text, size, position, fill, visibility and type changes. A moved group isn't repeated for each
  child.

The scope is `nodeId`, else the current page of the connected file, else every page.

## Rate limits and errors

Requests wait and retry on rate limits (`429`, honouring `Retry-After`), on server errors and on network errors, up
to three times. Errors say what to check: `FORBIDDEN` (token, scopes or access to the file), `NOT_FOUND` (file key,
comment or version id), `RATE_LIMITED`.
