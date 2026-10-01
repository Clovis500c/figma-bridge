# Layer names

Layers that Figma Bridge creates or exports get professional names: what the layer is for, the way a design system
or a developer would name it. `Frame 12`, `Rectangle 3` or a text layer named after its text say nothing to a
teammate, to code export or to an AI reading the file. Figma's own guidance asks for semantic names (`HeroImage`,
`PriceLabel`, `Card/Product/Default`) for the same reason.

The agent is told to name every layer it builds by role. Layers it leaves unnamed, and layers with Figma's default
names, get a role from the rules below:

| Where | What is renamed |
|---|---|
| `build` | Layers created without a `name` (frames, text, shapes, images, SVGs). Named layers are never changed. |
| `audit {fix:true}` (`names`) | Non-text layers with a default name (`Frame 12`, `Group 3`, `Rectangle 1 copy`…). |
| `export_roblox` | Every instance: the layer's own name in PascalCase, or its role, plus the Roblox suffixes ([docs/roblox.md](roblox.md#names)). |

## Roles

A layer is named after its children are, so a parent can use what they are. The first rule that matches wins.

**Text**

| Role | When |
|---|---|
| `Label` | Inside a button or a badge |
| `Value` | A number, a price or a count (`250`, `$12`, `3/5`, `+20%`) |
| `Title` | The largest text of the frame (18 px or more), or the largest text of its group (16 px or more), like a card's name over its details |
| `Heading` | 20 px or more |
| `Description` | Longer than 60 characters |
| `Caption` | 12 px or less |
| `Description` | Longer than 30 characters |
| `Label` | Anything else |

**Layers without children**

| Role | When |
|---|---|
| `Icon` | A vector, or a frame made only of vectors |
| `Avatar` | A round image (ellipse, or a square with full radius) |
| `Image` | An image fill |
| `Divider` | 2 px thick or less, longer than 8 px |
| `Background` | Covers its whole parent |
| `Button` | Has a click or press interaction |
| `Dot` / `Circle` | An ellipse (16 px or less: `Dot`) |
| `Shape` | Anything else |

**Layers with children**

| Role | When |
|---|---|
| `Button` | Has a click or press interaction, or looks like one: a fill or stroke, 72 px tall or less, one short text (plus icons) |
| `Badge` | Looks like a button but is 24 px tall or less, or its text is 12 px or less |
| `Screen` | The top frame, at a phone width (360–440 px, 640 px tall or more) or 1024 × 600 or larger |
| `Header` / `Footer` | Directly in a screen, 90% of its width or more, along its top or bottom edge |
| `Sidebar` | Directly in a screen, 90% of its height or more, at most 35% of its width, on its left edge |
| `<Child>List` / `<Child>Grid` | Two or more children with the same role or name: `CardList`, `ItemGrid` (grid or wrapping layout) |
| `Actions` | Two or more buttons |
| `Card` | A fill or stroke and rounded corners |
| `Panel` | A fill or stroke, square corners |
| `TextGroup` | Only text inside |
| `Row` | Horizontal auto-layout |
| `Grid` | Grid auto-layout |
| `Container` | Anything else |

In Figma, roles are used as they are (`Card`, `Title`). In Roblox they become PascalCase instance names with a suffix
for the kind of instance (`TitleLabel`, `BuyButton`), and siblings with the same name are numbered (`Card1`, `Card2`).

## Sources

- [Best practices to help Figma AI understand your design system](https://help.figma.com/hc/en-us/articles/38978644498199-Best-practices-to-help-Figma-AI-understand-your-design-system) (Figma): semantic layer and component names.
- [Roblox Lua style guide](https://roblox.github.io/lua-style-guide/): PascalCase for instances and classes, words spelled out.
- Roblox Creator Docs UI tutorials ([github.com/Roblox/creator-docs](https://github.com/Roblox/creator-docs)): instance names such as `HUDContainer`, `CloseButton`, `HeaderTextLabel`, `MeterBar`, `LeaderboardGui`.
