import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { ethers } from "ethers";
import "../index.css";
import {
  createWallet,
  importWalletFromPrivateKey,
  importWalletFromMnemonic,
  encryptWallet,
  saveWallet,
  isWalletSetup,
} from "../services/walletService";
import { Eye, EyeOff, Copy, Check, ArrowUpRight } from "lucide-react";

// Define CSS with Tailwind classes aligned to the new blue/emerald theme
const styles = {
  container:
    "fixed inset-0 overflow-hidden overscroll-none bg-gradient-to-br from-blue-50 via-white to-emerald-50 flex items-center justify-center p-6",
  card: "w-[92%] max-w-lg rounded-2xl border border-blue-100/60 bg-white/90 p-6 shadow-xl backdrop-blur",
  header: "text-2xl font-bold text-slate-800 text-center mb-1",
  subheader: "text-sm font-semibold text-slate-700 mb-2",
  input:
    "w-full p-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500",
  button:
    "gradient-button w-full py-2.5 px-4 rounded-xl hover:opacity-95 transition duration-200 text-white",
  errorText: "text-rose-600 text-sm mb-4",
  infoText: "text-slate-500 text-sm mb-4",
  mnemonicBox:
    "bg-slate-50 p-3 rounded-lg border border-slate-200 mb-3 text-sm break-words",
  walletInfo: "bg-slate-50 p-3 rounded-lg border border-slate-200 mb-4",
  walletAddress: "font-mono text-sm break-all",
  disclaimer: "text-xs text-slate-400 mt-4 text-center",
  loadingSpinner:
    "animate-spin h-5 w-5 mr-2 border-t-2 border-b-2 border-white rounded-full",
  flexCenter: "flex items-center justify-center",
  gradientBadge:
    "bg-gradient-to-r from-blue-500 to-emerald-500 text-white px-2.5 py-0.5 rounded-full text-[11px] font-medium",
};

// Welcome component
function Welcome() {
  const [tab, setTab] = useState("create"); // 'create' or 'import'
  const [privateKey, setPrivateKey] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [importMethod, setImportMethod] = useState("privateKey"); // 'privateKey' or 'mnemonic'
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [wallet, setWallet] = useState<
    ethers.HDNodeWallet | ethers.Wallet | null
  >(null);
  const [error, setError] = useState("");
  const [setupMessage, setSetupMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const [alreadySetup, setAlreadySetup] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showImportPassword, setShowImportPassword] = useState(false);
  const [showImportConfirmPassword, setShowImportConfirmPassword] =
    useState(false);
  // Multi-step create flow: 'password' -> 'reveal' -> 'verify'
  const [createStep, setCreateStep] = useState<
    "password" | "reveal" | "verify"
  >("password");
  const [verifyIndices, setVerifyIndices] = useState<number[]>([]);
  const [verifyInputs, setVerifyInputs] = useState<Record<number, string>>({});
  const [copiedSeed, setCopiedSeed] = useState(false);
  // Two-step import flow: 'method' -> 'password'
  const [importStep, setImportStep] = useState<"method" | "password">("method");

  // Check if wallet is already set up
  useEffect(() => {
    const checkWalletSetup = async () => {
      const setup = await isWalletSetup();
      setAlreadySetup(setup);

      if (setup) {
        setSetupMessage(
          "Wallet is already set up. You can close this tab and click on the extension icon to use your wallet."
        );
      }
    };

    checkWalletSetup();
  }, []);

  const copySeed = async () => {
    try {
      if (!wallet || !("mnemonic" in wallet) || !wallet.mnemonic) return;
      await navigator.clipboard.writeText(wallet.mnemonic.phrase);
      setCopiedSeed(true);
      setTimeout(() => setCopiedSeed(false), 1500);
    } catch (e) {
      // noop
    }
  };

  // Move to verify: pick 3 unique random indices from the mnemonic
  const startVerify = () => {
    if (!wallet || !("mnemonic" in wallet) || !wallet.mnemonic) {
      setError("Mnemonic not available.");
      return;
    }
    setError("");
    const words = wallet.mnemonic.phrase.trim().split(/\s+/);
    const total = words.length;
    const picks = new Set<number>();
    while (picks.size < Math.min(3, total)) {
      const idx = Math.floor(Math.random() * total); // 0-based
      picks.add(idx);
    }
    const selected = Array.from(picks).sort((a, b) => a - b);
    setVerifyIndices(selected);
    setVerifyInputs({});
    setCreateStep("verify");
  };

  const handleVerifyMnemonic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet || !("mnemonic" in wallet) || !wallet.mnemonic) {
      setError("Mnemonic not available.");
      return;
    }
    const words = wallet.mnemonic.phrase.trim().split(/\s+/);
    for (const idx of verifyIndices) {
      const input = (verifyInputs[idx] || "").trim().toLowerCase();
      if (input !== words[idx].toLowerCase()) {
        setError(`Word #${idx + 1} does not match.`);
        return;
      }
    }
    setError("");
    // Persist only now (after successful verification)
    try {
      const encryptedWallet = await encryptWallet(wallet as any, password);
      await saveWallet(encryptedWallet);
      setSetupComplete(true);
    } catch (err) {
      setError("Failed to save wallet. Please try again.");
    }
  };

  // Handle tab change
  const handleTabChange = (newTab: string) => {
    setTab(newTab);
    setError("");
    setSetupMessage("");
    if (newTab === "create") {
      setCreateStep("password");
    } else if (newTab === "import") {
      setImportStep("method");
    }
  };

  // Create new wallet
  const handleCreateWallet = async () => {
    try {
      setLoading(true);
      setError("");
      setSetupMessage("");

      // Validate password
      if (!password) {
        setError("Please enter a password");
        setLoading(false);
        return;
      }

      if (password !== confirmPassword) {
        setError("Passwords do not match");
        setLoading(false);
        return;
      }

      if (password.length < 8) {
        setError("Password must be at least 8 characters long");
        setLoading(false);
        return;
      }

      // Create wallet
      const newWallet = await createWallet();
      setWallet(newWallet);

      // Do NOT save yet — save only after verification passes
      // Proceed to reveal step
      setCreateStep("reveal");
    } catch (err) {
      console.error("Error creating wallet:", err);
      setError("Failed to create wallet. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Import wallet from private key or mnemonic
  const handleImportWallet = async () => {
    try {
      setLoading(true);
      setError("");
      setSetupMessage("");

      // Validate inputs
      if (importMethod === "privateKey") {
        if (!privateKey) {
          setError("Please enter a private key");
          setLoading(false);
          return;
        }
      } else {
        if (!mnemonic) {
          setError("Please enter your seed phrase");
          setLoading(false);
          return;
        }
      }

      if (!password) {
        setError("Please enter a password");
        setLoading(false);
        return;
      }

      if (password !== confirmPassword) {
        setError("Passwords do not match");
        setLoading(false);
        return;
      }

      if (password.length < 8) {
        setError("Password must be at least 8 characters long");
        setLoading(false);
        return;
      }

      // Import wallet
      const importedWallet =
        importMethod === "privateKey"
          ? await importWalletFromPrivateKey(privateKey)
          : await importWalletFromMnemonic(mnemonic);
      setWallet(importedWallet);

      // Encrypt and save wallet
      const encryptedWallet = await encryptWallet(importedWallet, password);
      await saveWallet(encryptedWallet);

      setSetupMessage("Wallet imported successfully!");
      setSetupComplete(true);
    } catch (err) {
      console.error("Error importing wallet:", err);
      setError(
        "Failed to import wallet. Please check your input and try again."
      );
    } finally {
      setLoading(false);
    }
  };

  // Handle continue to extension
  const handleContinue = () => {
    window.close();
  };

  // If wallet is already set up, show message
  if (alreadySetup) {
    return (
      <div className={styles.container}>
        <div className="pointer-events-none absolute -top-10 -left-10 h-40 w-40 rounded-full bg-gradient-to-br from-blue-400/20 to-emerald-400/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-10 -right-10 h-40 w-40 rounded-full bg-gradient-to-br from-emerald-400/20 to-blue-400/20 blur-3xl" />
        <div className={styles.card}>
          <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-gradient-to-br from-blue-500/15 to-emerald-500/15 flex items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-7 w-7 text-blue-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <h1 className={styles.header}>Arena Wallet</h1>
          <p className="text-base text-slate-800 text-center font-medium mt-2 mb-5">
            {setupMessage}
          </p>
          <button className={styles.button} onClick={handleContinue}>
            Continue to Extension
          </button>
        </div>
      </div>
    );
  }

  // If setup is complete, show success message and continue button
  if (setupComplete) {
    return (
      <div className={styles.container}>
        <div className="pointer-events-none absolute -top-10 -left-10 h-40 w-40 rounded-full bg-gradient-to-br from-blue-400/20 to-emerald-400/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-10 -right-10 h-40 w-40 rounded-full bg-gradient-to-br from-emerald-400/20 to-blue-400/20 blur-3xl" />
        <div className="relative w-full max-w-3xl">
          <div className="relative flex flex-col gap-6 rounded-[2.5rem] border border-blue-100/70 bg-white/80 p-6 shadow-2xl backdrop-blur-xl md:p-10">
            <div className="absolute inset-x-4 top-4 -z-10 rounded-full bg-gradient-to-r from-blue-500/10 via-emerald-400/10 to-blue-500/10 py-8 blur-2xl" />
            <div className="relative z-10">
              <div className="w-16 h-16 mb-4 rounded-2xl bg-gradient-to-br from-blue-500/15 to-emerald-500/15 flex items-center justify-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-9 w-9 text-blue-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.8}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-slate-900">
                Arena Wallet is Ready!
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                You&apos;re all set. Access your wallet anytime from the browser
                toolbar.
              </p>

              {wallet && "mnemonic" in wallet && wallet.mnemonic && (
                <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-700">
                      Recovery Phrase
                    </h2>
                    <button
                      type="button"
                      onClick={copySeed}
                      aria-label="Copy recovery phrase"
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
                    >
                      {copiedSeed ? (
                        <>
                          <Check className="h-4 w-4 text-emerald-600" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-4 w-4" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
                    {wallet.mnemonic.phrase
                      .trim()
                      .split(/\s+/)
                      .map((word, index) => (
                        <div
                          key={index}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-800 shadow-sm"
                        >
                          <span className="mr-1 text-xs font-semibold text-slate-400">
                            {index + 1}.
                          </span>
                          {word}
                        </div>
                      ))}
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-slate-500">
                    Store these words offline in a secure location. Anyone who
                    has them can access your funds.
                  </p>
                </div>
              )}

              <div className="mt-6 space-y-3">
                <div className="rounded-2xl border border-slate-200 bg-white/80 p-4">
                  <h2 className="text-sm font-semibold text-slate-700">
                    Wallet Address
                  </h2>
                  <p className="mt-2 rounded-xl border border-blue-100 bg-blue-50/70 p-3 font-mono text-sm text-slate-800">
                    {wallet?.address}
                  </p>
                </div>
                <button
                  className={`${styles.button} flex items-center justify-center gap-2`}
                  onClick={handleContinue}
                >
                  Continue to Extension
                  <ArrowUpRight className="h-4 w-4" />
                </button>
                <p className="text-sm text-slate-500">
                  You can now close this tab and click on the extension icon to
                  start using Arena Wallet.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Main welcome screen
  return (
    <div className={styles.container}>
      <div className="pointer-events-none absolute -top-10 -left-10 h-40 w-40 rounded-full bg-gradient-to-br from-blue-400/20 to-emerald-400/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-10 -right-10 h-40 w-40 rounded-full bg-gradient-to-br from-emerald-400/20 to-blue-400/20 blur-3xl" />
      <div className={styles.card}>
        <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-gradient-to-br from-blue-500/15 to-emerald-500/15 flex items-center justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-8 w-8 text-blue-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
        </div>

        <div className="mb-2 flex justify-center">
          <span className={styles.gradientBadge}>ARENA PLUS</span>
        </div>
        <h1 className="mb-2 text-center text-2xl font-bold text-slate-800">
          Arena Wallet Setup
        </h1>
        <p className="mb-6 text-center text-sm text-slate-500">
          Create a new wallet or import an existing one to get started.
        </p>

        {/* Segmented control for steps */}
        <div className="mb-6 flex rounded-lg bg-slate-100 p-1">
          <button
            onClick={() => handleTabChange("create")}
            className={`${
              tab === "create"
                ? "bg-gradient-to-r from-blue-500 to-emerald-500 text-white shadow"
                : "text-slate-600 hover:text-slate-800"
            } flex-1 rounded-md py-2 text-sm font-medium transition`}
          >
            Create New
          </button>
          <button
            onClick={() => handleTabChange("import")}
            className={`${
              tab === "import"
                ? "bg-gradient-to-r from-blue-500 to-emerald-500 text-white shadow"
                : "text-slate-600 hover:text-slate-800"
            } flex-1 rounded-md py-2 text-sm font-medium transition`}
          >
            Import Existing
          </button>
        </div>

        {!(tab === "create" && createStep === "verify") && error && (
          <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-md text-sm">
            <p>{error}</p>
          </div>
        )}

        {tab === "create" && createStep === "password" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreateWallet();
            }}
          >
            <div className="mb-5 rounded-xl border border-blue-100 bg-blue-50/60 p-4">
              <div className="mb-4">
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password (min 8 characters)"
                    className={`${styles.input} h-11 pr-12 mb-2`}
                    disabled={loading}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Toggle password visibility"
                    onMouseDown={(e) => e.preventDefault()}
                    className="absolute inset-y-0 right-2 my-auto grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? (
                      <EyeOff className="block h-5 w-5" />
                    ) : (
                      <Eye className="block h-5 w-5" />
                    )}
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showConfirmPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm password"
                    className={`${styles.input} h-11 pr-12`}
                    disabled={loading}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Toggle confirm password visibility"
                    onMouseDown={(e) => e.preventDefault()}
                    className="absolute inset-y-0 right-2 my-auto grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  >
                    {showConfirmPassword ? (
                      <EyeOff className="block h-5 w-5" />
                    ) : (
                      <Eye className="block h-5 w-5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
            <button
              type="submit"
              className={`${styles.button} flex items-center justify-center`}
              disabled={loading}
            >
              {loading ? (
                <span className={styles.flexCenter}>
                  <span className={styles.loadingSpinner}></span>
                  Creating...
                </span>
              ) : (
                <>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="mr-2 h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                    />
                  </svg>
                  Create Wallet
                </>
              )}
            </button>
          </form>
        )}

        {tab === "create" &&
          createStep === "reveal" &&
          wallet &&
          "mnemonic" in wallet &&
          wallet.mnemonic && (
            <div className="mb-5 rounded-xl border border-blue-100 bg-blue-50/60 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">
                  Your Recovery Phrase
                </h3>
                <button
                  type="button"
                  onClick={copySeed}
                  aria-label="Copy recovery phrase"
                  className="grid h-8 w-8 place-items-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                >
                  {copiedSeed ? (
                    <Check className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2 text-sm">
                {wallet.mnemonic.phrase
                  .trim()
                  .split(/\s+/)
                  .map((w, i) => (
                    <div
                      key={i}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-800"
                    >
                      <span className="mr-1 text-slate-400">{i + 1}.</span>
                      {w}
                    </div>
                  ))}
              </div>
              <p className="mt-3 text-xs text-slate-500">
                Write these 12/24 words in order and keep them somewhere safe.
                Anyone with these words can control your wallet.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  className="w-full rounded-xl border border-slate-200 bg-white py-2.5 text-slate-700 hover:bg-slate-50"
                  onClick={() => {
                    setError("");
                    setCreateStep("password");
                  }}
                >
                  Back
                </button>
                <button className={`${styles.button}`} onClick={startVerify}>
                  I've saved it, Continue
                </button>
              </div>
            </div>
          )}

        {tab === "create" &&
          createStep === "verify" &&
          wallet &&
          "mnemonic" in wallet &&
          wallet.mnemonic && (
            <form onSubmit={handleVerifyMnemonic}>
              <div className="mb-5 rounded-xl border border-blue-100 bg-blue-50/60 p-4">
                <h3 className="mb-3 text-sm font-semibold text-slate-700">
                  Verify your Recovery Phrase
                </h3>
                <div className="grid grid-cols-3 gap-3">
                  {verifyIndices.map((idx) => (
                    <div key={idx} className="space-y-1">
                      <label className="block text-xs font-medium text-slate-600">
                        Word #{idx + 1}
                      </label>
                      <input
                        value={verifyInputs[idx] || ""}
                        onChange={(e) =>
                          setVerifyInputs((s) => ({
                            ...s,
                            [idx]: e.target.value,
                          }))
                        }
                        className={`${styles.input}`}
                        placeholder={`Enter word #${idx + 1}`}
                      />
                    </div>
                  ))}
                </div>
                {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
                <div className="mt-4 flex gap-3">
                  <button
                    type="button"
                    className="w-full rounded-xl border border-slate-200 bg-white py-2.5 text-slate-700 hover:bg-slate-50"
                    onClick={() => {
                      setError("");
                      setCreateStep("reveal");
                    }}
                  >
                    Back
                  </button>
                  <button type="submit" className={`${styles.button}`}>
                    Verify & Finish
                  </button>
                </div>
              </div>
            </form>
          )}

        {tab === "import" && importStep === "method" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (importMethod === "privateKey") {
                if (!privateKey.trim()) {
                  setError("Please enter a private key");
                  return;
                }
              } else {
                if (!mnemonic.trim()) {
                  setError("Please enter your seed phrase");
                  return;
                }
              }
              setError("");
              setImportStep("password");
            }}
          >
            <div className="mb-5 rounded-xl border border-blue-100 bg-blue-50/60 p-4">
              <div className="mb-4 flex space-x-4">
                <label className="flex items-center text-sm font-medium text-gray-700">
                  <input
                    type="radio"
                    className="mr-1"
                    checked={importMethod === "privateKey"}
                    onChange={() => setImportMethod("privateKey")}
                  />
                  Private Key
                </label>
                <label className="flex items-center text-sm font-medium text-gray-700">
                  <input
                    type="radio"
                    className="mr-1"
                    checked={importMethod === "mnemonic"}
                    onChange={() => setImportMethod("mnemonic")}
                  />
                  Seed Phrase
                </label>
              </div>

              {importMethod === "privateKey" ? (
                <div className="mb-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Private Key
                  </label>
                  <input
                    type="text"
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder="Enter private key"
                    className={`${styles.input}`}
                    disabled={loading}
                  />
                </div>
              ) : (
                <div className="mb-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Seed Phrase
                  </label>
                  <textarea
                    value={mnemonic}
                    onChange={(e) => setMnemonic(e.target.value)}
                    placeholder="Enter 12 or 24 word phrase"
                    className={`${styles.input} resize-none`}
                    disabled={loading}
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                className="rounded-xl border border-slate-200 bg-white py-2.5 text-slate-700 hover:bg-slate-50"
                onClick={() => {
                  setError("");
                  setTab("create");
                }}
              >
                Back
              </button>
              <button type="submit" className={`${styles.button}`}>
                Continue
              </button>
            </div>
          </form>
        )}

        {tab === "import" && importStep === "password" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleImportWallet();
            }}
          >
            <div className="mb-5 rounded-xl border border-blue-100 bg-blue-50/60 p-4">
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showImportPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password (min 8 characters)"
                    className={`${styles.input} h-11 pr-12 mb-2`}
                    disabled={loading}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Toggle password visibility"
                    onMouseDown={(e) => e.preventDefault()}
                    className="absolute inset-y-0 right-2 my-auto grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    onClick={() => setShowImportPassword(!showImportPassword)}
                  >
                    {showImportPassword ? (
                      <EyeOff className="block h-5 w-5" />
                    ) : (
                      <Eye className="block h-5 w-5" />
                    )}
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showImportConfirmPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm password"
                    className={`${styles.input} h-11 pr-12`}
                    disabled={loading}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Toggle confirm password visibility"
                    onMouseDown={(e) => e.preventDefault()}
                    className="absolute inset-y-0 right-2 my-auto grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    onClick={() =>
                      setShowImportConfirmPassword(!showImportConfirmPassword)
                    }
                  >
                    {showImportConfirmPassword ? (
                      <EyeOff className="block h-5 w-5" />
                    ) : (
                      <Eye className="block h-5 w-5" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                className="rounded-xl border border-slate-200 bg-white py-2.5 text-slate-700 hover:bg-slate-50"
                onClick={() => {
                  setError("");
                  setImportStep("method");
                }}
              >
                Back
              </button>
              <button type="submit" className={`${styles.button}`}>
                Import Wallet
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// Render the Welcome component
ReactDOM.createRoot(document.getElementById("welcome-root")!).render(
  <React.StrictMode>
    <Welcome />
  </React.StrictMode>
);
