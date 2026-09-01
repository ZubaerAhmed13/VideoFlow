(() => {
  const RELOAD_GUARD = "videoflow-coi-reload-v1";
  const root = document.documentElement;
  const reveal = () => root.style.removeProperty("visibility");
  if (self.crossOriginIsolated) {
    sessionStorage.removeItem(RELOAD_GUARD);
    reveal();
    return;
  }
  if (!("serviceWorker" in navigator)) {
    reveal();
    return;
  }

  root.style.visibility = "hidden";
  const script = document.currentScript;
  const base = new URL("./", script?.src || location.href);
  const serviceWorkerUrl = new URL("service-worker.js", base);
  let reloading = false;

  const reloadOnce = () => {
    if (reloading) return;
    reloading = true;
    sessionStorage.setItem(RELOAD_GUARD, "1");
    location.reload();
  };

  const waitForControllerChange = (timeoutMs = 8_000) => new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      if (timer) clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", done);
      resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
    timer = window.setTimeout(done, timeoutMs);
  });

  const activateNewest = async (registration) => {
    if (registration.waiting) {
      const changed = waitForControllerChange();
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
      await changed;
      return;
    }
    const installing = registration.installing;
    if (!installing) return;
    await new Promise((resolve) => {
      const changed = () => {
        if (installing.state === "installed" || installing.state === "activated" || installing.state === "redundant") {
          installing.removeEventListener("statechange", changed);
          resolve();
        }
      };
      installing.addEventListener("statechange", changed);
      changed();
    });
    if (registration.waiting) {
      const changed = waitForControllerChange();
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
      await changed;
    }
  };

  void (async () => {
    try {
      const registration = await navigator.serviceWorker.register(serviceWorkerUrl.href, { scope: base.pathname });
      await registration.update().catch(() => undefined);
      await activateNewest(registration);
      if (!navigator.serviceWorker.controller) {
        await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((resolve) => window.setTimeout(resolve, 8_000)),
        ]);
      }

      if (sessionStorage.getItem(RELOAD_GUARD) === "1") {
        // Never loop if a browser or embedding context refuses the isolation
        // headers. The app stays usable, while AI remains worker-bounded.
        sessionStorage.removeItem(RELOAD_GUARD);
        reveal();
        return;
      }
      reloadOnce();
    } catch (error) {
      console.warn("VideoFlow could not establish the optional cross-origin-isolated runtime.", error);
      sessionStorage.removeItem(RELOAD_GUARD);
      reveal();
    }
  })();
})();
