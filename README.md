# Arena Plus Chrome Extension

Arena Plus is a powerful Chrome extension designed to enhance your experience on the Arena social platform.

## 🚀 Installation Guide

Since this extension is in active development, you can install it manually using the following steps:

### 1. Download the Extension
1. Go to the [Releases](https://github.com/plusonarena/arenaplus/releases) page of this repository.
2. Find the latest version (e.g., `v2.0.0`).
3. ⚠️ **IMPORTANT**: Download the `arena-plus-extension.zip` file from the **Assets** section.  
   *Do NOT download the "Source code" zip, as it will not work.*
4. Extract (unzip) the downloaded file to a folder on your computer.

### 2. Load into Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** by toggling the switch in the top-right corner.
3. Click the **Load unpacked** button.
4. Select the folder you just extracted (it should contain `manifest.json`).
5. The extension is now installed!

---

## 🛠 Development Setup

If you want to contribute or build the extension from source:

### Prerequisites
- [Node.js](https://nodejs.org/) (v20 or higher)
- [npm](https://www.npmjs.com/)

### Steps
1. **Clone the repository:**
   ```bash
   git clone https://github.com/plusonarena/arenaplus.git
   cd arenaplus
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file in the root directory and add your Supabase credentials:
   ```env
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   ```

4. **Build the extension:**
   ```bash
   npm run build
   ```
   The built extension will be in the `dist/` folder.

5. **Run in Development Mode:**
   ```bash
   npm run dev
   ```

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 📞 Support

For support or questions, please contact the development team at [plusonarena@gmail.com](mailto:plusonarena@gmail.com).
