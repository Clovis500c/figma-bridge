# Exporting code into a project

`export_code` turns a frame into code. Give it `projectPath` (the folder with the app's `package.json`) and the code
fits that project: its framework, its styling, its components and its tokens.

```json
{ "nodeId": "12:34", "projectPath": "C:/code/my-app" }
```

The result is a **file plan**: each file's project-relative path and content, plus the assets (images, icons) and
where they go. Nothing is written to the project until you call it again with `write: true`. Existing files that
differ are kept (`skipped (exists)`) unless `overwrite: true`. A copy of the plan is always saved to the temp folder
(`preview`).

| Parameter | Description |
|---|---|
| `projectPath` | Project root. |
| `name` | Component name (default: the layer name in PascalCase). |
| `outDir` | Folder for the component, relative to the project (default: the project's components folder). |
| `framework`, `styling` | Override what was detected. |
| `write`, `overwrite` | Write the plan into the project; replace files that differ. |

## What is detected

| | Read from |
|---|---|
| Framework | `package.json`: Next, React (Vite or not), Nuxt, Vue, SvelteKit, Svelte, React Native and Expo. |
| Styling | Tailwind v3 or v4 (`tailwindcss` version, `@tailwindcss/postcss` or `@tailwindcss/vite`), styled-components or Emotion, CSS modules (`*.module.css` in the sources), else plain CSS. |
| UI libraries | shadcn/ui (`components.json` or `components/ui` with class-variance-authority), MUI (`@mui/material`), Chakra (`@chakra-ui/react`). |
| TypeScript and aliases | `tsconfig.json` / `jsconfig.json` `paths` (`@/*` → `src/*`), `components.json` aliases, SvelteKit's `$lib`. |
| Locations | Components: the shadcn components alias, `src/lib/components` (SvelteKit), `src/components` or `components`. Assets: `public/figma` (Next, Nuxt; referenced as `/figma/…`), `static/figma` (SvelteKit), else `src/assets/figma`, imported from the code. |
| Tokens | Custom properties in the global stylesheets (`globals.css`, `index.css`, `app.css`, `styles/*.css`, `theme.css`, `tokens.css`…), Tailwind v4 `@theme` keys (`--color-*`, `--spacing-*`, `--radius-*`, `--text-*`), shadcn variables in HSL or oklch, and literal colors of a Tailwind v3 config (read, never executed). |

## Components

Every component file in the project's component folders is indexed with its props:

- React: exported components and their prop types (`interface ButtonProps`, inline object types), plus shadcn's `cva` variants with their options;
- Vue: `defineProps<{…}>()` and runtime `defineProps({…})`, default slot;
- Svelte: `export let` props (Svelte 4) and `$props()` (Svelte 5);
- MUI and Chakra: the common components (Button, TextField or Input, Chip or Badge, Avatar, Switch, Checkbox, Card).

A Figma instance is matched to a component by the name of its main component or component set (`Button`, or a
prefixed name such as `AppButton`). Its properties become props:

- variant values are matched by name, then by meaning (`Primary` → `default`, `Small` → `sm`, `Danger` → `destructive`); the default option is left out;
- booleans become boolean props;
- text properties named Label/Text/Title, or the first text inside the instance, become the children;
- interaction states (`State=Hover`) are left to the component.

A matched instance is rendered as `<Button variant="secondary" size="sm">Upgrade</Button>` with an import, and only
its size and position come from the design. The result lists the components used and the instances that matched
nothing (their layers are generated).

### figma-bridge.map.json

For names or props that don't match, add a mapping file at the project root:

```json
{
  "components": {
    "Primary CTA": { "import": "@/components/cta", "name": "CallToAction", "default": true },
    "Tag": { "name": "UserBadge", "props": { "Text": "label", "Tone": { "prop": "tone", "values": { "Positive": "success" } } } },
    "Icon/Legacy": { "ignore": true }
  }
}
```

Keys are Figma component (or component set) names. `props` maps a Figma property to a code prop, with optional value
translations; mapping to `"children"` puts the value inside the component. `ignore` always generates the layers.

## Generated code

| Framework | Output |
|---|---|
| React, Next | `Name.tsx` / `.jsx` with Tailwind classes, a `.module.css` (`className={styles.x}`), styled-components definitions, or a `.css` file. |
| Vue, Nuxt | `Name.vue`: `<script setup>` with the imports, the template, `<style module>` (`:class="$style.x"`) or `<style scoped>`, or Tailwind classes. |
| Svelte, SvelteKit | `Name.svelte` with `<script>`, markup and `<style>`. |
| React Native | `Name.tsx` with `View`, `Text`, `Image`, `Pressable` and `StyleSheet.create` (flex direction, shadows and borders translated; grids become wrapping rows). |

Colors become the project's tokens: `bg-primary` with Tailwind (or `bg-[var(--brand)]` for a plain CSS variable),
`var(--color-primary)` in CSS. Figma variables bound in the design are matched by name first, then by value. The root
stretches up to its design width (`w-full max-w-[360px]`); auto-layout fill and hug become flex rules as in the
standalone export.

Without `projectPath`, `export_code` writes a standalone page or component to a temp folder, in the framework and
styling you choose (default HTML + CSS).
