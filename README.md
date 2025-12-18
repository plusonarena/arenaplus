# Arena Plus Chrome Extension

Arena Plus augments the Arena Social experience with an embedded wallet, tipping, and promotion tools so you can engage directly from your browser.

## What it does
- Create or import an Avalanche wallet (AVAX and ERC-20 tokens such as PLUS and ARENA) directly in the extension.
- Send tips and interact with promotions/Post2Earn flows without leaving Arena Social.
- View balances and recent activity in a compact popup UI.
- Optional integrations with Supabase-authenticated Twitter sessions for social features.

## Quick install (unpacked)
This is the fastest way to try the extension before it’s published.
1. Download the latest `arena-plus-extension-dist.zip` from [Releases](https://github.com/plusonarena/arenaplus/releases) (do **not** download the source zip).
2. Unzip it to a folder on your machine.
3. In Chrome, open `chrome://extensions/`, enable **Developer mode**, and click **Load unpacked**.
4. Select the unzipped folder (it must contain `manifest.json`). The Arena Plus icon should appear in your toolbar.

## Build from source
Prerequisites: Node.js 20+, npm.
1. Clone and install:
   ```bash
   git clone https://github.com/plusonarena/arenaplus.git
   cd arenaplus
   npm install
   ```
2. Add environment variables in `.env`:
   ```env
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   VITE_AVAX_RPC_URL=your_avalanche_rpc  # optional, defaults to mainnet
   VITE_ARENAPRO_API_URL=...
   VITE_STARS_ARENA_API_URL=...
   ```
3. Build:
   ```bash
   npm run build
   ```
   The unpacked build will be in `dist/`.
4. Load `dist/` as an unpacked extension via `chrome://extensions/`.
5. Development mode (hot reload):
   ```bash
   npm run dev
   ```

## Security and privacy notes
- Wallet keys are encrypted client-side using PBKDF2 + AES-GCM; decrypted keys stay in memory/session only.
- Bearer-token interception/persistence has been removed; only user-approved sessions are used.
- Keep your `.env` secrets local and never commit them to version control.

## Troubleshooting
- If the popup shows “Wallet not set up”, open `welcome.html` (it auto-opens on first install) to create/import a wallet.
- If balances are stale, click refresh in the wallet tab or reopen the popup.
- After updating, reload the extension from `chrome://extensions/` to ensure background scripts are refreshed.

## License
MIT License. See [LICENSE](LICENSE) for details.

## Support
Questions or issues? Open a GitHub issue or email [plusonarena@gmail.com](mailto:plusonarena@gmail.com).
