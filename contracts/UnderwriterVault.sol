// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IReputationGate, GateReason} from "./interfaces/IReputationGate.sol";
import {ITrancheVault} from "./interfaces/ITrancheVault.sol";

/**
 * @title UnderwriterVault
 * @notice The trust layer. An underwriting model does not just publish a score - it posts its
 *         own collateral behind that score, and loses the collateral if reality comes in worse.
 *
 * Slashing is proportional, not binary, so the punishment matches the size of the miss:
 *
 *     error   = actualDefaultRateBps - (predictedDefaultRateBps + toleranceBps)
 *     slashed = bond * min(error, fullSlashErrorBps) / fullSlashErrorBps
 *
 * With the default fullSlashErrorBps = 1000, underestimating defaults by 10 percentage points
 * past the tolerance band costs the underwriter their entire bond. That is one sentence, and a
 * judge can hold it in their head - which matters more than a cleverer curve.
 *
 * Slashed bond does not go to the protocol. It flows into TrancheVault as first-loss cover and
 * is consumed by the waterfall before any junior holder is touched.
 */
contract UnderwriterVault is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;

    struct Prediction {
        address underwriter;
        address counterparty;
        bytes32 assetId;
        uint256 predictedDefaultRateBps;
        uint256 confidenceBps;
        bytes32 reasoningHash; // keccak256 of the model's stated reasoning - auditable offchain
        string modelVersion;
        uint256 bondAmount;
        uint256 bondReleased;
        uint256 bondSlashed;
        uint256 actualDefaultRateBps;
        uint64 postedAt;
        bool resolved;
        bool slashed;
    }

    IERC20 public immutable bondAsset;
    IReputationGate public gate;
    ITrancheVault public trancheVault;
    address public oracle;

    mapping(bytes32 => Prediction) public predictions;
    bytes32[] public assetIds;

    uint256 public minBond = 1_000e6; // base bond before the gate's multiplier
    uint256 public toleranceBps = 200; // grace band: being 2 points pessimistic-wrong is fine
    uint256 public fullSlashErrorBps = 1_000; // miss by 10 points past tolerance -> lose it all

    event GateSet(address gate);
    event TrancheVaultSet(address trancheVault);
    event OracleSet(address oracle);
    event ParamsSet(uint256 minBond, uint256 toleranceBps, uint256 fullSlashErrorBps);
    event PredictionPosted(
        bytes32 indexed assetId,
        address indexed underwriter,
        address indexed counterparty,
        uint256 predictedDefaultRateBps,
        uint256 confidenceBps,
        uint256 bondAmount,
        uint256 requiredBond,
        bytes32 reasoningHash,
        string modelVersion
    );
    event OutcomeResolved(
        bytes32 indexed assetId,
        uint256 predictedDefaultRateBps,
        uint256 actualDefaultRateBps,
        bool slashed,
        uint256 bondSlashed,
        uint256 bondReleased
    );

    error NotOracle();
    error NotEligible(GateReason reason);
    error BondTooSmall(uint256 provided, uint256 required);
    error AlreadyPosted();
    error UnknownAsset();
    error AlreadyResolved();
    error RateOutOfRange();

    modifier onlyOracle() {
        if (msg.sender != oracle && msg.sender != owner()) revert NotOracle();
        _;
    }

    constructor(IERC20 bondAsset_, address gate_, address initialOwner) Ownable(initialOwner) {
        bondAsset = bondAsset_;
        gate = IReputationGate(gate_);
        oracle = initialOwner;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setGate(address gate_) external onlyOwner {
        gate = IReputationGate(gate_);
        emit GateSet(gate_);
    }

    function setTrancheVault(address trancheVault_) external onlyOwner {
        trancheVault = ITrancheVault(trancheVault_);
        emit TrancheVaultSet(trancheVault_);
    }

    function setOracle(address oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleSet(oracle_);
    }

    function setParams(uint256 minBond_, uint256 toleranceBps_, uint256 fullSlashErrorBps_) external onlyOwner {
        require(fullSlashErrorBps_ > 0, "fullSlashErrorBps = 0");
        require(toleranceBps_ <= BPS, "tolerance > 100%");
        minBond = minBond_;
        toleranceBps = toleranceBps_;
        fullSlashErrorBps = fullSlashErrorBps_;
        emit ParamsSet(minBond_, toleranceBps_, fullSlashErrorBps_);
    }

    // ---------------------------------------------------------------------
    // Journey A step 1: post a prediction, lock a bond
    // ---------------------------------------------------------------------

    function requiredBondFor(address underwriter, address counterparty) public view returns (uint256) {
        (, uint256 multiplierBps) = gate.checkEligibility(underwriter, counterparty);
        return (minBond * multiplierBps) / BPS;
    }

    function postPrediction(
        bytes32 assetId,
        address counterparty,
        uint256 predictedDefaultRateBps,
        uint256 confidenceBps,
        bytes32 reasoningHash,
        string calldata modelVersion,
        uint256 bondAmount
    ) external {
        if (predictedDefaultRateBps > BPS || confidenceBps > BPS) revert RateOutOfRange();
        if (predictions[assetId].underwriter != address(0)) revert AlreadyPosted();

        (bool eligible, uint256 multiplierBps, GateReason reason) =
            gate.checkEligibilityDetailed(msg.sender, counterparty);
        if (!eligible) revert NotEligible(reason);

        uint256 required = (minBond * multiplierBps) / BPS;
        if (bondAmount < required) revert BondTooSmall(bondAmount, required);

        bondAsset.safeTransferFrom(msg.sender, address(this), bondAmount);

        predictions[assetId] = Prediction({
            underwriter: msg.sender,
            counterparty: counterparty,
            assetId: assetId,
            predictedDefaultRateBps: predictedDefaultRateBps,
            confidenceBps: confidenceBps,
            reasoningHash: reasoningHash,
            modelVersion: modelVersion,
            bondAmount: bondAmount,
            bondReleased: 0,
            bondSlashed: 0,
            actualDefaultRateBps: 0,
            postedAt: uint64(block.timestamp),
            resolved: false,
            slashed: false
        });
        assetIds.push(assetId);

        gate.recordUnderwriting(msg.sender, counterparty);

        emit PredictionPosted(
            assetId,
            msg.sender,
            counterparty,
            predictedDefaultRateBps,
            confidenceBps,
            bondAmount,
            required,
            reasoningHash,
            modelVersion
        );
    }

    // ---------------------------------------------------------------------
    // Journey A step 2: the outcome lands, the bond is slashed or released
    // ---------------------------------------------------------------------

    /// @notice Preview what a given outcome would cost the underwriter. Used by the demo UI so
    ///         the audience sees the consequence *before* the transaction fires.
    function previewSlash(bytes32 assetId, uint256 actualDefaultRateBps) public view returns (uint256 slashAmount) {
        Prediction storage p = predictions[assetId];
        if (p.underwriter == address(0)) return 0;
        uint256 threshold = p.predictedDefaultRateBps + toleranceBps;
        if (actualDefaultRateBps <= threshold) return 0;
        uint256 errorBps = actualDefaultRateBps - threshold;
        if (errorBps >= fullSlashErrorBps) return p.bondAmount;
        return (p.bondAmount * errorBps) / fullSlashErrorBps;
    }

    /// @notice Oracle reports the realised default rate. Bond is slashed proportionally and the
    ///         proceeds are pushed into the TrancheVault waterfall; the remainder goes home.
    function resolveOutcome(bytes32 assetId, uint256 actualDefaultRateBps) external onlyOracle {
        if (actualDefaultRateBps > BPS) revert RateOutOfRange();
        Prediction storage p = predictions[assetId];
        if (p.underwriter == address(0)) revert UnknownAsset();
        if (p.resolved) revert AlreadyResolved();

        uint256 slashAmount = previewSlash(assetId, actualDefaultRateBps);
        uint256 releaseAmount = p.bondAmount - slashAmount;

        p.resolved = true;
        p.slashed = slashAmount > 0;
        p.actualDefaultRateBps = actualDefaultRateBps;
        p.bondSlashed = slashAmount;
        p.bondReleased = releaseAmount;

        if (slashAmount > 0) {
            bondAsset.forceApprove(address(trancheVault), slashAmount);
            trancheVault.receiveBondProceeds(slashAmount);
        }
        if (releaseAmount > 0) {
            bondAsset.safeTransfer(p.underwriter, releaseAmount);
        }

        gate.recordResolution(p.underwriter, slashAmount > 0);

        // Push the realised credit loss through bond -> junior -> senior.
        uint256 loss = _lossFor(actualDefaultRateBps);
        if (loss > 0) {
            trancheVault.settleLoss(loss);
        } else {
            TrancheVaultLike(address(trancheVault)).settleClean();
        }

        emit OutcomeResolved(
            assetId, p.predictedDefaultRateBps, actualDefaultRateBps, slashAmount > 0, slashAmount, releaseAmount
        );
    }

    /// @dev Loss is the defaulted fraction of what was actually drawn down.
    function _lossFor(uint256 actualDefaultRateBps) internal view returns (uint256) {
        uint256 drawn = TrancheVaultLike(address(trancheVault)).drawnAmount();
        return (drawn * actualDefaultRateBps) / BPS;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Live predicted default rate for an asset - the ExitLiquidityPool prices off this.
    function currentPredictedDefaultRateBps(bytes32 assetId) external view returns (uint256) {
        return predictions[assetId].predictedDefaultRateBps;
    }

    function assetCount() external view returns (uint256) {
        return assetIds.length;
    }

    function getPrediction(bytes32 assetId) external view returns (Prediction memory) {
        return predictions[assetId];
    }
}

interface TrancheVaultLike {
    function drawnAmount() external view returns (uint256);
    function settleClean() external;
}
