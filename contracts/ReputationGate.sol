// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IReputationGate, GateReason} from "./interfaces/IReputationGate.sol";

/**
 * @title ReputationGate
 * @notice Decides who is even allowed to underwrite, and how much bond they must post to do it.
 *
 * The gate runs four heuristics:
 *   1. Wallet age      - a wallet minted five minutes ago is not a track record.
 *   2. Track record    - score moves up on clean resolutions, down hard on slashes.
 *   3. Funding origin  - if underwriter and counterparty trace to the same funding root,
 *                        this is one actor wearing two hats. Refuse.
 *   4. Pair repetition - the same underwriter blessing the same counterparty over and over
 *                        is the classic collusion-ring signature. Refuse past a threshold.
 *
 * Heuristics 1 and 3 depend on offchain graph analysis (wallet age in blocks, funding-source
 * fingerprint within N hops). Those are pushed onchain by an approved `attestor` and stored
 * here, so the value the gate acts on is always onchain and auditable. Heuristics 2 and 4 are
 * computed entirely onchain from this contract's own history.
 *
 * DEMO DISCLOSURE: the attestor is a trusted role in the MVP. Path to trust-minimising it
 * (signed attestations w/ multiple attestors, or a ZK proof of the graph query) is in the README.
 */
contract ReputationGate is IReputationGate, Ownable {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_SCORE = 10_000;

    struct UnderwriterProfile {
        uint256 trackRecordScore; // 0..MAX_SCORE, starts low and grows with clean history
        uint256 firstSeenBlock; // attested wallet age anchor
        uint256 lastActivityBlock;
        uint256 resolvedCount;
        uint256 slashedCount;
        bytes32 fundingRoot; // attested origin-of-funds fingerprint
        bool registered;
        bool flaggedForCollusion;
    }

    mapping(address => UnderwriterProfile) public profiles;

    /// @notice keccak256(underwriter, counterparty) => number of times that exact pair underwrote.
    mapping(bytes32 => uint256) public pairCount;

    /// @notice Offchain graph-analysis signers allowed to push wallet age / funding roots.
    mapping(address => bool) public attestors;

    /// @notice Contracts allowed to mutate reputation (i.e. UnderwriterVault).
    mapping(address => bool) public consumers;

    // ---- Tunable policy ----
    uint256 public minWalletAgeBlocks = 5_000;
    uint256 public maxPairRepeats = 3;
    uint256 public registrationScore = 2_000;
    uint256 public minScoreToUnderwrite = 1_000;
    uint256 public scoreGainPerCleanResolve = 750;
    /**
     * A slash costs exactly the gap between registration and the participation floor.
     *
     * This was 3_000, which is larger than registrationScore, and that produced a
     * dead end: a first slash floored the score at zero, zero is below
     * minScoreToUnderwrite, and the only way to earn score back is
     * scoreGainPerCleanResolve, which requires underwriting, which requires being
     * above the floor. One bad call ended an underwriter permanently with no route
     * back, which is not what the whitepaper describes and not a market anyone
     * would join.
     *
     * At 1_000 the policy reads as intended: a first slash drops 2_000 to 1_000, so
     * they may keep underwriting but at the worst bond multiplier plus the permanent
     * slash surcharge. A second slash takes them to zero and they are out. Expensive
     * once, disqualifying twice.
     */
    uint256 public scoreLossPerSlash = 1_000;

    // ---- Bond multiplier band ----
    /// Greenest allowed underwriter posts 3.0x the base bond; a spotless one posts 1.0x.
    uint256 public maxBondMultiplierBps = 30_000;
    uint256 public minBondMultiplierBps = 10_000;
    /// Every prior slash adds a permanent surcharge on top of the score-derived multiplier.
    uint256 public slashSurchargeBps = 5_000;

    event AttestorSet(address indexed attestor, bool allowed);
    event ConsumerSet(address indexed consumer, bool allowed);
    event ScoringSet(uint256 registrationScore, uint256 scoreGainPerCleanResolve, uint256 scoreLossPerSlash);
    event UnderwriterRegistered(address indexed underwriter, uint256 startingScore);
    event SignalsAttested(address indexed underwriter, uint256 firstSeenBlock, bytes32 fundingRoot);
    event CollusionFlagSet(address indexed underwriter, bool flagged, string note);
    event UnderwritingRecorded(address indexed underwriter, address indexed counterparty, uint256 pairCount);
    event ResolutionRecorded(address indexed underwriter, bool slashed, uint256 newScore);

    error NotAttestor();
    error NotConsumer();
    error AlreadyRegistered();

    modifier onlyAttestor() {
        if (!attestors[msg.sender] && msg.sender != owner()) revert NotAttestor();
        _;
    }

    modifier onlyConsumer() {
        if (!consumers[msg.sender]) revert NotConsumer();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {
        attestors[initialOwner] = true;
        emit AttestorSet(initialOwner, true);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setAttestor(address attestor, bool allowed) external onlyOwner {
        attestors[attestor] = allowed;
        emit AttestorSet(attestor, allowed);
    }

    function setConsumer(address consumer, bool allowed) external onlyOwner {
        consumers[consumer] = allowed;
        emit ConsumerSet(consumer, allowed);
    }

    function setPolicy(
        uint256 _minWalletAgeBlocks,
        uint256 _maxPairRepeats,
        uint256 _minScoreToUnderwrite,
        uint256 _maxBondMultiplierBps,
        uint256 _minBondMultiplierBps,
        uint256 _slashSurchargeBps
    ) external onlyOwner {
        require(_maxBondMultiplierBps >= _minBondMultiplierBps, "bad multiplier band");
        require(_minBondMultiplierBps >= BPS, "multiplier < 1x");
        minWalletAgeBlocks = _minWalletAgeBlocks;
        maxPairRepeats = _maxPairRepeats;
        minScoreToUnderwrite = _minScoreToUnderwrite;
        maxBondMultiplierBps = _maxBondMultiplierBps;
        minBondMultiplierBps = _minBondMultiplierBps;
        slashSurchargeBps = _slashSurchargeBps;
    }

    /**
     * The scoring curve, which setPolicy did not cover and so could not be corrected
     * without redeploying.
     *
     * The require is the whole point of this function existing. If a slash can cost
     * more than a new underwriter starts with, a first slash drops them below the
     * participation floor, and the only way to earn score back is by underwriting,
     * which they can no longer do. That is unrecoverable by construction, so it is
     * refused here rather than left as a configuration anyone could walk into.
     */
    function setScoring(
        uint256 _registrationScore,
        uint256 _scoreGainPerCleanResolve,
        uint256 _scoreLossPerSlash
    ) external onlyOwner {
        require(_registrationScore <= MAX_SCORE, "registration > max");
        // Both halves matter. Without the first, a loss larger than the registration
        // score underflows and panics before this message is ever seen, which is a
        // worse failure than the one being prevented.
        require(
            _scoreLossPerSlash <= _registrationScore &&
                _registrationScore - _scoreLossPerSlash >= minScoreToUnderwrite,
            "a first slash would be unrecoverable"
        );
        registrationScore = _registrationScore;
        scoreGainPerCleanResolve = _scoreGainPerCleanResolve;
        scoreLossPerSlash = _scoreLossPerSlash;
        emit ScoringSet(_registrationScore, _scoreGainPerCleanResolve, _scoreLossPerSlash);
    }

    // ---------------------------------------------------------------------
    // Registration & attestation
    // ---------------------------------------------------------------------

    function register(address underwriter) external onlyAttestor {
        UnderwriterProfile storage p = profiles[underwriter];
        if (p.registered) revert AlreadyRegistered();
        p.registered = true;
        p.trackRecordScore = registrationScore;
        p.firstSeenBlock = block.number;
        p.lastActivityBlock = block.number;
        emit UnderwriterRegistered(underwriter, registrationScore);
    }

    /// @notice Push offchain graph signals onchain. `firstSeenBlock` is the attested wallet-age
    ///         anchor; `fundingRoot` fingerprints where this wallet's funds originated.
    function attestSignals(address underwriter, uint256 firstSeenBlock, bytes32 fundingRoot) external onlyAttestor {
        UnderwriterProfile storage p = profiles[underwriter];
        require(p.registered, "not registered");
        require(firstSeenBlock <= block.number, "future block");
        p.firstSeenBlock = firstSeenBlock;
        p.fundingRoot = fundingRoot;
        emit SignalsAttested(underwriter, firstSeenBlock, fundingRoot);
    }

    /// @notice Manual override for the demo (and for a real incident response).
    function setCollusionFlag(address underwriter, bool flagged, string calldata note) external onlyAttestor {
        profiles[underwriter].flaggedForCollusion = flagged;
        emit CollusionFlagSet(underwriter, flagged, note);
    }

    // ---------------------------------------------------------------------
    // The gate itself
    // ---------------------------------------------------------------------

    function checkEligibility(address underwriter, address counterparty)
        public
        view
        returns (bool eligible, uint256 requiredBondMultiplierBps)
    {
        (eligible, requiredBondMultiplierBps,) = checkEligibilityDetailed(underwriter, counterparty);
    }

    function checkEligibilityDetailed(address underwriter, address counterparty)
        public
        view
        returns (bool eligible, uint256 requiredBondMultiplierBps, GateReason reason)
    {
        UnderwriterProfile storage p = profiles[underwriter];
        uint256 multiplier = _bondMultiplierBps(p);

        if (!p.registered) return (false, multiplier, GateReason.NotRegistered);
        if (p.flaggedForCollusion) return (false, multiplier, GateReason.FlaggedForCollusion);
        if (block.number - p.firstSeenBlock < minWalletAgeBlocks) {
            return (false, multiplier, GateReason.WalletTooYoung);
        }
        if (p.trackRecordScore < minScoreToUnderwrite) return (false, multiplier, GateReason.ScoreTooLow);

        // Same money behind both sides of the trade.
        bytes32 cpRoot = profiles[counterparty].fundingRoot;
        if (p.fundingRoot != bytes32(0) && p.fundingRoot == cpRoot) {
            return (false, multiplier, GateReason.SharedFundingSource);
        }

        // Collusion-ring signature: the same two wallets, again and again.
        if (pairCount[_pairKey(underwriter, counterparty)] >= maxPairRepeats) {
            return (false, multiplier, GateReason.RepeatedCounterparty);
        }

        return (true, multiplier, GateReason.Eligible);
    }

    /// @dev Multiplier falls linearly from max to min as the score climbs, then a permanent
    ///      surcharge is added for every past slash. A repeat offender never gets cheap again.
    function _bondMultiplierBps(UnderwriterProfile storage p) internal view returns (uint256) {
        uint256 score = p.trackRecordScore > MAX_SCORE ? MAX_SCORE : p.trackRecordScore;
        uint256 band = maxBondMultiplierBps - minBondMultiplierBps;
        uint256 multiplier = maxBondMultiplierBps - (band * score) / MAX_SCORE;
        return multiplier + (p.slashedCount * slashSurchargeBps);
    }

    function bondMultiplierBps(address underwriter) external view returns (uint256) {
        return _bondMultiplierBps(profiles[underwriter]);
    }

    // ---------------------------------------------------------------------
    // Reputation mutation (UnderwriterVault only)
    // ---------------------------------------------------------------------

    function recordUnderwriting(address underwriter, address counterparty) external onlyConsumer {
        bytes32 key = _pairKey(underwriter, counterparty);
        uint256 next = pairCount[key] + 1;
        pairCount[key] = next;
        profiles[underwriter].lastActivityBlock = block.number;
        emit UnderwritingRecorded(underwriter, counterparty, next);
    }

    function recordResolution(address underwriter, bool slashed) external onlyConsumer {
        UnderwriterProfile storage p = profiles[underwriter];
        p.resolvedCount += 1;
        p.lastActivityBlock = block.number;

        if (slashed) {
            p.slashedCount += 1;
            p.trackRecordScore = p.trackRecordScore > scoreLossPerSlash ? p.trackRecordScore - scoreLossPerSlash : 0;
        } else {
            uint256 next = p.trackRecordScore + scoreGainPerCleanResolve;
            p.trackRecordScore = next > MAX_SCORE ? MAX_SCORE : next;
        }
        emit ResolutionRecorded(underwriter, slashed, p.trackRecordScore);
    }

    function _pairKey(address underwriter, address counterparty) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(underwriter, counterparty));
    }
}
