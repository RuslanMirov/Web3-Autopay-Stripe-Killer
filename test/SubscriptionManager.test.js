"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const DAY  = 86_400n;
const MONTH = DAY * 30n;

describe("SubscriptionManager – ERC-4337 Recurring Payments", function () {
  let usdc, mgr;
  let owner, bundler, payer, merchant, sessionKey, stranger;

  beforeEach(async () => {
    [owner, bundler, payer, merchant, sessionKey, stranger] = await ethers.getSigners();
    const USDC_ = await ethers.getContractFactory("MockUSDC");
    usdc = await USDC_.deploy();
    await usdc.mint(payer.address, USDC(10_000));
    const MGR = await ethers.getContractFactory("SubscriptionManager");
    mgr = await MGR.deploy();
    await mgr.setBundler(bundler.address, true);
    await usdc.connect(payer).approve(await mgr.getAddress(), ethers.MaxUint256);
  });

  it("1. creates a subscription and emits SubscriptionCreated", async () => {
    const tx = await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, USDC(120), ethers.ZeroAddress
    );
    await expect(tx).to.emit(mgr, "SubscriptionCreated")
      .withArgs(0n, payer.address, merchant.address, await usdc.getAddress(), USDC(10), MONTH, USDC(120));
    const sub = await mgr.getSubscription(0);
    expect(sub.payer).to.equal(payer.address);
    expect(sub.active).to.be.true;
  });

  it("2. reverts subscription creation with zero amount", async () => {
    await expect(
      mgr.connect(payer).createSubscription(merchant.address, await usdc.getAddress(), 0, MONTH, 0, ethers.ZeroAddress)
    ).to.be.revertedWith("Zero amount");
  });

  it("3. bundler executes first payment immediately", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, 0, ethers.ZeroAddress
    );
    const before = await usdc.balanceOf(merchant.address);
    await expect(mgr.connect(bundler).executePayment(0)).to.emit(mgr, "PaymentExecuted");
    expect(await usdc.balanceOf(merchant.address)).to.equal(before + USDC(10));
  });

  it("4. reverts when payment called before next due date", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, 0, ethers.ZeroAddress
    );
    await mgr.connect(bundler).executePayment(0);
    await expect(mgr.connect(bundler).executePayment(0)).to.be.revertedWith("Payment not due yet");
  });

  it("5. executes second payment after interval elapsed", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, 0, ethers.ZeroAddress
    );
    await mgr.connect(bundler).executePayment(0);
    await time.increase(MONTH);
    await expect(mgr.connect(bundler).executePayment(0)).to.emit(mgr, "PaymentExecuted");
    const sub = await mgr.getSubscription(0);
    expect(sub.totalSpent).to.equal(USDC(20));
    expect(await mgr.cycleCount(0)).to.equal(2n);
  });

  it("6. blocks execution once total cap is reached", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, USDC(15), ethers.ZeroAddress
    );
    await mgr.connect(bundler).executePayment(0);
    await time.increase(MONTH);
    await expect(mgr.connect(bundler).executePayment(0)).to.be.revertedWith("Total cap exceeded");
  });

  it("7. payer can cancel their own subscription", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, 0, ethers.ZeroAddress
    );
    await expect(mgr.connect(payer).cancelSubscription(0))
      .to.emit(mgr, "SubscriptionCancelled").withArgs(0n, payer.address);
    expect((await mgr.getSubscription(0)).active).to.be.false;
  });

  it("8. bundler cannot execute on a cancelled subscription", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, 0, ethers.ZeroAddress
    );
    await mgr.connect(payer).cancelSubscription(0);
    await expect(mgr.connect(bundler).executePayment(0)).to.be.revertedWith("Subscription inactive");
  });

  it("9. session key can execute a payment", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, 0, sessionKey.address
    );
    await expect(mgr.connect(sessionKey).executePayment(0)).to.emit(mgr, "PaymentExecuted");
  });

  it("10. payer can update the session key", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, 0, ethers.ZeroAddress
    );
    await expect(mgr.connect(payer).setSessionKey(0, sessionKey.address))
      .to.emit(mgr, "SessionKeyUpdated").withArgs(0n, sessionKey.address);
    expect((await mgr.getSubscription(0)).sessionKey).to.equal(sessionKey.address);
  });

  it("11. stranger cannot execute payment", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, 0, ethers.ZeroAddress
    );
    await expect(mgr.connect(stranger).executePayment(0)).to.be.revertedWith("Not authorized executor");
  });

  it("12. merchant can refund a specific payment cycle", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, 0, ethers.ZeroAddress
    );
    await mgr.connect(bundler).executePayment(0);
    await usdc.connect(merchant).approve(await mgr.getAddress(), USDC(10));
    const payerBefore = await usdc.balanceOf(payer.address);
    await expect(mgr.connect(merchant).refundPayment(0, 1))
      .to.emit(mgr, "PaymentRefunded").withArgs(0n, 1n, USDC(10));
    expect(await usdc.balanceOf(payer.address)).to.equal(payerBefore + USDC(10));
    expect((await mgr.getSubscription(0)).totalSpent).to.equal(0n);
  });

  it("13. cannot refund the same cycle twice", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, 0, ethers.ZeroAddress
    );
    await mgr.connect(bundler).executePayment(0);
    await usdc.connect(merchant).approve(await mgr.getAddress(), USDC(20));
    await mgr.connect(merchant).refundPayment(0, 1);
    await expect(mgr.connect(merchant).refundPayment(0, 1)).to.be.revertedWith("Already refunded");
  });

  it("14. paymaster deposits ETH and bundler deducts gas cost", async () => {
    const deposit = ethers.parseEther("0.1");
    const gas    = ethers.parseEther("0.001");
    await mgr.paymasterDeposit_(payer.address, { value: deposit });
    expect(await mgr.paymasterDeposit(payer.address)).to.equal(deposit);
    await mgr.connect(bundler).deductGas(payer.address, gas);
    expect(await mgr.paymasterDeposit(payer.address)).to.equal(deposit - gas);
  });

  it("15. payer can withdraw unused paymaster ETH", async () => {
    const deposit = ethers.parseEther("1");
    await mgr.paymasterDeposit_(payer.address, { value: deposit });
    const balBefore = await ethers.provider.getBalance(payer.address);
    const tx = await mgr.connect(payer).withdrawPaymaster(deposit);
    const receipt = await tx.wait();
    const gasUsed = receipt.gasUsed * receipt.gasPrice;
    const balAfter = await ethers.provider.getBalance(payer.address);
    expect(balAfter).to.be.closeTo(balBefore + deposit - gasUsed, ethers.parseEther("0.0001"));
    expect(await mgr.paymasterDeposit(payer.address)).to.equal(0n);
  });

  it("16. isDue tracks multiple independent subscriptions correctly", async () => {
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(10), MONTH, 0, ethers.ZeroAddress
    );
    await mgr.connect(payer).createSubscription(
      merchant.address, await usdc.getAddress(), USDC(1), DAY, 0, ethers.ZeroAddress
    );
    expect(await mgr.isDue(0)).to.be.true;
    expect(await mgr.isDue(1)).to.be.true;
    await mgr.connect(bundler).executePayment(0);
    await mgr.connect(bundler).executePayment(1);
    expect(await mgr.isDue(0)).to.be.false;
    expect(await mgr.isDue(1)).to.be.false;
    await time.increase(DAY + 1n);
    expect(await mgr.isDue(0)).to.be.false;
    expect(await mgr.isDue(1)).to.be.true;
    await time.increase(DAY * 29n);
    expect(await mgr.isDue(0)).to.be.true;
    await mgr.connect(bundler).executePayment(1);
    expect(await mgr.cycleCount(0)).to.equal(1n);
    expect(await mgr.cycleCount(1)).to.equal(2n);
  });
});
