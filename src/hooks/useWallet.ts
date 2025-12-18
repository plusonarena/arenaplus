import { useState, useCallback } from "react";
import { ethers } from "ethers";
import {
  WalletInfo,
  TokenInfo,
  StoredWalletData,
} from "../types";
import { AVALANCHE_RPC, TOKENS_MAP, PLUS_TOKEN, TOKENS } from "../constants";
import { encryptPrivateKey } from "../helpers/secureCrypto";

export const useWallet = () => {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [transferLoading, setTransferLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);

  const getTokenBalance = useCallback(async (address: string) => {
    try {
      const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
      const tokenInfos: TokenInfo[] = [];

      for (const token of TOKENS) {
        if (token.isNative) {
          const balanceWei = await provider.getBalance(address);
          tokenInfos.push({
            balance: ethers.formatEther(balanceWei),
            symbol: token.symbol,
            decimals: token.decimals,
            address: token.address,
          });
        } else if (token.abi) {
          const contract = new ethers.Contract(
            token.address,
            token.abi,
            provider
          );
          const [balRaw, decimals, symbol] = await Promise.all([
            contract.balanceOf(address),
            contract.decimals(),
            contract.symbol(),
          ]);
          tokenInfos.push({
            balance: ethers.formatUnits(balRaw, decimals),
            symbol,
            decimals,
            address: token.address,
          });
        }
      }

      setTokens(tokenInfos);
    } catch (err) {
      console.error("Error fetching token balances:", err);
      setError("Failed to fetch token balances");
    }
  }, []);

  const init = useCallback(() => {
    setLoading(true);
    chrome.runtime.sendMessage({ type: "GET_APP_STATE" }, (response) => {
      if (response.isUnlocked && response.wallet) {
        setWallet(response.wallet);
        setIsUnlocked(true);
        getTokenBalance(response.wallet.address);
      } else {
        setIsUnlocked(false);
      }
      setLoading(false);
    });
  }, [getTokenBalance]);

  const unlockWallet = useCallback(
    async (password: string) => {
      setLoading(true);
      setError(null);
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: "UNLOCK_WALLET", password },
          (response) => {
            if (response.success && response.wallet) {
              setWallet(response.wallet);
              setIsUnlocked(true);
              getTokenBalance(response.wallet.address);
              resolve(response.wallet);
            } else {
              setError(response.error || "Failed to unlock wallet.");
              setIsUnlocked(false);
              reject(new Error(response.error || "Failed to unlock wallet."));
            }
            setLoading(false);
          }
        );
      });
    },
    [getTokenBalance]
  );

  const lockWallet = useCallback(() => {
    chrome.runtime.sendMessage({ type: "LOCK_WALLET" }, () => {
      setWallet(null);
      setIsUnlocked(false);
      setTokens([]);
    });
  }, []);

  const storeWallet = useCallback(
    async (privateKey: string, address: string, userPassword: string) => {
      try {
        const encryptedPrivateKey = await encryptPrivateKey(
          privateKey,
          userPassword
        );

        const walletData: StoredWalletData = {
          encryptedPrivateKey,
          address,
        };

        await chrome.storage.local.set({ walletData });
      } catch (err) {
        console.error("Error storing wallet:", err);
        throw err;
      }
    },
    []
  );

  const createNewWallet = useCallback(
    async (password: string) => {
      try {
        setLoading(true);
        setError(null);
        setTokens([]);

        if (!password) {
          setError("Please set a password for your wallet");
          return;
        }

        const randomWallet = ethers.Wallet.createRandom();
        const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
        const connectedWallet = randomWallet.connect(provider);

        await storeWallet(
          connectedWallet.privateKey,
          connectedWallet.address,
          password
        );

        await unlockWallet(password);
      } catch (err) {
        setError("Failed to create wallet. Please try again.");
        console.error("Wallet creation error:", err);
      } finally {
        setLoading(false);
      }
    },
    [storeWallet, unlockWallet]
  );

  const importWalletWithPrivateKey = useCallback(
    async (privateKey: string, password?: string) => {
      try {
        setLoading(true);
        setError(null);

        if (!password) {
          setError("Please set a password for your wallet");
          return false;
        }

        if (!ethers.isHexString(privateKey, 32)) {
          setError("Invalid private key format. Please check and try again.");
          return false;
        }

        const tempWallet = new ethers.Wallet(privateKey);

        await storeWallet(tempWallet.privateKey, tempWallet.address, password);

        await unlockWallet(password);

        return true;
      } catch (err) {
        setError("Failed to import wallet. Please check your private key.");
        console.error("Wallet import error:", err);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [storeWallet, unlockWallet]
  );

  const importWalletWithMnemonic = useCallback(
    async (phrase: string, password?: string) => {
      try {
        setLoading(true);
        setError(null);

        if (!password) {
          setError("Please set a password for your wallet");
          return false;
        }

        if (!ethers.Mnemonic.isValidMnemonic(phrase)) {
          setError("Invalid seed phrase. Please check and try again.");
          return false;
        }

        const mnemonicWallet = ethers.Wallet.fromPhrase(phrase);

        await storeWallet(
          mnemonicWallet.privateKey,
          mnemonicWallet.address,
          password
        );

        await unlockWallet(password);

        return true;
      } catch (err) {
        setError("Failed to import wallet. Please check your seed phrase.");
        console.error("Wallet import error:", err);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [storeWallet, unlockWallet]
  );

  const transferTokens = useCallback(
    async (toAddress: string, amount: string, tokenSymbol?: string) => {
      try {
        setTransferLoading(true);
        setError(null);

        if (!wallet?.privateKey) {
          throw new Error("Wallet not connected");
        }

        if (!ethers.isAddress(toAddress)) {
          throw new Error("Invalid recipient address format");
        }

        if (isNaN(Number(amount)) || Number(amount) <= 0) {
          throw new Error("Amount must be a positive number");
        }

        const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
        const signer = new ethers.Wallet(wallet.privateKey, provider);

        const token = tokenSymbol ? TOKENS_MAP[tokenSymbol] : TOKENS[0];
        if (!token) {
          throw new Error("Unsupported token");
        }

        if (token.isNative) {
          const parsedAmount = ethers.parseEther(amount);
          const balance = await provider.getBalance(wallet.address);
          const gasPrice = await provider.getFeeData();
          const estimatedGasCost = gasPrice.gasPrice
            ? gasPrice.gasPrice * BigInt(21000)
            : BigInt(0);

          if (balance < parsedAmount + estimatedGasCost) {
            throw new Error("Insufficient AVAX balance (including gas fees)");
          }

          const tx = await signer.sendTransaction({
            to: toAddress,
            value: parsedAmount,
          });
          await tx.wait();
        } else {
          const tokenContract = new ethers.Contract(
            PLUS_TOKEN.address,
            token.abi as any,
            signer
          );

          const decimals = await tokenContract.decimals();
          const parsedAmount = ethers.parseUnits(amount, decimals);
          const balance = await tokenContract.balanceOf(wallet.address);

          if (balance < parsedAmount) {
            throw new Error(`Insufficient ${token.symbol} balance`);
          }

          const tx = await tokenContract.transfer(toAddress, parsedAmount);
          await tx.wait();
        }

        await getTokenBalance(wallet.address);
        return true;
      } catch (err: any) {
        const errorMessage = err.message.includes("user rejected action")
          ? "Transaction was cancelled"
          : err.message || "An unknown error occurred during transfer";

        console.error("Transfer error:", err);
        setError(errorMessage);
        throw new Error(errorMessage);
      } finally {
        setTransferLoading(false);
      }
    },
    [wallet, getTokenBalance]
  );

  return {
    wallet,
    loading,
    transferLoading,
    error,
    isUnlocked,
    tokens,
    init,
    unlockWallet,
    lockWallet,
    createNewWallet,
    importWalletWithPrivateKey,
    importWalletWithMnemonic,
    storeWallet,
    transferTokens,
    getTokenBalance,
  };
};

export default useWallet;
