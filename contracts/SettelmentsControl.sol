// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    Initializable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {
    ECDSA
} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IERC20WithAuthorization is IERC20 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s        
    ) external;
}


contract SettelmentsControl is Initializable, EIP712Upgradeable {
    using SafeERC20 for IERC20WithAuthorization;

    struct ClientBalance {
        uint256 balance;
        address lastInboundAddress;
    }

    struct SettelmentContext {
        string clientId;
        uint256 clientBalance;
        string nativeId;
        address nativeAddress;
        uint256 amountToNative;
        string sessionId;
        uint256 timestamp;
        uint256 minutesQty;
        uint256 feePercentage;
        uint256 feeAmount;
        address feeCollector;
    }

    event TopUpClientBalance(
        bytes32 indexed operationId,
        string userId,
        uint256 amount,
        uint256 currentClientBalance,
        address sender
    );
    event PaymentClientToNative(
        bytes32 indexed operationId,
        SettelmentContext ctx
    );
    event NativeAddressSet(string indexed nativeId, address nativeAddress);
    event BackFundsToClient(
        bytes32 indexed operationId,
        string userId,
        address reciever,
        uint256 amount
    );
    event ChangeAdmin(address newAdmin);
    event MaxValiditySet(uint256 maxValidity);
    event FeeConfigSet(uint256 feePercentage, address feeCollector);
    event StuckFundsWithdrawn(address token, address to, uint256 amount);

    error OnlyAdmin();
    error OnlyOwner();
    error InsufficientClientBalanceForSessionSettelment(
        bytes32 operationId,
        SettelmentContext ctx
    );
    error NativeAddressIsOutForSessionSettelment(
        bytes32 operationId,
        SettelmentContext ctx
    );
    error InsufficientContractBalanceForSessionSettelment(
        bytes32 operationId,
        SettelmentContext ctx
    );

    error InsufficientClientBalanceForBackFunds(
        string clientId,
        address clientAddress,
        uint256 amount,
        uint256 clientBalance
    );

    error InsufficientContractBalanceForBackFunds(
        string clientId,
        address clientAddress,
        uint256 amount,
        uint256 clientBalance
    );
    error InvalidSignature();
    error NonceAlreadyUsed();
    error InvalidNativeAddress();
    error EmptyNativeId();
    error EmptyNonce();
    error FeeTooHigh(uint256 feePercentage);
    error InvalidFeeCollector();
    error SignatureExpired();
    error DeadlineTooFar();
    error InvalidMaxValidity();
    error InvalidAdmin();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientStuckFunds();
    error WithdrawalFailed();
    error OperationAlreadyProcessed(bytes32 operationId);
    error EmptyOperationId();

    // keccak256(abi.encode(uint256(keccak256("SettelmentsControl.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0xa3644cd4f32df58f1c4770a51fd2c07989147cd3f86e6250ba65ac2657ec7f00;

    bytes32 private constant ASSIGNMENT_TYPEHASH =
        keccak256(
            "NativeAddressAssignment(string nativeId,address nativeAddress,string nonce,uint256 deadline)"
        );

    struct ContractStorage {
        mapping(bytes32 => ClientBalance) clientBalances;
        mapping(bytes32 => address) nativeAddresses;
        mapping(bytes32 => bool) usedNonces;
        mapping(bytes32 => bool) processedOperations;
        IERC20WithAuthorization token;
        address admin;
        address owner;
        uint256 feePercentage;
        address feeCollector;
        uint256 maxValidity;
        uint256 totalClientBalance;
    }

    constructor() {
        _disableInitializers();
    }

    function _getContractStorage()
        private
        pure
        returns (ContractStorage storage $)
    {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    function _markProcessed(bytes32 operationId) internal {
        ContractStorage storage $ = _getContractStorage();
        $.processedOperations[operationId] = true;
    }

    modifier onlyAdmin() {
        ContractStorage storage $ = _getContractStorage();
        if (msg.sender != $.admin) {
            revert OnlyAdmin();
        }
        _;
    }

    modifier onlyOwner() {
        ContractStorage storage $ = _getContractStorage();
        if (msg.sender != $.owner) {
            revert OnlyOwner();
        }
        _;
    }

    function initialize(
        address _token,
        address _admin,
        address _owner,
        uint256 _feePercentage,
        address _feeCollector,
        uint256 _maxValidity
    ) external initializer {
        __EIP712_init("SettelmentsControl", "1.0");
        if (_feePercentage > 100) revert FeeTooHigh(_feePercentage);
        if (_maxValidity == 0) revert InvalidMaxValidity();
        if (
            _token == address(0) ||
            _admin == address(0) ||
            _owner == address(0) ||
            _feeCollector == address(0)
        ) {
            revert ZeroAddress();
        }
        ContractStorage storage $ = _getContractStorage();
        $.token = IERC20WithAuthorization(_token);
        $.admin = _admin;
        $.owner = _owner;
        $.feePercentage = _feePercentage;
        $.feeCollector = _feeCollector;
        $.maxValidity = _maxValidity;
        emit FeeConfigSet(_feePercentage, _feeCollector);
        emit ChangeAdmin(_admin);
    }

    function topUpClientBalance(
        bytes32 operationId,
        string calldata userId,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyAdmin {
        ContractStorage storage $ = _getContractStorage();

        if (operationId == bytes32(0)) revert EmptyOperationId();
        if ($.processedOperations[operationId]) {
            revert OperationAlreadyProcessed(operationId);
        }

        ClientBalance storage clientBalance = $.clientBalances[
            keccak256(abi.encodePacked(userId))
        ];

        $.token.receiveWithAuthorization(
            from,
            address(this),
            value,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );

        _applyTopUp(operationId, userId, from, value, clientBalance);
    }

    // Balance update + emit are extracted into a separate function to reduce
    // EVM stack depth: after adding operationId, topUpClientBalance has 10
    // parameters, and inlining the balance update + emit together with the
    // receiveWithAuthorization call triggers "Stack too deep" (compiled without
    // viaIR, audit finding C-01). Do not inline back.
    function _applyTopUp(
        bytes32 operationId,
        string calldata userId,
        address from,
        uint256 value,
        ClientBalance storage clientBalance
    ) internal {
        ContractStorage storage $ = _getContractStorage();
        clientBalance.balance += value;
        $.totalClientBalance += value;
        clientBalance.lastInboundAddress = from;

        _markProcessed(operationId);

        emit TopUpClientBalance(
            operationId,
            userId,
            value,
            clientBalance.balance,
            from
        );
    }

    function _buildSettelmentContext(
        string calldata clientId,
        string calldata nativeId,
        uint256 amount,
        string calldata sessionId,
        uint256 timestamp,
        uint256 minutesQty
    ) internal view returns (SettelmentContext memory ctx) {
        uint256 clientBalanceAmount = _getContractStorage()
            .clientBalances[keccak256(abi.encodePacked(clientId))].balance;

        address nativeAddress = _getContractStorage()
            .nativeAddresses[keccak256(abi.encodePacked(nativeId))];

        uint256 feePercentage = _getContractStorage().feePercentage;
        address feeCollector = _getContractStorage().feeCollector;

        uint256 feeAmount = (amount * feePercentage) / 100;
        uint256 amountToNative = amount - feeAmount;

        ctx.clientId = clientId;
        ctx.clientBalance = clientBalanceAmount;
        ctx.nativeId = nativeId;
        ctx.nativeAddress = nativeAddress;
        ctx.amountToNative = amountToNative;
        ctx.sessionId = sessionId;
        ctx.timestamp = timestamp;
        ctx.minutesQty = minutesQty;
        ctx.feePercentage = feePercentage;
        ctx.feeAmount = feeAmount;
        ctx.feeCollector = feeCollector;
    }

    function paymentClientToNative(
        bytes32 operationId,
        string calldata clientId,
        string calldata nativeId,
        uint256 amount,
        string calldata sessionId,
        uint256 timestamp,
        uint256 minutesQty
    ) external onlyAdmin {
        if (operationId == bytes32(0)) revert EmptyOperationId();
        if (_getContractStorage().processedOperations[operationId]) {
            revert OperationAlreadyProcessed(operationId);
        }

        if (amount == 0) revert ZeroAmount();

        bytes32 clientHash = keccak256(abi.encodePacked(clientId));

        SettelmentContext memory ctx = _buildSettelmentContext(
            clientId,
            nativeId,
            amount,
            sessionId,
            timestamp,
            minutesQty
        );

        if (ctx.nativeAddress == address(0)) {
            revert NativeAddressIsOutForSessionSettelment(operationId, ctx);
        }

        if (ctx.clientBalance < amount) {
            revert InsufficientClientBalanceForSessionSettelment(
                operationId,
                ctx
            );
        }

        IERC20WithAuthorization token = _getContractStorage().token;

        uint256 contractBalance = token.balanceOf(address(this));

        if (contractBalance < amount) {
            revert InsufficientContractBalanceForSessionSettelment(
                operationId,
                ctx
            );
        }

        if (ctx.amountToNative > 0) {
            token.safeTransfer(ctx.nativeAddress, ctx.amountToNative);
        }

        if (ctx.feeAmount > 0) {
            token.safeTransfer(ctx.feeCollector, ctx.feeAmount);
        }

        _getContractStorage().clientBalances[clientHash].balance -= amount;
        _getContractStorage().totalClientBalance -= amount;

        _markProcessed(operationId);

        emit PaymentClientToNative(operationId, ctx);
    }

    function backFundsToClient(
        bytes32 operationId,
        string calldata userId,
        uint256 amount
    ) external onlyAdmin {
        if (operationId == bytes32(0)) revert EmptyOperationId();
        if (_getContractStorage().processedOperations[operationId]) {
            revert OperationAlreadyProcessed(operationId);
        }

        if (amount == 0) revert ZeroAmount();
        ContractStorage storage $ = _getContractStorage();
        ClientBalance storage balance = $.clientBalances[
            keccak256(abi.encodePacked(userId))
        ];
        address lastAddress = balance.lastInboundAddress;
        uint256 currentBalance = balance.balance;
        if (currentBalance < amount) {
            revert InsufficientClientBalanceForBackFunds(
                userId,
                lastAddress,
                amount,
                currentBalance
            );
        }

        IERC20WithAuthorization token = $.token;

        uint256 contractBalance = token.balanceOf(address(this));

        if (contractBalance < amount) {
            revert InsufficientContractBalanceForBackFunds(
                userId,
                lastAddress,
                amount,
                currentBalance
            );
        }
        
        token.safeTransfer(lastAddress, amount);

        balance.balance = currentBalance - amount;
        $.totalClientBalance -= amount;

        _markProcessed(operationId);

        emit BackFundsToClient(operationId, userId, lastAddress, amount);
    }

    function getBalance(
        string calldata userId
    ) external view returns (ClientBalance memory) {
        bytes32 userHash = keccak256(abi.encodePacked(userId));
        ContractStorage storage $ = _getContractStorage();
        ClientBalance memory userBalance = $.clientBalances[userHash];
        return userBalance;
    }


    function changeAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert InvalidAdmin();
        ContractStorage storage $ = _getContractStorage();
        $.admin = newAdmin;
        emit ChangeAdmin(newAdmin);
    }

    function getAdmin() external view returns (address) {
        ContractStorage storage $ = _getContractStorage();
        return $.admin;
    }

    function getMaxValidity() external view returns (uint256) {
        return _getContractStorage().maxValidity;
    }

    function setMaxValidity(uint256 newMaxValidity) external onlyOwner {
        if (newMaxValidity == 0) revert InvalidMaxValidity();
        _getContractStorage().maxValidity = newMaxValidity;
        emit MaxValiditySet(newMaxValidity);
    }

    function isNonceUsed(string calldata nonce) external view returns (bool) {
        ContractStorage storage $ = _getContractStorage();
        bytes32 nonceHash = keccak256(abi.encodePacked(nonce));
        return $.usedNonces[nonceHash];
    }

    function _verifyAssignmentSignature(
        string calldata nativeId,
        address nativeAddress,
        string calldata nonce,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                ASSIGNMENT_TYPEHASH,
                keccak256(bytes(nativeId)),
                nativeAddress,
                keccak256(bytes(nonce)),
                deadline
            )
        );

        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(
            _hashTypedDataV4(structHash),
            v,
            r,
            s
        );

        if (err != ECDSA.RecoverError.NoError || signer != nativeAddress) {
            revert InvalidSignature();
        }
    }

    function setNativeAddressWithSignature(
        string calldata nativeId,
        address nativeAddress,
        string calldata nonce,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyAdmin {

        if (bytes(nativeId).length == 0) {
            revert EmptyNativeId();
        }
        if (nativeAddress == address(0)) {
            revert InvalidNativeAddress();
        }
        if (bytes(nonce).length == 0) {
            revert EmptyNonce();
        }

        ContractStorage storage $ = _getContractStorage();

        bytes32 nonceHash = keccak256(abi.encodePacked(nonce));
        if ($.usedNonces[nonceHash]) {
            revert NonceAlreadyUsed();
        }

        if (block.timestamp > deadline) {
            revert SignatureExpired();
        }

        if (deadline - block.timestamp > $.maxValidity) {
            revert DeadlineTooFar();
        }

        _verifyAssignmentSignature(
            nativeId,
            nativeAddress,
            nonce,
            deadline,
            v,
            r,
            s
        );

        $.usedNonces[nonceHash] = true;

        $.nativeAddresses[keccak256(abi.encodePacked(nativeId))] = nativeAddress;

        emit NativeAddressSet(nativeId, nativeAddress);
    }

    function getNativeAddress(
        string calldata nativeId
    ) external view returns (address) {
        bytes32 nativeHash = keccak256(abi.encodePacked(nativeId));
        ContractStorage storage $ = _getContractStorage();
        return $.nativeAddresses[nativeHash];
    }

    function isNativeAddressSet(
        string calldata nativeId
    ) external view returns (bool) {
        bytes32 nativeHash = keccak256(abi.encodePacked(nativeId));
        ContractStorage storage $ = _getContractStorage();
        return $.nativeAddresses[nativeHash] != address(0);
    }

    function setFeeConfig(
        uint256 feePercentage,
        address feeCollector
    ) external onlyOwner {
        if (feePercentage > 100) revert FeeTooHigh(feePercentage);
        if (feeCollector == address(0)) revert InvalidFeeCollector();
        
        ContractStorage storage $ = _getContractStorage();
        $.feePercentage = feePercentage;
        $.feeCollector = feeCollector;
        emit FeeConfigSet(feePercentage, feeCollector);
    }

    function getFeeConfig() external view returns (uint256 feePercentage, address feeCollector) {
        ContractStorage storage $ = _getContractStorage();
        return ($.feePercentage, $.feeCollector);
    }

    function getTotalClientBalance() external view returns (uint256) {
        return _getContractStorage().totalClientBalance;
    }

    function withdrawStuckTokens(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) revert ZeroAddress();

        uint256 contractBalance = IERC20(token).balanceOf(address(this));

        uint256 available;
        if (token == address(_getContractStorage().token)) {
            uint256 total = _getContractStorage().totalClientBalance;
            available = contractBalance > total
                ? contractBalance - total
                : 0;
        } else {
            available = contractBalance;
        }

        if (amount > available) revert InsufficientStuckFunds();

        SafeERC20.safeTransfer(IERC20(token), to, amount);

        emit StuckFundsWithdrawn(token, to, amount);
    }

    function withdrawStuckNative(
        address payable to,
        uint256 amount
    ) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance) revert InsufficientStuckFunds();

        (bool success, ) = to.call{value: amount}("");
        if (!success) revert WithdrawalFailed();

        emit StuckFundsWithdrawn(address(0), to, amount);
    }
}
