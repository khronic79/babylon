import { ethers, network } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("SettelmentsControlProxy", function () {
  async function deploySettelmentsControlProxyFixture() {
    const [owner, admin, user1, user2] = await ethers.getSigners();

    // ERC20 token deploy
    const Token = await ethers.getContractFactory("ERC20Mock");
    const initialSupply = BigInt(1000000) * BigInt(10 ** 18);
    const token = await Token.deploy(
      "Test Token",
      "TTK",
      owner.address,
      initialSupply,
    );

    // Implimentation deploy
    const Implementation =
      await ethers.getContractFactory("SettelmentsControl");
    const implementation = await Implementation.deploy();

    // Proxy init
    const Proxy = await ethers.getContractFactory("SettelmentsControlProxy");
    const proxy = await Proxy.deploy(implementation.target);

    // Connection to implimentation via proxy
    const proxyUsed = await ethers.getContractAt(
      "SettelmentsControl",
      proxy.target,
    );

    const initializer = new ethers.Wallet(
      `0x${process.env.PRIVATE_KEY}`,
      ethers.provider,
    );

    await network.provider.send("hardhat_setBalance", [
      initializer.address,
      "0x" + ethers.parseEther("100").toString(16),
    ]);

    await proxyUsed
      .connect(initializer)
      .initialize(token.target, admin.address);

    return {
      implementation,
      proxy,
      token,
      proxyUsed,
      owner,
      admin,
      user1,
      user2,
    };
  }

  describe("Proxy initialization", function () {
    it("Should set correct admin on deployment", async function () {
      const { proxy, owner } = await loadFixture(
        deploySettelmentsControlProxyFixture,
      );
      expect(await proxy.getProxyAdmin()).to.equal(owner.address);
    });

    it("Should return correct implementation", async function () {
      const { proxy, implementation } = await loadFixture(
        deploySettelmentsControlProxyFixture,
      );
      expect(await proxy.getImpl()).to.equal(implementation.target);
    });
  });

  describe("Admin functions", function () {
    it("Should allow admin to change admin", async function () {
      const { proxy, admin } = await loadFixture(
        deploySettelmentsControlProxyFixture,
      );
      await proxy.changeProxyAdmin(admin.address);
      expect(await proxy.getProxyAdmin()).to.equal(admin.address);
    });

    it("Should prevent non-admin from changing admin", async function () {
      const { proxy, user1 } = await loadFixture(
        deploySettelmentsControlProxyFixture,
      );
      await expect(
        proxy.connect(user1).changeProxyAdmin(user1.address),
      ).to.be.revertedWithCustomError(proxy, "OnlyAdmin");
    });

    it("Should allow admin to upgrade implementation", async function () {
      const { proxy, admin } = await loadFixture(
        deploySettelmentsControlProxyFixture,
      );
      const NewImplementation =
        await ethers.getContractFactory("SettelmentsControl");
      const newImplementation = await NewImplementation.deploy();
      await proxy.changeProxyAdmin(admin.address);
      await proxy.connect(admin).setImpl(newImplementation.target);
      expect(await proxy.getImpl()).to.equal(newImplementation.target);
    });

    it("Should prevent non-admin from upgrading implementation", async function () {
      const { proxy, user1 } = await loadFixture(
        deploySettelmentsControlProxyFixture,
      );
      const NewImplementation =
        await ethers.getContractFactory("SettelmentsControl");
      const newImplementation = await NewImplementation.deploy();
      await expect(
        proxy.connect(user1).setImpl(newImplementation.target),
      ).to.be.revertedWithCustomError(proxy, "OnlyAdmin");
    });
  });

  describe("ETH handling", function () {
    it("Should reject direct ETH transfers", async function () {
      const { proxy, user1 } = await loadFixture(
        deploySettelmentsControlProxyFixture,
      );
      await expect(
        user1.sendTransaction({
          to: await proxy.getAddress(),
          value: ethers.parseEther("1.0"),
        }),
      ).to.be.revertedWithCustomError(proxy, "NotAcceptEtherDirectly");
    });
  });
  describe("Using impl via proxy", function () {
    describe("TopUpClientBalance", function () {
      it("should increase client balance correctly", async function () {
        const { proxyUsed, token, user1 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );

        const userId = "user123";
        const amount = 1000n;

        await token.mint(user1.address, amount);

        await token.connect(user1).approve(proxyUsed.target, amount);
        await expect(
          proxyUsed.connect(user1).topUpClientBalance(amount, userId),
        )
          .to.emit(proxyUsed, "TopUpClientBalance")
          .withArgs(userId, amount, amount, user1.address);

        const balance = await proxyUsed.getBalance(userId);
        expect(balance.clientBalance).to.equal(amount);
        expect(balance.nativeBalance).to.equal(0);
      });

      it("should reject if token transfer fails", async function () {
        const { proxyUsed, token, user1 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );

        const userId = "user123";
        const amount = 1000;

        await expect(
          proxyUsed.connect(user1).topUpClientBalance(amount, userId),
        ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
      });
    });

    describe("PaymentClientToNative", function () {
      it("should transfer funds from client to native correctly", async function () {
        const { proxyUsed, token, admin, user1 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );
        const clientId = "client123";
        const nativeId = "native456";
        const amount = 500;

        await token.mint(user1.address, amount);

        await token.connect(user1).approve(proxyUsed.target, amount);
        await proxyUsed.connect(user1).topUpClientBalance(amount, clientId);

        await expect(
          proxyUsed
            .connect(admin)
            .paymentClientToNative(clientId, nativeId, amount),
        )
          .to.emit(proxyUsed, "PaymentClientToNative")
          .withArgs(clientId, 0, nativeId, amount, amount);

        const clientBalance = await proxyUsed.getBalance(clientId);
        const nativeBalance = await proxyUsed.getBalance(nativeId);

        expect(clientBalance.clientBalance).to.equal(0);
        expect(clientBalance.nativeBalance).to.equal(0);
        expect(nativeBalance.clientBalance).to.equal(0);
        expect(nativeBalance.nativeBalance).to.equal(amount);
      });

      it("should reject if not enough client balance", async function () {
        const { proxyUsed, admin } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );

        const clientId = "client123";
        const nativeId = "native456";
        const amount = 500;

        await expect(
          proxyUsed
            .connect(admin)
            .paymentClientToNative(clientId, nativeId, amount),
        ).to.be.revertedWithCustomError(proxyUsed, "InsufficientClientBalance");
      });

      it("should reject if called by non-admin", async function () {
        const { proxyUsed, user1 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );
        await expect(
          proxyUsed
            .connect(user1)
            .paymentClientToNative("client123", "native456", 100),
        ).to.be.revertedWithCustomError(proxyUsed, "OnlyAdmin");
      });
    });

    describe("WithdrawFundsToNative", function () {
      it("should withdraw native funds correctly", async function () {
        const { token, proxyUsed, admin, user1, user2 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );

        const clientId = "tempClient";
        const nativeId = "native123";
        const amount = 300;
        const receiver = user2.address;

        await token.mint(user1.address, amount);

        await token.connect(user1).approve(proxyUsed.target, amount);
        await proxyUsed.connect(user1).topUpClientBalance(amount, clientId);
        await proxyUsed
          .connect(admin)
          .paymentClientToNative(clientId, nativeId, amount);

        const initialReceiverBalance = await token.balanceOf(receiver);
        await expect(
          proxyUsed
            .connect(admin)
            .withdrawFundsToNative(nativeId, receiver, amount),
        )
          .to.emit(proxyUsed, "WithdrawFundsToNative")
          .withArgs(nativeId, receiver, amount);

        // Check balances
        const nativeBalance = await proxyUsed.getBalance(nativeId);
        expect(nativeBalance.nativeBalance).to.equal(0);
        expect(await token.balanceOf(receiver)).to.equal(
          initialReceiverBalance + BigInt(amount),
        );
      });

      it("should reject if not enough native balance", async function () {
        const { proxyUsed, admin, user2 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );

        await expect(
          proxyUsed
            .connect(admin)
            .withdrawFundsToNative("nonexistent", user2.address, 100),
        ).to.be.revertedWithCustomError(proxyUsed, "InsufficientNativeBalance");
      });

      it("should reject if called by non-admin", async function () {
        const { proxyUsed, user1, user2 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );

        await expect(
          proxyUsed
            .connect(user1)
            .withdrawFundsToNative("any", user2.address, 100),
        ).to.be.revertedWithCustomError(proxyUsed, "OnlyAdmin");
      });
    });

    describe("BackFundsToClient", function () {
      it("should return client funds correctly", async function () {
        const { token, proxyUsed, admin, user1, user2 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );

        const clientId = "client123";
        const amount = 200;
        const receiver = user2.address;

        await token.mint(user1.address, amount);

        await token.connect(user1).approve(proxyUsed.target, amount);
        await proxyUsed.connect(user1).topUpClientBalance(amount, clientId);

        const initialReceiverBalance = await token.balanceOf(receiver);
        await expect(
          proxyUsed
            .connect(admin)
            .backFundsToClient(clientId, receiver, amount),
        )
          .to.emit(proxyUsed, "BackFundsToClient")
          .withArgs(clientId, receiver, amount);

        const clientBalance = await proxyUsed.getBalance(clientId);
        expect(clientBalance.clientBalance).to.equal(0);
        expect(await token.balanceOf(receiver)).to.equal(
          initialReceiverBalance + BigInt(amount),
        );
      });

      it("should reject if not enough client balance", async function () {
        const { proxyUsed, admin, user2 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );

        await expect(
          proxyUsed
            .connect(admin)
            .backFundsToClient("nonexistent", user2.address, 100),
        ).to.be.revertedWithCustomError(proxyUsed, "InsufficientNativeBalance");
      });

      it("should reject if called by non-admin", async function () {
        const { proxyUsed, user1, user2 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );

        await expect(
          proxyUsed.connect(user1).backFundsToClient("any", user2.address, 100),
        ).to.be.revertedWithCustomError(proxyUsed, "OnlyAdmin");
      });
    });

    describe("WithdrawTokens", function () {
      it("should allow admin to withdraw tokens", async function () {
        const { token, proxyUsed, admin, user1 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );

        const amount = 1000;
        const receiver = user1.address;

        await token.transfer(await proxyUsed.getAddress(), amount);

        const initialReceiverBalance = await token.balanceOf(receiver);
        await proxyUsed.connect(admin).withdrawTokens(receiver, amount);

        expect(await token.balanceOf(receiver)).to.equal(
          initialReceiverBalance + BigInt(amount),
        );
      });

      it("should reject if called by non-admin", async function () {
        const { proxyUsed, user1 } = await loadFixture(
          deploySettelmentsControlProxyFixture,
        );

        await expect(
          proxyUsed.connect(user1).withdrawTokens(user1.address, 100),
        ).to.be.revertedWithCustomError(proxyUsed, "OnlyAdmin");
      });
    });
  });
});
