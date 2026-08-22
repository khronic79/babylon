// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20Mock} from "../../contracts/mock/ERC20Mock.sol";
import {SettelmentsControl} from "../../contracts/SettelmentsControl.sol";
import {SettelmentsControlProxy} from "../../contracts/SettelmentsControlProxy.sol";

// Общая база: деплой ERC20Mock → имплементация → прокси с атомарной инициализацией
// (обход _disableInitializers), плюс хелперы EIP-712/EIP-3009 подписей.
contract BaseTest is Test {
    ERC20Mock internal token;
    SettelmentsControl internal control;
    SettelmentsControlProxy internal proxy;

    address internal owner;
    address internal admin;
    address internal feeCollector;
    address internal user1;
    address internal user2;
    address internal native;

    uint256 internal constant USER1_PK = 0xA11CE;
    uint256 internal constant USER2_PK = 0xB0B;
    uint256 internal constant NATIVE_PK = 0xC0DE;

    uint256 internal feePercentage = 10;
    uint256 internal maxValidity = 1 days;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 internal constant RECEIVE_WITH_AUTH_TYPEHASH =
        keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );
    bytes32 internal constant ASSIGNMENT_TYPEHASH =
        keccak256(
            "NativeAddressAssignment(string nativeId,address nativeAddress,string nonce,uint256 deadline)"
        );

    function setUp() public virtual {
        owner = address(this);
        admin = makeAddr("admin");
        feeCollector = makeAddr("feeCollector");
        user1 = vm.addr(USER1_PK);
        user2 = vm.addr(USER2_PK);
        native = vm.addr(NATIVE_PK);

        token = new ERC20Mock("BabylonTest", "BT", owner, 1_000_000e18);
        token.mint(user1, 1_000_000e18);
        token.mint(user2, 1_000_000e18);
        token.mint(native, 1_000_000e18);

        SettelmentsControl impl = new SettelmentsControl();
        bytes memory data = abi.encodeCall(
            SettelmentsControl.initialize,
            (
                address(token),
                admin,
                owner,
                feePercentage,
                feeCollector,
                maxValidity
            )
        );
        proxy = new SettelmentsControlProxy(address(impl), data);
        control = SettelmentsControl(address(proxy));
    }

    // Домен токена: EIP712("BabylonTest", "2").
    function tokenDomainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN_TYPEHASH,
                    keccak256("BabylonTest"),
                    keccak256("2"),
                    block.chainid,
                    address(token)
                )
            );
    }

    // Домен реализации: EIP712("SettelmentsControl", "1.0"), verifyingContract = прокси.
    function assignmentDomainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN_TYPEHASH,
                    keccak256("SettelmentsControl"),
                    keccak256("1.0"),
                    block.chainid,
                    address(proxy)
                )
            );
    }

    function _signReceive(
        uint256 pk,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTH_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", tokenDomainSeparator(), structHash)
        );
        (v, r, s) = vm.sign(pk, digest);
    }

    function _signAssignment(
        uint256 pk,
        string memory nativeId,
        address nativeAddress,
        string memory nonce,
        uint256 deadline
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                ASSIGNMENT_TYPEHASH,
                keccak256(bytes(nativeId)),
                nativeAddress,
                keccak256(bytes(nonce)),
                deadline
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", assignmentDomainSeparator(), structHash)
        );
        (v, r, s) = vm.sign(pk, digest);
    }

    function _topUp(
        address from,
        uint256 pk,
        string memory userId,
        uint256 value,
        bytes32 nonce
    ) internal {
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(
            pk,
            from,
            address(proxy),
            value,
            validAfter,
            validBefore,
            nonce
        );
        vm.prank(admin);
        control.topUpClientBalance(
            userId,
            from,
            value,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );
    }

    function _setNative(
        address nativeAddress,
        uint256 pk,
        string memory nativeId,
        string memory nonce
    ) internal {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signAssignment(
            pk,
            nativeId,
            nativeAddress,
            nonce,
            deadline
        );
        vm.prank(admin);
        control.setNativeAddressWithSignature(
            nativeId,
            nativeAddress,
            nonce,
            deadline,
            v,
            r,
            s
        );
    }
}
