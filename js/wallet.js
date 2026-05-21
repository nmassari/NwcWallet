import "../css/ecs.css";
import { NwcKit, parseNwcUri } from "nwckit";
import { InvoiceQr } from "./invoice-qr.js";

const savedConnectionKey = "nwc_wallet_connection";

let client = null;
let connection = null;
let lastCreatedInvoice = "";
let lastSwapDepositAddress = "";
let currentView = "home";

function $(id) {
    return document.getElementById(id);
}

function text(id, value) {
    const el = $(id);
    if (el) el.textContent = value ?? "";
}

function value(id, nextValue) {
    const el = $(id);
    if (el) el.value = nextValue ?? "";
}

function status(id, message, type = "info") {
    const el = $(id);
    if (!el) return;

    el.textContent = message || "";
    el.dataset.type = type;
}

function clearStatus(id) {
    const el = $(id);
    if (!el) return;

    el.textContent = "";
    delete el.dataset.type;
}

function shorten(input, start = 10, end = 8) {
    if (!input) return "-";
    return input.length <= start + end + 3 ? input : `${input.slice(0, start)}...${input.slice(-end)}`;
}

function setView(view) {
    if (requiresConnection(view) && !client) {
        view = "nwc-string";
    }

    currentView = view;
    const activeTarget = view === "nwc-string" ? "settings" : view;

    if (view === "settings") {
        clearStatus("settingsStatus");
    }

    document.querySelectorAll(".app-view").forEach(page => {
        page.classList.toggle("active", page.dataset.view === view);
    });

    document.querySelectorAll("[data-view-target]").forEach(button => {
        button.classList.toggle("active", button.dataset.viewTarget === activeTarget);
    });
}

function requiresConnection(view) {
    return ["home", "receive", "pay", "swap"].includes(view);
}

function setConnectedUi(isConnected) {
    text("walletConnectionState", isConnected ? "Connesso" : "Non connesso");
    text("settingsConnectionState", isConnected ? "On" : "Off");
    text("settingsNwcStringState", localStorage.getItem(savedConnectionKey) ? "Impostata" : "Non impostata");

    $("disconnectButton").disabled = !isConnected;
    $("refreshBalanceButton").disabled = !isConnected;
    $("createInvoiceButton").disabled = !isConnected;
    $("payInvoiceButton").disabled = !isConnected;
    $("createForwardSwapButton").disabled = !isConnected;
    $("createReverseSwapButton").disabled = !isConnected;
    $("settingsClearConnectionButton").disabled = !localStorage.getItem(savedConnectionKey);
    $("clearConnectionButton").disabled = !localStorage.getItem(savedConnectionKey);
}

function clearWalletInfo() {
    text("walletBalance", "-");
    text("walletAlias", "NWC wallet");
    text("walletRelay", "-");
    text("walletPubkey", "-");
    text("settingsRelay", "-");
    text("settingsWalletPubkey", "-");
}

async function refreshBalance() {
    if (!client) return;

    const balance = await client.getBalance();
    text("walletBalance", `${balance.balance} sats`);
}

async function connectWallet() {
    const raw = $("nwcInput").value.trim();

    if (!raw) {
        status("nwcStringStatus", "Paste an NWC string.", "error");
        return;
    }

    await connectWithString(raw, true);
}

async function connectWithString(raw, saveConnection) {
    try {
        status("nwcStringStatus", "Connessione...");
        connection = parseNwcUri(raw);

        if (client) {
            try { await client.disconnect(); } catch {}
            client = null;
        }

        client = new NwcKit({
            connection,
            timeoutMs: 15000
        });

        await client.connect();
        const info = await client.getInfo();
        await refreshBalance();

        const relay = connection.relayUrl || "-";
        const pubkey = connection.walletPubkey || "-";

        text("walletRelay", shorten(relay, 18, 12));
        text("walletPubkey", shorten(pubkey));
        text("settingsRelay", relay);
        text("settingsWalletPubkey", shorten(pubkey, 16, 16));
        text("walletAlias", info?.alias || "NWC wallet");

        if (saveConnection) {
            localStorage.setItem(savedConnectionKey, raw);
        }

        setConnectedUi(true);
        clearStatus("settingsStatus");
        status("nwcStringStatus", "NWC string salvata.", "success");
        setView("home");
    } catch (err) {
        console.error(err);
        client = null;
        connection = null;
        clearWalletInfo();
        setConnectedUi(false);
        status("nwcStringStatus", err?.message || String(err), "error");
        setView("nwc-string");
    }
}

async function disconnectWallet() {
    try {
        if (client) await client.disconnect();
    } catch (err) {
        console.warn(err);
    }

    client = null;
    connection = null;
    clearWalletInfo();
    setConnectedUi(false);
    status("nwcStringStatus", "Disconnesso.", "info");
}

async function createInvoice() {
    if (!client) {
        status("receiveStatus", "Wallet not connected.", "error");
        setView("nwc-string");
        return;
    }

    const amount = Number($("receiveAmountInput").value);
    const memo = $("receiveMemoInput").value.trim();

    if (!Number.isFinite(amount) || amount <= 0) {
        status("receiveStatus", "Invalid amount.", "error");
        return;
    }

    try {
        status("receiveStatus", "Creating invoice...");
        const result = await client.makeInvoice({
            amount,
            description: memo || "NwcWallet invoice"
        });

        lastCreatedInvoice = result?.invoice || "";
        InvoiceQr.update("createdInvoiceQrWrap", "createdInvoiceQrImage", lastCreatedInvoice);
        $("createdInvoiceQrWrap").hidden = !lastCreatedInvoice;
        $("createdInvoiceSummary").hidden = !lastCreatedInvoice;
        text("createdInvoiceShort", shorten(lastCreatedInvoice, 12, 12));
        $("copyCreatedInvoiceButton").disabled = !lastCreatedInvoice;
        $("useCreatedInvoiceButton").disabled = !lastCreatedInvoice;
        status("receiveStatus", "Invoice ready.", "success");
    } catch (err) {
        console.error(err);
        status("receiveStatus", err?.message || String(err), "error");
    }
}

async function payInvoice() {
    if (!client) {
        status("payStatus", "Wallet not connected.", "error");
        setView("nwc-string");
        return;
    }

    const invoice = $("payInvoiceInput").value.trim();
    if (!invoice) {
        status("payStatus", "Paste an invoice.", "error");
        return;
    }

    try {
        status("payStatus", "Paying...");
        await client.payInvoice({ invoice });
        status("payStatus", "Payment sent.", "success");
        await refreshBalance();
    } catch (err) {
        console.error(err);
        status("payStatus", err?.message || String(err), "error");
    }
}

function setSwapMode(mode) {
    document.querySelectorAll("[data-swap-mode]").forEach(button => {
        button.classList.toggle("active", button.dataset.swapMode === mode);
    });

    $("forwardSwapPanel").hidden = mode !== "forward";
    $("reverseSwapPanel").hidden = mode !== "reverse";
}

async function createForwardSwap() {
    if (!client) {
        status("swapStatus", "Wallet not connected.", "error");
        setView("nwc-string");
        return;
    }

    const amount = Number($("swapAmountInput").value);
    const invoice = $("swapInvoiceInput").value.trim();

    if (!Number.isFinite(amount) || amount < 25000) {
        status("swapStatus", "Minimum 25000 sats.", "error");
        return;
    }

    if (!invoice) {
        status("swapStatus", "Invoice required.", "error");
        return;
    }

    try {
        status("swapStatus", "Creating swap...");
        const swap = await client.createOnchainToLightningSwap({
            amountSats: amount,
            invoice
        });

        lastSwapDepositAddress = swap.depositAddress || "";
        value("swapAddressOutput", lastSwapDepositAddress);
        updateSwapAddressPreview(lastSwapDepositAddress, swap.bip21 || lastSwapDepositAddress);
        status("swapStatus", "Deposit address ready.", "success");
    } catch (err) {
        console.error(err);
        status("swapStatus", err?.message || String(err), "error");
    }
}

async function createReverseSwap() {
    if (!client) {
        status("swapStatus", "Wallet not connected.", "error");
        setView("nwc-string");
        return;
    }

    const amount = Number($("reverseSwapAmountInput").value);
    const address = $("reverseSwapAddressInput").value.trim();

    if (!Number.isFinite(amount) || amount < 25000) {
        status("swapStatus", "Minimum 25000 sats.", "error");
        return;
    }

    if (!address) {
        status("swapStatus", "Bitcoin address required.", "error");
        return;
    }

    try {
        status("swapStatus", "Creating withdrawal...");
        const swap = await client.createLightningToOnchainSwap({
            amountSats: amount,
            destinationAddress: address
        });

        const invoice = swap.invoice || "";
        value("reverseSwapInvoiceOutput", invoice);
        InvoiceQr.update("reverseSwapQrWrap", "reverseSwapQrImage", invoice);
        $("reverseSwapQrWrap").hidden = !invoice;
        $("reverseSwapInvoiceSummary").hidden = !invoice;
        text("reverseSwapInvoiceShort", shorten(invoice, 12, 12));
        status("swapStatus", "Invoice ready.", "success");
    } catch (err) {
        console.error(err);
        status("swapStatus", err?.message || String(err), "error");
    }
}

async function pasteInto(id, statusId) {
    try {
        const clipboard = (await navigator.clipboard.readText()).trim();
        value(id, clipboard);
        if (id === "payInvoiceInput") {
            updatePayInvoicePreview(clipboard);
        }
        if (id === "swapInvoiceInput") {
            updateSwapInvoicePreview(clipboard);
        }
        if (id === "reverseSwapAddressInput") {
            updateReverseSwapAddressPreview(clipboard);
        }
        status(statusId, clipboard ? "Pasted." : "Clipboard empty.", clipboard ? "success" : "error");
    } catch (err) {
        console.error(err);
        status(statusId, "Clipboard unavailable.", "error");
    }
}

function updatePayInvoicePreview(invoice) {
    const hasInvoice = !!invoice;

    InvoiceQr.update("payInvoiceQrWrap", "payInvoiceQrImage", invoice);
    $("payInvoiceQrWrap").hidden = !hasInvoice;
    $("payInvoiceInput").hidden = hasInvoice;
    $("payInvoiceSummary").hidden = !hasInvoice;
    text("payInvoiceShort", shorten(invoice, 12, 12));
}

function updateSwapInvoicePreview(invoice) {
    const hasInvoice = !!invoice;

    InvoiceQr.update("swapInvoiceQrWrap", "swapInvoiceQrImage", invoice);
    $("swapInvoiceQrWrap").hidden = !hasInvoice;
    $("swapInvoiceInput").hidden = hasInvoice;
    $("swapInvoiceSummary").hidden = !hasInvoice;
    text("swapInvoiceShort", shorten(invoice, 12, 12));
}

function updateSwapAddressPreview(address, qrValue) {
    const hasAddress = !!address;

    InvoiceQr.update("swapAddressQrWrap", "swapAddressQrImage", qrValue || address);
    $("swapAddressQrWrap").hidden = !hasAddress;
    $("swapAddressSummary").hidden = !hasAddress;
    $("copySwapAddressButton").disabled = !hasAddress;
    text("swapAddressShort", shorten(address, 14, 14));
}

function updateReverseSwapAddressPreview(address) {
    const hasAddress = !!address;

    InvoiceQr.update("reverseSwapAddressQrWrap", "reverseSwapAddressQrImage", address);
    $("reverseSwapAddressQrWrap").hidden = !hasAddress;
    $("reverseSwapAddressInput").hidden = hasAddress;
    $("reverseSwapAddressSummary").hidden = !hasAddress;
    text("reverseSwapAddressShort", shorten(address, 14, 14));
}

async function copyText(textValue, statusId) {
    if (!textValue) {
        status(statusId, "Nothing to copy.", "error");
        return;
    }

    try {
        await navigator.clipboard.writeText(textValue);
        status(statusId, "Copied.", "success");
    } catch (err) {
        console.error(err);
        status(statusId, "Copy failed.", "error");
    }
}

function restoreSavedConnection() {
    const saved = localStorage.getItem(savedConnectionKey);
    if (saved) value("nwcInput", saved);
    text("settingsNwcStringState", saved ? "Impostata" : "Non impostata");
    return saved;
}

function forgetConnection() {
    localStorage.removeItem(savedConnectionKey);
    value("nwcInput", "");
    disconnectWallet();
    status("settingsStatus", "Connection forgotten.", "success");
    setView("nwc-string");
}

function wireEvents() {
    document.querySelectorAll("[data-view-target]").forEach(button => {
        button.addEventListener("click", () => setView(button.dataset.viewTarget));
    });

    document.querySelectorAll("[data-swap-mode]").forEach(button => {
        button.addEventListener("click", () => setSwapMode(button.dataset.swapMode));
    });

    $("saveNwcStringButton").addEventListener("click", connectWallet);
    $("disconnectButton").addEventListener("click", disconnectWallet);
    $("refreshBalanceButton").addEventListener("click", async () => {
        try {
            await refreshBalance();
        } catch (err) {
            console.error(err);
            status("nwcStringStatus", err?.message || String(err), "error");
        }
    });

    $("createInvoiceButton").addEventListener("click", createInvoice);
    $("payInvoiceButton").addEventListener("click", payInvoice);
    $("createForwardSwapButton").addEventListener("click", createForwardSwap);
    $("createReverseSwapButton").addEventListener("click", createReverseSwap);
    $("pastePayInvoiceButton").addEventListener("click", () => pasteInto("payInvoiceInput", "payStatus"));
    $("pasteSwapInvoiceButton").addEventListener("click", () => pasteInto("swapInvoiceInput", "swapStatus"));
    $("pasteReverseSwapAddressButton").addEventListener("click", () => pasteInto("reverseSwapAddressInput", "swapStatus"));
    $("copyCreatedInvoiceButton").addEventListener("click", () => copyText(lastCreatedInvoice, "receiveStatus"));
    $("copySwapAddressButton").addEventListener("click", () => copyText(lastSwapDepositAddress, "swapStatus"));
    $("useCreatedInvoiceButton").addEventListener("click", () => {
        value("payInvoiceInput", lastCreatedInvoice);
        updatePayInvoicePreview(lastCreatedInvoice);
        setView("pay");
    });

    $("payInvoiceInput").addEventListener("input", event => {
        const invoice = event.target.value.trim();
        updatePayInvoicePreview(invoice);
    });

    $("swapInvoiceInput").addEventListener("input", event => {
        const invoice = event.target.value.trim();
        updateSwapInvoicePreview(invoice);
    });

    $("reverseSwapAddressInput").addEventListener("input", event => {
        updateReverseSwapAddressPreview(event.target.value.trim());
    });

    $("createdInvoiceQrImage").addEventListener("click", () => copyText(lastCreatedInvoice, "receiveStatus"));
    $("reverseSwapQrImage").addEventListener("click", () => copyText($("reverseSwapInvoiceOutput").value.trim(), "swapStatus"));
    $("swapAddressQrImage").addEventListener("click", () => copyText(lastSwapDepositAddress, "swapStatus"));
    $("reverseSwapAddressQrImage").addEventListener("click", () => copyText($("reverseSwapAddressInput").value.trim(), "swapStatus"));
    $("clearConnectionButton").addEventListener("click", forgetConnection);
    $("settingsClearConnectionButton").addEventListener("click", forgetConnection);
}

document.addEventListener("DOMContentLoaded", async () => {
    const savedConnection = restoreSavedConnection();
    clearWalletInfo();
    setConnectedUi(false);
    setSwapMode("forward");
    $("copyCreatedInvoiceButton").disabled = true;
    $("useCreatedInvoiceButton").disabled = true;
    wireEvents();

    if (savedConnection) {
        await connectWithString(savedConnection, false);
    } else {
        setView("nwc-string");
    }
});
