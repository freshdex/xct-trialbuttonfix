// Xbox Store Free Trial Button Injector (content script)
// Dynamically detects the current game, checks for trial availability via API,
// and injects a GET Free Trial button if a trial exists.
(function () {
  "use strict";

  console.log("[XBOX-INJ] Content script loaded on:", location.href);

  const WRAPPER_ID = "injected-trial-wrapper";

  // Extract product ID from the URL
  // Formats: /games/store/p/XXXXX or /games/store/game-name/XXXXX
  function getProductIdFromUrl() {
    const url = location.pathname;
    const segments = url.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      if (/^[A-Z0-9]{10,14}$/i.test(segments[i])) {
        return segments[i].toUpperCase();
      }
    }
    return null;
  }

  function getXToken() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "getToken" }, (result) => {
        resolve(result ? result.xblToken : null);
      });
    });
  }

  function checkTrialAvailability(productId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "checkTrial", productId: productId }, (result) => {
        resolve(result);
      });
    });
  }

  function openBuyNowIframe(xToken, productId, skuId, availabilityId) {
    const existing = document.getElementById("trial-purchase-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "trial-purchase-overlay";
    overlay.style.cssText = `
      position: fixed !important; top: 0 !important; left: 0 !important;
      width: 100% !important; height: 100% !important;
      background: rgba(0,0,0,0.7) !important; z-index: 2147483647 !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
    `;

    const iframeName = "buynow_frame_" + Date.now();
    const iframe = document.createElement("iframe");
    iframe.name = iframeName;
    iframe.style.cssText = `
      width: 500px !important; height: 620px !important; border: none !important;
      border-radius: 8px !important; background: #1a1a1a !important;
    `;

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715";
    closeBtn.style.cssText = `
      position: fixed !important; top: 20px !important; right: 20px !important;
      background: #444 !important; color: white !important;
      border: none !important; border-radius: 50% !important;
      width: 40px !important; height: 40px !important; font-size: 20px !important;
      cursor: pointer !important; z-index: 2147483647 !important;
    `;
    closeBtn.addEventListener("click", () => overlay.remove());

    overlay.appendChild(closeBtn);
    overlay.appendChild(iframe);
    document.body.appendChild(overlay);

    const form = document.createElement("form");
    form.method = "POST";
    form.action = "https://www.microsoft.com/store/purchase/buynowui/buynow?noCanonical=true&market=US&locale=en-US&clientName=XboxCom";
    form.target = iframeName;
    form.style.display = "none";

    const fields = {
      data: JSON.stringify({ usePurchaseSdk: true }),
      market: "US",
      locale: "en-US",
      xToken: xToken,
      pageFormat: "full",
      products: JSON.stringify([{
        productId: productId,
        skuId: skuId,
        availabilityId: availabilityId
      }]),
      campaignId: "xboxcomct",
      callerApplicationId: "XboxCom",
      urlRef: "https://www.xbox.com/",
      clientType: "XboxCom",
      layout: "Modal",
      cssOverride: "XboxCom2NewUI",
      theme: "dark",
      sdkVersion: "5.10.6",
      GPC_DataSharingOptIn: "true",
      parentHostName: "www.xbox.com"
    };

    for (const [key, val] of Object.entries(fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = val;
      form.appendChild(input);
    }

    document.body.appendChild(form);
    form.submit();
    form.remove();
    console.log("[XBOX-INJ] BuyNow iframe submitted for", productId, "SKU", skuId);
  }

  // Current page state
  let currentProductId = null;
  let currentTrialInfo = null;
  let checking = false;
  let retryCount = 0;
  const MAX_RETRIES = 30;

  async function checkAndInject() {
    const productId = getProductIdFromUrl();
    if (!productId) return;

    // If product ID changed (SPA navigation), reset
    if (productId !== currentProductId) {
      currentProductId = productId;
      currentTrialInfo = null;
      checking = false;
      retryCount = 0;

      // Remove old button
      const old = document.getElementById(WRAPPER_ID);
      if (old) old.remove();
    }

    // Already have a button or already checking
    if (document.getElementById(WRAPPER_ID) || checking) return;

    // Need to check for trial
    if (currentTrialInfo === null) {
      checking = true;
      console.log("[XBOX-INJ] Checking trial availability for:", productId);

      const result = await checkTrialAvailability(productId);
      checking = false;

      if (result && result.error) {
        retryCount++;
        console.log("[XBOX-INJ] API error:", result.error, `- retry ${retryCount}/${MAX_RETRIES}`);
        if (retryCount >= MAX_RETRIES) {
          currentTrialInfo = false;
          console.log("[XBOX-INJ] Max retries reached, giving up");
        }
        return;
      }

      if (result && result.trialInfo) {
        currentTrialInfo = result.trialInfo;
        console.log("[XBOX-INJ] Trial found!", JSON.stringify(currentTrialInfo));
      } else {
        currentTrialInfo = false;
        console.log("[XBOX-INJ] No trial available for this game");
        return;
      }
    }

    if (!currentTrialInfo) return;

    // Wait for the actions panel to exist
    const panel = document.querySelector('[class*="desktopProductActionsPanel"]')
      || document.querySelector('[class*="ProductActionsPanel"]');
    if (!panel) return;

    // Create the button
    const dialog = document.createElement("dialog");
    dialog.id = WRAPPER_ID;
    dialog.style.cssText = `
      position: fixed !important;
      bottom: 40px !important;
      right: 40px !important;
      top: auto !important;
      left: auto !important;
      z-index: 2147483647 !important;
      border: none !important;
      padding: 0 !important;
      margin: 0 !important;
      background: transparent !important;
      overflow: visible !important;
    `;

    dialog.innerHTML = `
      <button id="injected-trial-btn" style="
        display: inline-flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        min-width: 180px !important;
        height: 75px !important;
        padding: 10px 28px !important;
        background-color: #107c10 !important;
        color: white !important;
        border: 2px solid #0e6b0e !important;
        border-radius: 6px !important;
        cursor: pointer !important;
        font-family: 'Segoe UI', sans-serif !important;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4) !important;
        opacity: 1 !important;
        visibility: visible !important;
      ">
        <span style="font-size:16px !important;font-weight:700 !important;text-transform:uppercase !important;letter-spacing:0.5px !important;color:white !important;">GET</span>
        <span style="font-size:13px !important;font-weight:400 !important;margin-top:3px !important;color:white !important;">Free trial</span>
      </button>
    `;

    const trial = currentTrialInfo;

    dialog.querySelector("button").addEventListener("click", async () => {
      console.log("[XBOX-INJ] GET clicked for", trial.productId, "SKU", trial.skuId);

      const xToken = await getXToken();
      if (!xToken) {
        alert("Auth token not captured yet. Refresh and try again.");
        return;
      }

      openBuyNowIframe(xToken, trial.productId, trial.skuId, trial.availabilityId);
    });

    document.documentElement.appendChild(dialog);
    dialog.show();
    console.log("[XBOX-INJ] Trial button shown for", trial.productId);
  }

  // Listen for postMessage from BuyNow iframe
  window.addEventListener("message", (event) => {
    if (event.origin && event.origin.includes("microsoft.com")) {
      console.log("[XBOX-INJ] postMessage from BuyNow:", event.data);

      const data = event.data;
      if (data && (data.type === "purchaseComplete" || data.status === "success" ||
          (typeof data === "string" && data.includes("purchased")))) {
        const overlay = document.getElementById("trial-purchase-overlay");
        if (overlay) overlay.remove();
        alert("Free trial claimed successfully! Refresh the page.");
      }

      if (data && (data.type === "close" || data.type === "cancel" || data.action === "close")) {
        const overlay = document.getElementById("trial-purchase-overlay");
        if (overlay) overlay.remove();
      }
    }
  });

  // Poll for changes (SPA navigation + dynamic content)
  setInterval(() => checkAndInject(), 1000);
  const observer = new MutationObserver(() => checkAndInject());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
