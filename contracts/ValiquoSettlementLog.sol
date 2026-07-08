// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ValiquoSettlementLog
/// @notice Append-only, permanent record of real Valiquo settlements. This
///         contract never holds, custodies, or moves any funds - real
///         payment settlement happens entirely on Circle's Gateway/USDC
///         contracts. logSettlement() is called AFTER a real payment has
///         already succeeded, purely to leave a trustless, independently
///         verifiable proof trail.
/// @dev Two numbers are meant to be independently verifiable by anyone,
///      with no trust in Valiquo's own server required, via a single free
///      eth_call against a public RPC endpoint - no log-indexing needed:
///        - settlementCount()     -> total settlements ever logged
///        - distinctPayerCount()  -> count of distinct payerAddress values
///      The full SettlementLogged event is also emitted on every call for
///      human-readable, per-negotiation audit detail.
contract ValiquoSettlementLog {
    /// @notice Deployer address. Immutable - the only privilege this role
    ///         has is rotating `logger` (see setLogger), never anything
    ///         touching funds, since this contract holds none.
    address public immutable owner;

    /// @notice The only address allowed to call logSettlement(). Rotatable
    ///         by `owner` so a compromised or retired logging key can be
    ///         replaced without redeploying the contract (old entries
    ///         remain valid and immutable either way).
    address public logger;

    /// @notice Total number of settlements ever logged. Increments by
    ///         exactly 1 on every successful logSettlement() call.
    uint256 public settlementCount;

    /// @notice Count of distinct payerAddress values seen across all
    ///         logged settlements. Increments only the first time a given
    ///         payerAddress is logged; repeat payers do not increment it
    ///         again.
    uint256 public distinctPayerCount;

    /// @dev Tracks which payerAddress values have been seen before, so
    ///      distinctPayerCount only increments once per unique payer.
    mapping(address => bool) private _seenPayer;

    /// @notice Emitted on every successful logSettlement() call.
    /// @param payerAddress The real settled payer (from the Gateway
    ///        payment), indexed so anyone can filter/verify by payer.
    /// @param negotiationId The off-chain negotiation's UUID, packed into
    ///        16 bytes (a v4 UUID is exactly 128 bits - this is a lossless,
    ///        reversible encoding, not a hash: strip the dashes from the
    ///        UUID string to get these same bytes back).
    /// @param tool The tool name the settlement paid for (kept as a plain
    ///        string, not indexed, so it stays human-readable in the event
    ///        data rather than only visible as a topic hash).
    /// @param agreedPriceMicroUsdc The settled price in micro-USDC (USDC's
    ///        own 6-decimal precision), e.g. 8000 for $0.008.
    /// @param timestamp block.timestamp at the moment of logging - never
    ///        caller-supplied, so it can't be spoofed by whoever holds the
    ///        logger key.
    event SettlementLogged(
        address indexed payerAddress,
        bytes16 indexed negotiationId,
        string tool,
        uint256 agreedPriceMicroUsdc,
        uint256 timestamp
    );

    /// @dev Restricts logSettlement() to the current `logger` address only.
    ///      This is the sole spam-prevention mechanism: without it, anyone
    ///      could inflate settlementCount/distinctPayerCount with fake
    ///      entries, defeating the entire purpose of this contract.
    modifier onlyLogger() {
        require(msg.sender == logger, "not authorized");
        _;
    }

    /// @param _logger Initial authorized logging address. Recommended to
    ///        be a dedicated low-privilege key, separate from any key that
    ///        also controls real funds (e.g. SELLER_PRIVATE_KEY) - since
    ///        this contract holds no funds, a leaked logger key can only
    ///        write junk log entries, never move money.
    constructor(address _logger) {
        owner = msg.sender;
        logger = _logger;
    }

    /// @notice Rotates the authorized logging address. Owner-only escape
    ///         hatch for key rotation after a suspected logger-key leak or
    ///         routine rotation - does not affect any previously logged
    ///         settlement, which remains permanent either way.
    function setLogger(address _logger) external {
        require(msg.sender == owner, "not owner");
        logger = _logger;
    }

    /// @notice Records a real, already-settled Valiquo payment. Must only
    ///         ever be called after payment has genuinely succeeded
    ///         (verified off-chain, e.g. after Postgres flips a quote to
    ///         FULFILLED) - this function performs no payment logic itself
    ///         and moves no funds.
    /// @param tool The tool name the settlement paid for.
    /// @param agreedPriceMicroUsdc The settled price in micro-USDC.
    /// @param negotiationId The off-chain negotiation's UUID, as raw bytes
    ///        (dashes stripped) rather than a hash.
    /// @param payerAddress The real settled payer address.
    /// @return newSettlementCount The updated total settlement count after
    ///         this call.
    function logSettlement(
        string calldata tool,
        uint256 agreedPriceMicroUsdc,
        bytes16 negotiationId,
        address payerAddress
    ) external onlyLogger returns (uint256 newSettlementCount) {
        settlementCount += 1;

        if (!_seenPayer[payerAddress]) {
            _seenPayer[payerAddress] = true;
            distinctPayerCount += 1;
        }

        emit SettlementLogged(payerAddress, negotiationId, tool, agreedPriceMicroUsdc, block.timestamp);

        return settlementCount;
    }
}
