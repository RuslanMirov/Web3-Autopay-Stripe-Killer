# Web3 Stripe Killer

A Web3 infrastructure project building **safe, automated, and developer-friendly recurring payments** — without the security risks endemic to most DeFi payment systems.

---

## Vision

Enable **real auto-pay in Web3** with strong security guarantees and simple UX — the power of traditional payment platforms, but **without centralized control, unlimited approvals, or private key trust**.

---

## Core Principles

| Principle | What it means |
|---|---|
| **No Unlimited Approve** | Tokens live inside a smart wallet, not approved to external contracts |
| **No Unlimited Deposit** | Wallet holds only what the user puts in; services claim specific amounts |
| **No Private Key Trust** | Claims are authorized by subscription state, not by holding a key |
| **Contract-Based Automation** | ERC-4337 EntryPoint enforces timing, caps, and whitelist on-chain |
| **Real Auto-Pay** | Services pull payment every 30 days without user interaction |
| **Simple and Safe UX** | One deposit into your smart wallet — done |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Platform Admin                                                     │
│  PlatformRegistry.addService(addr, operator, name, ...)             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ whitelists
                               ▼
                    ┌──────────────────────┐
                    │   PlatformRegistry   │
                    │  isWhitelisted(addr) │
                    └──────────┬───────────┘
                               │ checked by
              ┌────────────────┴────────────────┐
              ▼                                 ▼
┌─────────────────────────┐       ┌──────────────────────────────┐
│   SubscriptionWallet    │       │   ServiceBase (per service)  │
│   (one per user)        │       │                              │
│                         │       │  Receives tokens on claim    │
│  Tokens held inside     │       │  Per-subscriber accounting   │
│  subscribe()            │       │  _onPaymentReceived() hook   │
│  unsubscribe()          │       │                              │
│  executeClaim() ◄───────┼───────┤  Called via EntryPoint       │
└────────────┬────────────┘       └──────────────────────────────┘
             │ deployed by
             ▼
   ┌─────────────────────┐
   │    WalletFactory    │
   │  CREATE2 deploy     │
   │  getWalletAddress() │   ← counterfactual address before deploy
   └─────────────────────┘

         Claim flow (every 30 days, no user action required):

         Service/Bundler builds UserOp via ClaimBundlerHelper
                   ↓
         EntryPoint.handleOps([userOp])
                   ↓
         wallet.validateUserOp()  ← checks all conditions on-chain:
           • callData = executeClaim(service)
           • service is platform-whitelisted
           • subscription is active
           • block.timestamp >= nextClaimAt (30-day interval)
           • totalCap not exceeded
           • wallet balance >= amountPerCycle
                   ↓ (validationData = 0 → proceed)
         wallet.executeClaim(service)
           • re-checks all conditions (defence in depth)
           • updates nextClaimAt += 30 days
           • auto-cancels if lifetime totalCap reached
           • IERC20(token).safeTransfer(service, amount)
```

---

## Contracts

### `PlatformRegistry.sol`
The trust root. Platform admin maintains a whitelist of approved service contracts. Smart wallets reject claims from any address not listed here. Includes two-step admin transfer for safe ownership handoff.

```
addService(addr, operator, name, description)
removeService(addr)
isWhitelisted(addr) → bool
```

### `SubscriptionWallet.sol`
ERC-4337 smart account. Each user deploys one (or more) wallets via the factory. **Tokens live here** — no unlimited EOA approvals. Implements two `validateUserOp` paths:

- **Path A — Owner-signed ops** (ECDSA over userOpHash): general wallet execution, deposits, withdrawals
- **Path B — Subscription claims** (magic bytes + service address): no ECDSA needed; authorization is the subscription state itself

```
subscribe(service, token, amountPerCycle, totalCap, startImmediately)
unsubscribe(service)
executeClaim(service)       ← only callable by EntryPoint
depositToken(token, amount)
withdrawToken(token, amount)
fundEntryPoint()            ← ETH deposit for bundler gas
```

### `WalletFactory.sol`
CREATE2 factory for deterministic wallet deployment. Users can know their wallet address before it exists on-chain (counterfactual funding). First-op deployment supported via EntryPoint `initCode`.

```
createWallet(owner, salt) → wallet   ← idempotent
getWalletAddress(owner, salt) → address
```

### `ServiceBase.sol`
Abstract base all whitelisted services extend. Handles payment receipt accounting, revenue tracking per subscriber, and withdrawal. Override `_onPaymentReceived()` to add your business logic (e.g. mint access NFT, unlock tier, update member status).

```
acknowledgePayment(wallet, token, amount)
withdrawRevenue(token, amount)
_onPaymentReceived(wallet, token, amount, cycle)  ← virtual hook
```

### `ClaimBundlerHelper.sol`
Read-only helper bundlers call off-chain to build valid UserOperations and find claimable wallets. Not a transaction — call via `eth_call`.

```
buildClaimOp(wallet, service, maxFee, priorityFee) → UserOperation
checkClaimable(wallets[], services[]) → ClaimStatus[]
```

### `interfaces/IERC4337.sol`
Clean ERC-4337 v0.6 types: `UserOperation` struct, `IAccount`, `IEntryPoint`.

---

## Security Properties

| Property | Mechanism |
|---|---|
| No unlimited approve from EOA | Tokens deposited into smart wallet, not approved to services |
| Service whitelist | `registry.isWhitelisted()` checked in `validateUserOp` AND `executeClaim` |
| 30-day interval enforced on-chain | `nextClaimAt` hardcoded constant, not a parameter |
| Lifetime spending cap | `totalCap` auto-cancels subscription when reached |
| Balance guard at validation time | Claim fails before reaching chain if wallet is short |
| Re-entrancy protection | `nonReentrant` on `executeClaim` and `execute` |
| Defence in depth | All conditions checked in both `validateUserOp` AND `executeClaim` |
| User always in control | `unsubscribe()` callable directly from EOA, no UserOp needed |
| Counterfactual wallets | Fund wallet before deployment; no race conditions |

---

## Tests

**43 tests** covering all contracts and both `validateUserOp` paths.

| Suite | Tests | Coverage |
|---|---|---|
| `[A] PlatformRegistry` | 7 | whitelist/remove, duplicate guard, two-step admin, pagination |
| `[B] WalletFactory` | 6 | CREATE2 address prediction, idempotent deploy, salt/owner isolation |
| `[C] Wallet management` | 8 | deposit/withdraw, subscribe/unsubscribe guards, service list |
| `[D] validateUserOp` | 12 | Both paths — claim magic + ECDSA, all 9 failure modes |
| `[E] executeClaim` | 8 | Full lifecycle, timing, direct-call guard, mid-sub de-list |
| `[F] Edge cases` | 6 | Auto-cancel on cap, unlimited cap, multi-service, zero balance |
| `[G] ClaimBundlerHelper` | 6 | buildClaimOp structure, batch checkClaimable, nonce tracking |

Run with:
```bash
npx hardhat test
```

---

## Project Structure

```
contracts/
├── interfaces/
│   └── IERC4337.sol          # UserOperation struct, IAccount, IEntryPoint
├── PlatformRegistry.sol      # Service whitelist (platform admin)
├── SubscriptionWallet.sol    # ERC-4337 smart account (one per user)
├── WalletFactory.sol         # CREATE2 wallet deployer
├── ServiceBase.sol           # Abstract base for whitelisted services
└── ClaimBundlerHelper.sol    # Off-chain helper for bundlers

test/
├── mocks/
│   └── Mocks.sol             # MockUSDC, MockEntryPoint, MockService
└── SubscriptionSystem.test.js
```

---

## Roadmap

| # | Item | Status |
|---|---|---|
| 0 | ERC-4337 smart wallet + subscription engine | ✅ Done |
| 1 | Platform registry + service whitelist | ✅ Done |
| 2 | Full test suite (43 tests) | ✅ Done |
| 3 | SDK for developers — easy `subscribe()` + claim integration | 🔜 Next |
| 4 | Bundler service — automated off-chain claim execution | 🔜 Next |
| 5 | UI / Backend — subscription dashboard, wallet management | 🔜 Next |
| 6 | Multi-token support + cross-chain (Polygon zkEVM, Base) | 📋 Planned |
| 7 | Refund standard — service-initiated refund back to wallet | 📋 Planned |

---

## Join the Project

If you are interested in discussing the project, collaborating, or contributing:

**LinkedIn:** https://www.linkedin.com/in/ruslan-mirov/