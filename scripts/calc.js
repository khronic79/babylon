import { keccak256, toUtf8Bytes, AbiCoder } from "ethers";

function calculateStorageSlot() {
  // 1. Вычисляем keccak256("SettelmentsControl.storage")
  const labelHash = keccak256(toUtf8Bytes("SettelmentsControl.storage"));

  // 2. Преобразуем в BigInt и вычитаем 1
  const numericHash = BigInt(labelHash) - 1n;

  // 3. Кодируем в ABI формат (32 байта)
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["uint256"],
    [numericHash],
  );

  // 4. Вычисляем keccak256 от закодированных данных
  const slotHash = keccak256(encoded);

  // 5. Создаём маску (обнуляем последний байт)
  const mask = BigInt(
    "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00",
  );
  const finalSlot = BigInt(slotHash) & mask;

  // Возвращаем как hex строку с 0x
  return "0x" + finalSlot.toString(16).padStart(64, "0");
}

const storageSlot = calculateStorageSlot();
console.log("Storage Slot:", storageSlot);
