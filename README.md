# NwcWallet

NwcWallet is the EasyCryptoSend browser wallet for Nostr Wallet Connect (NWC). It is a Vite-powered PWA that connects to an NWC provider and exposes the wallet flows used by EasyCryptoSend.

## Features

- NWC connection management with QR scanning support.
- Lightning BTC balance, invoice creation, and invoice payment.
- LNUSDT balance tab backed by Taproot Asset NWC methods.
- LNUSDT invoice creation and payment through `make_taproot_asset_invoice` and `pay_taproot_asset_invoice`.
- Swap route selector for BTC, LNBTC, USDT Taproot Assets, and LNUSDT.
- Static production build suitable for IIS hosting.

## NWC Methods Used

The wallet keeps the standard BTC Lightning flow intact and adds Taproot Asset-specific calls for USDT over Lightning:

- `get_balance`
- `make_invoice`
- `pay_invoice`
- `get_taproot_asset_balances`
- `make_taproot_asset_invoice`
- `pay_taproot_asset_invoice`

Taproot Asset features require the connected provider to support the new methods and to have the official asset configuration enabled.

## Development

Install dependencies:

```powershell
npm install
```

Run the local dev server:

```powershell
npm run dev
```

Build for production:

```powershell
npm run build
```

The production output is generated in `dist/`.

## IIS Deployment

The current local IIS publish target is:

```text
D:\pub\NwcWallet
```

Publish by building the app, emptying that target directory, and copying the contents of `dist/` into it.

## Packages

The wallet consumes `nwckit` from npm. Keep `package-lock.json` committed so the IIS build is reproducible.
