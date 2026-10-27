import "../css/ecs.css";
import { BrowserQRCodeReader } from "@zxing/browser";
import {
    buildNwcUri,
    generateNwcClientIdentity,
    loadSubscriptionOffer,
    NostrPaymentMessages,
    NwcKit,
    parseNwcUri
} from "nwckit";
import { InvoiceQr } from "./invoice-qr.js";

const savedConnectionKey = "nwc_wallet_connection";
const cameraPermissionPromptKey = "nwc_wallet_camera_permission_prompted_v3";
const themeKey = "nwc_wallet_theme";
const swapHistoryKey = "nwc_wallet_swap_history";
const contactsKey = "nwc_wallet_contacts";
const subscriptionsKey = "nwc_wallet_subscriptions";
const installPromptDismissedKey = "nwc_wallet_install_prompt_dismissed";
const installPromptSnoozedUntilKey = "nwc_wallet_install_prompt_snoozed_until";
const deviceUnlockEnabledKey = "nwc_wallet_device_unlock_enabled";
const deviceUnlockCredentialKey = "nwc_wallet_device_unlock_credential";
const deviceUnlockPromptedKey = "nwc_wallet_device_unlock_prompted";
const deviceUnlockRepairKey = "nwc_wallet_device_unlock_repair_v2";
const encryptedBackupFormat = "nwcwallet-encrypted-backup";
const encryptedBackupVersion = 1;
const backupKdfIterations = 310000;
const billingApiBaseUrl = "https://ocb.easycryptosend.it/api/billing";
const providerInfoUrl = "https://nwc.easycryptosend.it/api/nwc/provider-info";
const appBuild = "pwa-v17-20261027";
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
const usdtTaprootAsset = {
    asset: "USDT",
    chain: "bitcoin",
    network: "mainnet",
    rail: "taproot-assets"
};
const usdtLightningAsset = {
    asset: "USDT",
    chain: "bitcoin",
    network: "mainnet",
    rail: "taproot-assets-lightning"
};
const swapAssetChoices = {
    btc_onchain: {
        label: "BTC",
        name: "Bitcoin",
        icon: "₿",
        destinationLabel: "Bitcoin address",
        destinationPlaceholder: "bc1...",
        loadedLabel: "Bitcoin address loaded",
        amountUnit: "sat",
        minAmount: 25000,
        defaultAmount: "25000",
        asset: bitcoinOnchainAsset
    },
    btc_lightning: {
        label: "LNBTC",
        name: "Lightning BTC",
        icon: "⚡︎",
        destinationLabel: "Lightning invoice",
        destinationPlaceholder: "lnbc...",
        loadedLabel: "Lightning invoice loaded",
        amountUnit: "sat",
        minAmount: 25000,
        defaultAmount: "25000",
        asset: bitcoinLightningAsset
    },
    usdt_taproot: {
        label: "USDT",
        name: "Taproot Assets",
        icon: "$",
        destinationLabel: "USDT Taproot address",
        destinationPlaceholder: "taprt...",
        loadedLabel: "USDT Taproot address loaded",
        amountUnit: "usdt",
        minAmount: 0.01,
        defaultAmount: "1",
        asset: usdtTaprootAsset
    },
    usdt_lightning: {
        label: "LNUSDT",
        name: "USDT Lightning",
        icon: "₮",
        destinationLabel: "USDT Lightning invoice",
        destinationPlaceholder: "ln...",
        loadedLabel: "USDT Lightning invoice loaded",
        amountUnit: "usdt",
        minAmount: 0.01,
        defaultAmount: "1",
        asset: usdtLightningAsset
    }
};

let client = null;
let appMessages = null;
let connection = null;
let walletCapabilities = null;
let walletInfo = null;
let lastCreatedInvoice = "";
let lastSwapDepositAddress = "";
let pendingSwapAttempt = null;

function withSwapRequestId(request) {
    const fingerprint = JSON.stringify(request);
    if (!pendingSwapAttempt || pendingSwapAttempt.fingerprint !== fingerprint) {
        pendingSwapAttempt = {
            fingerprint,
            requestId: crypto.randomUUID().replaceAll("-", "")
        };
    }
    return { ...request, requestId: pendingSwapAttempt.requestId };
}
let currentView = "home";
let qrReader = null;
let scannerControls = null;
let scannerStream = null;
let activeScanTarget = null;
let activeScanStatus = null;
let deferredInstallPrompt = null;
let swapHistory = [];
let contacts = [];
let subscriptions = [];
let deviceUnlockRequestInFlight = false;
let deviceUnlockOverlayMode = "unlock";
let swapSendAssetKey = "btc_onchain";
let swapReceiveAssetKey = "btc_lightning";
let activeBalanceAsset = "LNBTC";
let walletAssetBalances = [];
let receiveAsset = "LNBTC";
let payAsset = "LNBTC";
let schedulerAsset = "LNBTC";
let selectedSubscriptionId = null;
let activeAssetPickerSide = "send";
let backupPasswordResolver = null;
let pendingBackupFile = null;

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

function isNostrPubkey(value) {
    return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isEasyCryptoSendConnection(parsedConnection) {
    try {
        return new URL(parsedConnection?.relayUrl || "").hostname.toLowerCase() === "relay.easycryptosend.it";
    } catch {
        return false;
    }
}

async function getProviderRotation(parsedConnection) {
    if (!isEasyCryptoSendConnection(parsedConnection) || !isNostrPubkey(parsedConnection?.walletPubkey)) {
        return null;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);

    try {
        const response = await fetch(providerInfoUrl, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal
        });
        const provider = await readApiResponse(response);
        const currentPubkey = String(provider?.walletServicePubkey || "").toLowerCase();
        const savedPubkey = parsedConnection.walletPubkey.toLowerCase();
        const retiredPubkeys = Array.isArray(provider?.retiredWalletServicePubkeys)
            ? provider.retiredWalletServicePubkeys.map(value => String(value).toLowerCase())
            : [];

        if (!isNostrPubkey(currentPubkey) || currentPubkey === savedPubkey || !retiredPubkeys.includes(savedPubkey)) {
            return null;
        }

        return {currentPubkey, savedPubkey};
    } catch (err) {
        console.warn("Could not verify NWC provider key rotation.", err);
        return null;
    } finally {
        window.clearTimeout(timeout);
    }
}

function shorten(input, start = 10, end = 8) {
    if (!input) return "-";
    return input.length <= start + end + 3 ? input : `${input.slice(0, start)}...${input.slice(-end)}`;
}

function extractEmail(input) {
    const match = String(input || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match?.[0] || "";
}

function formatSats(amount) {
    const value = Number(amount || 0);
    return `${Number.isFinite(value) ? value.toLocaleString("en-US") : "0"} sats`;
}

function amountToApi(amount) {
    return schedulerAsset === "LNBTC"
        ? String(Math.round(Number(amount)))
        : String(Number(amount));
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

function todayIsoDate() {
    return toIsoDate(new Date());
}

function toIsoDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
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

function loadSchedulerState() {
    contacts = readJsonArray(contactsKey);
    subscriptions = readJsonArray(subscriptionsKey);
}

function readJsonArray(key) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveContacts() {
    localStorage.setItem(contactsKey, JSON.stringify(contacts.slice(0, 100)));
}

function saveSubscriptions() {
    localStorage.setItem(subscriptionsKey, JSON.stringify(subscriptions.slice(0, 100)));
}

function upsertContact(contact) {
    if (!contact?.pubkey) return;

    contacts = [
        {
            ...contact,
            updatedAt: Date.now()
        },
        ...contacts.filter(item => item.pubkey !== contact.pubkey)
    ].slice(0, 100);

    saveContacts();
}

function upsertSubscription(subscription) {
    if (!subscription?.subscriptionId) return;

    subscriptions = [
        {
            ...subscription,
            updatedAt: Date.now()
        },
        ...subscriptions.filter(item => item.subscriptionId !== subscription.subscriptionId)
    ].slice(0, 100);

    saveSubscriptions();
    renderScheduler();
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

function bytesToBase64Url(bytes) {
    const binary = Array.from(new Uint8Array(bytes), byte => String.fromCharCode(byte)).join("");
    return btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
}

function base64UrlToBytes(value) {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function randomBytes(length = 32) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
}

async function deriveBackupKey(password, salt, usages) {
    const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            hash: "SHA-256",
            salt,
            iterations: backupKdfIterations
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        usages
    );
}

async function encryptConnectionBackup(nwcString, password) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveBackupKey(password, salt, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(nwcString)
    );

    return {
        format: encryptedBackupFormat,
        version: encryptedBackupVersion,
        createdAt: new Date().toISOString(),
        kdf: {
            name: "PBKDF2",
            hash: "SHA-256",
            iterations: backupKdfIterations,
            salt: bytesToBase64Url(salt)
        },
        cipher: {
            name: "AES-GCM",
            iv: bytesToBase64Url(iv),
            data: bytesToBase64Url(encrypted)
        }
    };
}

async function decryptConnectionBackup(backup, password) {
    if (backup?.format !== encryptedBackupFormat || backup?.version !== encryptedBackupVersion) {
        throw new Error("This is not a supported NwcWallet backup.");
    }

    if (backup?.kdf?.name !== "PBKDF2" || backup?.kdf?.hash !== "SHA-256" ||
        backup?.kdf?.iterations !== backupKdfIterations || backup?.cipher?.name !== "AES-GCM") {
        throw new Error("The backup uses unsupported encryption settings.");
    }

    const salt = base64UrlToBytes(backup.kdf.salt || "");
    const iv = base64UrlToBytes(backup.cipher.iv || "");
    const encrypted = base64UrlToBytes(backup.cipher.data || "");
    const key = await deriveBackupKey(password, salt, ["decrypt"]);

    try {
        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
        const nwcString = new TextDecoder().decode(decrypted);
        parseNwcUri(nwcString);
        return nwcString;
    } catch {
        throw new Error("Wrong password or damaged backup.");
    }
}

function requestBackupPassword(mode) {
    if (backupPasswordResolver) {
        return Promise.reject(new Error("A backup prompt is already open."));
    }

    const isExport = mode === "export";
    text("backupPasswordTitle", isExport ? "Encrypt backup" : "Unlock backup");
    text(
        "backupPasswordText",
        isExport
            ? "Choose a password for this backup file. It cannot be recovered if you forget it."
            : "Enter the password used when this backup was created."
    );
    value("backupPasswordInput", "");
    value("backupPasswordConfirmInput", "");
    $("backupPasswordConfirmWrap").hidden = !isExport;
    clearStatus("backupPasswordStatus");
    $("backupPasswordOverlay").hidden = false;

    setTimeout(() => $("backupPasswordInput")?.focus(), 0);

    return new Promise(resolve => {
        backupPasswordResolver = { resolve, mode };
    });
}

function closeBackupPassword(password = null) {
    const pending = backupPasswordResolver;
    backupPasswordResolver = null;
    $("backupPasswordOverlay").hidden = true;
    value("backupPasswordInput", "");
    value("backupPasswordConfirmInput", "");
    pending?.resolve(password);
}

function submitBackupPassword() {
    if (!backupPasswordResolver) return;

    const password = $("backupPasswordInput").value;
    if (password.length < 10) {
        status("backupPasswordStatus", "Use at least 10 characters.", "error");
        return;
    }

    if (backupPasswordResolver.mode === "export" && password !== $("backupPasswordConfirmInput").value) {
        status("backupPasswordStatus", "Passwords do not match.", "error");
        return;
    }

    closeBackupPassword(password);
}

async function exportEncryptedBackup() {
    const nwcString = localStorage.getItem(savedConnectionKey) || "";
    if (!nwcString) {
        status("settingsStatus", "Connect a wallet before creating a backup.", "error");
        return;
    }

    try {
        const password = await requestBackupPassword("export");
        if (!password) return;

        const backup = await encryptConnectionBackup(nwcString, password);
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `nwcwallet-backup-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        status("settingsStatus", "Encrypted backup created. Keep the file and password separate.", "success");
    } catch (err) {
        console.error(err);
        status("settingsStatus", err?.message || String(err), "error");
    }
}

async function importEncryptedBackup(file) {
    if (!file) return;

    try {
        const password = await requestBackupPassword("import");
        if (!password) return;

        const backup = JSON.parse(await file.text());
        const nwcString = await decryptConnectionBackup(backup, password);
        value("nwcInput", nwcString);
        const connected = await connectWithString(nwcString, true);
        if (!connected) {
            throw new Error("Backup decrypted, but the wallet connection failed.");
        }
        status("settingsStatus", "Encrypted backup restored.", "success");
    } catch (err) {
        console.error(err);
        status("settingsStatus", err?.message || String(err), "error");
    } finally {
        $("backupFileInput").value = "";
        pendingBackupFile = null;
    }
}

function isDeviceUnlockAvailable() {
    return window.isSecureContext && !!navigator.credentials && !!window.PublicKeyCredential;
}

function isDeviceUnlockEnabled() {
    return localStorage.getItem(deviceUnlockEnabledKey) === "1" && !!localStorage.getItem(deviceUnlockCredentialKey);
}

function repairDeviceUnlockPromptState() {
    const wasPrompted = localStorage.getItem(deviceUnlockPromptedKey) === "1";
    const hasCredential = !!localStorage.getItem(deviceUnlockCredentialKey);
    const alreadyRepaired = localStorage.getItem(deviceUnlockRepairKey) === "1";

    if (wasPrompted && !hasCredential && !alreadyRepaired) {
        localStorage.removeItem(deviceUnlockPromptedKey);
        localStorage.setItem(deviceUnlockRepairKey, "1");
    }
}

function getDeviceUnlockErrorMessage(err) {
    const message = err?.message || "";

    if (/pending/i.test(message)) {
        return "Secure unlock is already open. Complete or cancel the system prompt and try again.";
    }

    if (err?.name === "NotAllowedError") {
        return "Secure unlock was cancelled or timed out.";
    }

    if (err?.name === "NotSupportedError") {
        return "This browser does not support secure unlock on this device.";
    }

    if (err?.name === "SecurityError") {
        return "Secure unlock requires HTTPS or localhost.";
    }

    return message || "Secure unlock failed.";
}

function getDeviceUnlockCredentialId() {
    return localStorage.getItem(deviceUnlockCredentialKey) || "";
}

function getDeviceUnlockLabel() {
    const ua = window.navigator.userAgent || "";
    if (/iphone|ipad|ipod|android/i.test(ua)) return "Face ID, fingerprint or passkey";
    if (/macintosh|mac os x/i.test(ua)) return "Touch ID or passkey";
    if (/windows/i.test(ua)) return "Windows Hello or passkey";
    return "Passkey";
}

function updateDeviceUnlockUi() {
    const available = isDeviceUnlockAvailable();
    const enabled = isDeviceUnlockEnabled();
    const button = $("deviceUnlockToggleButton");

    if (!button) return;

    button.disabled = !available || deviceUnlockRequestInFlight;
    button.setAttribute("aria-checked", String(enabled));
    text("deviceUnlockToggleLabel", deviceUnlockRequestInFlight ? "..." : enabled ? "On" : available ? "Off" : "No");
}

async function createDeviceUnlockCredential() {
    const userId = randomBytes(32);
    const credential = await navigator.credentials.create({
        publicKey: {
            challenge: randomBytes(32),
            rp: {
                name: "NwcWallet"
            },
            user: {
                id: userId,
                name: "nwcwallet-local-user",
                displayName: "NwcWallet"
            },
            pubKeyCredParams: [
                { type: "public-key", alg: -7 },
                { type: "public-key", alg: -257 }
            ],
            authenticatorSelection: {
                residentKey: "preferred",
                userVerification: "required"
            },
            attestation: "none",
            timeout: 60000
        }
    });

    if (!credential?.rawId) {
        throw new Error("Secure unlock was not created.");
    }

    localStorage.setItem(deviceUnlockCredentialKey, bytesToBase64Url(credential.rawId));
    localStorage.setItem(`${deviceUnlockCredentialKey}_user`, bytesToBase64Url(userId));
    localStorage.setItem(deviceUnlockEnabledKey, "1");
    localStorage.setItem(deviceUnlockPromptedKey, "1");
}

async function requestDeviceUnlock(statusId = "settingsStatus") {
    if (deviceUnlockRequestInFlight) {
        throw new Error("Secure unlock is already open. Complete or cancel the system prompt and try again.");
    }

    const credentialId = getDeviceUnlockCredentialId();
    if (!credentialId) {
        throw new Error("Secure unlock is not configured.");
    }

    deviceUnlockRequestInFlight = true;
    updateDeviceUnlockUi();

    try {
        const credential = await navigator.credentials.get({
            publicKey: {
                challenge: randomBytes(32),
                allowCredentials: [{
                    type: "public-key",
                    id: base64UrlToBytes(credentialId)
                }],
                userVerification: "required",
                timeout: 60000
            }
        });

        if (!credential) {
            throw new Error("Secure unlock was cancelled.");
        }

        status(statusId, "Unlocked.", "success");
    } finally {
        deviceUnlockRequestInFlight = false;
        updateDeviceUnlockUi();
    }
}

async function enableDeviceUnlock(statusId = "settingsStatus") {
    if (deviceUnlockRequestInFlight) {
        status(statusId, "Secure unlock is already open. Complete or cancel the system prompt and try again.", "error");
        return false;
    }

    if (!isDeviceUnlockAvailable()) {
        status(statusId, "Secure unlock requires HTTPS, localhost and a browser with passkey support.", "error");
        updateDeviceUnlockUi();
        return false;
    }

    try {
        deviceUnlockRequestInFlight = true;
        updateDeviceUnlockUi();
        status(statusId, `Creating secure unlock with ${getDeviceUnlockLabel()}...`);
        await createDeviceUnlockCredential();
        status(statusId, "Secure unlock enabled.", "success");
        return true;
    } catch (err) {
        console.error(err);
        status(statusId, getDeviceUnlockErrorMessage(err), "error");
        return false;
    } finally {
        deviceUnlockRequestInFlight = false;
        updateDeviceUnlockUi();
    }
}

async function disableDeviceUnlock(statusId = "settingsStatus") {
    const confirmed = window.confirm("Disable secure unlock for this device?");
    if (!confirmed) {
        return false;
    }

    localStorage.removeItem(deviceUnlockEnabledKey);
    localStorage.removeItem(deviceUnlockCredentialKey);
    localStorage.removeItem(`${deviceUnlockCredentialKey}_user`);
    localStorage.setItem(deviceUnlockPromptedKey, "1");
    updateDeviceUnlockUi();
    status(statusId, "Secure unlock disabled.", "success");
    return true;
}

async function toggleDeviceUnlock() {
    if (isDeviceUnlockEnabled()) {
        await disableDeviceUnlock("settingsStatus");
    } else {
        await enableDeviceUnlock("settingsStatus");
    }
}

async function maybeOfferDeviceUnlock() {
    if (!client || isDeviceUnlockEnabled() || localStorage.getItem(deviceUnlockPromptedKey) || !isDeviceUnlockAvailable()) {
        return;
    }

    localStorage.setItem(deviceUnlockPromptedKey, "1");
    showDeviceUnlockSetupOverlay();
}

function showDeviceUnlockOverlay(message = "") {
    const overlay = $("deviceUnlockOverlay");
    if (!overlay) return;

    deviceUnlockOverlayMode = "unlock";
    text("deviceUnlockTitle", "Unlock NwcWallet");
    text("deviceUnlockText", `Use ${getDeviceUnlockLabel()} to open the wallet.`);
    text("deviceUnlockRetryButton", "Unlock");
    text("deviceUnlockForgetButton", "Forget saved connection");
    status("deviceUnlockStatus", message, message ? "error" : "info");
    overlay.hidden = false;
}

function showDeviceUnlockSetupOverlay() {
    const overlay = $("deviceUnlockOverlay");
    if (!overlay) return;

    deviceUnlockOverlayMode = "setup";
    text("deviceUnlockTitle", "Protect NwcWallet");
    text("deviceUnlockText", `Enable ${getDeviceUnlockLabel()} whenever you open this saved wallet.`);
    text("deviceUnlockRetryButton", "Enable secure unlock");
    text("deviceUnlockForgetButton", "Not now");
    clearStatus("deviceUnlockStatus");
    overlay.hidden = false;
}

function hideDeviceUnlockOverlay() {
    const overlay = $("deviceUnlockOverlay");
    if (overlay) overlay.hidden = true;
    clearStatus("deviceUnlockStatus");
}

async function unlockSavedConnectionBeforeConnect() {
    if (!isDeviceUnlockEnabled()) {
        return true;
    }

    if (!isDeviceUnlockAvailable()) {
        showDeviceUnlockOverlay("Secure unlock is not available in this browser. Use Settings after reconnecting to disable it.");
        return false;
    }

    showDeviceUnlockOverlay();

    try {
        status("deviceUnlockStatus", "Waiting for secure unlock...");
        await requestDeviceUnlock("deviceUnlockStatus");
        hideDeviceUnlockOverlay();
        return true;
    } catch (err) {
        console.error(err);
        showDeviceUnlockOverlay(getDeviceUnlockErrorMessage(err));
        return false;
    }
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
    return ["home", "receive", "pay", "swap", "scheduler"].includes(view);
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

function setConnectionHealth(state, detail) {
    if (state === "connected") {
        text("walletConnectionState", "Connected");
        text("settingsConnectionState", "On");
        return;
    }
    if (state === "connecting") {
        text("walletConnectionState", "Connecting...");
        text("settingsConnectionState", "Connecting");
        return;
    }
    if (state === "degraded") {
        text("walletConnectionState", "Connection degraded");
        text("settingsConnectionState", detail ? `Degraded: ${detail}` : "Degraded");
        return;
    }
    text("walletConnectionState", "Not connected");
    text("settingsConnectionState", "Off");
}

function clearWalletInfo() {
    text("walletBalance", "-");
    text("walletAlias", "");
    walletAssetBalances = [];
    renderSelectedBalance();
    text("walletRelay", "-");
    text("walletPubkey", "-");
    text("settingsRelay", "-");
    text("settingsWalletPubkey", "-");
    walletCapabilities = null;
    walletInfo = null;
    updateSchedulerAuthorizationUi();
    setEmptyList("transactionList", "Connect a wallet to see Lightning activity.");
    renderSwapHistory();
    renderScheduler();
}

function updateSchedulerAuthorizationUi() {
    const isDedicated = walletCapabilities?.canPaySubscriptionInvoice === true;
    const canCreate = walletCapabilities?.canCreateSubscriptionAuthorization === true;
    const canRevokeParent = walletCapabilities?.canRevokeSubscriptionAuthorization === true;
    const schedulerPubkey = walletInfo?.subscription_scheduler_pubkey;
    const selected = subscriptions.find(item => item.subscriptionId === selectedSubscriptionId);
    text(
        "schedulerAuthorizationMode",
        !client
            ? "Not connected"
            : isDedicated
                ? "Dedicated recurring NWC"
                : canCreate && schedulerPubkey
                    ? "Ready"
                    : "Provider update required"
    );

    const createButton = $("createSubscriptionAuthorizationButton");
    if (createButton) {
        createButton.disabled = !client || isDedicated || !canCreate || !schedulerPubkey || schedulerAsset !== "LNBTC";
    }

    const revokeButton = $("revokeSubscriptionAuthorizationButton");
    if (revokeButton) {
        const canRevokeSelected = Boolean(selected && selected.status !== "revoked" && canRevokeParent);
        const canRevokeDedicated = isDedicated && walletCapabilities?.canRevokeSubscription === true;
        revokeButton.hidden = !canRevokeSelected && !canRevokeDedicated;
        revokeButton.disabled = !canRevokeSelected && !canRevokeDedicated;
    }
}

function startAppMessages() {
    stopAppMessages();

    if (!connection?.secret || !connection?.relayUrl) {
        return;
    }

    appMessages = new NostrPaymentMessages({
        privateKey: connection.secret,
        relays: [connection.relayUrl],
        timeoutMs: 15000
    });

    appMessages.onError(error => {
        console.warn("Scheduler message error:", error);
        if (currentView === "scheduler") {
            status("schedulerStatus", error?.message || String(error), "error");
        }
    });
    appMessages.subscribe();
    text("schedulerCustomerPubkey", shorten(appMessages.pubkey, 16, 16));
}

function stopAppMessages() {
    try {
        appMessages?.close();
    } catch (err) {
        console.warn(err);
    }

    appMessages = null;
    text("schedulerCustomerPubkey", "-");
}

async function refreshBalance() {
    if (!client) return;

    walletAssetBalances = await loadAssetBalances();
    renderSelectedBalance();
}

async function loadAssetBalances() {
    try {
        const result = await client.request("get_taproot_asset_balances", {});
        if (Array.isArray(result?.balances)) {
            return result.balances;
        }
    } catch (err) {
        console.warn("Asset balances unavailable, falling back to get_balance.", err);
    }

    const balance = await client.getBalance();
    return [
        {
            asset: "LNBTC",
            unit: "sat",
            balance: String(balance.balance),
            available: String(balance.balance),
            status: "active"
        },
        {
            asset: "LNUSDT",
            unit: "USDT",
            balance: "0",
            available: "0",
            status: "unavailable"
        }
    ];
}

function renderSelectedBalance() {
    document.querySelectorAll("[data-balance-asset]").forEach(button => {
        const active = button.dataset.balanceAsset === activeBalanceAsset;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });

    const selected = walletAssetBalances.find(item => item.asset === activeBalanceAsset);
    if (!selected) {
        text("walletBalance", "-");
        text("walletAlias", "");
        return;
    }

    if (selected.status && selected.status !== "active") {
        text("walletBalance", "Not active");
        text("walletAlias", activeBalanceAsset === "LNUSDT" ? "USDT Lightning is not enabled yet" : selected.status);
        return;
    }

    const unit = selected.unit || (selected.asset === "LNBTC" ? "sat" : "USDT");
    const amount = selected.balance ?? selected.available ?? "0";
    text("walletBalance", `${formatBalanceAmount(amount, unit)} ${unit}`);
    text("walletAlias", "");
}

function formatBalanceAmount(amount, unit) {
    const raw = String(amount ?? "0");
    if (unit === "sat") {
        const value = Number(raw);
        return Number.isFinite(value) ? Math.trunc(value).toLocaleString("en-US") : raw;
    }

    const value = Number(raw);
    return Number.isFinite(value)
        ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })
        : raw;
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
            meta: `${formatTime(tx.settled_at || tx.created_at)} - ${shorten(tx.payment_hash || tx.invoice || "", 8, 8)}`,
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
        const title = swap.sendAsset && swap.receiveAsset
            ? `${swap.sendAsset} to ${swap.receiveAsset}`
            : swap.direction === "lightning_to_onchain" ? "Lightning to BTC" : "BTC to Lightning";
        const amount = swap.amountUnit === "usdt"
            ? `${swap.amountSats} USDT`
            : formatSats(swap.amountSats);
        list.appendChild(createHistoryItem({
            title,
            meta: `${new Date(swap.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} - ${shorten(swap.swapId, 8, 8)}`,
            amount,
            amountType: swap.direction === "lightning_to_onchain" ? "outgoing" : "incoming",
            statusText: swap.status || "pending"
        }));
    });
}

function renderScheduler() {
    renderContactList();
    renderSubscriptionList();
}

function renderContactList() {
    const list = $("contactList");
    if (!list) return;

    list.innerHTML = "";
    if (!contacts.length) {
        setEmptyList("contactList", "No contacts yet.");
        return;
    }

    contacts.slice(0, 6).forEach(contact => {
        list.appendChild(createHistoryItem({
            title: contact.displayName || "Merchant",
            meta: `${contact.role || "merchant"} - ${shorten(contact.pubkey, 10, 10)}`,
            amount: contact.verified ? "verified" : "saved",
            amountType: contact.verified ? "incoming" : "",
            statusText: contact.source || "contact"
        }));
    });
}

function renderSubscriptionList() {
    const list = $("subscriptionList");
    if (!list) return;

    list.innerHTML = "";
    if (!subscriptions.length) {
        setEmptyList("subscriptionList", "No subscriptions yet.");
        return;
    }

    subscriptions.forEach(subscription => {
        const merchant = contacts.find(item => item.pubkey === subscription.merchantPubkey);
        const billingModel = subscription.billingModel || "recurring_fixed";
        const modelLabel = billingModel === "fixed_installments"
            ? `${subscription.installmentCount || "?"} installments`
            : billingModel === "recurring_variable"
                ? "variable"
                : "fixed";
        const totalLabel = billingModel === "fixed_installments" && subscription.totalAmount
            ? ` · total ${subscription.totalAmount} ${subscription.asset === "LNUSDT" ? "USDT" : "sat"}`
            : "";
        const item = createHistoryItem({
            title: merchant?.displayName || subscription.description || "Subscription",
            meta: `${modelLabel} · ${subscription.interval || "-"}${totalLabel} · ${shorten(subscription.subscriptionId, 8, 8)}`,
            amount: subscription.asset === "LNUSDT"
                ? `${Number(subscription.amount || 0).toLocaleString("en-US")} USDT`
                : formatSats(subscription.amount),
            amountType: "outgoing",
            statusText: subscription.status || "active"
        });

        item.addEventListener("click", () => selectSubscription(subscription.subscriptionId));
        list.appendChild(item);
    });
}

function selectSubscription(subscriptionId) {
    const subscription = subscriptions.find(item => item.subscriptionId === subscriptionId);
    if (!subscription) return;

    value("schedulerMerchantPubkeyInput", subscription.merchantPubkey || "");
    value("schedulerMerchantNameInput", getContactName(subscription.merchantPubkey));
    value("schedulerSubscriptionIdInput", subscription.subscriptionId || "");
    selectedSubscriptionId = subscriptionId;
    value("schedulerBillingModelInput", subscription.billingModel || "recurring_fixed");
    updateSchedulerBillingModelUi();
    setSchedulerAsset(subscription.asset || "LNBTC");
    value("schedulerAmountInput", subscription.amount || "");
    value("schedulerMaxSingleInput", subscription.maxSinglePayment || subscription.amount || "");
    value("schedulerMaxPeriodInput", subscription.maxPeriodSpend || subscription.amount || "");
    value("schedulerTotalAmountInput", subscription.totalAmount || "");
    value("schedulerInstallmentCountInput", subscription.installmentCount || "");
    value("schedulerIntervalInput", subscription.interval || "monthly");
    value("schedulerNextDueInput", subscription.nextDueDate || todayIsoDate());
    value("schedulerExpiresInput", subscription.expiresDate || "");
    value("schedulerDescriptionInput", subscription.description || "");
    updateSchedulerAuthorizationUi();
    status("schedulerStatus", "Authorization selected.", "success");
}

function getContactName(pubkey) {
    return contacts.find(item => item.pubkey === pubkey)?.displayName || "";
}

function getCustomerPubkey() {
    return appMessages?.pubkey || "";
}

function setDefaultSchedulerDates() {
    if (!$("schedulerNextDueInput")?.value) {
        value("schedulerNextDueInput", todayIsoDate());
    }
    if (!$("schedulerExpiresInput")?.value) {
        const expiry = new Date();
        expiry.setFullYear(expiry.getFullYear() + 1);
        value("schedulerExpiresInput", toIsoDate(expiry));
    }
}

async function loadScannedSubscriptionOffer(referenceValue) {
    const reference = (referenceValue || $("schedulerOfferReferenceInput").value).trim();
    if (!reference) {
        status("schedulerStatus", "Scan or paste a subscription offer first.", "error");
        return;
    }

    try {
        status("schedulerStatus", "Loading and verifying the signed Nostr offer…", "info");
        const fallbackRelays = connection?.relayUrl ? [connection.relayUrl] : [];
        const verified = await loadSubscriptionOffer(reference, fallbackRelays);
        const offer = verified.offer;
        if (offer.validUntil && new Date(offer.validUntil).getTime() <= Date.now()) {
            throw new Error("This merchant subscription offer has expired.");
        }

        value("schedulerOfferReferenceInput", reference);
        $("schedulerOfferReferenceInput").dataset.offerId = offer.offerId;
        value("schedulerMerchantNameInput", offer.merchantName);
        value("schedulerMerchantPubkeyInput", verified.merchantPubkey);
        value(
            "schedulerSubscriptionIdInput",
            `${offer.offerId.slice(0, 80)}.${crypto.randomUUID()}`
        );
        value("schedulerBillingModelInput", offer.billingModel || "recurring_fixed");
        updateSchedulerBillingModelUi();
        setSchedulerAsset(offer.asset);
        value("schedulerAmountInput", offer.amount);
        value("schedulerMaxSingleInput", offer.suggestedMaxSinglePayment ?? offer.amount);
        value("schedulerMaxPeriodInput", offer.suggestedMaxPeriodSpend ?? offer.amount);
        value("schedulerIntervalInput", offer.interval);
        if (offer.totalAmount !== undefined) value("schedulerTotalAmountInput", offer.totalAmount);
        if (offer.installmentCount !== undefined) value("schedulerInstallmentCountInput", offer.installmentCount);
        if (offer.firstDueAt) value("schedulerNextDueInput", offer.firstDueAt.slice(0, 10));
        value("schedulerDescriptionInput", offer.description);
        if (offer.authorizationExpiresAt) {
            value("schedulerExpiresInput", offer.authorizationExpiresAt.slice(0, 10));
        }

        text("verifiedOfferTitle", offer.merchantName);
        text(
            "verifiedOfferDetails",
            `${offer.description} · ${offer.billingModel || "recurring_fixed"} · ${offer.amount} ${offer.unit} · ${offer.interval} · ${shorten(verified.merchantPubkey, 10, 10)}`
        );
        $("verifiedSubscriptionOffer").hidden = false;
        status("schedulerStatus", "Merchant signature verified. Review the limits before authorizing.", "success");
    } catch (err) {
        console.error(err);
        $("verifiedSubscriptionOffer").hidden = true;
        status("schedulerStatus", err?.message || String(err), "error");
    }
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
        status("nwcStringStatus", "Paste a wallet connection string.", "error");
        return;
    }

    await connectWithString(raw, true);
}

async function requestHostedWallet() {
    const button = $("createWalletNwcButton");

    try {
        button.disabled = true;
        status("nwcStringStatus", "Creating wallet...");

        const identity = generateNwcClientIdentity();
        const createResponse = await fetch(`${billingApiBaseUrl}/orders`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                orderType: "NostrWalletConnect",
                plan: "wallet",
                label: "NwcWallet",
                clientPubkey: identity.publicKey
            })
        });

        const order = await readApiResponse(createResponse);
        const orderId = order?.orderId || order?.id;

        if (!orderId) {
            throw new Error("Wallet order was not created.");
        }

        status("nwcStringStatus", "Provisioning wallet connection...");

        const statusResponse = await fetch(`${billingApiBaseUrl}/orders/${orderId}`);
        const result = await readApiResponse(statusResponse);
        const descriptor = result?.nwcConnection;

        if (!descriptor?.walletPubkey || !descriptor?.relayUrl ||
            descriptor?.clientPubkey?.toLowerCase() !== identity.publicKey.toLowerCase()) {
            throw new Error("The server returned an invalid wallet connection descriptor.");
        }

        const nwcString = buildNwcUri({
            walletPubkey: descriptor.walletPubkey,
            relayUrl: descriptor.relayUrl,
            secret: identity.secret
        });

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
        const parsedConnection = parseNwcUri(raw);
        const rotation = await getProviderRotation(parsedConnection);

        if (rotation) {
            clearWalletInfo();
            setConnectedUi(false);
            status("nwcStringStatus", "This EasyCryptoSend connection was retired after a provider security-key rotation.", "error");

            const replaceConnection = window.confirm(
                "EasyCryptoSend rotated its NWC provider security key. This saved connection is officially retired. Forget it and generate a new wallet connection now?"
            );

            if (replaceConnection) {
                clearSavedConnectionData();
                value("nwcInput", "");
                if (client) {
                    try { await client.disconnect(); } catch {}
                }
                stopAppMessages();
                client = null;
                connection = null;
                await requestHostedWallet();
            } else {
                setView("nwc-string");
            }

            return false;
        }

        connection = parsedConnection;

        if (client) {
            try { await client.disconnect(); } catch {}
            client = null;
        }

        client = new NwcKit({
            connection,
            timeoutMs: 15000,
            onConnectionStateChange: setConnectionHealth
        });

        await client.connect();
        startAppMessages();
        const info = await client.getInfo();
        walletInfo = info;
        walletCapabilities = await client.getCapabilities(info);
        updateSchedulerAuthorizationUi();
        await refreshHomeData();

        const relay = connection.relayUrl || "-";
        const pubkey = connection.walletPubkey || "-";

        text("walletRelay", shorten(relay, 18, 12));
        text("walletPubkey", shorten(pubkey));
        text("settingsRelay", relay);
        text("settingsWalletPubkey", shorten(pubkey, 16, 16));
        text("walletAlias", extractEmail(info?.alias));

        if (saveConnection) {
            localStorage.setItem(savedConnectionKey, raw);
        }

        setConnectedUi(true);
        clearStatus("settingsStatus");
        status("nwcStringStatus", "Wallet connection saved.", "success");
        setView("home");

        if (saveConnection) {
            await maybeOfferDeviceUnlock();
        }

        return true;
    } catch (err) {
        console.error(err);
        client = null;
        connection = null;
        clearWalletInfo();
        setConnectedUi(false);
        status("nwcStringStatus", err?.message || String(err), "error");
        setView("nwc-string");
        return false;
    }
}

async function disconnectWallet() {
    try {
        if (client) await client.disconnect();
    } catch (err) {
        console.warn(err);
    }

    stopAppMessages();
    client = null;
    connection = null;
    walletCapabilities = null;
    clearWalletInfo();
    setConnectedUi(false);
    status("nwcStringStatus", "Disconnected.", "info");
}

async function createSubscriptionAuthorization() {
    if (!client || !appMessages) {
        status("schedulerStatus", "Connect your main wallet first.", "error");
        return;
    }
    if (walletCapabilities?.canCreateSubscriptionAuthorization !== true) {
        status("schedulerStatus", "The connected provider does not support dedicated recurring authorizations yet.", "error");
        return;
    }
    const schedulerPubkey = walletInfo?.subscription_scheduler_pubkey;
    if (!isNostrPubkey(schedulerPubkey)) {
        status("schedulerStatus", "The provider has not published a trusted scheduler identity.", "error");
        return;
    }
    if (schedulerAsset !== "LNBTC") {
        status("schedulerStatus", "LNUSDT recurring execution is gated until the Taproot Assets rail is active.", "error");
        return;
    }

    const merchantPubkey = $("schedulerMerchantPubkeyInput").value.trim().toLowerCase();
    const merchantName = $("schedulerMerchantNameInput").value.trim();
    const subscriptionId = $("schedulerSubscriptionIdInput").value.trim() || `sub_${crypto.randomUUID()}`;
    const amount = Number($("schedulerAmountInput").value);
    const billingModel = $("schedulerBillingModelInput").value || "recurring_fixed";
    const totalAmount = billingModel === "fixed_installments"
        ? Number($("schedulerTotalAmountInput").value)
        : null;
    const installmentCount = billingModel === "fixed_installments"
        ? Number($("schedulerInstallmentCountInput").value)
        : null;
    const maxSinglePayment = Number($("schedulerMaxSingleInput").value);
    const maxPeriodSpend = Number($("schedulerMaxPeriodInput").value);
    const interval = $("schedulerIntervalInput").value || "monthly";
    const nextDueDateValue = $("schedulerNextDueInput").value;
    const expiresDateValue = $("schedulerExpiresInput").value;
    const description = $("schedulerDescriptionInput").value.trim() || "Recurring payment";

    if (!isNostrPubkey(merchantPubkey)) {
        status("schedulerStatus", "Merchant pubkey must be a 64-character Nostr public key.", "error");
        return;
    }
    if (![amount, maxSinglePayment, maxPeriodSpend].every(Number.isFinite) ||
        amount <= 0 || amount > maxSinglePayment || maxSinglePayment > maxPeriodSpend) {
        status("schedulerStatus", "Use positive limits with amount ≤ maximum payment ≤ maximum period.", "error");
        return;
    }
    if (billingModel === "fixed_installments" &&
        (!Number.isFinite(totalAmount) || totalAmount <= 0 ||
         !Number.isInteger(installmentCount) || installmentCount <= 0 || installmentCount > 10000 ||
         totalAmount > amount * installmentCount || totalAmount <= amount * (installmentCount - 1))) {
        status("schedulerStatus", "Total, installment amount and number of installments are inconsistent.", "error");
        return;
    }
    if (!nextDueDateValue || !expiresDateValue || nextDueDateValue > expiresDateValue) {
        status("schedulerStatus", "Choose valid first-payment and expiry dates.", "error");
        return;
    }

    const dedicatedIdentity = generateNwcClientIdentity();
    const nextDueAt = new Date(`${nextDueDateValue}T09:00:00`).toISOString();
    const expiresAt = new Date(`${expiresDateValue}T23:59:59`).toISOString();
    const scheduleId = crypto.randomUUID();

    try {
        status("schedulerStatus", "Creating a restricted NWC authorization...");
        const descriptor = await client.request("create_subscription_authorization", {
            client_pubkey: dedicatedIdentity.publicKey,
            subscription_id: subscriptionId,
            merchant_pubkey: merchantPubkey,
            asset: schedulerAsset,
            billing_model: billingModel,
            amount: amountToApi(amount),
            total_amount: totalAmount === null ? undefined : amountToApi(totalAmount),
            installment_count: installmentCount ?? undefined,
            max_single_payment: amountToApi(maxSinglePayment),
            max_period_spend: amountToApi(maxPeriodSpend),
            expires_at: expiresAt,
            label: `Subscription ${merchantName || shorten(merchantPubkey, 8, 8)}`
        });
        if (!descriptor?.wallet_pubkey || !descriptor?.relay_url ||
            descriptor.client_pubkey?.toLowerCase() !== dedicatedIdentity.publicKey.toLowerCase()) {
            throw new Error("Provider returned an invalid subscription authorization descriptor.");
        }
        const dedicatedNwc = buildNwcUri({
            walletPubkey: descriptor.wallet_pubkey,
            relayUrl: descriptor.relay_url,
            secret: dedicatedIdentity.secret
        });
        await appMessages.send({
            recipientPubkey: schedulerPubkey,
            type: "subscription.authorization_granted",
            payload: {
                scheduleId,
                subscriptionId,
                clientPubkey: dedicatedIdentity.publicKey,
                merchantPubkey,
                asset: schedulerAsset,
                unit: schedulerAsset === "LNUSDT" ? "USDT" : "sat",
                amount: amountToApi(amount),
                billingModel,
                totalAmount: totalAmount === null ? undefined : amountToApi(totalAmount),
                installmentCount: installmentCount ?? undefined,
                maxSinglePayment: amountToApi(maxSinglePayment),
                maxPeriodSpend: amountToApi(maxPeriodSpend),
                interval,
                description,
                nextDueAt,
                expiresAt,
                nwcConnectionUri: dedicatedNwc
            }
        });

        upsertContact({
            pubkey: merchantPubkey,
            role: "merchant",
            displayName: merchantName || "Merchant",
            relayUrls: connection?.relayUrl ? [connection.relayUrl] : [],
            source: "subscription",
            createdAt: Date.now()
        });
        upsertSubscription({
            scheduleId,
            subscriptionId,
            offerId: $("schedulerOfferReferenceInput").dataset.offerId || undefined,
            merchantPubkey,
            asset: schedulerAsset,
            unit: schedulerAsset === "LNUSDT" ? "USDT" : "sat",
            amount,
            billingModel,
            totalAmount,
            installmentCount,
            maxSinglePayment,
            maxPeriodSpend,
            interval,
            nextDueDate: nextDueDateValue,
            expiresDate: expiresDateValue,
            description,
            status: "active",
            createdAt: Date.now()
        });
        selectedSubscriptionId = subscriptionId;
        value("schedulerSubscriptionIdInput", subscriptionId);
        updateSchedulerAuthorizationUi();
        renderScheduler();
        status("schedulerStatus", "Restricted authorization created and delivered to the scheduler.", "success");
    } catch (err) {
        console.error(err);
        status("schedulerStatus", err?.message || String(err), "error");
    }
}

async function revokeCurrentSubscriptionAuthorization() {
    if (!client) {
        status("schedulerStatus", "Connect your wallet first.", "error");
        return;
    }

    if (walletCapabilities?.canPaySubscriptionInvoice === true &&
        walletCapabilities?.canRevokeSubscription === true) {
        const confirmed = window.confirm("Revoke this dedicated recurring-payment authorization?");
        if (!confirmed) return;
        try {
            await client.revokeSubscription({ reason: "Revoked by the user from NwcWallet." });
            clearSavedConnectionData();
            value("nwcInput", "");
            await disconnectWallet();
            status("nwcStringStatus", "Recurring-payment authorization revoked.", "success");
            setView("nwc-string");
        } catch (err) {
            status("schedulerStatus", err?.message || String(err), "error");
        }
        return;
    }

    const subscription = subscriptions.find(item => item.subscriptionId === selectedSubscriptionId);
    if (!subscription || walletCapabilities?.canRevokeSubscriptionAuthorization !== true) {
        status("schedulerStatus", "This connection has no recurring-payment authorization to revoke.", "error");
        return;
    }

    const confirmed = window.confirm(
        `Revoke the recurring authorization for ${subscription.description || subscription.subscriptionId}?`
    );
    if (!confirmed) return;

    try {
        status("schedulerStatus", "Revoking authorization...");
        await client.request("revoke_subscription_authorization", {
            subscription_id: subscription.subscriptionId,
            reason: "Revoked by the user from NwcWallet."
        });
        const schedulerPubkey = walletInfo?.subscription_scheduler_pubkey;
        if (appMessages && isNostrPubkey(schedulerPubkey)) {
            await appMessages.send({
                recipientPubkey: schedulerPubkey,
                type: "subscription.revoke",
                payload: {
                    subscriptionId: subscription.subscriptionId,
                    merchantPubkey: subscription.merchantPubkey,
                    customerPubkey: appMessages.pubkey,
                    reason: "Revoked by the user from NwcWallet.",
                    createdAt: new Date().toISOString()
                }
            });
        }
        upsertSubscription({ ...subscription, status: "revoked", revokedAt: Date.now() });
        updateSchedulerAuthorizationUi();
        renderScheduler();
        status("schedulerStatus", "Recurring-payment authorization revoked.", "success");
    } catch (err) {
        console.error(err);
        status("schedulerStatus", err?.message || String(err), "error");
    }
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
        const result = receiveAsset === "LNUSDT"
            ? await client.request("make_taproot_asset_invoice", {
                asset: "LNUSDT",
                amount,
                unit: "USDT",
                description: memo || "NwcWallet USDT invoice"
            })
            : await client.makeInvoice({
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
        const payment = payAsset === "LNUSDT"
            ? await client.request("pay_taproot_asset_invoice", {
                asset: "LNUSDT",
                invoice
            })
            : await client.payInvoice({ invoice });
        const serviceFee = Number(payment?.service_fee_paid || 0);
        status(
            "payStatus",
            serviceFee > 0
                ? `Payment sent. Service fee ${formatSats(serviceFee)}.`
                : "Payment sent.",
            "success"
        );
        await refreshHomeData();
    } catch (err) {
        console.error(err);
        if (["TIMEOUT", "RELAY_TIMEOUT", "DISCONNECTED", "PAYMENT_UNKNOWN"].includes(err?.code)) {
            status("payStatus", "Payment outcome is uncertain. Do not retry while the wallet verifies it.", "error");
            if (payAsset === "LNBTC") {
                try {
                    const lookup = await client.lookupInvoice({ invoice });
                    if (lookup?.state === "settled") {
                        status("payStatus", "Payment verified as sent after reconnecting.", "success");
                        await refreshHomeData();
                    }
                } catch (lookupError) {
                    console.warn("Payment reconciliation is still pending", lookupError);
                }
            }
            return;
        }
        status("payStatus", err?.message || String(err), "error");
    }
}

function setReceiveAsset(asset) {
    receiveAsset = asset === "LNUSDT" ? "LNUSDT" : "LNBTC";
    document.querySelectorAll("[data-receive-asset]").forEach(button => {
        const active = button.dataset.receiveAsset === receiveAsset;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });

    text("receiveAmountLabel", receiveAsset === "LNUSDT" ? "Amount USDT" : "Amount sats");
    $("receiveAmountInput").min = receiveAsset === "LNUSDT" ? "0.01" : "1";
    $("receiveAmountInput").step = receiveAsset === "LNUSDT" ? "0.01" : "1";
    if (receiveAsset === "LNUSDT" && Number($("receiveAmountInput").value) >= 1000) {
        value("receiveAmountInput", "1.00");
    }
    if (receiveAsset === "LNBTC" && Number($("receiveAmountInput").value) < 1) {
        value("receiveAmountInput", "1000");
    }
    text("createdInvoiceShort", "-");
    lastCreatedInvoice = "";
    InvoiceQr.update("createdInvoiceQrWrap", "createdInvoiceQrImage", "");
    $("createdInvoiceSummary").hidden = true;
    $("copyCreatedInvoiceButton").disabled = true;
    $("useCreatedInvoiceButton").disabled = true;
    status("receiveStatus", "");
}

function setPayAsset(asset) {
    payAsset = asset === "LNUSDT" ? "LNUSDT" : "LNBTC";
    document.querySelectorAll("[data-pay-asset]").forEach(button => {
        const active = button.dataset.payAsset === payAsset;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });

    text("payInvoiceLabel", payAsset === "LNUSDT" ? "USDT Lightning invoice" : "Lightning invoice");
    $("payInvoiceInput").placeholder = payAsset === "LNUSDT" ? "ln..." : "lnbc...";
    status("payStatus", "");
}

function setSchedulerAsset(asset) {
    schedulerAsset = asset === "LNUSDT" ? "LNUSDT" : "LNBTC";
    document.querySelectorAll("[data-scheduler-asset]").forEach(button => {
        const active = button.dataset.schedulerAsset === schedulerAsset;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });
    const isUsdt = schedulerAsset === "LNUSDT";
    ["schedulerAmountInput", "schedulerMaxSingleInput", "schedulerMaxPeriodInput", "schedulerTotalAmountInput"].forEach(id => {
        const input = $(id);
        input.min = isUsdt ? "0.01" : "1";
        input.step = isUsdt ? "0.01" : "1";
    });
    updateSchedulerBillingModelUi();
    updateSchedulerAuthorizationUi();
    status(
        "schedulerStatus",
        isUsdt ? "LNUSDT recurring execution is visible but remains technically gated." : "",
        isUsdt ? "info" : "info"
    );
}

function updateSchedulerBillingModelUi() {
    const model = $("schedulerBillingModelInput")?.value || "recurring_fixed";
    const unit = schedulerAsset === "LNUSDT" ? "USDT" : "sats";
    $("schedulerInstallmentFields").hidden = model !== "fixed_installments";
    text(
        "schedulerAmountLabel",
        model === "recurring_variable"
            ? `Maximum expected amount ${unit}`
            : model === "fixed_installments"
                ? `Installment amount ${unit}`
                : `Amount ${unit}`
    );
}

function setSwapMode(mode) {
    document.querySelectorAll("[data-swap-mode]").forEach(button => {
        button.classList.toggle("active", button.dataset.swapMode === mode);
    });

    $("forwardSwapPanel").hidden = false;
    $("reverseSwapPanel").hidden = true;
    updateSwapAssetUi();
}

function getSwapSendKey() {
    return swapSendAssetKey;
}

function getSwapReceiveKey() {
    return swapReceiveAssetKey;
}

function getSwapChoice(key) {
    return swapAssetChoices[key] || swapAssetChoices.btc_lightning;
}

function getSwapDirection(sendKey, receiveKey) {
    if (sendKey === "btc_onchain" && receiveKey === "btc_lightning") return "onchain_to_lightning";
    if (sendKey === "btc_lightning" && receiveKey === "btc_onchain") return "lightning_to_onchain";
    return `${sendKey}_to_${receiveKey}`;
}

function routeUsesInvoice(receiveKey) {
    return receiveKey === "btc_lightning" || receiveKey === "usdt_lightning";
}

function buildSwapRequest(amount, destination) {
    const sendKey = getSwapSendKey();
    const receiveKey = getSwapReceiveKey();
    const send = getSwapChoice(sendKey);
    const receive = getSwapChoice(receiveKey);
    const request = {
        direction: getSwapDirection(sendKey, receiveKey),
        sendAsset: send.asset,
        receiveAsset: receive.asset,
        amount: send.amountUnit === "sat" ? satsAmount(amount) : { value: String(amount), unit: "usdt" }
    };

    if (routeUsesInvoice(receiveKey)) {
        request.receiveInvoice = destination;
    } else {
        request.receiveAddress = destination;
    }

    return request;
}

function syncSwapAssetState(changedSide = "send") {
    if (swapSendAssetKey === swapReceiveAssetKey) {
        const replacement = Object.keys(swapAssetChoices).find(key => key !== (changedSide === "send" ? swapSendAssetKey : swapReceiveAssetKey));
        if (changedSide === "send") {
            swapReceiveAssetKey = replacement || "btc_lightning";
        } else {
            swapSendAssetKey = replacement || "btc_onchain";
        }
    }
}

function updateSwapAssetUi(changedSide = "send") {
    syncSwapAssetState(changedSide);

    const sendKey = getSwapSendKey();
    const receiveKey = getSwapReceiveKey();
    const send = getSwapChoice(sendKey);
    const receive = getSwapChoice(receiveKey);

    text("swapSendAssetLabel", send.label);
    text("swapReceiveAssetLabel", receive.label);
    text("swapAmountLabel", send.amountUnit === "sat" ? "Amount sats" : "Amount USDT");
    $("swapAmountInput").min = String(send.minAmount);
    if (!Number.isFinite(Number($("swapAmountInput").value)) || Number($("swapAmountInput").value) < send.minAmount) {
        value("swapAmountInput", send.defaultAmount);
    }

    text("swapDestinationLabel", receive.destinationLabel);
    text("swapDestinationLoadedLabel", receive.loadedLabel);
    $("swapInvoiceInput").placeholder = receive.destinationPlaceholder;
    $("swapInvoiceQrImage").alt = `${receive.label} destination QR`;
}

function resetSwapAssetDefaults() {
    swapSendAssetKey = "btc_onchain";
    swapReceiveAssetKey = "btc_lightning";
    updateSwapAssetUi("send");
}

function openAssetPicker(side) {
    activeAssetPickerSide = side === "receive" ? "receive" : "send";
    const blockedKey = activeAssetPickerSide === "send" ? swapReceiveAssetKey : swapSendAssetKey;
    const currentKey = activeAssetPickerSide === "send" ? swapSendAssetKey : swapReceiveAssetKey;

    text("assetPickerTitle", activeAssetPickerSide === "send" ? "Select send asset" : "Select receive asset");

    const list = $("assetPickerList");
    list.innerHTML = "";

    Object.entries(swapAssetChoices).forEach(([key, choice]) => {
        if (key === blockedKey) return;

        const button = document.createElement("button");
        button.type = "button";
        button.className = `asset-picker-option${key === currentKey ? " active" : ""}`;
        button.dataset.assetKey = key;
        button.innerHTML = `
            <span class="asset-picker-icon">${choice.icon}</span>
            <span class="asset-picker-copy">
                <strong>${choice.label}</strong>
                <small>${choice.name}</small>
            </span>
        `;
        button.addEventListener("click", () => chooseAsset(key));
        list.appendChild(button);
    });

    $("assetPickerModal").hidden = false;
}

function closeAssetPicker() {
    $("assetPickerModal").hidden = true;
}

function chooseAsset(key) {
    if (!swapAssetChoices[key]) return;

    if (activeAssetPickerSide === "send") {
        swapSendAssetKey = key;
    } else {
        swapReceiveAssetKey = key;
    }

    updateSwapAssetUi(activeAssetPickerSide);
    closeAssetPicker();
}

async function createForwardSwap() {
    if (!client) {
        status("swapStatus", "Wallet not connected.", "error");
        setView("nwc-string");
        return;
    }

    if (!hasEasyCryptoSendSwapAccess()) {
        updateSwapAccessGate("swap");
        status("swapStatus", "This feature requires an EasyCryptoSend swap-enabled connection.", "error");
        return;
    }

    const amount = Number($("swapAmountInput").value);
    const destination = $("swapInvoiceInput").value.trim();
    const sendKey = getSwapSendKey();
    const receiveKey = getSwapReceiveKey();
    const send = getSwapChoice(sendKey);
    const receive = getSwapChoice(receiveKey);

    if (!Number.isFinite(amount) || amount < send.minAmount) {
        status("swapStatus", send.amountUnit === "sat" ? "Minimum 25000 sats." : "Amount must be positive.", "error");
        return;
    }

    if (!destination) {
        status("swapStatus", `${receive.destinationLabel} required.`, "error");
        return;
    }

    try {
        status("swapStatus", "Creating swap...");
        const swap = await client.createSwap(withSwapRequestId(buildSwapRequest(amount, destination)));
        pendingSwapAttempt = null;

        const resultValue = swap.depositAddress || swap.invoice || "";
        lastSwapDepositAddress = resultValue;
        addSwapHistory({
            swapId: swap.swapId,
            direction: swap.direction || getSwapDirection(sendKey, receiveKey),
            amountSats: amount,
            amountUnit: send.amountUnit,
            status: swap.status || "pending",
            sendAsset: send.label,
            receiveAsset: receive.label,
            depositAddress: swap.depositAddress || "",
            invoice: swap.invoice || ""
        });
        value("swapAddressOutput", resultValue);
        updateSwapAddressPreview(resultValue, swap.bip21 || resultValue);
        status("swapStatus", resultValue ? "Swap instructions ready." : "Swap created.", "success");
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
        status("swapStatus", "This feature requires an EasyCryptoSend swap-enabled connection.", "error");
        return;
    }

    const amount = Number($("reverseSwapAmountInput").value);
    const address = $("reverseSwapAddressInput").value.trim();
    const sendAsset = getReverseSendAsset();
    const isUsdt = sendAsset.asset === "USDT";

    if (!Number.isFinite(amount) || amount <= 0 || (!isUsdt && amount < 25000)) {
        status("swapStatus", isUsdt ? "Amount must be positive." : "Minimum 25000 sats.", "error");
        return;
    }

    if (!address) {
        status("swapStatus", "Bitcoin address required.", "error");
        return;
    }

    try {
        status("swapStatus", "Creating withdrawal...");
        const swap = await client.createSwap(withSwapRequestId(buildReverseSwapRequest(amount, address)));
        pendingSwapAttempt = null;

        const invoice = swap.invoice || "";
        addSwapHistory({
            swapId: swap.swapId,
            direction: swap.direction || (isUsdt ? "taproot_assets_to_onchain" : "lightning_to_onchain"),
            amountSats: amount,
            status: swap.status || "pending",
            sendAsset: sendAsset.asset,
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

async function applyScannedValue(targetId, rawValue) {
    const scannedValue = normalizeScannedValue(targetId, rawValue);
    value(targetId, scannedValue);

    if (targetId === "schedulerOfferReferenceInput") {
        await loadScannedSubscriptionOffer(scannedValue);
        return;
    }

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
            async (result) => {
                if (!result) return;

                const scannedText = result.getText();
                const scanTarget = activeScanTarget;
                const scanStatus = activeScanStatus;
                closeScanner();
                await applyScannedValue(scanTarget, scannedText);
                if (scanTarget !== "schedulerOfferReferenceInput") {
                    status(scanStatus, "QR acquired.", "success");
                }
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

function clearSavedConnectionData() {
    localStorage.removeItem(savedConnectionKey);
    localStorage.removeItem(deviceUnlockEnabledKey);
    localStorage.removeItem(deviceUnlockCredentialKey);
    localStorage.removeItem(`${deviceUnlockCredentialKey}_user`);
    localStorage.removeItem(deviceUnlockPromptedKey);
    localStorage.removeItem(deviceUnlockRepairKey);
    updateDeviceUnlockUi();
    hideDeviceUnlockOverlay();
}

function forgetConnection() {
    const confirmed = window.confirm("Forget the saved wallet connection and disconnect this wallet?");
    if (!confirmed) {
        return;
    }

    clearSavedConnectionData();
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

    document.querySelectorAll("[data-balance-asset]").forEach(button => {
        button.addEventListener("click", () => {
            activeBalanceAsset = button.dataset.balanceAsset || "LNBTC";
            renderSelectedBalance();
        });
    });

    document.querySelectorAll("[data-receive-asset]").forEach(button => {
        button.addEventListener("click", () => setReceiveAsset(button.dataset.receiveAsset));
    });

    document.querySelectorAll("[data-pay-asset]").forEach(button => {
        button.addEventListener("click", () => setPayAsset(button.dataset.payAsset));
    });

    document.querySelectorAll("[data-scheduler-asset]").forEach(button => {
        button.addEventListener("click", () => setSchedulerAsset(button.dataset.schedulerAsset));
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
    $("createSubscriptionAuthorizationButton").addEventListener("click", createSubscriptionAuthorization);
    $("revokeSubscriptionAuthorizationButton").addEventListener("click", revokeCurrentSubscriptionAuthorization);
    $("loadSubscriptionOfferButton").addEventListener("click", () => loadScannedSubscriptionOffer());
    $("schedulerBillingModelInput").addEventListener("change", updateSchedulerBillingModelUi);
    $("schedulerAmountInput").addEventListener("change", event => {
        const amount = event.target.value;
        if (!$("schedulerMaxSingleInput").value) value("schedulerMaxSingleInput", amount);
        if (!$("schedulerMaxPeriodInput").value) value("schedulerMaxPeriodInput", amount);
    });

    $("createInvoiceButton").addEventListener("click", createInvoice);
    $("payInvoiceButton").addEventListener("click", payInvoice);
    $("createForwardSwapButton").addEventListener("click", createForwardSwap);
    $("createReverseSwapButton").addEventListener("click", createReverseSwap);
    $("swapSendAssetButton").addEventListener("click", () => openAssetPicker("send"));
    $("swapReceiveAssetButton").addEventListener("click", () => openAssetPicker("receive"));
    $("closeAssetPickerButton").addEventListener("click", closeAssetPicker);
    $("assetPickerModal").addEventListener("click", event => {
        if (event.target === $("assetPickerModal")) closeAssetPicker();
    });
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
    $("exportBackupButton").addEventListener("click", exportEncryptedBackup);
    $("importBackupButton").addEventListener("click", () => $("backupFileInput").click());
    $("backupFileInput").addEventListener("change", event => {
        pendingBackupFile = event.target.files?.[0] || null;
        importEncryptedBackup(pendingBackupFile);
    });
    $("backupPasswordSubmitButton").addEventListener("click", submitBackupPassword);
    $("backupPasswordCancelButton").addEventListener("click", () => closeBackupPassword());
    $("backupPasswordInput").addEventListener("keydown", event => {
        if (event.key === "Enter") submitBackupPassword();
    });
    $("backupPasswordConfirmInput").addEventListener("keydown", event => {
        if (event.key === "Enter") submitBackupPassword();
    });
    $("closeScannerButton").addEventListener("click", closeScanner);
    $("themeToggleButton").addEventListener("click", toggleTheme);
    $("deviceUnlockToggleButton").addEventListener("click", toggleDeviceUnlock);
    $("deviceUnlockRetryButton").addEventListener("click", async () => {
        if (deviceUnlockOverlayMode === "setup") {
            const enabled = await enableDeviceUnlock("deviceUnlockStatus");
            if (enabled) hideDeviceUnlockOverlay();
            return;
        }
        const savedConnection = restoreSavedConnection();
        const unlocked = await unlockSavedConnectionBeforeConnect();
        if (unlocked && savedConnection) {
            await connectWithString(savedConnection, false);
        }
    });
    $("deviceUnlockForgetButton").addEventListener("click", () => {
        if (deviceUnlockOverlayMode === "setup") {
            hideDeviceUnlockOverlay();
            return;
        }
        forgetConnection();
    });
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
    text("settingsAppVersion", appBuild);
    showInstallPrompt(isIosDevice() ? "ios" : "browser");
    requestCameraPermissionOnStartup();
    loadSwapHistory();
    loadSchedulerState();
    renderScheduler();
    setDefaultSchedulerDates();
    setSchedulerAsset("LNBTC");
    repairDeviceUnlockPromptState();
    const savedConnection = restoreSavedConnection();
    updateDeviceUnlockUi();
    clearWalletInfo();
    setConnectedUi(false);
    setSwapMode("forward");
    resetSwapAssetDefaults();
    $("copyCreatedInvoiceButton").disabled = true;
    $("useCreatedInvoiceButton").disabled = true;
    wireEvents();

    if (savedConnection) {
        const unlocked = await unlockSavedConnectionBeforeConnect();
        if (unlocked) {
            await connectWithString(savedConnection, false);
        }
    } else {
        setView("nwc-string");
    }
});
