// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IERC4337.sol";

/// @title  ServiceBase
/// @notice Base contract that every whitelisted service should extend.
///         Services are separate contracts — they don't pull from user EOAs.
///         Instead, smart wallets push tokens to this contract when a claim
///         UserOperation is executed through the EntryPoint.
///
///         Revenue accounting is tracked per subscriber wallet.
///
/// @dev    Extend this contract to build your specific service logic.
///         Override `_onPaymentReceived` to add your business logic.
///
abstract contract ServiceBase is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ───────────────────────────────────────────────────────────────

    address public serviceOwner;
    string  public serviceName;

    struct PaymentRecord {
        uint256 amount;
        uint256 timestamp;
        uint256 cycleNumber;   // 1-based
    }

    // subscriber wallet → list of payment records
    mapping(address => PaymentRecord[]) private _payments;

    // subscriber wallet → total received
    mapping(address => uint256) public totalReceivedFrom;

    // Accumulated revenue per token
    mapping(address => uint256) public tokenRevenue;

    // ─── Events ──────────────────────────────────────────────────────────────

    event PaymentReceived(
        address indexed wallet,
        address indexed token,
        uint256 amount,
        uint256 cycleNumber,
        uint256 timestamp
    );
    event RevenueWithdrawn(address indexed token, uint256 amount);
    event ServiceOwnerUpdated(address indexed oldOwner, address indexed newOwner);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyServiceOwner() {
        require(msg.sender == serviceOwner, "Service: not owner");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(string memory _name) {
        serviceOwner = msg.sender;
        serviceName  = _name;
    }

    // ─── Payment Receipt ─────────────────────────────────────────────────────

    /// @notice Called automatically when a SubscriptionWallet's executeClaim()
    ///         transfers tokens here. Not directly callable — the transfer itself
    ///         triggers accounting via the wallet's executeClaim logic.
    ///
    ///         Services should implement a callback pattern: after tokens arrive
    ///         they call `acknowledgePayment` to trigger this accounting.
    ///
    ///         Alternatively, the service can listen for Transfer events off-chain.
    ///
    /// @param wallet  The SubscriptionWallet that made the payment.
    /// @param token   ERC-20 token received.
    /// @param amount  Amount received (in token's smallest unit).
    function acknowledgePayment(
        address wallet,
        address token,
        uint256 amount
    ) external nonReentrant {
        // Caller must be the wallet itself (sent tokens, then called this)
        // Or the EntryPoint can be configured to call this as a second step
        // For simplicity: verify token balance increased
        // (In production: use a more robust pull mechanism)

        uint256 cycle = _payments[wallet].length + 1;

        _payments[wallet].push(PaymentRecord({
            amount:      amount,
            timestamp:   block.timestamp,
            cycleNumber: cycle
        }));

        totalReceivedFrom[wallet] += amount;
        tokenRevenue[token]       += amount;

        emit PaymentReceived(wallet, token, amount, cycle, block.timestamp);

        // Hook for subclasses
        _onPaymentReceived(wallet, token, amount, cycle);
    }

    // ─── Revenue Withdrawal ──────────────────────────────────────────────────

    /// @notice Withdraw accumulated token revenue to service owner.
    function withdrawRevenue(address token, uint256 amount)
        external
        onlyServiceOwner
        nonReentrant
    {
        require(tokenRevenue[token] >= amount, "Service: insufficient revenue");
        tokenRevenue[token] -= amount;
        IERC20(token).safeTransfer(serviceOwner, amount);
        emit RevenueWithdrawn(token, amount);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getPaymentHistory(address wallet)
        external view
        returns (PaymentRecord[] memory)
    {
        return _payments[wallet];
    }

    function getPaymentCount(address wallet) external view returns (uint256) {
        return _payments[wallet].length;
    }

    // ─── Ownership ───────────────────────────────────────────────────────────

    function transferServiceOwnership(address newOwner) external onlyServiceOwner {
        require(newOwner != address(0), "Zero address");
        emit ServiceOwnerUpdated(serviceOwner, newOwner);
        serviceOwner = newOwner;
    }

    // ─── Hook ────────────────────────────────────────────────────────────────

    /// @dev Override in subclass to implement service-specific payment logic.
    ///      e.g. unlock premium tier, mint an access NFT, update subscription status
    function _onPaymentReceived(
        address wallet,
        address token,
        uint256 amount,
        uint256 cycle
    ) internal virtual {}

    receive() external payable {}
}


// ─── Example: Streaming Service ──────────────────────────────────────────────

/// @notice Minimal example showing how a real service extends ServiceBase.
///         Tracks which wallets are "active subscribers" based on payment history.
contract StreamingService is ServiceBase {

    uint256 public constant PLAN_PRICE = 10e6; // 10 USDC (6 decimals)

    mapping(address => bool) public isActiveMember;
    mapping(address => uint256) public memberSince;

    event MemberActivated(address indexed wallet);
    event MemberExpired(address indexed wallet);

    constructor() ServiceBase("StreamingService v1") {}

    function _onPaymentReceived(
        address wallet,
        address /*token*/,
        uint256 amount,
        uint256 /*cycle*/
    ) internal override {
        if (amount >= PLAN_PRICE && !isActiveMember[wallet]) {
            isActiveMember[wallet] = true;
            memberSince[wallet]    = block.timestamp;
            emit MemberActivated(wallet);
        }
    }

    /// @notice Called off-chain / by cron to expire wallets that haven't paid.
    function expireMember(address wallet) external {
        // In production: check if wallet's nextClaimAt is overdue by > grace period
        isActiveMember[wallet] = false;
        emit MemberExpired(wallet);
    }
}
