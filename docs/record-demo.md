# Recording the demo GIF

A 45–60 second loop for the top of the README. Save it as `docs/demo.gif` (720 px wide, under 8 MB), then uncomment
the image line in the README.

## Setup

- Figma desktop, light theme, a new file with an empty page. The Figma Bridge plugin open on the right, expanded.
- An AI client next to it (Claude Code in a terminal with a large font, or Claude Desktop), about one third of the
  screen.
- `examples/` and a small local web page ready, so nothing has to load from the network during the take.
- Hide notifications, bookmarks bar and personal files. Record at 2× and export at 15 fps.

## Shots

| Time | Prompt or action | What the viewer should see |
|---|---|---|
| 0–3 s | Title card: "Figma Bridge: your AI agent, inside Figma". | Static. |
| 3–15 s | *"Build examples/pricing-section.json, then check it with audit."* | The plugin log shows **Build · Pricing · 60 layers**; the section appears in one go, zoomed to fit; the audit result in the client. |
| 15–28 s | *"Import http://localhost:5173 at 1440 and 390."* | Two frames side by side; open the layers panel briefly to show Header / Nav / Card names and auto-layout. |
| 28–38 s | *"Make it dark: create Light and Dark modes from our tokens and switch this frame to Dark."* | Variables panel with two modes; the frame switches to dark. |
| 38–50 s | *"Export the pricing card into ~/code/demo-app with our components."* | The client shows `import { Button } from "@/components/ui/button"` and `<Button variant="secondary">`; cut to the app in the browser rendering it. |
| 50–55 s | Press Ctrl+Z once in Figma. | The last change disappears in one step. |
| 55–60 s | End card: `npx @clovis500c/figma-bridge setup`. | Static. |

## Tips

- Speed up waiting parts 2–4× in the editor; never speed up the moment a result appears.
- Keep the mouse still while the agent works: the point is that nothing is done by hand.
- Crop to the Figma canvas and the client only; no menu bar.
- Check the frames look right before recording: rerun until the import and the export are clean.
