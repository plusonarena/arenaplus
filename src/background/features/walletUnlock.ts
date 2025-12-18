import { ethers } from "ethers";
import type { StoredWalletData, WalletInfo } from "../../types";
import { AVALANCHE_RPC } from "../../constants";
import type { LogFn } from "../core/logger";
import { decryptPrivateKey } from "../../helpers/secureCrypto";

export async function unlockAndInitializeWallet(
  userPassword: string,
  log?: LogFn
): Promise<WalletInfo> {
  const data = await chrome.storage.local.get("walletData");
  if (!data.walletData) {
    throw new Error("No wallet found in storage.");
  }

  const walletData: StoredWalletData = data.walletData;

  try {
    const privateKey = await decryptPrivateKey(
      walletData.encryptedPrivateKey,
      userPassword
    );

    if (!privateKey) {
      throw new Error("Invalid password.");
    }

    const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
    const ethersWallet = new ethers.Wallet(privateKey, provider);

    return {
      address: ethersWallet.address,
      privateKey: ethersWallet.privateKey,
      mnemonic: "",
      provider,
    };
  } catch (decryptError) {
    log?.("Decryption failed", decryptError);
    throw new Error("Invalid password.");
  }
}
