// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

// Минимальный интерфейс EIP-3009 (USDC на Polygon).
interface IERC3009 {
    function version() external view returns (string memory);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
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

// F-4: fork Polygon mainnet, проверка реального USDC (EIP-3009).
//
// Требует внешнего RPC: POLYGON_RPC_URL (default https://polygon-rpc.com).
// Skip-гвард: при FORK_TESTS=0 (default) тесты пропускаются — в offline-среде не падают.
contract USDCForkTest is Test {
    address internal constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;

    // Аккаунт-подписант (произвольный известный приватный ключ).
    uint256 internal constant SIGNER_PK = 0x123456;
    address internal signer;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 internal constant RECEIVE_WITH_AUTH_TYPEHASH =
        keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    function setUp() public {
        signer = vm.addr(SIGNER_PK);
        if (vm.envOr("FORK_TESTS", uint256(0)) == 0) {
            vm.skip(true);
            return;
        }
        string memory rpc = vm.envOr(
            "POLYGON_RPC_URL",
            string("https://polygon-rpc.com")
        );
        uint256 blockNumber = vm.envOr(
            "POLYGON_FORK_BLOCK",
            uint256(66000000)
        );
        vm.createSelectFork(rpc, blockNumber);
    }

    function test_USDC_version() public {
        assertEq(IERC3009(USDC).version(), "2");
    }

    // Проверка, что split-сигнатура (v, r, s) валидируется так же, как в моке:
    // подписанный receiveWithAuthorization проходит, балансы меняются.
    function test_USDC_receiveWithAuthorization() public {
        address holder = vm.envOr(
            "USDC_HOLDER",
            address(0x28C6c06298d514Db089934071355E5743bf21d60)
        );

        uint256 amount = 100e6; // 100 USDC (6 decimals)
        // Финансируем подписанта от известного держателя.
        vm.prank(holder);
        IERC3009(USDC).transfer(signer, amount);

        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;
        bytes32 nonce = keccak256("usdc-fork-nonce");

        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("USD Coin"),
                keccak256("2"),
                block.chainid,
                USDC
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTH_TYPEHASH,
                signer,
                address(this),
                amount,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, digest);

        uint256 before = IERC3009(USDC).balanceOf(address(this));
        IERC3009(USDC).receiveWithAuthorization(
            signer,
            address(this),
            amount,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );

        assertEq(IERC3009(USDC).balanceOf(address(this)), before + amount);
        assertEq(IERC3009(USDC).balanceOf(signer), 0);
    }
}
