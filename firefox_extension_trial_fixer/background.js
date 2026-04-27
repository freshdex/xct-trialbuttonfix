// Background event page (Firefox MV3)
// 1. Captures XBL3.0 auth tokens from emerald requests
// 2. Queries productActions + productDetails APIs to find hidden trials

// Firefox exposes the WebExtensions API on `browser`; `chrome` is also
// available as a callback-style alias, so we keep using it for parity with
// the Chrome build.

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
        // Step 1: Check productActions for Trial action or SKU 0011
        const actionsResp = await fetch(
          `https://emerald.xboxservices.com/xboxcomfd/productActions/${productId}?locale=en-US`,
          { headers: makeHeaders(result.xblToken) }
        );

        if (!actionsResp.ok) {
          const errBody = await actionsResp.text().catch(() => "");
          sendResponse({ error: `productActions ${actionsResp.status}: ${errBody.substring(0, 200)}` });
          return;
        }

        const actionsData = await actionsResp.json();
        console.log("[XBOX-INJ-BG] productActions for", productId);

        let trialInfo = null;
        let hasTrialSku = false;

        if (actionsData.productActions && actionsData.productActions.length > 0) {
          const pa = actionsData.productActions[0];

          // Check for explicit Trial action (visible for non-Game Pass users)
          if (pa.productActions) {
            for (const action of pa.productActions) {
              if (action.actionType === "Trial" && action.actionArguments) {
                trialInfo = {
                  productId: action.actionArguments.ProductId || productId,
                  skuId: action.actionArguments.SkuId,
                  availabilityId: action.actionArguments.AvailabilityId
                };
                break;
              }
            }
          }

          // Check if SKU 0011 exists (trial SKU hidden by Game Pass)
          if (!trialInfo && pa.skuActionsBySkuId && pa.skuActionsBySkuId["0011"]) {
            hasTrialSku = true;
            console.log("[XBOX-INJ-BG] SKU 0011 found but Trial action hidden (Game Pass bug)");
          }
        }

        // If we found an explicit trial, return it
        if (trialInfo) {
          console.log("[XBOX-INJ-BG] Trial found via productActions:", JSON.stringify(trialInfo));
          sendResponse({ trialInfo });
          return;
        }

        // If no SKU 0011, no trial exists
        if (!hasTrialSku) {
          console.log("[XBOX-INJ-BG] No trial SKU (0011) for this game");
          sendResponse({ trialInfo: null });
          return;
        }

        // Step 2: SKU 0011 exists but Trial action is hidden.
        // Get the availability ID from productDetails.
        console.log("[XBOX-INJ-BG] Fetching productDetails for availability ID...");

        // productDetails uses api-version 2.0
        const detailHeaders = makeHeaders(result.xblToken);
        detailHeaders["x-ms-api-version"] = "2.0";

        const detailsResp = await fetch(
          `https://emerald.xboxservices.com/xboxcomfd/productDetails/${productId}?locale=en-US&enableFullDetail=true&deviceType=desktop`,
          { headers: detailHeaders }
        );

        if (!detailsResp.ok) {
          const errBody = await detailsResp.text().catch(() => "");
          console.error("[XBOX-INJ-BG] productDetails", detailsResp.status, ":", errBody.substring(0, 500));

          // Try the display catalog API as fallback
          console.log("[XBOX-INJ-BG] Trying displaycatalog fallback...");
          const catResp = await fetch(
            `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${productId}&market=US&languages=en-US`,
            { headers: { "Accept": "application/json" } }
          );

          if (catResp.ok) {
            const catData = await catResp.json();
            const catStr = JSON.stringify(catData);
            // Find availability for SKU 0011
            const match = catStr.match(/"SkuId"\s*:\s*"0011"[\s\S]*?"AvailabilityId"\s*:\s*"([^"]+)"/i);
            if (match) {
              console.log("[XBOX-INJ-BG] Found availability via catalog:", match[1]);
              sendResponse({ trialInfo: { productId, skuId: "0011", availabilityId: match[1] } });
              return;
            }
          }

          // Last resort fallback
          console.log("[XBOX-INJ-BG] All APIs failed, cannot get availability ID");
          sendResponse({ trialInfo: { productId, skuId: "0011", availabilityId: "" } });
          return;
        }

        const detailsData = await detailsResp.json();

        // Search for SKU 0011's availability ID in the product details
        let availabilityId = "";
        try {
          const detailsStr = JSON.stringify(detailsData);

          // Look for SKU 0011 availability patterns
          if (detailsData.skus) {
            for (const sku of detailsData.skus) {
              if (sku.skuId === "0011" && sku.availabilities && sku.availabilities.length > 0) {
                availabilityId = sku.availabilities[0].availabilityId;
                break;
              }
            }
          }

          // Also try nested product.skus structure
          if (!availabilityId && detailsData.products) {
            for (const prod of detailsData.products) {
              if (prod.skus) {
                for (const sku of prod.skus) {
                  if (sku.skuId === "0011" && sku.availabilities && sku.availabilities.length > 0) {
                    availabilityId = sku.availabilities[0].availabilityId;
                    break;
                  }
                }
              }
              if (availabilityId) break;
            }
          }

          // Regex fallback: find 0011 near an availability ID
          if (!availabilityId) {
            const match = detailsStr.match(/"skuId"\s*:\s*"0011"[^}]*?"availabilityId"\s*:\s*"([^"]+)"/);
            if (match) availabilityId = match[1];
          }
          if (!availabilityId) {
            // Try reversed order
            const match2 = detailsStr.match(/"availabilityId"\s*:\s*"([^"]+)"[^}]*?"skuId"\s*:\s*"0011"/);
            if (match2) availabilityId = match2[1];
          }
        } catch (e) {
          console.error("[XBOX-INJ-BG] Error parsing details:", e);
        }

        console.log("[XBOX-INJ-BG] Trial SKU 0011 availability:", availabilityId || "(not found, will try empty)");

        sendResponse({
          trialInfo: {
            productId: productId,
            skuId: "0011",
            availabilityId: availabilityId
          }
        });

      } catch (e) {
        console.error("[XBOX-INJ-BG] Error:", e);
        sendResponse({ error: e.message });
      }
    });
    return true;
  }
});

console.log("[XBOX-INJ-BG] Background script started");
