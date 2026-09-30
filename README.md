# Figma Bridge

> Local MCP bridge that lets Claude Code design in the Figma desktop app, with no rate limits. (Docs in French.)

Un pont local entre Claude Code et l'app **Figma desktop** : l'IA design directement dans ton fichier, **sans limite de requêtes**
(tout passe par un plugin de développement, jamais par l'API web de Figma).

```
Claude Code ──stdio──▶ serveur MCP (bun) ──WebSocket localhost:3055──▶ UI du plugin ──postMessage──▶ Figma (API plugin)
```

- **Zéro manip côté connexion** : le serveur WebSocket démarre tout seul avec le serveur MCP. Le plugin se connecte au lancement
  et se reconnecte tout seul si le serveur redémarre. Pas de canal à taper.
- **Plusieurs fenêtres Claude Code** : la première ouvre le port, les suivantes s'y branchent. Si elle se ferme, une autre prend le relais.
- **Plusieurs fichiers Figma** : `list_sessions` + `select_session` (par nom de fichier).

## Installation (Windows, une seule fois, ~2 min)

Prérequis : [Bun](https://bun.sh) (`powershell -c "irm bun.sh/install.ps1 | iex"`), Figma desktop, Claude Code.

1. **Télécharger** `figma-bridge-vX.Y.Z.zip` dans la [dernière release](https://github.com/Clovis500c/figma-bridge/releases/latest)
   et le dézipper où tu veux (par ex. `C:\Users\<toi>\figma-bridge`). Évite un dossier synchronisé OneDrive.
2. **Installer**, dans ce dossier :
   ```bash
   bun install
   ```
   ```bash
   bun run setup
   ```
   `setup` enregistre le serveur MCP `FigmaBridge` dans Claude Code pour **tous tes projets**, avec les bons chemins.
   Il passe par la commande `claude` si elle existe, sinon il modifie `~/.claude.json` et en garde une copie `.bak-figma-bridge`.
   Il affiche aussi le chemin exact du manifest.
3. **Plugin Figma** : Figma desktop → *Plugins → Development → Import plugin from manifest…* → `plugin\manifest.json`
   (le chemin affiché par `setup`).
4. **Redémarrer Claude Code**, puis dans ton fichier Figma : *Plugins → Development → Figma Bridge*. La pastille passe au vert.

<details><summary>Configuration manuelle (sans <code>setup</code>)</summary>

Dans le `.mcp.json` d'un projet :

```json
{
  "mcpServers": {
    "FigmaBridge": {
      "type": "stdio",
      "command": "C:\Users\<toi>\.bun\bin\bun.exe",
      "args": ["run", "C:\Users\<toi>\figma-bridge\src\server.ts"]
    }
  }
}
```
</details>

Ensuite, pour relancer le plugin :
- **Ctrl+Alt+P** relance le dernier plugin utilisé ;
- ou le bouton **Figma Bridge** dans le panneau de droite (quand rien n'est sélectionné), ajouté au premier lancement.

Le bouton **—** réduit le plugin en une petite barre. Il continue de marcher réduit, mais **pas fermé**.

## Outils MCP

| Outil | Rôle |
|---|---|
| `run_script({ code, timeoutMs? })` | **L'outil principal.** Exécute du JS de l'API plugin (`figma`), avec `await` au premier niveau et `return` pour la sortie. Une expression seule est renvoyée automatiquement. Erreur → `{ ok:false, error, line, stack }`. 30 s par défaut, 120 s max. |
| `screenshot({ nodeId?, scale?, format?, maxDimension?, returnImage? })` | Exporte un nœud (par défaut, la sélection) dans un fichier temporaire et renvoie `{ path, width, height }`. `returnImage:true` montre aussi l'image à l'IA. |
| `place_image({ path \| url, nodeId?, parentId?, x?, y?, width?, height?, scaleMode?, name? })` | Image PNG/JPG/WEBP/GIF en remplissage d'un nœud, ou sur un nouveau rectangle. Le WEBP et les images de plus de 4096 px sont convertis automatiquement. |
| `import_svg({ path \| svgString, x?, y?, parentId?, name? })` | SVG → vecteurs modifiables. |
| `get_context()` | Fichier, pages, page courante, sélection (avec ses dimensions), viewport. |
| `list_fonts({ filter?, limit? })` | Polices disponibles, regroupées par famille. |
| `list_sessions()` / `select_session({ name })` | Fichiers connectés et choix du fichier cible. |

Aides disponibles dans `run_script` :

```js
await utils.loadFonts("Inter:Bold", "Inter:Regular");   // ou un TextNode, ou {family, style} (mis en cache)
const card = await utils.node("12:408");                  // getNodeByIdAsync
await utils.page("Menus");                                // change de page (chargement dynamique)
frame.fills = utils.solid("#A259FF", 0.9);                // Paint[]
text.fills = [{ type: "SOLID", color: utils.hex("#fff") }];
console.log("debug");                                     // renvoyé dans `logs`
return { id: card.id };                                   // les nœuds deviennent {id, name, type}
```

## Vérifier que tout marche

```bash
bun run test
```

Le test démarre le serveur et attend que le plugin soit ouvert dans Figma. Il enchaîne ensuite script, capture, image, SVG,
contexte et polices, puis supprime ce qu'il a créé : le fichier revient à son état de départ.

Autres commandes : `bun run build` (recompile `plugin/code.js`), `bun run check` (TypeScript strict pour le serveur et le plugin).

## Dépannage

| Symptôme dans le plugin | Solution |
|---|---|
| **En attente de Claude Code** | Le serveur MCP ne tourne pas : ouvre Claude Code dans un projet où `FigmaBridge` est configuré (`/mcp` pour vérifier). |
| **Port 3055 occupé** | Un autre programme utilise le port, souvent l'ancien socket TalkToFigma (`bun run src/socket.ts`). Ferme-le : la connexion reprend toute seule. |
| L'IA dit « Several Figma files are connected » | Normal avec plusieurs fichiers ouverts : elle doit appeler `select_session`. |
| Un script fige Figma | Une boucle synchrone infinie ne peut pas être interrompue. Ferme le plugin (ou Figma) et relance-le. |

Le journal des commandes est dans `%TEMP%\figma-bridge\bridge.log`, et les captures dans `%TEMP%\figma-bridge\`.

## Réglages (variables d'environnement du serveur MCP)

| Variable | Défaut | Rôle |
|---|---|---|
| `FIGMA_BRIDGE_CHANNEL` | `default` | Canal (à mettre aussi dans les Réglages du plugin). Sert à isoler plusieurs agents. |
| `FIGMA_BRIDGE_PORT` | `3055` | Port. Le manifest n'autorise que 3055 : si tu le changes, change aussi `devAllowedDomains` et `WS_URL` dans `plugin/ui.html`. |
| `FIGMA_BRIDGE_OUT` | `%TEMP%\figma-bridge` | Dossier des captures et du journal. |

## Sécurité

- Le serveur n'écoute que sur `127.0.0.1`.
- Un navigateur ne peut pas piloter Figma : une page web qui ouvre une WebSocket vers le port est refusée comme agent,
  seuls les processus locaux (sans en-tête `Origin`) peuvent envoyer des commandes.
- Le plugin est en mode développement : `allowedDomains: ["none"]`, avec seulement `localhost:3055` autorisé.

## Structure

```
src/server.ts      serveur MCP (stdio) + les 8 outils
src/bridge.ts      hub WebSocket, découpage des gros messages, sessions, reprise du port
scripts/setup.ts   enregistre le serveur MCP dans Claude Code (bun run setup)
src/image.ts       lecture du format et des dimensions d'une image (sans dépendance)
plugin/code.ts     thread principal du plugin (→ code.js avec bun build)
plugin/ui.html     UI : WebSocket, reconnexion, conversion d'images, journal
plugin/manifest.json
test/selftest.ts   test de bout en bout (bun run test)
```

## Licence

MIT
