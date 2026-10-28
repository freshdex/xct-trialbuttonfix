// XBOX Playback gate (runs in the page's own world, at document_start).
//
// xbox.com/playback is finished but hidden behind Microsoft's feature gate
// EnablePlaybackPage (the share card behind EnablePlaybackCardSharePage). The
// app reads its gates from window.__PRELOADED_STATE__.experiments: the
// environment gates, the experiment gates and `overrideFeatureGates`, merged
// in that order, keys in lower case. An inline script writes that state while
// the page parses. This trap adds the two Playback gates to
// overrideFeatureGates as the state is written, so xbox.com's own router opens
// /playback and xbox.com's own client sends `xbl-experiments:
// EnablePlaybackPage,...` to Microsoft's Playback service, which then answers
// with the member's real archive. Nothing else on the page is changed.
(function () {
  "use strict";

  const GATES = { enableplaybackpage: true, enableplaybackcardsharepage: true };

  function openGates(state) {
    try {
      const exp = state && state.experiments;
      if (exp && typeof exp === "object") {
        exp.overrideFeatureGates = Object.assign({}, exp.overrideFeatureGates, GATES);
      }
    } catch (_e) {
      // Never break xbox.com: a state we do not understand is left as it is.
    }
    return state;
  }

  if (window.__PRELOADED_STATE__) {
    openGates(window.__PRELOADED_STATE__);
    return;
  }
  let value;
  try {
    Object.defineProperty(window, "__PRELOADED_STATE__", {
      configurable: true,
      enumerable: true,
      get() { return value; },
      set(v) { value = openGates(v); },
    });
  } catch (_e) {
    // The page defined it first and locked it: nothing to do.
  }
})();
