import "../css/ecs.css";
import { BrowserQRCodeReader } from "@zxing/browser";
import { NwcKit, parseNwcUri } from "nwckit";
import { InvoiceQr } from "./invoice-qr.js";

const savedConnectionKey = "nwc_wallet_connection";
const cameraPermissionPromptKey = "nwc_wallet_camera_permission_prompted_v3";
const themeKey = "nwc_wallet_theme";
const swapHistoryKey = "nwc_wallet_swap_history";
const installPromptDismissedKey = "nwc_wallet_install_prompt_dismissed";
const installPromptSnoozedUntilKey = "nwc_wallet_install_prompt_snoozed_until";
const billingApiBaseUrl = "https://ocb.easycryptosend.it/api/billing";
const appBuild = "qr-camera-v7-20260521";
const easyCryptoSendHost = "easycryptosend.it";
const bitcoinOnchainAsset = {
    asset: "BTC",
    chain: "bitcoin",
    network: "mainnet",
    rail: "onchain"
};
const bitcoinLightningAsset = {
    asset: "BTC",
    chain: "bitcoin",
    network: "mainnet",
    rail: "lightning"
};

let client = null;
let connection = null;
let lastCreatedInvoice = "";
let lastSwapDepositAddress = "";
let currentView = "home";
let qrReader = null;
let scannerControls = null;
let scannerStream = null;
let activeScanTarget = null;
let activeScanStatus = null;
let deferredInstallPrompt = null;
let swapHistory = [];

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

function scannerStatus(message, type = "info") {
    status("qrScannerStatus", `${message}\n${appBuild}`, type);
}

function getCameraErrorMessage(err) {
    const name = err?.name || "CameraError";

    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        return "Camera permission denied. Enable camera access from the address bar lock icon and try again.";
    }

    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        return "No camera found by the browser. If you are using a simulator or a desktop without a camera, use Paste.";
    }

    if (name === "NotReadableError" || name === "TrackStartError") {
        return "Camera is busy or unreadable. Close other apps using the camera and try again.";
    }

    if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
        return "Camera found, but it does not match the requested settings. Trying basic settings.";
    }

    if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
        return "Camera access requires HTTPS or localhost.";
    }

    return `Camera unavailable (${name}). Use Paste or check browser permissions.`;
}

function clearStatus(id) {
    const el = $(id);
    if (!el) return;

    el.textContent = "";
    delete el.dataset.type;
}

function getResponseData(payload) {
    if (!payload || typeof payload !== "object") return null;
    return payload.data ?? payload;
}

function getErrorMessage(payload, fallback) {
    const error = payload?.error || payload?.message || "";
    const detail = payload?.detail || "";

    if (error && detail) {
        return `${error}: ${detail}`;
    }

    return error || detail || payload?.raw || fallback;
}

async function readApiResponse(response) {
    const raw = await response.text();
    let payload = null;

    try {
        payload = raw ? JSON.parse(raw) : null;
    } catch {
        payload = { raw };
    }

    if (!response.ok) {
        throw new Error(getErrorMessage(payload, `HTTP ${response.status}`));
    }

    return getResponseData(payload);
}

function shorten(input, start = 10, end = 8) {
    if (!input) return "-";
    return input.length <= start + end + 3 ? input : `${input.slice(0, start)}...${input.slice(-end)}`;
}

function formatSats(amount) {
    const value = Number(amount || 0);
    return `${Number.isFinite(value) ? value.toLocaleString("en-US") : "0"} sats`;
}

function formatTime(unixSeconds) {
    if (!unixSeconds) return "-";
    return new Date(unixSeconds * 1000).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function createHistoryItem({ title, meta, amount, amountType, statusText }) {
    const item = document.createElement("div");
    item.className = "history-item";

    const left = document.createElement("div");
    const titleEl = document.createElement("div");
    titleEl.className = "history-title";
    titleEl.textContent = title;
    const metaEl = document.createElement("div");
    metaEl.className = "history-meta";
    metaEl.textContent = meta || "-";
    left.append(titleEl, metaEl);

    const right = document.createElement("div");
    const amountEl = document.createElement("div");
    amountEl.className = `history-amount ${amountType || ""}`.trim();
    amountEl.textContent = amount;
    const statusEl = document.createElement("div");
    statusEl.className = "history-status";
    statusEl.textContent = statusText || "";
    right.append(amountEl, statusEl);

    item.append(left, right);
    return item;
}

function setEmptyList(id, message) {
    const list = $(id);
    if (!list) return;

    list.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = message;
    list.appendChild(empty);
}

function currentNwcString() {
    return $("nwcInput")?.value?.trim() || localStorage.getItem(savedConnectionKey) || "";
}

function satsAmount(amountSats) {
    return {
        value: String(Math.round(amountSats)),
        unit: "sat"
    };
}

function hasEasyCryptoSendSwapAccess() {
    return currentNwcString().toLowerCase().includes(easyCryptoSendHost);
}

function loadSwapHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(swapHistoryKey) || "[]");
        swapHistory = Array.isArray(parsed) ? parsed : [];
    } catch {
        swapHistory = [];
    }
}

function saveSwapHistory() {
    localStorage.setItem(swapHistoryKey, JSON.stringify(swapHistory.slice(0, 20)));
}

function addSwapHistory(entry) {
    if (!entry?.swapId) return;

    swapHistory = [
        {
            ...entry,
            createdAt: entry.createdAt || Date.now()
        },
        ...swapHistory.filter(item => item.swapId !== entry.swapId)
    ].slice(0, 20);

    saveSwapHistory();
    renderSwapHistory();
}

function getInitialTheme() {
    const saved = localStorage.getItem(themeKey);
    if (saved === "light" || saved === "dark") {
        return saved;
    }

    return "dark"; // window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
}

function applyTheme(theme) {
    const nextTheme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem(themeKey, nextTheme);

    const isLight = nextTheme === "light";
    $("themeToggleButton")?.setAttribute("aria-checked", String(isLight));
    text("themeToggleLabel", isLight ? "Light" : "Dark");
}

function toggleTheme() {
    const currentTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    applyTheme(currentTheme === "light" ? "dark" : "light");
}

function isStandaloneMode() {
    return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}

function isIosDevice() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent || "");
}

function shouldShowInstallPrompt() {
    if (isStandaloneMode() || localStorage.getItem(installPromptDismissedKey)) {
        return false;
    }

    const snoozedUntil = Number(localStorage.getItem(installPromptSnoozedUntilKey) || "0");
    return !snoozedUntil || Date.now() > snoozedUntil;
}

function showInstallPrompt(mode) {
    if (!shouldShowInstallPrompt()) {
        return;
    }

    const prompt = $("installPrompt");
    const installButton = $("installAppButton");
    if (mode === "ios") {
        text("installPromptText", "Tap Share, then Add to Home Screen. No store download required.");
        installButton.hidden = true;
    } else if (deferredInstallPrompt) {
        text("installPromptText", "Use it like an app, directly from your browser. No store download required.");
        text("installAppButton", "Add to Home Screen");
        installButton.hidden = false;
    } else {
        text("installPromptText", "Open your browser menu and choose Install app or Add to Home Screen. No store download required.");
        text("installAppButton", "How to add");
        installButton.hidden = false;
    }

    prompt.hidden = false;
}

function hideInstallPrompt() {
    $("installPrompt").hidden = true;
}

async function installPwa() {
    if (!deferredInstallPrompt) {
        const message = "Open your browser menu and choose Install app or Add to Home Screen.";
        text("installPromptText", `${message} No store download required.`);
        window.alert(message);
        return;
    }

    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;

    if (choice?.outcome === "accepted") {
        localStorage.setItem(installPromptDismissedKey, "1");
        localStorage.removeItem(installPromptSnoozedUntilKey);
        hideInstallPrompt();
    }
}

function dismissInstallPrompt() {
    const oneDayMs = 24 * 60 * 60 * 1000;
    localStorage.setItem(installPromptSnoozedUntilKey, String(Date.now() + oneDayMs));
    hideInstallPrompt();
}

function updateSwapAccessGate(view = currentView) {
    const isBlocked = view === "swap" && !hasEasyCryptoSendSwapAccess();

    $("swapAccessModal").hidden = !isBlocked;
    $("createForwardSwapButton").disabled = isBlocked || !client;
    $("createReverseSwapButton").disabled = isBlocked || !client;
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

    updateSwapAccessGate(view);
}

function requiresConnection(view) {
    return ["home", "receive", "pay", "swap"].includes(view);
}

function setConnectedUi(isConnected) {
    text("walletConnectionState", isConnected ? "Connected" : "Not connected");
    text("settingsConnectionState", isConnected ? "On" : "Off");
    text("settingsNwcStringState", localStorage.getItem(savedConnectionKey) ? "Set" : "Not set");

    $("disconnectButton").disabled = !isConnected;
    $("refreshBalanceButton").disabled = !isConnected;
    $("createInvoiceButton").disabled = !isConnected;
    $("payInvoiceButton").disabled = !isConnected;
    $("createForwardSwapButton").disabled = !isConnected;
    $("createReverseSwapButton").disabled = !isConnected;
    $("settingsClearConnectionButton").disabled = !localStorage.getItem(savedConnectionKey);
    $("clearConnectionButton").disabled = !localStorage.getItem(savedConnectionKey);
    updateSwapAccessGate();
}

function clearWalletInfo() {
    text("walletBalance", "-");
    text("walletAlias", "NWC wallet");
    text("walletRelay", "-");
    text("walletPubkey", "-");
    text("settingsRelay", "-");
    text("settingsWalletPubkey", "-");
    setEmptyList("transactionList", "Connect a wallet to see Lightning activity.");
    renderSwapHistory();
}

async function refreshBalance() {
    if (!client) return;

    const balance = await client.getBalance();
    text("walletBalance", `${balance.balance} sats`);
}

async function refreshTransactions() {
    if (!client) {
        setEmptyList("transactionList", "Connect a wallet to see Lightning activity.");
        return;
    }

    try {
        const result = await client.listTransactions({ limit: 8 });
        renderTransactions(result?.transactions || []);
    } catch (err) {
        console.error(err);
        setEmptyList("transactionList", err?.message || "Transactions unavailable.");
    }
}

function renderTransactions(transactions) {
    const list = $("transactionList");
    if (!list) return;

    list.innerHTML = "";
    if (!transactions.length) {
        setEmptyList("transactionList", "No transactions yet.");
        return;
    }

    transactions.forEach(tx => {
        const type = tx.type === "outgoing" ? "outgoing" : "incoming";
        const sign = type === "outgoing" ? "-" : "+";
        list.appendChild(createHistoryItem({
            title: type === "outgoing" ? "Sent payment" : "Received payment",
            meta: `${formatTime(tx.settled_at || tx.created_at)} · ${shorten(tx.payment_hash || tx.invoice || "", 8, 8)}`,
            amount: `${sign}${formatSats(tx.amount)}`,
            amountType: type,
            statusText: tx.settled === false ? "pending" : "settled"
        }));
    });
}

function renderSwapHistory() {
    const list = $("swapHistoryList");
    if (!list) return;

    list.innerHTML = "";
    if (!swapHistory.length) {
        setEmptyList("swapHistoryList", "No swaps yet.");
        return;
    }

    swapHistory.forEach(swap => {
        list.appendChild(createHistoryItem({
            title: swap.direction === "lightning_to_onchain" ? "Lightning to BTC" : "BTC to Lightning",
            meta: `${new Date(swap.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${shorten(swap.swapId, 8, 8)}`,
            amount: formatSats(swap.amountSats),
            amountType: swap.direction === "lightning_to_onchain" ? "outgoing" : "incoming",
            statusText: swap.status || "pending"
        }));
    });
}

async function refreshSwapHistory() {
    if (!client || !swapHistory.length) {
        renderSwapHistory();
        return;
    }

    const updated = [];
    for (const swap of swapHistory) {
        try {
            const status = await client.getSwapStatus({ swapId: swap.swapId });
            updated.push({
                ...swap,
                status: status?.status || swap.status,
                updatedAt: Date.now()
            });
        } catch (err) {
            console.warn(err);
            updated.push(swap);
        }
    }

    swapHistory = updated;
    saveSwapHistory();
    renderSwapHistory();
}

async function refreshHomeData() {
    await refreshBalance();
    await refreshTransactions();
    await refreshSwapHistory();
}

async function connectWallet() {
    const raw = $("nwcInput").value.trim();

    if (!raw) {
        status("nwcStringStatus", "Paste an NWC string.", "error");
        return;
    }

    await connectWithString(raw, true);
}

async function requestHostedWallet() {
    const button = $("createWalletNwcButton");

    try {
        button.disabled = true;
        status("nwcStringStatus", "Creating wallet...");

        const createResponse = await fetch(`${billingApiBaseUrl}/orders`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                orderType: "NostrWalletConnect",
                plan: "wallet",
                label: "NwcWallet"
            })
        });

        const order = await readApiResponse(createResponse);
        const orderId = order?.orderId || order?.id;

        if (!orderId) {
            throw new Error("Wallet order was not created.");
        }

        status("nwcStringStatus", "Provisioning NWC string...");

        const statusResponse = await fetch(`${billingApiBaseUrl}/orders/${orderId}`);
        const result = await readApiResponse(statusResponse);
        const nwcString = result?.nostrWalletConnect || "";

        if (!nwcString) {
            throw new Error("NWC string was not returned by the server.");
        }

        value("nwcInput", nwcString);
        await connectWithString(nwcString, true);
    } catch (err) {
        console.error(err);
        status("nwcStringStatus", err?.message || String(err), "error");
    } finally {
        button.disabled = false;
    }
}

async function connectWithString(raw, saveConnection) {
    try {
        status("nwcStringStatus", "Connecting...");
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
        await refreshHomeData();

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
        status("nwcStringStatus", "NWC string saved.", "success");
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
    status("nwcStringStatus", "Disconnected.", "info");
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
        await refreshTransactions();
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
        await refreshHomeData();
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

    if (!hasEasyCryptoSendSwapAccess()) {
        updateSwapAccessGate("swap");
        status("swapStatus", "Swaps are available only with a Nostr key generated by easycryptosend.it.", "error");
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
        const swap = await client.createSwap({
            direction: "onchain_to_lightning",
            sendAsset: bitcoinOnchainAsset,
            receiveAsset: bitcoinLightningAsset,
            amount: satsAmount(amount),
            receiveInvoice: invoice
        });

        lastSwapDepositAddress = swap.depositAddress || "";
        addSwapHistory({
            swapId: swap.swapId,
            direction: "onchain_to_lightning",
            amountSats: amount,
            status: swap.status || "pending",
            depositAddress: lastSwapDepositAddress
        });
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

    if (!hasEasyCryptoSendSwapAccess()) {
        updateSwapAccessGate("swap");
        status("swapStatus", "Swaps are available only with a Nostr key generated by easycryptosend.it.", "error");
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
        const swap = await client.createSwap({
            direction: "lightning_to_onchain",
            sendAsset: bitcoinLightningAsset,
            receiveAsset: bitcoinOnchainAsset,
            amount: satsAmount(amount),
            receiveAddress: address
        });

        const invoice = swap.invoice || "";
        addSwapHistory({
            swapId: swap.swapId,
            direction: "lightning_to_onchain",
            amountSats: amount,
            status: swap.status || "pending",
            lockupAddress: swap.lockupAddress || "",
            invoice
        });
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

function applyScannedValue(targetId, rawValue) {
    const scannedValue = normalizeScannedValue(targetId, rawValue);
    value(targetId, scannedValue);

    if (targetId === "payInvoiceInput") {
        updatePayInvoicePreview(scannedValue);
    }

    if (targetId === "swapInvoiceInput") {
        updateSwapInvoicePreview(scannedValue);
    }

    if (targetId === "reverseSwapAddressInput") {
        updateReverseSwapAddressPreview(scannedValue);
    }
}

function normalizeScannedValue(targetId, rawValue) {
    const value = (rawValue || "").trim();

    if (targetId === "payInvoiceInput" || targetId === "swapInvoiceInput") {
        return value.toLowerCase().startsWith("lightning:")
            ? value.slice("lightning:".length)
            : value;
    }

    if (targetId === "reverseSwapAddressInput" && value.toLowerCase().startsWith("bitcoin:")) {
        return value.slice("bitcoin:".length).split("?")[0];
    }

    return value;
}

async function requestCameraPermissionOnStartup() {
    if (localStorage.getItem(cameraPermissionPromptKey)) {
        return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false
        });
        stream.getTracks().forEach(track => track.stop());
        localStorage.setItem(cameraPermissionPromptKey, "1");
    } catch (err) {
        localStorage.removeItem(cameraPermissionPromptKey);
        console.warn("Camera permission was not granted:", err);
    }
}

async function openScanner(targetId, statusId) {
    if (!navigator.mediaDevices?.getUserMedia) {
        status(statusId, "Camera is not supported by this browser.", "error");
        return;
    }

    activeScanTarget = targetId;
    activeScanStatus = statusId;
    $("qrScannerOverlay").hidden = false;
    text("qrScannerBuild", appBuild);
    scannerStatus("Allow camera access.", "info");

    try {
        closeScanner(false);
        activeScanTarget = targetId;
        activeScanStatus = statusId;
        $("qrScannerOverlay").hidden = false;
        text("qrScannerBuild", appBuild);
        scannerStatus("Starting camera...", "info");

        const video = $("qrScannerVideo");
        try {
            scannerStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: "environment" }
                },
                audio: false
            });
        } catch (err) {
            if (err?.name !== "OverconstrainedError" && err?.name !== "ConstraintNotSatisfiedError") {
                throw err;
            }

            scannerStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: false
            });
        }

        video.srcObject = scannerStream;
        video.setAttribute("playsinline", "true");
        await video.play();
        scannerStatus("Frame the QR code.", "info");

        qrReader = qrReader || new BrowserQRCodeReader();
        scannerControls = await qrReader.decodeFromVideoElement(
            video,
            (result) => {
                if (!result) return;

                const scannedText = result.getText();
                applyScannedValue(activeScanTarget, scannedText);
                status(activeScanStatus, "QR acquired.", "success");
                closeScanner();
            }
        );

        setTimeout(() => {
            if (!scannerControls || video.videoWidth > 0) return;

            scannerStatus(
                "Camera did not start. Check browser permissions or use Paste.",
                "error"
            );
        }, 2500);
    } catch (err) {
        console.error(err);
        closeScanner(false);
        $("qrScannerOverlay").hidden = false;
        text("qrScannerBuild", appBuild);

        const message = getCameraErrorMessage(err);
        scannerStatus(message, "error");
        status(statusId, message, "error");
    }
}

function closeScanner(hideOverlay = true) {
    try {
        scannerControls?.stop();
    } catch (err) {
        console.warn(err);
    }

    scannerControls = null;
    if (scannerStream) {
        scannerStream.getTracks().forEach(track => track.stop());
        scannerStream = null;
    }

    const video = $("qrScannerVideo");
    if (video) {
        video.pause();
        video.srcObject = null;
    }

    activeScanTarget = null;
    activeScanStatus = null;
    if (hideOverlay) {
        $("qrScannerOverlay").hidden = true;
    }
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
    text("settingsNwcStringState", saved ? "Set" : "Not set");
    return saved;
}

function forgetConnection() {
    const confirmed = window.confirm("Forget the saved NWC string and disconnect this wallet?");
    if (!confirmed) {
        return;
    }

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

    document.querySelectorAll("[data-scan-target]").forEach(button => {
        button.addEventListener("click", () => openScanner(button.dataset.scanTarget, button.dataset.scanStatus));
    });

    $("saveNwcStringButton").addEventListener("click", connectWallet);
    $("createWalletNwcButton").addEventListener("click", requestHostedWallet);
    $("disconnectButton").addEventListener("click", disconnectWallet);
    $("refreshBalanceButton").addEventListener("click", async () => {
        try {
            await refreshHomeData();
        } catch (err) {
            console.error(err);
            status("nwcStringStatus", err?.message || String(err), "error");
        }
    });
    $("refreshTransactionsButton").addEventListener("click", refreshTransactions);
    $("refreshSwapsButton").addEventListener("click", refreshSwapHistory);

    $("createInvoiceButton").addEventListener("click", createInvoice);
    $("payInvoiceButton").addEventListener("click", payInvoice);
    $("createForwardSwapButton").addEventListener("click", createForwardSwap);
    $("createReverseSwapButton").addEventListener("click", createReverseSwap);
    $("pasteNwcStringButton").addEventListener("click", () => pasteInto("nwcInput", "nwcStringStatus"));
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
    $("closeScannerButton").addEventListener("click", closeScanner);
    $("themeToggleButton").addEventListener("click", toggleTheme);
    $("installAppButton").addEventListener("click", installPwa);
    $("dismissInstallButton").addEventListener("click", dismissInstallPrompt);
}

window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    showInstallPrompt("browser");
});

window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    localStorage.setItem(installPromptDismissedKey, "1");
    localStorage.removeItem(installPromptSnoozedUntilKey);
    hideInstallPrompt();
});

document.addEventListener("DOMContentLoaded", async () => {
    applyTheme(getInitialTheme());
    showInstallPrompt(isIosDevice() ? "ios" : "browser");
    requestCameraPermissionOnStartup();
    loadSwapHistory();
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
