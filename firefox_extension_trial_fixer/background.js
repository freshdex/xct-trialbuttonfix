// Background event page (Firefox MV3)
// Firefox exposes the WebExtensions API on `browser`; `chrome` is also
// available as a callback-style alias, so we keep using it for parity with
// the Chrome build.
//
// 1. Captures XBL3.0 auth tokens from emerald requests
// 2. Queries productActions + productDetails APIs to find hidden trials

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!details.requestHeaders) return;
    for (const header of details.requestHeaders) {
      if (header.name.toLowerCase() === "authorization" && header.value && header.value.includes("XBL3.0")) {
        chrome.storage.local.set({ xblToken: header.value, tokenTime: Date.now() });
        return;
      }
    }
  },
  { urls: ["https://emerald.xboxservices.com/*"] },
  ["requestHeaders"]
);

// Generate MS-CV header
let cvCounter = 0;
function generateMsCV() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "/").replace(/=/g, "");
  cvCounter++;
  return `${base64}.${cvCounter}`;
}

function makeHeaders(token) {
  return {
    "Authorization": token,
    "x-ms-api-version": "1.0",
    "ms-cv": generateMsCV(),
    "x-xbl-client-name": "XboxCom",
    "x-xbl-client-type": "web",
    "x-xbl-contract-version": "2",
    "Accept": "application/json",
    "Origin": "https://www.xbox.com",
    "Referer": "https://www.xbox.com/"
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getToken") {
    chrome.storage.local.get(["xblToken", "tokenTime"], (result) => sendResponse(result));
    return true;
  }

  if (msg.type === "checkTrial") {
    const productId = msg.productId;
    chrome.storage.local.get(["xblToken"], async (result) => {
      if (!result.xblToken) {
        sendResponse({ error: "No auth token available" });
        return;
      }

      try {
        // Step 1: Check productActions for explicit Trial action.
        // This is visible for non-Game-Pass users; for Game Pass users on
        // affected SKUs Microsoft hides the Trial action — that's the bug
        // this extension exists to work around.
        const actionsResp = await fetch(
          `https://emerald.xboxservices.com/xboxcomfd/productActions/${productId}?locale=en-US`,
          { headers: makeHeaders(result.xblToken) }
        );

        if (actionsResp.ok) {
          const actionsData = await actionsResp.json();
          const pa = actionsData.productActions && actionsData.productActions[0];
          if (pa && pa.productActions) {
            for (const action of pa.productActions) {
              if (action.actionType === "Trial" && action.actionArguments) {
                const trialInfo = {
                  productId: action.actionArguments.ProductId || productId,
                  skuId: action.actionArguments.SkuId,
                  availabilityId: action.actionArguments.AvailabilityId
                };
                console.log("[XBOX-INJ-BG] Trial found via productActions:", JSON.stringify(trialInfo));
                sendResponse({ trialInfo });
                return;
              }
            }
          }
        }

        // Step 2: No explicit Trial action — either no trial exists OR it's
        // hidden by the Game Pass bug. Resolve via displaycatalog by looking
        // for ANY SKU with IsTrial=true. The trial SKU id varies per product
        // (Dead Island 2 uses "0004", many others use "0011", etc.) so we
        // can't hardcode it.
        console.log("[XBOX-INJ-BG] No explicit Trial action — checking displaycatalog for hidden trial SKU");
        const catResp = await fetch(
          `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${productId}&market=US&languages=en-US&fieldsTemplate=details`,
          { headers: { "Accept": "application/json" } }
        );

        if (!catResp.ok) {
          console.log("[XBOX-INJ-BG] displaycatalog failed:", catResp.status);
          sendResponse({ trialInfo: null });
          return;
        }

        const catData = await catResp.json();
        const product = catData.Products && catData.Products[0];
        if (!product) {
          console.log("[XBOX-INJ-BG] No product in catalog response");
          sendResponse({ trialInfo: null });
          return;
        }

        const dsas = product.DisplaySkuAvailabilities || [];
        for (const dsa of dsas) {
          const sku = dsa.Sku || {};
          const props = sku.Properties || {};
          if (props.IsTrial === true) {
            const skuId = sku.SkuId;
            const availabilityId =
              (dsa.Availabilities && dsa.Availabilities[0] && dsa.Availabilities[0].AvailabilityId) || "";
            if (skuId && availabilityId) {
              console.log(`[XBOX-INJ-BG] Trial SKU ${skuId} found via catalog, avail ${availabilityId}`);
              sendResponse({ trialInfo: { productId, skuId, availabilityId } });
              return;
            }
          }
        }

        console.log("[XBOX-INJ-BG] No trial SKU found in catalog for", productId);
        sendResponse({ trialInfo: null });

      } catch (e) {
        console.error("[XBOX-INJ-BG] Error:", e);
        sendResponse({ error: e.message });
      }
    });
    return true;
  }
});

console.log("[XBOX-INJ-BG] Background script started");
