// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITrancheVault, Tranche} from "./interfaces/ITrancheVault.sol";
import {TrancheShare} from "./TrancheShare.sol";

/**
 * @title TrancheVault
 * @notice Holds the deal's cash and owns the loss waterfall. Two ERC-4626 TrancheShare vaults
 *         (senior + junior) sit on top and delegate their NAV here.
 *
 * Lifecycle
 *   Open     -> senior/junior deposits accepted (only after a prediction + bond exist)
 *   Funded   -> capital drawn down to the originator; nobody can redeem; the ONLY way out
 *               early is selling into the ExitLiquidityPool
 *   Settled  -> repayment recorded, loss run through the waterfall, redemptions open
 *
 * Loss waterfall, in strict order:
 *   1. the underwriter's slashed bond
 *   2. junior principal
 *   3. senior principal
 *
 * If the slashed bond exceeds the realised loss, the surplus is credited to junior - they are
 * the first-loss taker, so they are the ones the overage belongs to.
 *
 * Cash invariant, asserted in the test suite:
 *   after settle+finalize:  asset.balanceOf(this) == seniorAssets + juniorAssets
 */
contract TrancheVault is ITrancheVault, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;

    enum Status {
        Uninitialised,
        Open,
        Funded,
        Settled
    }

    IERC20 public immutable asset;
    TrancheShare public senior;
    TrancheShare public junior;

    address public underwriterVault;
    address public originator;

    Status public status;
    bytes32 public assetId;
    uint64 public maturity;

    /// Accounting balance attributable to each class. Losses are applied here.
    uint256 public seniorAssets;
    uint256 public juniorAssets;

    /// Slashed underwriter bond sitting as first-loss cover.
    uint256 public bondCover;

    /// Capital drawn down to the originator, and what has come back.
    uint256 public drawnAmount;
    uint256 public repaidAmount;

    /// Senior may not exceed this share of the stack - junior has to be thick enough to matter.
    uint256 public maxSeniorRatioBps = 8_000;

    event Initialised(bytes32 indexed assetId, address senior, address junior, uint64 maturity);
    event Deposited(Tranche indexed tranche, uint256 assets, uint256 newTrancheAssets);
    event Withdrawn(Tranche indexed tranche, uint256 assets, address receiver);
    event Drawdown(address indexed originator, uint256 amount);
    event RepaymentRecorded(uint256 amount, uint256 totalRepaid);
    event BondProceedsReceived(uint256 amount, uint256 totalBondCover);
    event LossSettled(uint256 loss, uint256 fromBond, uint256 fromJunior, uint256 fromSenior);
    event BondSurplusToJunior(uint256 surplus);
    event Finalised(uint256 seniorAssets, uint256 juniorAssets, uint256 cash);

    error WrongStatus(Status expected, Status actual);
    error OnlyUnderwriterVault();
    error OnlyShareVault();
    error SeniorTooThick();

    modifier onlyStatus(Status s) {
        if (status != s) revert WrongStatus(s, status);
        _;
    }

    modifier onlyUnderwriterVault() {
        if (msg.sender != underwriterVault) revert OnlyUnderwriterVault();
        _;
    }

    modifier onlyShareVault() {
        if (msg.sender != address(senior) && msg.sender != address(junior)) revert OnlyShareVault();
        _;
    }

    constructor(IERC20 asset_, address initialOwner) Ownable(initialOwner) {
        asset = asset_;
    }

    // ---------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------

    function initialise(
        bytes32 assetId_,
        uint64 maturity_,
        address underwriterVault_,
        address originator_,
        string memory namePrefix
    ) external onlyOwner onlyStatus(Status.Uninitialised) {
        require(maturity_ > block.timestamp, "maturity in past");
        assetId = assetId_;
        maturity = maturity_;
        underwriterVault = underwriterVault_;
        originator = originator_;

        senior = new TrancheShare(
            asset, string.concat(namePrefix, " Senior"), string.concat(namePrefix, "-SR"), address(this), Tranche.Senior
        );
        junior = new TrancheShare(
            asset, string.concat(namePrefix, " Junior"), string.concat(namePrefix, "-JR"), address(this), Tranche.Junior
        );

        status = Status.Open;
        emit Initialised(assetId_, address(senior), address(junior), maturity_);
    }

    function setMaxSeniorRatioBps(uint256 bps) external onlyOwner {
        require(bps <= BPS, "ratio > 100%");
        maxSeniorRatioBps = bps;
    }

    // ---------------------------------------------------------------------
    // Views used by the ERC-4626 share vaults
    // ---------------------------------------------------------------------

    function trancheAssets(Tranche tranche) public view returns (uint256) {
        return tranche == Tranche.Senior ? seniorAssets : juniorAssets;
    }

    function depositsOpen() external view returns (bool) {
        return status == Status.Open;
    }

    /**
     * @notice Whether a holder may take their money out right now.
     *
     * @dev Open, because nothing has been drawn yet and changing your mind before a
     *      deal starts should not cost you your capital. Settled, because the deal is
     *      finished. Funded is deliberately excluded: that is the whole premise, the
     *      cash is with the originator and financing real invoices, and the exit pool
     *      exists precisely because this door is shut.
     */
    function redemptionsOpen() external view returns (bool) {
        return status == Status.Open || status == Status.Settled;
    }

    function totalTrancheAssets() external view returns (uint256) {
        return seniorAssets + juniorAssets;
    }

    /// @notice Attachment point: the fraction of the stack that has to burn before senior is hit.
    function seniorProtectionBps() external view returns (uint256) {
        uint256 total = seniorAssets + juniorAssets;
        if (total == 0) return 0;
        return ((juniorAssets + bondCover) * BPS) / total;
    }

    // ---------------------------------------------------------------------
    // Share vault callbacks
    // ---------------------------------------------------------------------

    function onDeposit(Tranche tranche, uint256 assets) external onlyShareVault onlyStatus(Status.Open) {
        if (tranche == Tranche.Senior) {
            seniorAssets += assets;
        } else {
            juniorAssets += assets;
        }
        uint256 total = seniorAssets + juniorAssets;
        if (total > 0 && (seniorAssets * BPS) / total > maxSeniorRatioBps) revert SeniorTooThick();
        emit Deposited(tranche, assets, trancheAssets(tranche));
    }

    /**
     * @notice Pay a holder out. Allowed while the deal is still Open, and again once Settled.
     *
     * @dev This used to be Settled only, which made a deposit into an Open deal a one
     *      way door. Nothing has been drawn at that point: the cash is sitting in this
     *      contract untouched, the originator has not seen it, and no risk has been
     *      taken. Locking somebody in before the deal has even started is not the
     *      promise the protocol makes. The promise is that you cannot redeem once the
     *      money is out working, and that is Status.Funded, which remains closed.
     *
     *      Junior leaving while Open can push the senior share of a smaller stack past
     *      the ratio cap, so the cap is re-checked on the way out exactly as it is on
     *      the way in. Senior leaving can only improve the ratio, but the same check
     *      covers both and costs nothing.
     */
    function onWithdraw(Tranche tranche, uint256 assets, address receiver) external onlyShareVault {
        if (status != Status.Open && status != Status.Settled) {
            revert WrongStatus(Status.Settled, status);
        }

        if (tranche == Tranche.Senior) {
            seniorAssets -= assets;
        } else {
            juniorAssets -= assets;
        }

        if (status == Status.Open) {
            uint256 total = seniorAssets + juniorAssets;
            if (total > 0 && (seniorAssets * BPS) / total > maxSeniorRatioBps) revert SeniorTooThick();
        }

        asset.safeTransfer(receiver, assets);
        emit Withdrawn(tranche, assets, receiver);
    }

    // ---------------------------------------------------------------------
    // Deal lifecycle
    // ---------------------------------------------------------------------

    /// @notice Draw the raised capital down to the originator and lock the deal.
    function fund(uint256 amount) external onlyOwner onlyStatus(Status.Open) {
        require(amount > 0 && amount <= seniorAssets + juniorAssets, "bad drawdown");
        require(juniorAssets > 0, "no first-loss capital");
        drawnAmount = amount;
        status = Status.Funded;
        asset.safeTransfer(originator, amount);
        emit Drawdown(originator, amount);
    }

    /// @notice Originator returns principal (net of whatever defaulted) at maturity.
    function recordRepayment(uint256 amount) external onlyStatus(Status.Funded) {
        asset.safeTransferFrom(msg.sender, address(this), amount);
        repaidAmount += amount;
        emit RepaymentRecorded(amount, repaidAmount);
    }

    /// @notice UnderwriterVault pushes slashed bond in. Becomes first-loss cover.
    function receiveBondProceeds(uint256 amount) external onlyUnderwriterVault {
        if (amount == 0) return;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        bondCover += amount;
        emit BondProceedsReceived(amount, bondCover);
    }

    /// @notice Run a realised loss through bond -> junior -> senior. Called at resolution.
    function settleLoss(uint256 loss) external onlyUnderwriterVault onlyStatus(Status.Funded) {
        uint256 remaining = loss;

        uint256 fromBond = remaining < bondCover ? remaining : bondCover;
        bondCover -= fromBond;
        remaining -= fromBond;

        uint256 fromJunior = remaining < juniorAssets ? remaining : juniorAssets;
        juniorAssets -= fromJunior;
        remaining -= fromJunior;

        uint256 fromSenior = remaining < seniorAssets ? remaining : seniorAssets;
        seniorAssets -= fromSenior;
        remaining -= fromSenior;

        emit LossSettled(loss, fromBond, fromJunior, fromSenior);

        // Bond over-covered the loss: the excess belongs to the first-loss taker.
        if (bondCover > 0) {
            juniorAssets += bondCover;
            emit BondSurplusToJunior(bondCover);
            bondCover = 0;
        }

        status = Status.Settled;
        emit Finalised(seniorAssets, juniorAssets, asset.balanceOf(address(this)));
    }

    /// @notice Escape hatch: settle a deal that repaid in full with no loss to run.
    function settleClean() external onlyUnderwriterVault onlyStatus(Status.Funded) {
        if (bondCover > 0) {
            juniorAssets += bondCover;
            emit BondSurplusToJunior(bondCover);
            bondCover = 0;
        }
        status = Status.Settled;
        emit Finalised(seniorAssets, juniorAssets, asset.balanceOf(address(this)));
    }

    /// @notice Cash held minus what the tranches are owed. Should be zero after a clean settle.
    function cashSurplus() external view returns (int256) {
        return int256(asset.balanceOf(address(this))) - int256(seniorAssets + juniorAssets);
    }
}
