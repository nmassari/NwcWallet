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
        navigator.serviceWorker.register("/sw.js").catch(err => {
            console.warn("Service worker registration failed:", err);
        });
    });
}
