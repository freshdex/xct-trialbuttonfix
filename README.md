# XCT Trial Button Fix

A small browser extension that puts the **GET Free Trial** button back on Xbox Store product pages when Microsoft hides it.

Available as a Chrome (MV3) build and a Firefox (MV3) build. Both behave identically — same UI, same logic, same network calls.

## Why this exists

A lot of Xbox games still ship a free trial SKU (the internal `SkuId` is `0011`), but Microsoft's storefront stops surfacing the **Free Trial** action button under common conditions:

- you're an active **Game Pass** subscriber (the trial is suppressed in favour of "Play with Game Pass"),
- the game has been delisted but the trial entitlement is still claimable,
- the page falls back to a generic "Buy" / "Pre-order" layout that omits secondary actions,
- regional storefronts simply hide the action.

The trial entitlement itself is still on your account if you redeem it — the Xbox apps and the cloud will recognise it. The store page is the only thing pretending it doesn't exist.

This extension detects those cases and injects a working **GET Free Trial** button that drives Microsoft's real BuyNow purchase widget with the trial SKU, so you can claim the trial in two clicks.

## What it does, end-to-end

1. **Captures your XBL3.0 auth token.** When you're signed in to xbox.com, the page makes API calls to `emerald.xboxservices.com` carrying an `Authorization: XBL3.0 …` header. The extension's background script silently records that header into `storage.local` so it can reuse it for API calls of its own. Nothing is sent off-device.
2. **Detects the current product.** The content script watches `xbox.com/*/games/store/...` URLs, pulls the `9XXXXXXXXXX`-style product ID out of the path, and re-checks on SPA navigation.
3. **Asks Xbox if a trial exists.** The background script calls `productActions` and looks for either:
   - an explicit `actionType: "Trial"` (the case where Microsoft just forgot to render the button), or
   - a hidden `skuActionsBySkuId["0011"]` entry (the Game-Pass-suppression case).
4. **Resolves the trial's availability ID.** When the trial is hidden, it queries `productDetails` (api-version 2.0) and, if that fails, falls back to `displaycatalog.mp.microsoft.com` to dig the `AvailabilityId` for SKU `0011` out of the catalog.
5. **Injects the button.** A floating green **GET / Free trial** button is added to the product page (bottom-right, inside a top-layer `<dialog>` so it can't be clipped or covered by the page's own UI).
6. **Opens the real BuyNow widget.** Clicking the button POSTs a form to `microsoft.com/store/purchase/buynowui/buynow` inside a modal iframe — the same widget the official store uses. You see Microsoft's real purchase UI, accept, and the trial entitlement is added to your account. The overlay closes itself on `purchaseComplete` / `close` postMessages.

The extension is purely a UI fix — it does not bypass DRM, region locks, age gates, or payment. It only un-hides an action that the back-end already permits.

## Files

```
chrome_extension_trial_fixer/        # Chrome / Edge / Brave (MV3)
  manifest.json
  background.js                      # service_worker
  content.js

firefox_extension_trial_fixer/       # Firefox (MV3)
  manifest.json                      # uses background.scripts + browser_specific_settings.gecko
  background.js                      # event-page script (no extraHeaders)
  content.js                         # identical to Chrome
```

The Firefox port differs from the Chrome build in two places only:

- `manifest.json` declares `browser_specific_settings.gecko.id` (required for AMO signing) and uses `background.scripts` rather than `background.service_worker`, so it works on Firefox 115 ESR and up — not just Firefox 121+.
- `background.js` drops the Chrome-only `"extraHeaders"` flag from the `webRequest.onSendHeaders` listener; Firefox captures the Authorization header without it.

`content.js` is byte-identical between the two builds. The `chrome.*` namespace is available as a callback alias in Firefox MV3, so no polyfill is needed.

## Install — Chrome / Edge / Brave / any Chromium

1. Download or `git clone` this repo.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and pick the `chrome_extension_trial_fixer/` folder.
5. Make sure the extension is **enabled** in the list. The icon does not need to be pinned to the toolbar — there is no popup; it works entirely in the background.
6. Open `https://www.xbox.com/`, sign in, and visit any game page (e.g. `https://www.xbox.com/en-US/games/store/.../9NXXXXXXX`). If a trial exists, the green **GET Free trial** button appears in the bottom-right of the page within a few seconds.

To update later, `git pull` and hit the **Reload** (↻) button on the extension's tile in `chrome://extensions`.

## Install — Firefox

Mozilla requires extensions to be signed for permanent installs in regular Firefox. You have three options.

### Option A — Temporary install (easiest, lasts until Firefox restarts)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `firefox_extension_trial_fixer/manifest.json` (any file inside the folder works).
4. The extension is now active. Visit `https://www.xbox.com/` and use it as normal.

This is fine for occasional use. You'll have to reload it every time you restart Firefox.

### Option B — Permanent install on Developer Edition / Nightly / Unbranded

These builds let you turn signing off:

1. Use **Firefox Developer Edition**, **Nightly**, or the **Unbranded** build (regular Firefox release/ESR will not allow this).
2. Open `about:config`, set `xpinstall.signatures.required` to `false`.
3. Zip the **contents** of `firefox_extension_trial_fixer/` (not the folder itself — `manifest.json` must be at the root of the zip). Rename the `.zip` to `.xpi`:
   ```bash
   cd firefox_extension_trial_fixer
   zip -r ../xct-trialbuttonfix.xpi *
   ```
4. Drag the `.xpi` into Firefox, or open it via `about:addons` → gear icon → **Install Add-on From File…**.

### Option C — Self-sign through addons.mozilla.org

If you want it to install on regular Firefox without messing with config:

1. Make a free account at <https://addons.mozilla.org/developers/>.
2. Build the `.xpi` as in Option B.
3. Submit it as **self-distributed** (you don't have to list it on AMO publicly). Mozilla signs it automatically for unlisted submissions in most cases.
4. Install the signed `.xpi` on any Firefox.

## Using it

There is no popup, no settings page, no toolbar UI. Just:

1. Be signed in on `xbox.com`.
2. Open a game's store page.
3. If a trial SKU exists for that game, the floating **GET Free trial** button appears bottom-right within a few seconds. Click it.
4. Microsoft's real purchase modal opens in an overlay. Confirm. The trial is added to your account, the overlay closes, and you'll see a "Free trial claimed successfully!" alert.
5. Refresh the page or open the Xbox app to see the trial in your library.

If nothing shows up after ~30 seconds:

- Check the page's DevTools console for `[XBOX-INJ]` log lines. They tell you whether a trial was detected, what API failed, etc.
- The most common cause of "no button" is "no trial SKU exists for this game" — most games don't have one. The extension only injects a button when a trial actually exists.
- The token capture is passive: if you've never visited the site since installing the extension, navigate around xbox.com once so it can grab a fresh `XBL3.0` token before opening a game page.

## Permissions, in plain English

- **`webRequest`** — read the `Authorization` header on requests *your browser is already sending* to `emerald.xboxservices.com`, so the extension can re-use your sign-in. No requests are blocked or modified.
- **`storage`** — store the captured token locally so the background script can use it. Nothing leaves your machine.
- **Host permissions** (`emerald.xboxservices.com`, `*.xboxlive.com`, `xbox.com`, `microsoft.com`, `displaycatalog.mp.microsoft.com`) — needed so the extension can call the same APIs the storefront calls, and so the BuyNow iframe can post back to the page.

The extension makes **zero outbound calls to any third-party server.** It only talks to Microsoft endpoints.

## Caveats

- The extension only works for accounts where the trial entitlement *would* be granted by Microsoft if the button existed. It does not invent trials that aren't on the back-end.
- Microsoft can change the `productActions` / `productDetails` schemas at any time. If the button stops appearing on games where you know a trial exists, check the console for parse errors and open an issue.
- Game Pass Ultimate / PC Game Pass do not block the trial entitlement itself — you can claim it and keep it after you cancel Game Pass.
- The button is intentionally fixed-position in the bottom-right corner so the page's own React tree can't accidentally remove it during re-renders. If a future xbox.com redesign covers it up, the selector logic in `content.js` may need a tweak.

## Source

This repo is a sibling of [Xbox Collection Tracker (XCT)](https://github.com/Freshdex/xbox-collection-tracker). The extension was originally bundled inside that repo and has been split out so it can be installed on its own.

## License

No license file is included; treat this as personal-use source. Pull requests welcome.
