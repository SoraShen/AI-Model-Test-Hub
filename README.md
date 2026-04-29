<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/0cd42339-8425-4fe1-a1e1-cbab9258b4e3

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Create `.env.local` and set `ENCRYPTION_KEY` (used to encrypt model API keys at rest):
   - `cp .env.example .env.local`
   - `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   - set `ENCRYPTION_KEY="...base64..."` in `.env.local`
3. Run the app:
   `npm run dev`
