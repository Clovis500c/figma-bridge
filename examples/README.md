# Examples

Ready-made inputs for Figma Bridge. Ask your agent to use one, for example *"Build examples/pricing-section.json"*,
or paste a file into a tool call.

| File | Tool | What it makes |
|---|---|---|
| `pricing-section.json` | `build` (spec) | A pricing section: header and three plan cards in a grid, the middle one featured with a gradient. |
| `dashboard.json` | `build` (spec) | An admin dashboard: sidebar navigation, top bar, four stat cards and a bar chart. |
| `mobile-login.json` | `build` (spec) | A 390 × 844 mobile sign-in screen with fields, a primary button and a footer link. |
| `tailwind-tokens.json` | `design_tokens` (tokens) | A small Tailwind theme: colors, spacing, radii, font sizes, turned into variables and text styles. |
| `checkout-flow.json` | `build` in FigJam (spec) | A Mermaid flowchart laid out as a FigJam diagram. |

Every file is checked by the test suite (`test/examples.test.ts`).
