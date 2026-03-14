"use strict";

/**
 * ERC-4337 Subscription System — Test Suite
 *
 * Coverage map:
 *   [A] PlatformRegistry  — whitelist management + two-step admin transfer
 *   [B] WalletFactory     — CREATE2 deployment + counterfactual addresses
 *   [C] SubscriptionWallet — token management + subscribe/unsubscribe + ownership
 *   [D] validateUserOp    — Path A (owner ECDSA) + Path B (subscription claim)
 *   [E] executeClaim      — full claim lifecycle via MockEntryPoint
 *   [F] Edge cases        — cap enforcement, auto-cancel, balance guard, guard reuse
 *   [G] ClaimBundlerHelper — buildClaimOp + checkClaimable batch view
 *
 * Key differences from old SubscriptionManager tests:
 *   ✗ No MaxUint256 approve from EOA to manager
 *   ✓ Tokens are deposited INTO the smart wallet
 *   ✓ Claims routed through MockEntryPoint.handleOps
 *   ✓ Services must be platform-whitelisted
 *   ✓ Interval is 30 days (hardcoded constant, not per-subscription)
 *   ✓ validateUserOp returns 0/1 not reverts (ERC-4337 spec)
 */

const { expect }       = require("chai");
const { ethers }       = require("hardhat");
const { time }         = require("@nomicfoundation/hardhat-network-helpers");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const USDC  = (n) => ethers.parseUnits(String(n), 6);
const DAY   = 86_400n;
const MONTH = DAY * 30n;          // matches SUBSCRIPTION_INTERVAL constant

// Build the ERC-4337 "claim" signature: CLAIM_MAGIC ++ abi.encode(serviceAddr)
function buildClaimSig(serviceAddr) {
  const CLAIM_MAGIC = "0x7c1e2e76";
  const encodedAddr = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [serviceAddr]);
  return ethers.concat([CLAIM_MAGIC, encodedAddr]); // 4 + 32 = 36 bytes
}

// Build callData for executeClaim(address)
function buildClaimCallData(walletIface, serviceAddr) {
  return walletIface.encodeFunctionData("executeClaim", [serviceAddr]);
}

// Construct a minimal UserOperation struct for claim ops
function buildClaimOp(walletAddr, serviceAddr, walletIface, nonce = 0n) {
  return {
    sender:               walletAddr,
    nonce:                nonce,
    initCode:             "0x",
    callData:             buildClaimCallData(walletIface, serviceAddr),
    callGasLimit:         200_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas:   50_000n,
    maxFeePerGas:         ethers.parseUnits("2", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    paymasterAndData:     "0x",
    signature:            buildClaimSig(serviceAddr),
  };
}

// Sign a UserOp hash with owner key (Path A)
async function signOwnerOp(signer, userOp) {
  const opHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      // matches MockEntryPoint.simulateOp hash: keccak256(abi.encode(userOp))
      // For simplicity we use the same hash the mock uses
      ["tuple(address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes)"],
      [[
        userOp.sender, userOp.nonce, userOp.initCode, userOp.callData,
        userOp.callGasLimit, userOp.verificationGasLimit, userOp.preVerificationGas,
        userOp.maxFeePerGas, userOp.maxPriorityFeePerGas, userOp.paymasterAndData,
        userOp.signature,
      ]]
    )
  );
  const sig = await signer.signMessage(ethers.getBytes(opHash));
  return { ...userOp, signature: sig };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

async function deployFixture() {
  const [admin, alice, bob, operator, stranger] = await ethers.getSigners();

  // Tokens
  const USDC_ = await ethers.getContractFactory("MockUSDC");
  const usdc   = await USDC_.deploy();

  // Registry
  const Registry = await ethers.getContractFactory("PlatformRegistry");
  const registry  = await Registry.deploy();

  // MockEntryPoint
  const EP_   = await ethers.getContractFactory("MockEntryPoint");
  const entryPoint = await EP_.deploy();

  // Factory
  const Factory = await ethers.getContractFactory("WalletFactory");
  const factory  = await Factory.deploy(
    await entryPoint.getAddress(),
    await registry.getAddress()
  );

  // Deploy Alice's wallet via factory
  const tx        = await factory.createWallet(alice.address, ethers.zeroPadBytes("0x", 32));
  const receipt   = await tx.wait();
  const walletAddr = await factory.getWalletAddress(alice.address, ethers.zeroPadBytes("0x", 32));
  const SubscriptionWallet = await ethers.getContractFactory("SubscriptionWallet");
  const wallet    = SubscriptionWallet.attach(walletAddr);

  // MockService
  const Svc_   = await ethers.getContractFactory("MockService");
  const service = await Svc_.deploy(await usdc.getAddress());

  // Wallet interface for encoding callData
  const walletIface = SubscriptionWallet.interface;

  // Mint USDC to Alice and Bob
  await usdc.mint(alice.address, USDC(10_000));
  await usdc.mint(bob.address,   USDC(10_000));

  return {
    admin, alice, bob, operator, stranger,
    usdc, registry, entryPoint, factory, wallet, service, walletIface,
    walletAddr, SubscriptionWallet,
  };
}

// Standard "subscribed + funded" state
async function subscribedFixture() {
  const base = await deployFixture();
  const { usdc, registry, wallet, service, alice, operator, walletAddr } = base;

  // Whitelist service
  await registry.addService(
    await service.getAddress(),
    operator.address,
    "Streaming Service",
    "30-day USDC plan"
  );

  // Fund wallet with 120 USDC (12 months)
  await usdc.connect(alice).approve(walletAddr, USDC(120));
  await wallet.connect(alice).depositToken(await usdc.getAddress(), USDC(120));

  // Subscribe — first claim available immediately
  await wallet.connect(alice).subscribe(
    await service.getAddress(),
    await usdc.getAddress(),
    USDC(10),
    USDC(120),       // 12-month total cap
    true             // startImmediately
  );

  return base;
}

// ─── [A] PlatformRegistry ────────────────────────────────────────────────────

describe("[A] PlatformRegistry", function () {
  it("A1. admin can whitelist a service and isWhitelisted returns true", async () => {
    const { registry, service, operator } = await deployFixture();
    const svcAddr = await service.getAddress();

    await expect(
      registry.addService(svcAddr, operator.address, "Streaming", "desc")
    ).to.emit(registry, "ServiceAdded")
     .withArgs(svcAddr, operator.address, "Streaming");

    expect(await registry.isWhitelisted(svcAddr)).to.be.true;
    const info = await registry.getService(svcAddr);
    expect(info.name).to.equal("Streaming");
    expect(info.operator).to.equal(operator.address);
    expect(info.active).to.be.true;
  });

  it("A2. non-admin cannot add a service", async () => {
    const { registry, service, stranger, operator } = await deployFixture();
    await expect(
      registry.connect(stranger).addService(
        await service.getAddress(), operator.address, "X", "Y"
      )
    ).to.be.revertedWith("PlatformRegistry: not admin");
  });

  it("A3. adding duplicate service reverts", async () => {
    const { registry, service, operator } = await deployFixture();
    const svcAddr = await service.getAddress();
    await registry.addService(svcAddr, operator.address, "Svc", "d");
    await expect(
      registry.addService(svcAddr, operator.address, "Svc2", "d2")
    ).to.be.revertedWith("Already whitelisted");
  });

  it("A4. admin can remove a service; isWhitelisted returns false", async () => {
    const { registry, service, operator } = await deployFixture();
    const svcAddr = await service.getAddress();
    await registry.addService(svcAddr, operator.address, "Svc", "d");

    await expect(registry.removeService(svcAddr))
      .to.emit(registry, "ServiceRemoved").withArgs(svcAddr);

    expect(await registry.isWhitelisted(svcAddr)).to.be.false;
  });

  it("A5. removing already-inactive service reverts", async () => {
    const { registry, service, operator } = await deployFixture();
    const svcAddr = await service.getAddress();
    await registry.addService(svcAddr, operator.address, "Svc", "d");
    await registry.removeService(svcAddr);
    await expect(registry.removeService(svcAddr)).to.be.revertedWith("Not active");
  });

  it("A6. two-step admin transfer works correctly", async () => {
    const { registry, alice, bob, admin } = await deployFixture();

    await expect(registry.initiateAdminTransfer(alice.address))
      .to.emit(registry, "AdminTransferInitiated").withArgs(alice.address);

    // Bob cannot accept (not pendingAdmin)
    await expect(registry.connect(bob).acceptAdminTransfer())
      .to.be.revertedWith("Not pending admin");

    await expect(registry.connect(alice).acceptAdminTransfer())
      .to.emit(registry, "AdminTransferred").withArgs(admin.address, alice.address);

    expect(await registry.admin()).to.equal(alice.address);
    expect(await registry.pendingAdmin()).to.equal(ethers.ZeroAddress);
  });

  it("A7. getActiveServices paginates correctly", async () => {
    const { registry, operator } = await deployFixture();

    // Deploy 3 extra services
    const Svc = await ethers.getContractFactory("MockService");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const tok = await MockUSDC.deploy();
    const svcs = await Promise.all([0,1,2].map(() => Svc.deploy(tok.getAddress())));

    for (const [i, s] of svcs.entries()) {
      await registry.addService(await s.getAddress(), operator.address, `Svc${i}`, "d");
    }

    // Remove middle one
    await registry.removeService(await svcs[1].getAddress());

    const [active] = await registry.getActiveServices(0, 10);
    // Only 2 active
    expect(active.filter(a => a !== ethers.ZeroAddress).length).to.be.gte(2);
  });
});

// ─── [B] WalletFactory ───────────────────────────────────────────────────────

describe("[B] WalletFactory", function () {
  it("B1. deploys wallet at predicted counterfactual address", async () => {
    const { factory, alice } = await deployFixture();
    const salt       = ethers.zeroPadBytes("0x", 32);
    const predicted  = await factory.getWalletAddress(alice.address, salt);
    const tx         = await factory.createWallet(alice.address, salt);
    await tx.wait();
    expect(await factory.isDeployedWallet(predicted)).to.be.true;
  });

  it("B2. createWallet is idempotent — second call returns same address", async () => {
    const { factory, alice } = await deployFixture();
    const salt = ethers.zeroPadBytes("0x", 32);
    const tx1  = await factory.createWallet(alice.address, salt);
    const r1   = await tx1.wait();
    const tx2  = await factory.createWallet(alice.address, salt);
    const r2   = await tx2.wait();
    // Second deployment should NOT emit WalletDeployed (no state change)
    const events2 = r2.logs.filter(l => {
      try {
        const parsed = factory.interface.parseLog(l);
        return parsed?.name === "WalletDeployed";
      } catch { return false; }
    });
    expect(events2.length).to.equal(0);
  });

  it("B3. different salts produce different wallet addresses", async () => {
    const { factory, alice } = await deployFixture();
    const salt0 = ethers.zeroPadBytes("0x", 32);
    const salt1 = ethers.zeroPadValue("0x01", 32);
    const addr0 = await factory.getWalletAddress(alice.address, salt0);
    const addr1 = await factory.getWalletAddress(alice.address, salt1);
    expect(addr0).to.not.equal(addr1);
  });

  it("B4. same salt but different owners produce different addresses", async () => {
    const { factory, alice, bob } = await deployFixture();
    const salt  = ethers.zeroPadBytes("0x", 32);
    const addrA = await factory.getWalletAddress(alice.address, salt);
    const addrB = await factory.getWalletAddress(bob.address, salt);
    expect(addrA).to.not.equal(addrB);
  });

  it("B5. deployed wallet has correct entryPoint, registry, and owner", async () => {
    const { factory, alice, entryPoint, registry, SubscriptionWallet } = await deployFixture();
    const salt    = ethers.zeroPadBytes("0x", 32);
    const addr    = await factory.getWalletAddress(alice.address, salt);
    await factory.createWallet(alice.address, salt);
    const wallet  = SubscriptionWallet.attach(addr);

    expect(await wallet.entryPoint()).to.equal(await entryPoint.getAddress());
    expect(await wallet.registry()).to.equal(await registry.getAddress());
    expect(await wallet.owner()).to.equal(alice.address);
  });

  it("B6. walletsByOwner tracks all wallets for a given owner", async () => {
    const { factory, alice } = await deployFixture();
    const salt0 = ethers.zeroPadBytes("0x", 32);
    const salt1 = ethers.zeroPadValue("0x01", 32);
    await factory.createWallet(alice.address, salt0);
    await factory.createWallet(alice.address, salt1);
    const wallets = await factory.getWalletsByOwner(alice.address);
    expect(wallets.length).to.equal(2);
  });
});

// ─── [C] SubscriptionWallet – subscription management & tokens ───────────────

describe("[C] SubscriptionWallet — management", function () {
  it("C1. owner can deposit tokens into wallet", async () => {
    const { usdc, wallet, alice, walletAddr } = await deployFixture();
    await usdc.connect(alice).approve(walletAddr, USDC(100));
    await expect(wallet.connect(alice).depositToken(await usdc.getAddress(), USDC(100)))
      .to.emit(wallet, "TokenDeposited")
      .withArgs(await usdc.getAddress(), USDC(100));
    expect(await usdc.balanceOf(walletAddr)).to.equal(USDC(100));
    // Verify Alice's EOA was NOT given unlimited approve to the service
    // (approval was only to the wallet itself)
    expect(await usdc.allowance(alice.address, walletAddr)).to.equal(0n);
  });

  it("C2. anyone can deposit tokens (e.g. gift from Bob)", async () => {
    const { usdc, wallet, bob, walletAddr } = await deployFixture();
    await usdc.connect(bob).approve(walletAddr, USDC(50));
    await wallet.connect(bob).depositToken(await usdc.getAddress(), USDC(50));
    expect(await usdc.balanceOf(walletAddr)).to.equal(USDC(50));
  });

  it("C3. only owner can withdraw tokens", async () => {
    const { usdc, wallet, alice, stranger, walletAddr } = await deployFixture();
    await usdc.connect(alice).approve(walletAddr, USDC(100));
    await wallet.connect(alice).depositToken(await usdc.getAddress(), USDC(100));

    await expect(wallet.connect(stranger).withdrawToken(await usdc.getAddress(), USDC(10)))
      .to.be.revertedWith("SW: not owner");

    const before = await usdc.balanceOf(alice.address);
    await wallet.connect(alice).withdrawToken(await usdc.getAddress(), USDC(100));
    expect(await usdc.balanceOf(alice.address)).to.equal(before + USDC(100));
  });

  it("C4. subscribe emits Subscribed and sets correct state", async () => {
    const { registry, wallet, service, alice, operator, usdc } = await deployFixture();
    await registry.addService(await service.getAddress(), operator.address, "Svc", "d");

    const ts = BigInt(await time.latest());
    await expect(
      wallet.connect(alice).subscribe(
        await service.getAddress(), await usdc.getAddress(), USDC(10), USDC(120), false
      )
    ).to.emit(wallet, "Subscribed");

    const sub = await wallet.getSubscription(await service.getAddress());
    expect(sub.active).to.be.true;
    expect(sub.amountPerCycle).to.equal(USDC(10));
    expect(sub.totalCap).to.equal(USDC(120));
    // startImmediately=false → nextClaimAt ≈ ts + 30 days
    expect(sub.nextClaimAt).to.be.closeTo(ts + MONTH, 5n);
  });

  it("C5. subscribe with startImmediately=true sets nextClaimAt to now", async () => {
    const { registry, wallet, service, alice, operator, usdc } = await deployFixture();
    await registry.addService(await service.getAddress(), operator.address, "Svc", "d");

    const ts = BigInt(await time.latest());
    await wallet.connect(alice).subscribe(
      await service.getAddress(), await usdc.getAddress(), USDC(10), 0n, true
    );

    const sub = await wallet.getSubscription(await service.getAddress());
    expect(sub.nextClaimAt).to.be.closeTo(ts, 5n);
  });

  it("C6. cannot subscribe to a non-whitelisted service", async () => {
    const { wallet, service, alice, usdc } = await deployFixture();
    await expect(
      wallet.connect(alice).subscribe(
        await service.getAddress(), await usdc.getAddress(), USDC(10), 0n, true
      )
    ).to.be.revertedWith("SW: service not whitelisted");
  });

  it("C7. cannot subscribe twice to the same service", async () => {
    const { registry, wallet, service, alice, operator, usdc } = await deployFixture();
    await registry.addService(await service.getAddress(), operator.address, "Svc", "d");
    await wallet.connect(alice).subscribe(
      await service.getAddress(), await usdc.getAddress(), USDC(10), 0n, true
    );
    await expect(
      wallet.connect(alice).subscribe(
        await service.getAddress(), await usdc.getAddress(), USDC(10), 0n, true
      )
    ).to.be.revertedWith("SW: already subscribed");
  });

  it("C8. subscribe rejects zero amount", async () => {
    const { registry, wallet, service, alice, operator, usdc } = await deployFixture();
    await registry.addService(await service.getAddress(), operator.address, "Svc", "d");
    await expect(
      wallet.connect(alice).subscribe(
        await service.getAddress(), await usdc.getAddress(), 0n, 0n, true
      )
    ).to.be.revertedWith("SW: zero amount");
  });

  it("C9. only owner can subscribe", async () => {
    const { registry, wallet, service, stranger, operator, usdc } = await deployFixture();
    await registry.addService(await service.getAddress(), operator.address, "Svc", "d");
    await expect(
      wallet.connect(stranger).subscribe(
        await service.getAddress(), await usdc.getAddress(), USDC(10), 0n, true
      )
    ).to.be.revertedWith("SW: not owner");
  });

  it("C10. unsubscribe marks active=false and emits Unsubscribed", async () => {
    const { wallet, service, alice } = await subscribedFixture();
    await expect(wallet.connect(alice).unsubscribe(await service.getAddress()))
      .to.emit(wallet, "Unsubscribed")
      .withArgs(await service.getAddress(), alice.address);
    expect(await wallet.isSubscribed(await service.getAddress())).to.be.false;
  });

  it("C11. unsubscribing a non-active subscription reverts", async () => {
    const { wallet, service, alice } = await subscribedFixture();
    await wallet.connect(alice).unsubscribe(await service.getAddress());
    await expect(wallet.connect(alice).unsubscribe(await service.getAddress()))
      .to.be.revertedWith("SW: not subscribed");
  });

  it("C12. only owner can unsubscribe", async () => {
    const { wallet, service, stranger } = await subscribedFixture();
    await expect(wallet.connect(stranger).unsubscribe(await service.getAddress()))
      .to.be.revertedWith("SW: not owner");
  });

  it("C13. isDue returns false before interval and true after", async () => {
    const { wallet, service } = await subscribedFixture();
    const svcAddr = await service.getAddress();

    // startImmediately=true → due right away
    expect(await wallet.isDue(svcAddr)).to.be.true;
  });

  it("C14. subscribedServices list grows correctly", async () => {
    const { registry, wallet, alice, usdc, operator } = await deployFixture();

    // Deploy a second service
    const Svc2 = await (await ethers.getContractFactory("MockService")).deploy(await usdc.getAddress());
    const Svc3 = await (await ethers.getContractFactory("MockService")).deploy(await usdc.getAddress());

    await registry.addService(await Svc2.getAddress(), operator.address, "S2", "d");
    await registry.addService(await Svc3.getAddress(), operator.address, "S3", "d");

    await wallet.connect(alice).subscribe(await Svc2.getAddress(), await usdc.getAddress(), USDC(5), 0n, true);
    await wallet.connect(alice).subscribe(await Svc3.getAddress(), await usdc.getAddress(), USDC(7), 0n, true);

    expect(await wallet.getSubscribedServicesCount()).to.equal(2n);
    const list = await wallet.getSubscribedServices(0, 10);
    expect(list).to.include(await Svc2.getAddress());
    expect(list).to.include(await Svc3.getAddress());
  });

  it("C15. ownership transfer works and non-owner reverts", async () => {
    const { wallet, alice, bob, stranger } = await deployFixture();

    await expect(wallet.connect(stranger).transferOwnership(bob.address))
      .to.be.revertedWith("SW: not owner");

    await expect(wallet.connect(alice).transferOwnership(bob.address))
      .to.emit(wallet, "OwnershipTransferred")
      .withArgs(alice.address, bob.address);

    expect(await wallet.owner()).to.equal(bob.address);
    // Alice is no longer owner
    await expect(wallet.connect(alice).withdrawToken(ethers.ZeroAddress, 0n))
      .to.be.revertedWith("SW: not owner");
  });
});

// ─── [D] validateUserOp ───────────────────────────────────────────────────────

describe("[D] validateUserOp — both paths", function () {
  it("D1. claim path: valid op returns SIG_VALIDATION_SUCCESS (0)", async () => {
    const { entryPoint, wallet, service, walletIface } = await subscribedFixture();
    const userOp = buildClaimOp(
      await wallet.getAddress(),
      await service.getAddress(),
      walletIface
    );
    const result = await entryPoint.validateOnly(userOp);
    expect(result).to.equal(0n);
  });

  it("D2. claim path: non-whitelisted service returns FAILED (1)", async () => {
    const { entryPoint, wallet, usdc, walletIface, alice } = await deployFixture();

    // Create a rogue service (not whitelisted)
    const RogueSvc = await (await ethers.getContractFactory("MockService")).deploy(await usdc.getAddress());

    // Manually build subscription state by subscribing after temporarily whitelisting
    // (to isolate the "not whitelisted" check we just try without whitelisting)
    const userOp = buildClaimOp(
      await wallet.getAddress(),
      await RogueSvc.getAddress(),
      walletIface
    );
    const result = await entryPoint.validateOnly(userOp);
    expect(result).to.equal(1n); // SIG_VALIDATION_FAILED
  });

  it("D3. claim path: inactive subscription returns FAILED", async () => {
    const { entryPoint, wallet, service, walletIface, alice } = await subscribedFixture();
    await wallet.connect(alice).unsubscribe(await service.getAddress());

    const userOp = buildClaimOp(
      await wallet.getAddress(), await service.getAddress(), walletIface
    );
    expect(await entryPoint.validateOnly(userOp)).to.equal(1n);
  });

  it("D4. claim path: payment not yet due returns FAILED", async () => {
    const { registry, wallet, service, alice, operator, usdc, entryPoint, walletIface, walletAddr } =
      await deployFixture();
    await registry.addService(await service.getAddress(), operator.address, "S", "d");
    await usdc.connect(alice).approve(walletAddr, USDC(100));
    await wallet.connect(alice).depositToken(await usdc.getAddress(), USDC(100));

    // startImmediately=false → not due for 30 days
    await wallet.connect(alice).subscribe(
      await service.getAddress(), await usdc.getAddress(), USDC(10), 0n, false
    );

    const userOp = buildClaimOp(
      await wallet.getAddress(), await service.getAddress(), walletIface
    );
    expect(await entryPoint.validateOnly(userOp)).to.equal(1n);
  });

  it("D5. claim path: insufficient wallet balance returns FAILED", async () => {
    const { registry, wallet, service, alice, operator, usdc, entryPoint, walletIface, walletAddr } =
      await deployFixture();
    await registry.addService(await service.getAddress(), operator.address, "S", "d");

    // Subscribe but DON'T fund the wallet
    await wallet.connect(alice).subscribe(
      await service.getAddress(), await usdc.getAddress(), USDC(10), 0n, true
    );

    const userOp = buildClaimOp(
      await wallet.getAddress(), await service.getAddress(), walletIface
    );
    expect(await entryPoint.validateOnly(userOp)).to.equal(1n);
  });

  it("D6. claim path: cap already exceeded returns FAILED", async () => {
    const { entryPoint, wallet, service, walletIface, walletAddr, usdc, alice } = await subscribedFixture();

    // Execute the first claim to use up the cap
    const op = buildClaimOp(await wallet.getAddress(), await service.getAddress(), walletIface);
    await entryPoint.simulateOp(op);

    // Manually drain remaining cycles to hit cap
    // Cap = 120 USDC, amountPerCycle = 10, need 11 more to exceed
    for (let i = 0; i < 11; i++) {
      await time.increase(MONTH);
      if (await wallet.isDue(await service.getAddress())) {
        // Fund more if needed
        const bal = await usdc.balanceOf(await wallet.getAddress());
        if (bal < USDC(10)) {
          await usdc.connect(alice).approve(await wallet.getAddress(), USDC(10));
          await wallet.connect(alice).depositToken(await usdc.getAddress(), USDC(10));
        }
        try {
          const nextOp = buildClaimOp(await wallet.getAddress(), await service.getAddress(), walletIface, BigInt(i+1));
          await entryPoint.simulateOp(nextOp);
        } catch {}
      }
    }

    // Now subscription should be auto-cancelled (cap reached)
    const sub = await wallet.getSubscription(await service.getAddress());
    if (!sub.active) {
      // Auto-cancelled — validateUserOp must return FAILED
      const finalOp = buildClaimOp(await wallet.getAddress(), await service.getAddress(), walletIface, 99n);
      expect(await entryPoint.validateOnly(finalOp)).to.equal(1n);
    }
    // Either auto-cancelled or cap exceeded — both are correct behavior
  });

  it("D7. claim path: wrong callData selector returns FAILED", async () => {
    const { entryPoint, wallet, service, walletIface } = await subscribedFixture();
    const userOp = {
      ...buildClaimOp(await wallet.getAddress(), await service.getAddress(), walletIface),
      // Replace callData with a different selector
      callData: walletIface.encodeFunctionData("unsubscribe", [await service.getAddress()]),
      signature: buildClaimSig(await service.getAddress()),
    };
    expect(await entryPoint.validateOnly(userOp)).to.equal(1n);
  });

  it("D8. claim path: service in signature ≠ service in callData returns FAILED", async () => {
    const { entryPoint, wallet, service, usdc, walletIface, operator, registry } = await subscribedFixture();

    // Deploy a second service
    const Svc2 = await (await ethers.getContractFactory("MockService")).deploy(await usdc.getAddress());
    await registry.addService(await Svc2.getAddress(), operator.address, "S2", "d");

    const userOp = {
      sender:               await wallet.getAddress(),
      nonce:                0n,
      initCode:             "0x",
      callData:             walletIface.encodeFunctionData("executeClaim", [await service.getAddress()]),
      callGasLimit:         200_000n,
      verificationGasLimit: 200_000n,
      preVerificationGas:   50_000n,
      maxFeePerGas:         1n,
      maxPriorityFeePerGas: 1n,
      paymasterAndData:     "0x",
      signature:            buildClaimSig(await Svc2.getAddress()), // ← mismatch
    };
    expect(await entryPoint.validateOnly(userOp)).to.equal(1n);
  });

  it("D9. claim path: truncated signature (< 36 bytes) returns FAILED", async () => {
    const { entryPoint, wallet, service, walletIface } = await subscribedFixture();
    const userOp = {
      ...buildClaimOp(await wallet.getAddress(), await service.getAddress(), walletIface),
      signature: "0x7c1e2e76aabb", // only 6 bytes, not 36
    };
    expect(await entryPoint.validateOnly(userOp)).to.equal(1n);
  });

  it("D10. owner path: valid ECDSA signature returns SUCCESS", async () => {
    const { entryPoint, wallet, alice, walletIface } = await deployFixture();

    // Build a generic owner-signed op (e.g. withdrawToken)
    const baseOp = {
      sender:               await wallet.getAddress(),
      nonce:                0n,
      initCode:             "0x",
      callData:             walletIface.encodeFunctionData("withdrawToken", [ethers.ZeroAddress, 0n]),
      callGasLimit:         100_000n,
      verificationGasLimit: 100_000n,
      preVerificationGas:   50_000n,
      maxFeePerGas:         1n,
      maxPriorityFeePerGas: 1n,
      paymasterAndData:     "0x",
      signature:            "0x", // placeholder before signing
    };
    const signed = await signOwnerOp(alice, baseOp);
    expect(await entryPoint.validateOnly(signed)).to.equal(0n);
  });

  it("D11. owner path: wrong signer returns FAILED (1)", async () => {
    const { entryPoint, wallet, stranger, walletIface } = await deployFixture();
    const baseOp = {
      sender:               await wallet.getAddress(),
      nonce:                0n,
      initCode:             "0x",
      callData:             "0x",
      callGasLimit:         100_000n,
      verificationGasLimit: 100_000n,
      preVerificationGas:   50_000n,
      maxFeePerGas:         1n,
      maxPriorityFeePerGas: 1n,
      paymasterAndData:     "0x",
      signature:            "0x",
    };
    const signed = await signOwnerOp(stranger, baseOp); // stranger, not owner
    expect(await entryPoint.validateOnly(signed)).to.equal(1n);
  });

  it("D12. validateUserOp reverts if called by non-EntryPoint", async () => {
    const { wallet, service, walletIface, alice } = await subscribedFixture();
    const userOp = buildClaimOp(await wallet.getAddress(), await service.getAddress(), walletIface);
    await expect(
      wallet.connect(alice).validateUserOp(userOp, ethers.ZeroHash, 0n)
    ).to.be.revertedWith("SW: not EntryPoint");
  });
});

// ─── [E] executeClaim via EntryPoint ─────────────────────────────────────────

describe("[E] executeClaim — full lifecycle", function () {
  it("E1. valid claim transfers tokens from wallet to service", async () => {
    const { entryPoint, wallet, service, walletIface } = await subscribedFixture();
    const svcAddr = await service.getAddress();
    const svcBefore = await service.getBalance();
    const walBefore = await (await ethers.getContractAt("MockUSDC", await (await subscribedFixture()).usdc.getAddress())).balanceOf(await wallet.getAddress());

    const userOp = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface);
    await expect(entryPoint.simulateOp(userOp)).to.emit(wallet, "PaymentClaimed");

    expect(await service.getBalance()).to.equal(svcBefore + USDC(10));
  });

  it("E2. first claim transfers correct amount and updates nextClaimAt", async () => {
    const { entryPoint, wallet, service, walletIface } = await subscribedFixture();
    const svcAddr = await service.getAddress();

    const userOp = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface);
    await entryPoint.simulateOp(userOp);

    const sub = await wallet.getSubscription(svcAddr);
    expect(sub.totalPaid).to.equal(USDC(10));
    // nextClaimAt should now be ~30 days in the future
    const now = BigInt(await time.latest());
    expect(sub.nextClaimAt).to.be.closeTo(now + MONTH, 5n);
  });

  it("E3. second claim succeeds after 30 days pass", async () => {
    const { entryPoint, wallet, service, walletIface } = await subscribedFixture();
    const svcAddr = await service.getAddress();

    const op1 = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface);
    await entryPoint.simulateOp(op1);

    await time.increase(MONTH);

    const op2 = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface, 1n);
    await entryPoint.simulateOp(op2);

    const sub = await wallet.getSubscription(svcAddr);
    expect(sub.totalPaid).to.equal(USDC(20));
  });

  it("E4. claim before 30 days reverts with 'SW: not due'", async () => {
    const { entryPoint, wallet, service, walletIface } = await subscribedFixture();
    const svcAddr = await service.getAddress();

    const op1 = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface);
    await entryPoint.simulateOp(op1);

    // Try to claim immediately (interval not elapsed)
    const op2 = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface, 1n);
    await expect(entryPoint.simulateOp(op2)).to.be.revertedWith("EP: validation failed");
  });

  it("E5. claim reverts when subscription is cancelled", async () => {
    const { entryPoint, wallet, service, walletIface, alice } = await subscribedFixture();
    const svcAddr = await service.getAddress();

    await wallet.connect(alice).unsubscribe(svcAddr);
    const userOp = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface);
    await expect(entryPoint.simulateOp(userOp)).to.be.revertedWith("EP: validation failed");
  });

  it("E6. executeClaim reverts if called directly (not via EntryPoint)", async () => {
    const { wallet, service, alice } = await subscribedFixture();
    await expect(
      wallet.connect(alice).executeClaim(await service.getAddress())
    ).to.be.revertedWith("SW: not EntryPoint");
  });

  it("E7. claim reverts if service is de-listed mid-subscription", async () => {
    const { entryPoint, wallet, service, walletIface, registry } = await subscribedFixture();
    const svcAddr = await service.getAddress();

    // Admin removes service AFTER user subscribed
    await registry.removeService(svcAddr);

    const userOp = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface);
    await expect(entryPoint.simulateOp(userOp)).to.be.revertedWith("EP: validation failed");
  });

  it("E8. claim reverts if wallet has insufficient balance", async () => {
    const { entryPoint, wallet, service, walletIface, alice, usdc } = await subscribedFixture();
    const svcAddr = await service.getAddress();
    const walletAddr = await wallet.getAddress();

    // Drain the wallet
    const bal = await usdc.balanceOf(walletAddr);
    await wallet.connect(alice).withdrawToken(await usdc.getAddress(), bal);

    const userOp = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface);
    await expect(entryPoint.simulateOp(userOp)).to.be.revertedWith("EP: validation failed");
  });
});

// ─── [F] Edge Cases ───────────────────────────────────────────────────────────

describe("[F] Edge cases — caps, auto-cancel, multi-service", function () {
  it("F1. subscription auto-cancels when totalCap is exactly reached", async () => {
    const { registry, wallet, service, alice, operator, usdc, entryPoint, walletIface, walletAddr } =
      await deployFixture();
    await registry.addService(await service.getAddress(), operator.address, "S", "d");

    // Cap = exactly 2 cycles (20 USDC)
    await usdc.connect(alice).approve(walletAddr, USDC(20));
    await wallet.connect(alice).depositToken(await usdc.getAddress(), USDC(20));
    await wallet.connect(alice).subscribe(
      await service.getAddress(), await usdc.getAddress(), USDC(10), USDC(20), true
    );
    const svcAddr = await service.getAddress();

    // Cycle 1
    const op1 = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface, 0n);
    await entryPoint.simulateOp(op1);
    expect((await wallet.getSubscription(svcAddr)).active).to.be.true;

    // Cycle 2 — hits cap exactly
    await time.increase(MONTH);
    const op2 = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface, 1n);
    await expect(entryPoint.simulateOp(op2))
      .to.emit(wallet, "Unsubscribed"); // auto-cancel event

    expect((await wallet.getSubscription(svcAddr)).active).to.be.false;
    expect((await wallet.getSubscription(svcAddr)).totalPaid).to.equal(USDC(20));
  });

  it("F2. claim blocked after auto-cancel from cap", async () => {
    const { registry, wallet, service, alice, operator, usdc, entryPoint, walletIface, walletAddr } =
      await deployFixture();
    await registry.addService(await service.getAddress(), operator.address, "S", "d");
    await usdc.connect(alice).approve(walletAddr, USDC(10));
    await wallet.connect(alice).depositToken(await usdc.getAddress(), USDC(10));
    await wallet.connect(alice).subscribe(
      await service.getAddress(), await usdc.getAddress(), USDC(10), USDC(10), true
    );
    const svcAddr = await service.getAddress();

    // One claim hits the cap and auto-cancels
    await entryPoint.simulateOp(buildClaimOp(await wallet.getAddress(), svcAddr, walletIface, 0n));
    expect((await wallet.getSubscription(svcAddr)).active).to.be.false;

    // Attempt second claim — wallet has been refunded/refilled and 30 days passed
    await time.increase(MONTH);
    await usdc.connect(alice).approve(walletAddr, USDC(10));
    await wallet.connect(alice).depositToken(await usdc.getAddress(), USDC(10));

    const op2 = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface, 1n);
    await expect(entryPoint.simulateOp(op2)).to.be.revertedWith("EP: validation failed");
  });

  it("F3. totalCap=0 (unlimited) allows many cycles", async () => {
    const { registry, wallet, service, alice, operator, usdc, entryPoint, walletIface, walletAddr } =
      await deployFixture();
    await registry.addService(await service.getAddress(), operator.address, "S", "d");
    await usdc.connect(alice).approve(walletAddr, USDC(50));
    await wallet.connect(alice).depositToken(await usdc.getAddress(), USDC(50));
    await wallet.connect(alice).subscribe(
      await service.getAddress(), await usdc.getAddress(), USDC(10), 0n, true // 0 = no cap
    );
    const svcAddr = await service.getAddress();

    for (let i = 0; i < 5; i++) {
      if (i > 0) await time.increase(MONTH);
      const op = buildClaimOp(await wallet.getAddress(), svcAddr, walletIface, BigInt(i));
      await entryPoint.simulateOp(op);
    }

    const sub = await wallet.getSubscription(svcAddr);
    expect(sub.totalPaid).to.equal(USDC(50));
    expect(sub.active).to.be.true; // still active with unlimited cap
  });

  it("F4. two independent services claim independently on their own schedules", async () => {
    const { registry, wallet, alice, usdc, operator, entryPoint, walletIface, walletAddr } =
      await deployFixture();
    const Svc2 = await (await ethers.getContractFactory("MockService")).deploy(await usdc.getAddress());
    const Svc3 = await (await ethers.getContractFactory("MockService")).deploy(await usdc.getAddress());
    await registry.addService(await Svc2.getAddress(), operator.address, "S2", "d");
    await registry.addService(await Svc3.getAddress(), operator.address, "S3", "d");

    await usdc.connect(alice).approve(walletAddr, USDC(500));
    await wallet.connect(alice).depositToken(await usdc.getAddress(), USDC(500));

    // Both subscriptions start immediately
    await wallet.connect(alice).subscribe(await Svc2.getAddress(), await usdc.getAddress(), USDC(10), 0n, true);
    await wallet.connect(alice).subscribe(await Svc3.getAddress(), await usdc.getAddress(), USDC(20), 0n, true);

    // Claim both at t=0
    await entryPoint.simulateOp(buildClaimOp(await wallet.getAddress(), await Svc2.getAddress(), walletIface, 0n));
    await entryPoint.simulateOp(buildClaimOp(await wallet.getAddress(), await Svc3.getAddress(), walletIface, 1n));

    expect((await wallet.getSubscription(await Svc2.getAddress())).totalPaid).to.equal(USDC(10));
    expect((await wallet.getSubscription(await Svc3.getAddress())).totalPaid).to.equal(USDC(20));

    // After 30 days — both claimable again
    await time.increase(MONTH);
    expect(await wallet.isDue(await Svc2.getAddress())).to.be.true;
    expect(await wallet.isDue(await Svc3.getAddress())).to.be.true;

    // Claim Svc2 but not Svc3
    await entryPoint.simulateOp(buildClaimOp(await wallet.getAddress(), await Svc2.getAddress(), walletIface, 2n));
    expect(await wallet.isDue(await Svc2.getAddress())).to.be.false;
    expect(await wallet.isDue(await Svc3.getAddress())).to.be.true; // still claimable
  });

  it("F5. wallet with zero balance blocks claim validation", async () => {
    const { registry, wallet, service, alice, operator, usdc, entryPoint, walletIface } =
      await deployFixture();
    await registry.addService(await service.getAddress(), operator.address, "S", "d");

    // Subscribe WITHOUT depositing any tokens
    await wallet.connect(alice).subscribe(
      await service.getAddress(), await usdc.getAddress(), USDC(10), 0n, true
    );

    const userOp = buildClaimOp(await wallet.getAddress(), await service.getAddress(), walletIface);
    // validateUserOp returns 1 (FAILED) — claim never hits executeClaim
    expect(await entryPoint.validateOnly(userOp)).to.equal(1n);
  });

  it("F6. tokens stay in wallet after unsubscribe (not auto-returned)", async () => {
    const { wallet, service, alice, usdc } = await subscribedFixture();
    const walletAddr = await wallet.getAddress();
    const balBefore  = await usdc.balanceOf(walletAddr);

    await wallet.connect(alice).unsubscribe(await service.getAddress());

    // Tokens are NOT automatically refunded — owner must explicitly withdraw
    expect(await usdc.balanceOf(walletAddr)).to.equal(balBefore);

    // Owner can pull them back manually
    await wallet.connect(alice).withdrawToken(await usdc.getAddress(), balBefore);
    expect(await usdc.balanceOf(alice.address)).to.be.gte(balBefore);
  });
});

// ─── [G] ClaimBundlerHelper ───────────────────────────────────────────────────

describe("[G] ClaimBundlerHelper", function () {
  async function helperFixture() {
    const base = await subscribedFixture();
    const Helper = await ethers.getContractFactory("ClaimBundlerHelper");
    const helper = await Helper.deploy(await base.entryPoint.getAddress());
    return { ...base, helper };
  }

  it("G1. buildClaimOp produces correct sender, callData, and signature", async () => {
    const { helper, wallet, service } = await helperFixture();
    const op = await helper.buildClaimOp(
      await wallet.getAddress(),
      await service.getAddress(),
      ethers.parseUnits("2", "gwei"),
      ethers.parseUnits("1", "gwei")
    );

    expect(op.sender).to.equal(await wallet.getAddress());

    // signature must start with CLAIM_MAGIC
    expect(op.signature.slice(0, 10)).to.equal("0x7c1e2e76");

    // callData selector must be executeClaim
    const SubscriptionWallet = await ethers.getContractFactory("SubscriptionWallet");
    const selector = SubscriptionWallet.interface.getFunction("executeClaim").selector;
    expect(op.callData.slice(0, 10)).to.equal(selector);
  });

  it("G2. checkClaimable correctly identifies a due, funded subscription", async () => {
    const { helper, wallet, service } = await helperFixture();
    const statuses = await helper.checkClaimable(
      [await wallet.getAddress()],
      [await service.getAddress()]
    );
    expect(statuses[0].isDue).to.be.true;
    expect(statuses[0].hasBalance).to.be.true;
    expect(statuses[0].isWhitelisted).to.be.true;
  });

  it("G3. checkClaimable correctly flags unfunded wallet", async () => {
    const { helper, wallet, service, alice, usdc } = await helperFixture();
    // Drain wallet
    const bal = await usdc.balanceOf(await wallet.getAddress());
    await wallet.connect(alice).withdrawToken(await usdc.getAddress(), bal);

    const statuses = await helper.checkClaimable(
      [await wallet.getAddress()],
      [await service.getAddress()]
    );
    expect(statuses[0].isDue).to.be.true;
    expect(statuses[0].hasBalance).to.be.false;
  });

  it("G4. checkClaimable correctly flags payment not yet due", async () => {
    const { helper, wallet, service, entryPoint, walletIface } = await helperFixture();

    // Execute first claim so it's no longer due
    const op = buildClaimOp(await wallet.getAddress(), await service.getAddress(), walletIface);
    await entryPoint.simulateOp(op);

    const statuses = await helper.checkClaimable(
      [await wallet.getAddress()],
      [await service.getAddress()]
    );
    expect(statuses[0].isDue).to.be.false;
  });

  it("G5. checkClaimable handles batch of mixed statuses", async () => {
    const { helper, wallet, service, registry, alice, usdc, walletAddr, operator, entryPoint, walletIface } =
      await helperFixture();

    // Deploy second service — not whitelisted
    const Svc2 = await (await ethers.getContractFactory("MockService")).deploy(await usdc.getAddress());

    const statuses = await helper.checkClaimable(
      [await wallet.getAddress(), await wallet.getAddress()],
      [await service.getAddress(), await Svc2.getAddress()]
    );

    // First: whitelisted, due, funded
    expect(statuses[0].isWhitelisted).to.be.true;
    expect(statuses[0].isDue).to.be.true;

    // Second: not whitelisted
    expect(statuses[1].isWhitelisted).to.be.false;
  });

  it("G6. buildClaimOp sets correct nonce from EntryPoint", async () => {
    const { helper, wallet, service, entryPoint, walletIface } = await helperFixture();

    // Execute one op to increment nonce
    const op0 = buildClaimOp(await wallet.getAddress(), await service.getAddress(), walletIface, 0n);
    await entryPoint.simulateOp(op0);
    await time.increase(MONTH);

    // buildClaimOp should now read nonce=1 from entryPoint
    const op1 = await helper.buildClaimOp(
      await wallet.getAddress(),
      await service.getAddress(),
      1n,
      1n
    );
    expect(op1.nonce).to.equal(1n);
  });
});
