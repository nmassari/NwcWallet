# NwcWallet

NwcWallet is the EasyCryptoSend browser wallet for Nostr Wallet Connect (NWC). It is a Vite-powered PWA that connects to an NWC provider and exposes the wallet flows used by EasyCryptoSend.

## Features

- NWC connection management with QR scanning support.
- Client-side NWC identity generation: hosted-wallet provisioning sends only the public key to EasyCryptoSend.
- Password-encrypted local export/import of the NWC connection credential.
- Provider-key rotation recovery that is offered only for EasyCryptoSend keys explicitly marked as retired by NwcProvider.
- Recurring-payment authorization panel with merchant identity, asset, cadence,
  per-payment/period limits and expiry.
- Three enforceable billing models: fixed recurring amount, fixed installment
  plan (including a smaller final remainder), and recurring variable amount
  within explicit caps.
- Camera scanning and pasted import of signed merchant subscription offers.
- Cryptographic verification of the merchant Nostr event before offer fields
  are populated; the customer subscription id is generated separately.
- Browser-generated, dedicated NWC identity for each recurring authorization;
  the main wallet credential is never delivered to the scheduler.
- Revocation from the main wallet, plus server-side revocation when a dedicated
  subscription connection is imported directly.
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
- `revoke_subscription` (dedicated subscription connections only)
- `create_subscription_authorization` (main wallet connection)
- `revoke_subscription_authorization` (main wallet connection)
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

Hosted wallet creation uses the public-key-only provisioning flow. The client secret is generated in the browser and is only placed in the locally assembled NWC URI. The encrypted backup uses PBKDF2-SHA-256 and AES-256-GCM; neither the backup password nor the NWC URI is uploaded by the backup feature.

Automatic recurring payments use a separate `subscription_scheduler` NWC
authorization created by the main wallet. NwcWallet generates that
authorization's private key locally, sends only its public key to NwcProvider,
then delivers the resulting restricted NWC URI to the scheduler through an
encrypted Nostr application message. The browser stores only non-secret display
metadata for the subscription.

The authorization is bound to one subscription id, merchant pubkey, asset,
billing model, amount policy, period limit and expiry. Fixed installment plans
also bind the total and installment count. Revocation disables the child
authorization at NwcProvider and notifies the scheduler over Nostr. LNUSDT is
shown in the interface but recurring execution remains gated until the Taproot
Assets payment rail is enabled server-side.
