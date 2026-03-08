// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SubscriptionManager
/// @notice Implements the ERC-4337 article's recurring-payment architecture:
///         - Users create subscriptions with amount + interval + spending cap
///         - A trusted "bundler" role executes due payments (simulates UserOperation flow)
///         - Paymaster can sponsor gas by pre-funding ETH on behalf of payers
///         - Session keys: payer can delegate execution to a separate key
///         - Risk limits: per-tx cap + total spending cap per subscription
///         - Refund: merchant can refund a specific payment cycle
contract SubscriptionManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Data structures ────────────────────────────────────────────────────

    struct Subscription {
        address payer;          // smart-account / user wallet
        address recipient;      // merchant contract / address
        address token;          // ERC-20 token (e.g. USDC)
        uint256 amount;         // amount per cycle
        uint256 interval;       // seconds between payments
        uint256 nextPayment;    // timestamp of next due payment
        uint256 totalCap;       // max lifetime spending (0 = unlimited)
        uint256 totalSpent;     // lifetime amount paid so far
        address sessionKey;     // optional delegated key (0 = none)
        bool active;
    }

    struct PaymentRecord {
        uint256 subscriptionId;
        uint256 cycle;          // cycle index (1-based)
        uint256 amount;
        uint256 timestamp;
        bool refunded;
    }

    // ─── State ───────────────────────────────────────────────────────────────

    uint256 public nextSubId;
    mapping(uint256 => Subscription) public subscriptions;

    // subId => cycleIndex => PaymentRecord
    mapping(uint256 => mapping(uint256 => PaymentRecord)) public paymentRecords;
    mapping(uint256 => uint256) public cycleCount; // subId => total cycles executed

    // Bundler whitelist (simulates trusted relayer / Bundler in ERC-4337)
    mapping(address => bool) public isBundler;
    address public owner;

    // Paymaster: maps payer => ETH balance deposited for gas sponsorship
    mapping(address => uint256) public paymasterDeposit;

    // ─── Events ──────────────────────────────────────────────────────────────

    event SubscriptionCreated(
        uint256 indexed subId,
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 amount,
        uint256 interval,
        uint256 totalCap
    );
    event PaymentExecuted(
        uint256 indexed subId,
        uint256 indexed cycle,
        address indexed executor,
        uint256 amount,
        uint256 timestamp
    );
    event SubscriptionCancelled(uint256 indexed subId, address cancelledBy);
    event SessionKeyUpdated(uint256 indexed subId, address sessionKey);
    event PaymentRefunded(uint256 indexed subId, uint256 indexed cycle, uint256 amount);
    event BundlerSet(address bundler, bool status);
    event PaymasterDeposited(address indexed payer, uint256 amount);
    event PaymasterWithdrawn(address indexed payer, uint256 amount);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyBundler() {
        require(isBundler[msg.sender], "Not a bundler");
        _;
    }

    modifier subExists(uint256 subId) {
        require(subId < nextSubId, "Sub not found");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
        isBundler[msg.sender] = true; // owner is also default bundler
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function setBundler(address bundler, bool status) external onlyOwner {
        isBundler[bundler] = status;
        emit BundlerSet(bundler, status);
    }

    // ─── Subscription CRUD ───────────────────────────────────────────────────

    /// @notice Create a recurring-payment subscription
    /// @param recipient  Merchant address
    /// @param token      ERC-20 token for payment
    /// @param amount     Amount per cycle (in token's smallest unit)
    /// @param interval   Seconds between payments
    /// @param totalCap   Maximum lifetime spending (0 = no cap)
    /// @param sessionKey Optional delegated execution key (0 = none)
    function createSubscription(
        address recipient,
        address token,
        uint256 amount,
        uint256 interval,
        uint256 totalCap,
        address sessionKey
    ) external returns (uint256 subId) {
        require(recipient != address(0), "Zero recipient");
        require(token != address(0), "Zero token");
        require(amount > 0, "Zero amount");
        require(interval > 0, "Zero interval");

        subId = nextSubId++;
        subscriptions[subId] = Subscription({
            payer: msg.sender,
            recipient: recipient,
            token: token,
            amount: amount,
            interval: interval,
            nextPayment: block.timestamp, // first payment immediately available
            totalCap: totalCap,
            totalSpent: 0,
            sessionKey: sessionKey,
            active: true
        });

        emit SubscriptionCreated(subId, msg.sender, recipient, token, amount, interval, totalCap);
    }

    /// @notice Cancel a subscription – callable by payer, session key, or bundler
    function cancelSubscription(uint256 subId) external subExists(subId) {
        Subscription storage sub = subscriptions[subId];
        require(
            msg.sender == sub.payer ||
            msg.sender == sub.sessionKey ||
            isBundler[msg.sender],
            "Not authorized"
        );
        sub.active = false;
        emit SubscriptionCancelled(subId, msg.sender);
    }

    /// @notice Update the session key for a subscription
    function setSessionKey(uint256 subId, address key) external subExists(subId) {
        require(subscriptions[subId].payer == msg.sender, "Not payer");
        subscriptions[subId].sessionKey = key;
        emit SessionKeyUpdated(subId, key);
    }

    // ─── Payment Execution (Bundler / Session Key) ───────────────────────────

    /// @notice Execute the next due payment for a subscription.
    ///         Callable by: whitelisted Bundler OR the subscription's session key.
    ///         Mirrors ERC-4337's EntryPoint calling the Smart Account's executePayment.
    function executePayment(uint256 subId)
        external
        nonReentrant
        subExists(subId)
    {
        Subscription storage sub = subscriptions[subId];

        // Authorization: bundler OR session key
        require(
            isBundler[msg.sender] || msg.sender == sub.sessionKey,
            "Not authorized executor"
        );

        require(sub.active, "Subscription inactive");
        require(block.timestamp >= sub.nextPayment, "Payment not due yet");

        // Risk limit: total cap check
        if (sub.totalCap > 0) {
            require(
                sub.totalSpent + sub.amount <= sub.totalCap,
                "Total cap exceeded"
            );
        }

        // State updates before transfer (checks-effects-interactions)
        uint256 cycle = ++cycleCount[subId];
        sub.totalSpent += sub.amount;
        sub.nextPayment = block.timestamp + sub.interval;

        // Record the payment
        paymentRecords[subId][cycle] = PaymentRecord({
            subscriptionId: subId,
            cycle: cycle,
            amount: sub.amount,
            timestamp: block.timestamp,
            refunded: false
        });

        // Transfer tokens from payer to recipient
        IERC20(sub.token).safeTransferFrom(sub.payer, sub.recipient, sub.amount);

        emit PaymentExecuted(subId, cycle, msg.sender, sub.amount, block.timestamp);
    }

    // ─── Refund (Merchant-initiated) ─────────────────────────────────────────

    /// @notice Merchant can refund a specific payment cycle back to the payer.
    ///         Merchant must have pre-approved this contract to spend the token.
    function refundPayment(uint256 subId, uint256 cycle)
        external
        nonReentrant
        subExists(subId)
    {
        Subscription storage sub = subscriptions[subId];
        require(msg.sender == sub.recipient, "Not the recipient");

        PaymentRecord storage record = paymentRecords[subId][cycle];
        require(record.amount > 0, "No payment record");
        require(!record.refunded, "Already refunded");

        record.refunded = true;
        // Reduce totalSpent so the cap accounting stays correct
        if (sub.totalSpent >= record.amount) {
            sub.totalSpent -= record.amount;
        }

        IERC20(sub.token).safeTransferFrom(sub.recipient, sub.payer, record.amount);

        emit PaymentRefunded(subId, cycle, record.amount);
    }

    // ─── Paymaster (Gas Sponsorship Simulation) ───────────────────────────────

    /// @notice Deposit ETH as gas credit for a payer (Paymaster pattern)
    function paymasterDeposit_(address payer) external payable {
        require(msg.value > 0, "Zero deposit");
        paymasterDeposit[payer] += msg.value;
        emit PaymasterDeposited(payer, msg.value);
    }

    /// @notice Bundler deducts gas cost from payer's Paymaster balance
    function deductGas(address payer, uint256 gasCost) external onlyBundler {
        require(paymasterDeposit[payer] >= gasCost, "Insufficient paymaster balance");
        paymasterDeposit[payer] -= gasCost;
    }

    /// @notice Payer withdraws unused Paymaster ETH balance
    function withdrawPaymaster(uint256 amount) external nonReentrant {
        require(paymasterDeposit[msg.sender] >= amount, "Insufficient balance");
        paymasterDeposit[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");
        emit PaymasterWithdrawn(msg.sender, amount);
    }

    // ─── View helpers ────────────────────────────────────────────────────────

    function getSubscription(uint256 subId) external view returns (Subscription memory) {
        return subscriptions[subId];
    }

    function getPaymentRecord(uint256 subId, uint256 cycle)
        external view
        returns (PaymentRecord memory)
    {
        return paymentRecords[subId][cycle];
    }

    function isDue(uint256 subId) external view subExists(subId) returns (bool) {
        Subscription storage sub = subscriptions[subId];
        return sub.active && block.timestamp >= sub.nextPayment;
    }

    receive() external payable {}
}
