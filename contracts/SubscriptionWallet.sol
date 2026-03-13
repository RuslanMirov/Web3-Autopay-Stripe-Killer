// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./interfaces/IERC4337.sol";

interface IPlatformRegistry {
    function isWhitelisted(address service) external view returns (bool);
}

/// @title  SubscriptionWallet
/// @notice ERC-4337 smart account with built-in subscription management.
///
///         ┌─────────────────────────────────────────────────────────────┐
///         │  Key design decisions vs old SubscriptionManager.sol        │
///         │                                                             │
///         │  ✗ NO unlimited ERC-20 approve from user's EOA             │
///         │  ✓ Tokens live INSIDE the smart wallet                     │
///         │  ✓ Services claim via EntryPoint UserOperations             │
///         │  ✓ Only platform-whitelisted services can claim            │
///         │  ✓ 30-day interval enforced in validateUserOp + execute     │
///         │  ✓ Owner can cancel at any time                             │
///         │  ✓ Two validation paths: owner-signed OR subscription claim │
///         └─────────────────────────────────────────────────────────────┘
///
///         Claim flow:
///           Service/Bundler → EntryPoint.handleOps([userOp])
///                           → wallet.validateUserOp()   [checks conditions]
///                           → wallet.executeClaim(svc)  [transfers tokens]
///
contract SubscriptionWallet is IAccount, ReentrancyGuard {
    using SafeERC20  for IERC20;
    using ECDSA      for bytes32;

    // ─── Constants ───────────────────────────────────────────────────────────

    uint256 public constant SUBSCRIPTION_INTERVAL = 30 days;

    /// @dev Magic bytes in UserOp.signature field that flags a subscription
    ///      claim rather than an owner-signed operation.
    ///      keccak256("SUBSCRIPTION_CLAIM") truncated to 4 bytes.
    bytes4  public constant CLAIM_MAGIC = 0x7c1e2e76;

    // ─── Immutables ──────────────────────────────────────────────────────────

    IEntryPoint        public immutable entryPoint;
    IPlatformRegistry  public immutable registry;

    // ─── State ───────────────────────────────────────────────────────────────

    address public owner;

    struct Subscription {
        address token;           // ERC-20 token paid each cycle
        uint256 amountPerCycle;  // Tokens transferred to service each claim
        uint256 totalCap;        // Lifetime max (0 = unlimited)
        uint256 totalPaid;       // Lifetime tokens paid so far
        uint256 subscribedAt;    // Timestamp of subscription creation
        uint256 nextClaimAt;     // Timestamp when next claim becomes valid
        bool    active;
    }

    // service address → Subscription config
    mapping(address => Subscription) private _subscriptions;

    // Ordered list for enumeration / front-end
    address[] public subscribedServices;

    // ─── Events ──────────────────────────────────────────────────────────────

    event Subscribed(
        address indexed service,
        address indexed token,
        uint256 amountPerCycle,
        uint256 totalCap,
        uint256 nextClaimAt
    );
    event Unsubscribed(address indexed service, address cancelledBy);
    event PaymentClaimed(
        address indexed service,
        address indexed token,
        uint256 amount,
        uint256 totalPaid,
        uint256 nextClaimAt
    );
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event TokenDeposited(address indexed token, uint256 amount);
    event TokenWithdrawn(address indexed token, uint256 amount);
    event ETHReceived(address indexed sender, uint256 amount);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "SW: not owner");
        _;
    }

    modifier onlyEntryPoint() {
        require(msg.sender == address(entryPoint), "SW: not EntryPoint");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(
        address _entryPoint,
        address _registry,
        address _owner
    ) {
        require(_entryPoint != address(0), "Zero entryPoint");
        require(_registry   != address(0), "Zero registry");
        require(_owner      != address(0), "Zero owner");

        entryPoint = IEntryPoint(_entryPoint);
        registry   = IPlatformRegistry(_registry);
        owner      = _owner;
    }

    // ─── ERC-4337: validateUserOp ─────────────────────────────────────────────
    //
    //   Two paths based on UserOp.signature:
    //
    //   Path A — Owner operation (signature = ECDSA sig over userOpHash):
    //     • Verifies ECDSA signature was made by `owner`
    //     • Allows any callData (general wallet execution)
    //
    //   Path B — Subscription claim (signature = abi.encode(CLAIM_MAGIC, serviceAddr)):
    //     • No ECDSA needed — authorization is the subscription state itself
    //     • callData MUST be executeClaim(address) for that service
    //     • Service MUST be platform-whitelisted
    //     • Subscription MUST be active and due
    //     • Total cap MUST not be exceeded
    //
    // ─────────────────────────────────────────────────────────────────────────

    function validateUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    )
        external
        override
        onlyEntryPoint
        returns (uint256 validationData)
    {
        // Prefund EntryPoint gas escrow if required
        if (missingAccountFunds > 0) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok,) = address(entryPoint).call{value: missingAccountFunds}("");
            require(ok, "SW: gas prefund failed");
        }

        // ── Determine validation path from signature field ──────────────────

        if (_isClaimSignature(userOp.signature)) {
            return _validateClaimOp(userOp);
        } else {
            return _validateOwnerOp(userOp, userOpHash);
        }
    }

    /// @dev Path A: verify ECDSA owner signature
    function _validateOwnerOp(
        UserOperation calldata userOp,
        bytes32 userOpHash
    ) private view returns (uint256) {
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        address signer  = ethHash.recover(userOp.signature);

        if (signer != owner) {
            return SIG_VALIDATION_FAILED;
        }
        return SIG_VALIDATION_SUCCESS;
    }

    /// @dev Path B: validate a subscription claim UserOp without ECDSA
    function _validateClaimOp(UserOperation calldata userOp)
        private view returns (uint256)
    {
        // Decode service address from signature payload: (bytes4 magic, address service)
        if (userOp.signature.length < 36) return SIG_VALIDATION_FAILED;
        address service = abi.decode(userOp.signature[4:], (address));

        // callData must be exactly: executeClaim(address)
        if (userOp.callData.length != 36)            return SIG_VALIDATION_FAILED;
        bytes4 selector = bytes4(userOp.callData[:4]);
        if (selector != this.executeClaim.selector)  return SIG_VALIDATION_FAILED;

        address callService = abi.decode(userOp.callData[4:], (address));
        if (callService != service)                   return SIG_VALIDATION_FAILED;

        // Service must be platform-whitelisted
        if (!registry.isWhitelisted(service))         return SIG_VALIDATION_FAILED;

        // Subscription must exist and be active
        Subscription storage sub = _subscriptions[service];
        if (!sub.active)                              return SIG_VALIDATION_FAILED;

        // Payment must be due
        if (block.timestamp < sub.nextClaimAt)        return SIG_VALIDATION_FAILED;

        // Total cap check
        if (sub.totalCap > 0) {
            if (sub.totalPaid + sub.amountPerCycle > sub.totalCap)
                return SIG_VALIDATION_FAILED;
        }

        // Wallet must hold enough tokens
        uint256 balance = IERC20(sub.token).balanceOf(address(this));
        if (balance < sub.amountPerCycle)             return SIG_VALIDATION_FAILED;

        return SIG_VALIDATION_SUCCESS;
    }

    /// @dev True if signature starts with CLAIM_MAGIC bytes4
    function _isClaimSignature(bytes calldata sig) private pure returns (bool) {
        if (sig.length < 4) return false;
        return bytes4(sig[:4]) == CLAIM_MAGIC;
    }

    // ─── ERC-4337: executeClaim ───────────────────────────────────────────────

    /// @notice Transfer one subscription cycle's payment to a whitelisted service.
    /// @dev    Called by EntryPoint after validateUserOp passes.
    ///         Double-checks all conditions (checks-effects-interactions pattern).
    /// @param service The whitelisted service contract receiving payment.
    function executeClaim(address service)
        external
        onlyEntryPoint
        nonReentrant
    {
        // Re-check everything (defence in depth, even after validateUserOp)
        require(registry.isWhitelisted(service), "SW: service not whitelisted");

        Subscription storage sub = _subscriptions[service];
        require(sub.active,                      "SW: not subscribed");
        require(block.timestamp >= sub.nextClaimAt, "SW: not due");

        if (sub.totalCap > 0) {
            require(
                sub.totalPaid + sub.amountPerCycle <= sub.totalCap,
                "SW: total cap exceeded"
            );
        }

        uint256 amount = sub.amountPerCycle;

        // Check wallet balance
        require(
            IERC20(sub.token).balanceOf(address(this)) >= amount,
            "SW: insufficient balance"
        );

        // ── Effects ─────────────────────────────────────────────────────────
        sub.totalPaid   += amount;
        sub.nextClaimAt  = block.timestamp + SUBSCRIPTION_INTERVAL;

        if (sub.totalCap > 0 && sub.totalPaid >= sub.totalCap) {
            // Auto-cancel when lifetime cap is reached
            sub.active = false;
            emit Unsubscribed(service, address(this));
        }

        // ── Interaction ──────────────────────────────────────────────────────
        IERC20(sub.token).safeTransfer(service, amount);

        emit PaymentClaimed(
            service,
            sub.token,
            amount,
            sub.totalPaid,
            sub.nextClaimAt
        );
    }

    // ─── ERC-4337: execute (general owner-signed operations) ─────────────────

    /// @notice Execute an arbitrary call from the owner (via EntryPoint after ECDSA validation).
    ///         Use this for token deposits, external DeFi calls, etc.
    function execute(
        address target,
        uint256 value,
        bytes calldata data
    ) external onlyEntryPoint nonReentrant {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) {
            // Bubble up the revert reason
            assembly { revert(add(result, 32), mload(result)) }
        }
    }

    // ─── Subscription Management (owner-direct, no UserOp needed) ────────────

    /// @notice Subscribe to a whitelisted service.
    /// @param service        Platform-whitelisted service contract address.
    /// @param token          ERC-20 token the service charges in.
    /// @param amountPerCycle Tokens transferred to service every 30 days.
    /// @param totalCap       Lifetime spending cap in tokens (0 = no cap).
    /// @param startImmediately If true, first claim is available immediately;
    ///                         if false, first claim is available after 30 days.
    function subscribe(
        address service,
        address token,
        uint256 amountPerCycle,
        uint256 totalCap,
        bool    startImmediately
    ) external onlyOwner {
        require(registry.isWhitelisted(service), "SW: service not whitelisted");
        require(!_subscriptions[service].active, "SW: already subscribed");
        require(token          != address(0),    "SW: zero token");
        require(amountPerCycle  > 0,             "SW: zero amount");

        uint256 firstClaim = startImmediately
            ? block.timestamp
            : block.timestamp + SUBSCRIPTION_INTERVAL;

        _subscriptions[service] = Subscription({
            token:          token,
            amountPerCycle: amountPerCycle,
            totalCap:       totalCap,
            totalPaid:      0,
            subscribedAt:   block.timestamp,
            nextClaimAt:    firstClaim,
            active:         true
        });

        subscribedServices.push(service);

        emit Subscribed(service, token, amountPerCycle, totalCap, firstClaim);
    }

    /// @notice Cancel a subscription. Tokens already paid are non-refundable
    ///         unless the service implements a refund mechanism.
    function unsubscribe(address service) external onlyOwner {
        require(_subscriptions[service].active, "SW: not subscribed");
        _subscriptions[service].active = false;
        emit Unsubscribed(service, msg.sender);
    }

    // ─── Token Management ────────────────────────────────────────────────────

    /// @notice Deposit ERC-20 tokens into this wallet for subscriptions.
    ///         Owner approves this wallet once to pull; tokens then live here.
    ///         Much better than approving each service contract.
    function depositToken(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit TokenDeposited(token, amount);
    }

    /// @notice Withdraw ERC-20 tokens (owner only).
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner, amount);
        emit TokenWithdrawn(token, amount);
    }

    /// @notice Withdraw ETH (owner only).
    function withdrawETH(uint256 amount) external onlyOwner nonReentrant {
        require(address(this).balance >= amount, "SW: insufficient ETH");
        (bool ok,) = owner.call{value: amount}("");
        require(ok, "SW: ETH transfer failed");
    }

    /// @notice Deposit ETH into EntryPoint so bundlers can be paid for claim gas.
    function fundEntryPoint() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    /// @notice Withdraw unused EntryPoint ETH deposit.
    function withdrawFromEntryPoint(uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(payable(owner), amount);
    }

    // ─── Ownership ───────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "SW: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getSubscription(address service)
        external view
        returns (Subscription memory)
    {
        return _subscriptions[service];
    }

    function isSubscribed(address service) external view returns (bool) {
        return _subscriptions[service].active;
    }

    function isDue(address service) external view returns (bool) {
        Subscription storage sub = _subscriptions[service];
        return sub.active && block.timestamp >= sub.nextClaimAt;
    }

    /// @notice Returns the EntryPoint deposit balance for this wallet.
    function entryPointBalance() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    function getSubscribedServicesCount() external view returns (uint256) {
        return subscribedServices.length;
    }

    function getSubscribedServices(uint256 offset, uint256 limit)
        external view
        returns (address[] memory result)
    {
        uint256 len = subscribedServices.length;
        uint256 end = offset + limit > len ? len : offset + limit;
        result = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = subscribedServices[i];
        }
    }

    // ─── Receive ETH ─────────────────────────────────────────────────────────

    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }
}
