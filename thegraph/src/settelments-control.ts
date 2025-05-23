import {
  BackFundsToClient as BackFundsToClientEvent,
  BalanceUpdated as BalanceUpdatedEvent,
  ChangeAdmin as ChangeAdminEvent,
  Initialized as InitializedEvent,
  PaymentClientToNative as PaymentClientToNativeEvent,
  TopUpClientBalance as TopUpClientBalanceEvent,
  WithdrawFundsToNative as WithdrawFundsToNativeEvent
} from "../generated/SettelmentsControl/SettelmentsControl"
import {
  BackFundsToClient,
  BalanceUpdated,
  ChangeAdmin,
  Initialized,
  PaymentClientToNative,
  TopUpClientBalance,
  WithdrawFundsToNative
} from "../generated/schema"

export function handleBackFundsToClient(event: BackFundsToClientEvent): void {
  let entity = new BackFundsToClient(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.userId = event.params.userId
  entity.reciever = event.params.reciever
  entity.amount = event.params.amount

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}

export function handleBalanceUpdated(event: BalanceUpdatedEvent): void {
  let entity = new BalanceUpdated(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.user = event.params.user
  entity.newBalance = event.params.newBalance

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}

export function handleChangeAdmin(event: ChangeAdminEvent): void {
  let entity = new ChangeAdmin(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.newAdmin = event.params.newAdmin

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}

export function handleInitialized(event: InitializedEvent): void {
  let entity = new Initialized(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.version = event.params.version

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}

export function handlePaymentClientToNative(
  event: PaymentClientToNativeEvent
): void {
  let entity = new PaymentClientToNative(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.clientId = event.params.clientId
  entity.clientBalance = event.params.clientBalance
  entity.nativeId = event.params.nativeId
  entity.nativeBalance = event.params.nativeBalance
  entity.amount = event.params.amount
  entity.sessionId = event.params.sessionId
  entity.timestamp = event.params.timestamp
  entity.minutesQty = event.params.minutesQty

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}

export function handleTopUpClientBalance(event: TopUpClientBalanceEvent): void {
  let entity = new TopUpClientBalance(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.userId = event.params.userId
  entity.amount = event.params.amount
  entity.currentClientBalance = event.params.currentClientBalance
  entity.sender = event.params.sender

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}

export function handleWithdrawFundsToNative(
  event: WithdrawFundsToNativeEvent
): void {
  let entity = new WithdrawFundsToNative(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.userId = event.params.userId
  entity.reciever = event.params.reciever
  entity.amount = event.params.amount

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}
