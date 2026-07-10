# CommentBot — AI-Powered Comment Generator

Generate natural, AI-powered comments for WordPress articles using Grok AI.

## Features

- 🤖 AI-generated comments via Grok API
- 🔗 Batch process multiple URLs
- 📋 Copy-to-clipboard per comment
- 📄 Export results as TXT or CSV
- ⚡ Serverless architecture (Vercel)

## Deploy to Vercel

1. Push this repo to GitHub
2. Connect the repo to [Vercel](https://vercel.com)
3. Deploy — no environment variables needed (API key is hardcoded)

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3456`

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS
- **Backend**: Vercel Serverless Functions (Node.js)
- **AI**: Grok API (xAI)
- **HTML Parsing**: node-html-parser
