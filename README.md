# Web3 Stripe Killer

A Web3 infrastructure project focused on building **safe, automated, and developer-friendly recurring payments** without the security risks common in many DeFi payment systems.

## Vision

Enable **real auto-pay in Web3** with strong security guarantees and simple UX — similar to traditional payment platforms but **without centralized control**.

## Core Principles

* **No Unlimited Approve**
* **No Unlimited Deposit**
* **No Trust in Private Keys**
* **Secure contract-based automation**
* **Real Auto-Pay**
* **Simple and Safe UX**

## Project Structure

The project will include the following components:

1. **Public Smart Contracts**
   Open contracts enabling decentralized recurring payments.

2. **Public SDK for Developers**
   Tools and libraries for easy integration into dApps and services.

3. **Private Frontend & Backend**
   Core infrastructure powering automation and service logic.

4. **Private Frontend Repository**
   User interface for managing subscriptions and payments.


# Contracts

```
SubscriptionManager.sol
The main contract implementing:

Subscription creation – payer, recipient, token, amount, interval, totalCap, sessionKey
Bundler execution – whitelisted bundler submits executePayment() (mirrors ERC-4337 Bundler→EntryPoint flow)
Session keys – payer can delegate execution to a secondary key
Risk limits – per-subscription totalCap enforces lifetime spending ceiling
Refunds – merchant calls refundPayment(subId, cycle) to return funds to payer
Paymaster – ETH deposit/deduct/withdraw for gas sponsorship simulation
```

# TODO

```
1) SDK for developers for easy integration
2) UI/Backend for UX
```


## Join the Project

If you are interested in discussing the project, collaborating, or contributing:

LinkedIn:
https://www.linkedin.com/in/ruslan-mirov/
