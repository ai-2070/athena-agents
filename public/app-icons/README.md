# App icons

Logos for programs that Simple Icons doesn't have and that aren't Craft apps (those are in
`public/craft-icons`). `web/appicons.ts` picks them, and `appLogo` in `web/views/stationdata.ts`
falls back to them after the Simple Icons logos and the Craft app icons. Orca, Cua and Composio are only
used for the skills that come with the dashboard (`shared/skillmarks.ts`).

| File | Source |
|---|---|
| `irfanview.ico` | IrfanView’s own favicon, from https://www.irfanview.com/favicon.ico. |
| `comfyui.png` | The ComfyUI Desktop app's icon (`assets/Comfy_Logo_x256.png` in its `resources/app.asar`): the yellow mark cut out of its dark square onto a clear background, 96 × 96. |
| `orca.png` | Orca's app icon, `resources/icon.png` in [stablyai/orca](https://github.com/stablyai/orca) at `274b99919f6c3d62634df2040dec6de4f9b1c4a7` (MIT): its clear margin cut off, 96 × 96. |
| `cua.png` | Cua's app icon, `apps/cua-spaces-mobile/assets/cua-app-icon-256.png` in [trycua/cua](https://github.com/trycua/cua) at `23404c7f51ed6b9f15e5fc953ddc8ae555bae0bb` (MIT): its clear margin cut off, 96 × 96. |
| `composio.png` | Composio's icon, `docs/app/icon.png` in [ComposioHQ/composio](https://github.com/ComposioHQ/composio) at `0a4609a554d4f973a4125a1326c71229575b9f0c` (MIT), 96 × 96. |
| `lmstudio.png` | LM Studio's own one-colour tray mark (`resources/trayIconDarkTemplate@3x.png` in its install folder), filled with the light end of its app icon's purple (`#6a72ed`), 66 × 66. |

The ComfyUI name and logo belong to Comfy Org, the LM Studio name and logo to Element Labs, and the Orca,
Cua and Composio names and logos to their makers; they are shown here only to say which program is meant. Refresh from the same files; never redraw them.
