import {
  assert,
  describe,
  test,
  clearStore,
  beforeAll,
  afterAll
} from "matchstick-as/assembly/index"
import { Address, BigInt } from "@graphprotocol/graph-ts"
import { BackFundsToClient } from "../generated/schema"
import { BackFundsToClient as BackFundsToClientEvent } from "../generated/SettelmentsControl/SettelmentsControl"
import { handleBackFundsToClient } from "../src/settelments-control"
import { createBackFundsToClientEvent } from "./settelments-control-utils"

// Tests structure (matchstick-as >=0.5.0)
// https://thegraph.com/docs/en/subgraphs/developing/creating/unit-testing-framework/#tests-structure

describe("Describe entity assertions", () => {
  beforeAll(() => {
    let userId = "Example string value"
    let reciever = Address.fromString(
      "0x0000000000000000000000000000000000000001"
    )
    let amount = BigInt.fromI32(234)
    let newBackFundsToClientEvent = createBackFundsToClientEvent(
      userId,
      reciever,
      amount
    )
    handleBackFundsToClient(newBackFundsToClientEvent)
  })

  afterAll(() => {
    clearStore()
  })

  // For more test scenarios, see:
  // https://thegraph.com/docs/en/subgraphs/developing/creating/unit-testing-framework/#write-a-unit-test

  test("BackFundsToClient created and stored", () => {
    assert.entityCount("BackFundsToClient", 1)

    // 0xa16081f360e3847006db660bae1c6d1b2e17ec2a is the default address used in newMockEvent() function
    assert.fieldEquals(
      "BackFundsToClient",
      "0xa16081f360e3847006db660bae1c6d1b2e17ec2a-1",
      "userId",
      "Example string value"
    )
    assert.fieldEquals(
      "BackFundsToClient",
      "0xa16081f360e3847006db660bae1c6d1b2e17ec2a-1",
      "reciever",
      "0x0000000000000000000000000000000000000001"
    )
    assert.fieldEquals(
      "BackFundsToClient",
      "0xa16081f360e3847006db660bae1c6d1b2e17ec2a-1",
      "amount",
      "234"
    )

    // More assert options:
    // https://thegraph.com/docs/en/subgraphs/developing/creating/unit-testing-framework/#asserts
  })
})
