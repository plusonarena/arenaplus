import { useState, useEffect } from "react";
import { decryptPrivateKey } from "../helpers/secureCrypto";
import { StoredWalletData } from "../types";

export const usePasswordManager = () => {
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  useEffect(() => {
    checkStoredPassword();
  }, []);

  const checkStoredPassword = async () => {
    const data = await chrome.storage.local.get("walletData");
    setHasStoredPassword(!!data.walletData);
  };

  const verifyPassword = async (password: string): Promise<boolean> => {
    const data = await chrome.storage.local.get("walletData");
    const walletData = data.walletData as StoredWalletData | undefined;
    if (!walletData) return false;
    try {
      await decryptPrivateKey(walletData.encryptedPrivateKey, password);
      return true;
    } catch {
      return false;
    }
  };

  const clearTempPassword = async () => {
    setTempPassword(null);
    setHasStoredPassword(false);
  };

  return {
    hasStoredPassword,
    tempPassword,
    checkStoredPassword,
    verifyPassword,
    clearTempPassword,
  };
};
