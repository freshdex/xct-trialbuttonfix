// Background service worker
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
  ["requestHeaders", "extraHeaders"]
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

// In-memory cache of resolved trialInfo, keyed by productId. Survives within
// the service-worker lifetime; second nav to the same product is instant.
// `null` is cached too so we don't re-probe games that have no trial.
const _trialCache = new Map();

async function _probeProductActions(token, productId) {
  const r = await fetch(
    `https://emerald.xboxservices.com/xboxcomfd/productActions/${productId}?locale=en-US`,
    { headers: makeHeaders(token) }
  );
  if (!r.ok) throw new Error("productActions HTTP " + r.status);
  const data = await r.json();
  const pa = data.productActions && data.productActions[0];
  if (!pa || !pa.productActions) throw new Error("no productActions array");
  for (const action of pa.productActions) {
    if (action.actionType === "Trial" && action.actionArguments) {
      return {
        productId: action.actionArguments.ProductId || productId,
        skuId: action.actionArguments.SkuId,
        availabilityId: action.actionArguments.AvailabilityId,
        source: "productActions"
      };
    }
  }
  throw new Error("no Trial action");
}

async function _probeDisplayCatalog(productId) {
  const r = await fetch(
    `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${productId}&market=US&languages=en-US&fieldsTemplate=details`,
    { headers: { "Accept": "application/json" } }
  );
  if (!r.ok) throw new Error("displaycatalog HTTP " + r.status);
  const data = await r.json();
  const product = data.Products && data.Products[0];
  if (!product) throw new Error("no product in catalog response");
  for (const dsa of (product.DisplaySkuAvailabilities || [])) {
    const sku = dsa.Sku || {};
    const props = sku.Properties || {};
    if (props.IsTrial === true) {
      const skuId = sku.SkuId;
      const availabilityId =
        (dsa.Availabilities && dsa.Availabilities[0] && dsa.Availabilities[0].AvailabilityId) || "";
      if (skuId && availabilityId) {
        return { productId, skuId, availabilityId, source: "displaycatalog" };
      }
    }
  }
  throw new Error("no IsTrial SKU");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getToken") {
    chrome.storage.local.get(["xblToken", "tokenTime"], (result) => sendResponse(result));
    return true;
  }

  if (msg.type === "checkTrial") {
    const productId = msg.productId;

    // Cached? Respond synchronously.
    if (_trialCache.has(productId)) {
      const cached = _trialCache.get(productId);
      console.log("[XBOX-INJ-BG] Cache hit for", productId, "→", cached ? "trial" : "no-trial");
      sendResponse({ trialInfo: cached });
      return true;
    }

    chrome.storage.local.get(["xblToken"], async (result) => {
      if (!result.xblToken) {
        sendResponse({ error: "No auth token available" });
        return;
      }

      // Race the two probes — productActions usually wins for non-hidden
      // trials; displaycatalog is the fallback for Game-Pass-hidden trials.
      // Promise.any() resolves on the first SUCCESSFUL probe, so we no longer
      // wait for productActions to fail before starting the catalog lookup.
      try {
        const trialInfo = await Promise.any([
          _probeProductActions(result.xblToken, productId),
          _probeDisplayCatalog(productId)
        ]);
        console.log(`[XBOX-INJ-BG] Trial found via ${trialInfo.source}:`,
                    JSON.stringify({ productId: trialInfo.productId,
                                     skuId: trialInfo.skuId,
                                     availabilityId: trialInfo.availabilityId }));
        _trialCache.set(productId, trialInfo);
        sendResponse({ trialInfo });
      } catch (e) {
        // AggregateError from Promise.any when both probes fail. The user
        // has no trial available for this product.
        const reasons = (e && e.errors) ? e.errors.map(x => x.message).join("; ") : String(e);
        console.log("[XBOX-INJ-BG] No trial for", productId, "—", reasons);
        _trialCache.set(productId, null);
        sendResponse({ trialInfo: null });
      }
    });
    return true;
  }
});

console.log("[XBOX-INJ-BG] Service worker started");
