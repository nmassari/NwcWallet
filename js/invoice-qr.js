export const InvoiceQr = {
    update(wrapId, imageId, invoice) {
        const wrap = document.getElementById(wrapId);
        const img = document.getElementById(imageId);

        if (!wrap || !img) return;

        const value = (invoice || "").trim();

        if (!value) {
            wrap.style.display = "none";
            img.removeAttribute("src");
            return;
        }

        const encoded = encodeURIComponent(value);
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encoded}`;
        wrap.style.display = "block";
    },

    clear(wrapId, imageId) {
        this.update(wrapId, imageId, "");
    }
};
