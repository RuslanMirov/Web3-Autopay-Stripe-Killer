// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./SubscriptionWallet.sol";

/// @title  WalletFactory
/// @notice Deploys SubscriptionWallet instances at deterministic addresses (CREATE2).
///         Users can know their wallet address before deploying it (counterfactual).
///         EntryPoint's `initCode` field uses this factory for first-op deployment.
///
///         initCode encoding for EntryPoint:
///           abi.encodePacked(
///               address(factory),
///               abi.encodeCall(factory.createWallet, (owner, salt))
///           )
///
contract WalletFactory {

    // ─── State ───────────────────────────────────────────────────────────────

    IEntryPoint       public immutable entryPoint;
    IPlatformRegistry public immutable registry;

    // Track deployed wallets for indexing
    mapping(address => address[]) public walletsByOwner; // owner → wallets
    mapping(address => bool)      public isDeployedWallet;

    // ─── Events ──────────────────────────────────────────────────────────────

    event WalletDeployed(
        address indexed wallet,
        address indexed owner,
        bytes32 indexed salt
    );

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _entryPoint, address _registry) {
        require(_entryPoint != address(0), "Zero entryPoint");
        require(_registry   != address(0), "Zero registry");
        entryPoint = IEntryPoint(_entryPoint);
        registry   = IPlatformRegistry(_registry);
    }

    // ─── Deployment ──────────────────────────────────────────────────────────

    /// @notice Deploy a new SubscriptionWallet for `owner` at deterministic address.
    ///         Idempotent: returns existing wallet if already deployed at that address.
    /// @param owner The EOA that will own and control the wallet.
    /// @param salt  Allows one owner to deploy multiple wallets (use 0 for first).
    /// @return wallet The address of the deployed (or existing) wallet.
    function createWallet(address owner, bytes32 salt)
        external
        returns (SubscriptionWallet wallet)
    {
        address predicted = getWalletAddress(owner, salt);

        // If already deployed, return existing (idempotent for EntryPoint initCode)
        if (isDeployedWallet[predicted]) {
            return SubscriptionWallet(payable(predicted));
        }

        bytes32 deploySalt = _combineSalt(owner, salt);

        wallet = new SubscriptionWallet{salt: deploySalt}(
            address(entryPoint),
            address(registry),
            owner
        );

        require(address(wallet) == predicted, "Factory: address mismatch");

        isDeployedWallet[address(wallet)] = true;
        walletsByOwner[owner].push(address(wallet));

        emit WalletDeployed(address(wallet), owner, salt);
    }

    // ─── Address Prediction ──────────────────────────────────────────────────

    /// @notice Compute the counterfactual address of a wallet before deployment.
    ///         Use this to fund the wallet with tokens/ETH before it exists on-chain.
    function getWalletAddress(address owner, bytes32 salt)
        public view
        returns (address)
    {
        bytes32 deploySalt = _combineSalt(owner, salt);

        bytes memory bytecode = abi.encodePacked(
            type(SubscriptionWallet).creationCode,
            abi.encode(address(entryPoint), address(registry), owner)
        );

        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            deploySalt,
            keccak256(bytecode)
        )))));
    }

    // ─── View helpers ────────────────────────────────────────────────────────

    function getWalletsByOwner(address owner)
        external view
        returns (address[] memory)
    {
        return walletsByOwner[owner];
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    /// @dev Combine owner + user salt so two owners can't collide.
    function _combineSalt(address owner, bytes32 salt)
        private pure
        returns (bytes32)
    {
        return keccak256(abi.encode(owner, salt));
    }
}
