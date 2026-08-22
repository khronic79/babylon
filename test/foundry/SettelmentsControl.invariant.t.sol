// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {SettelmentsControl} from "../../contracts/SettelmentsControl.sol";
import {SettelmentsControlProxy} from "../../contracts/SettelmentsControlProxy.sol";
import {ERC20Mock} from "../../contracts/mock/ERC20Mock.sol";

// Handler крутит topUp/payment/backFunds от имени admin через vm.prank.
// Revert'ы (недостаток баланса и т.п.) — ожидаемы и игнорируются invariant-раннером.
contract SettelmentsControlHandler is BaseTest {
    uint256 private nonceCounter;

    constructor(
        SettelmentsControl _control,
        ERC20Mock _token,
        address _proxy,
        address _admin,
        address _user1,
        address _user2
    ) {
        control = _control;
        token = _token;
        proxy = SettelmentsControlProxy(payable(_proxy));
        admin = _admin;
        user1 = _user1;
        user2 = _user2;
        native = address(0);
        owner = address(this);
        feeCollector = address(0);
        feePercentage = 10;
        maxValidity = 1 days;
    }

    // Пустой override: не даём invariant-раннеру вызывать BaseTest.setUp (который
    // передеплоил бы контракты в хранилище handler'а и сломал инвариант).
    function setUp() public override {}

    function _nextNonce() private returns (bytes32) {
        nonceCounter++;
        return bytes32(nonceCounter);
    }

    function topUp(uint256 value, uint256 seed) external {
        bool isAlice = seed % 2 == 0;
        address from = isAlice ? user1 : user2;
        uint256 pk = isAlice ? USER1_PK : USER2_PK;
        string memory userId = isAlice ? "alice" : "bob";
        // Ограничиваем потолок, чтобы аккаунты не истощались одним топ-апом
        // и живых (не ревертящих) последовательностей было больше.
        value = bound(value, 1, 1e20);
        _topUp(from, pk, userId, value, _nextNonce());
    }

    function payment(uint256 amount, uint256 seed) external {
        bool isAlice = seed % 2 == 0;
        string memory userId = isAlice ? "alice" : "bob";
        amount = bound(amount, 1, 1e20);
        vm.prank(admin);
        control.paymentClientToNative(
            userId,
            "native-1",
            amount,
            "s",
            block.timestamp,
            30
        );
    }

    function backFunds(uint256 amount, uint256 seed) external {
        bool isAlice = seed % 2 == 0;
        string memory userId = isAlice ? "alice" : "bob";
        amount = bound(amount, 1, 1e20);
        vm.prank(admin);
        control.backFundsToClient(userId, amount);
    }
}

contract SettelmentsControlInvariant is BaseTest {
    string[] private users;
    SettelmentsControlHandler private handler;

    function setUp() public override {
        super.setUp();
        _setNative(native, NATIVE_PK, "native-1", "invariant-native");
        users = new string[](2);
        users[0] = "alice";
        users[1] = "bob";
        handler = new SettelmentsControlHandler(
            control,
            token,
            address(proxy),
            admin,
            user1,
            user2
        );
        targetContract(address(handler));
        // setUp — не бизнес-функция; исключаем из фаззинга, чтобы не тратить вызовы.
        bytes4[] memory excluded = new bytes4[](1);
        excluded[0] = SettelmentsControlHandler.setUp.selector;
        excludeSelector(FuzzSelector({addr: address(handler), selectors: excluded}));
    }

    function invariant_totalMatchesSum() public view {
        uint256 sum = 0;
        for (uint256 i = 0; i < users.length; i++) {
            sum += control.getBalance(users[i]).balance;
        }
        assertEq(control.getTotalClientBalance(), sum);
    }
}
