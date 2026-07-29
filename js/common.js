if (import.meta.env.DEV && "serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations()
        .then(registrations => registrations.forEach(registration => registration.unregister()))
        .catch(err => console.warn("Service worker cleanup failed:", err));

    if ("caches" in window) {
        caches.keys()
            .then(keys => keys.forEach(key => caches.delete(key)))
            .catch(err => console.warn("Cache cleanup failed:", err));
    }
} else if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        let refreshing = false;

        navigator.serviceWorker.addEventListener("controllerchange", () => {
            if (refreshing) return;
            refreshing = true;
            window.location.reload();
        });

        navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
            .then(registration => {
                registration.update().catch(err => {
                    console.warn("Service worker update check failed:", err);
                });

                if (registration.waiting) {
                    registration.waiting.postMessage({ type: "SKIP_WAITING" });
                }

                registration.addEventListener("updatefound", () => {
                    const nextWorker = registration.installing;
                    if (!nextWorker) return;

                    nextWorker.addEventListener("statechange", () => {
                        if (nextWorker.state === "installed" && navigator.serviceWorker.controller) {
                            nextWorker.postMessage({ type: "SKIP_WAITING" });
                        }
                    });
                });
            })
            .catch(err => {
                console.warn("Service worker registration failed:", err);
            });
    });
}
