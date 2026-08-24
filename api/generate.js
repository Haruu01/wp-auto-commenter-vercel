import { parse } from 'node-html-parser';

// ── Hardcoded Config ────────────────────────────────────────────────────────
const GROK_API_KEY = process.env.GROK_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_NAME = 'Joenathan';
const DEFAULT_EMAIL = 'berita@esaunggul.ac.id';
const DEFAULT_WEBSITE = 'https://www.esaunggul.ac.id/';

// ── Delay Config (in seconds) ───────────────────────────────────────────────
const DELAY_MIN_SEC = 8; // Minimum delay between comments
const DELAY_MAX_SEC = 11; // Maximum delay between comments

function randomDelay() {
  const ms = (Math.floor(Math.random() * (DELAY_MAX_SEC - DELAY_MIN_SEC + 1)) + DELAY_MIN_SEC) * 1000;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Fetch Page HTML ─────────────────────────────────────────────────────────
async function fetchPageHtml(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
  } catch (fetchErr) {
    const msg = fetchErr.name === 'TimeoutError'
      ? `Timeout: ${url} tidak merespons dalam 15 detik`
      : `Gagal koneksi ke ${url}: ${fetchErr.cause?.message || fetchErr.message}`;
    throw new Error(msg);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} dari ${url}`);
  }

  return await res.text();
}

// ── Extract Article Text ────────────────────────────────────────────────────
function extractArticleText(html) {
  const root = parse(html);

  const removeTags = ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'iframe'];
  for (const tag of removeTags) {
    root.querySelectorAll(tag).forEach(el => el.remove());
  }

  const selectors = ['article', '.entry-content', '.post-content', '.article-content', 'main', '.content'];
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) {
      const text = el.text.replace(/\s+/g, ' ').trim();
      if (text.length > 100) return text;
    }
  }

  const bodyText = root.querySelector('body')?.text.replace(/\s+/g, ' ').trim() || '';
  return bodyText;
}

// ── Extract WP Comment Form Data ────────────────────────────────────────────
function extractCommentFormData(html, pageUrl) {
  const root = parse(html);

  // Find the comment form
  const form = root.querySelector('#commentform') || root.querySelector('form[action*="wp-comments-post"]');
  if (!form) {
    return null;
  }

  // Get form action URL
  let actionUrl = form.getAttribute('action') || '';
  if (!actionUrl) {
    // Default WP comment post URL
    try {
      const u = new URL(pageUrl);
      actionUrl = `${u.origin}/wp-comments-post.php`;
    } catch {
      return null;
    }
  }

  // Make sure it's an absolute URL
  if (actionUrl.startsWith('/')) {
    try {
      const u = new URL(pageUrl);
      actionUrl = `${u.origin}${actionUrl}`;
    } catch {
      return null;
    }
  }

  // Extract comment_post_ID
  const postIdInput = form.querySelector('input[name="comment_post_ID"]');
  const commentPostId = postIdInput?.getAttribute('value') || '';

  // Extract comment_parent (for replies, usually 0)
  const parentInput = form.querySelector('input[name="comment_parent"]');
  const commentParent = parentInput?.getAttribute('value') || '0';

  // Extract any hidden fields (nonces, etc.)
  const hiddenFields = {};
  form.querySelectorAll('input[type="hidden"]').forEach(inp => {
    const name = inp.getAttribute('name');
    const value = inp.getAttribute('value') || '';
    if (name && name !== 'comment_post_ID' && name !== 'comment_parent') {
      hiddenFields[name] = value;
    }
  });

  return {
    actionUrl,
    commentPostId,
    commentParent,
    hiddenFields,
  };
}

// ── Submit Comment to WordPress ─────────────────────────────────────────────
async function submitComment({ actionUrl, commentPostId, commentParent, hiddenFields, comment, name, email, website, pageUrl }) {
  const formData = new URLSearchParams();
  formData.append('comment', comment);
  formData.append('author', name);
  formData.append('email', email);
  formData.append('url', website);
  formData.append('comment_post_ID', commentPostId);
  formData.append('comment_parent', commentParent);

  // Add any hidden fields (nonces, etc.)
  for (const [key, value] of Object.entries(hiddenFields)) {
    formData.append(key, value);
  }

  let res;
  try {
    res = await fetch(actionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': pageUrl,
        'Origin': new URL(pageUrl).origin,
      },
      body: formData.toString(),
      redirect: 'manual', // Don't auto-follow — we need the redirect URL
      signal: AbortSignal.timeout(20000),
    });
  } catch (fetchErr) {
    const msg = fetchErr.name === 'TimeoutError'
      ? 'Timeout saat submit komentar'
      : `Gagal submit: ${fetchErr.cause?.message || fetchErr.message}`;
    throw new Error(msg);
  }

  // WordPress typically redirects (302/303) to the comment URL after successful submission
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') || '';
    return {
      success: true,
      commentUrl: location,
    };
  }

  // If 200, the comment might have been posted and we're on the page
  if (res.status === 200) {
    // Try to extract comment URL from the response body
    const responseHtml = await res.text();

    // Check if there's an error message (duplicate, too fast, etc.)
    if (responseHtml.includes('Duplicate comment detected') || responseHtml.includes('duplicate')) {
      throw new Error('Komentar duplikat terdeteksi — komentar ini sudah pernah dikirim');
    }
    if (responseHtml.includes('too quickly') || responseHtml.includes('terlalu cepat')) {
      throw new Error('Terlalu cepat — tunggu beberapa detik sebelum mengirim komentar lagi');
    }
    if (responseHtml.includes('Comments are closed') || responseHtml.includes('Komentar ditutup')) {
      throw new Error('Komentar ditutup untuk artikel ini');
    }

    return {
      success: true,
      commentUrl: pageUrl, // Fallback to page URL
    };
  }

  // Error responses
  if (res.status === 409) {
    throw new Error('Komentar duplikat terdeteksi');
  }
  if (res.status === 429) {
    throw new Error('Terlalu banyak komentar — coba lagi nanti');
  }

  throw new Error(`Submit gagal: HTTP ${res.status}`);
}

// ── AI Comment Generation ───────────────────────────────────────────────────
async function generateGrokComment(articleText, retryCount = 0) {
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-3-mini',
        messages: [
          {
            role: 'user',
            content: `Baca artikel berikut dan buatkan 1 komentar yang sangat natural, relevan, apresiatif, dan menarik. PENTING: Gunakan bahasa yang SAMA PERSIS dengan bahasa yang digunakan pada artikel tersebut (misal: jika artikel dalam bahasa Inggris, komentar WAJIB dalam bahasa Inggris; jika bahasa Indonesia, WAJIB bahasa Indonesia, dsb). Panjang komentar sekitar 2-4 kalimat. Jangan memberikan teks pengantar seperti "Berikut adalah komentar:" dll, cukup output isi komentarnya saja tanpa tanda kutip.\n\nArtikel:\n${articleText.substring(0, 5000)}`,
          },
        ],
      }),
    });

    if (response.status === 429) {
      if (retryCount < 2) {
        await new Promise(resolve => setTimeout(resolve, 15000));
        return generateGrokComment(articleText, retryCount + 1);
      }
      throw new Error('Rate limit exceeded after retries');
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Grok API error: ${response.status} — ${errText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error(`Error generating Grok comment (attempt ${retryCount + 1}):`, error.message);
    if (error.message.includes('Rate limit') && retryCount < 2) {
      await new Promise(resolve => setTimeout(resolve, 15000));
      return generateGrokComment(articleText, retryCount + 1);
    }
    throw error;
  }
}

async function generateComment(articleText, retryCount = 0) {
  try {
    const prompt = `Baca artikel berikut dan buatkan 1 komentar yang sangat natural, relevan, apresiatif, dan menarik. PENTING: Gunakan bahasa yang SAMA PERSIS dengan bahasa yang digunakan pada artikel tersebut (misal: jika artikel dalam bahasa Inggris, komentar WAJIB dalam bahasa Inggris; jika bahasa Indonesia, WAJIB bahasa Indonesia, dsb). Panjang komentar sekitar 2-4 kalimat. Jangan memberikan teks pengantar seperti "Berikut adalah komentar:" dll, cukup output isi komentarnya saja tanpa tanda kutip.\n\nArtikel:\n${articleText.substring(0, 5000)}`;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.7,
        }
      }),
    });

    if (response.status === 429) {
      if (retryCount < 2) {
        await new Promise(resolve => setTimeout(resolve, 15000));
        return generateComment(articleText, retryCount + 1);
      }
      throw new Error('Gemini Rate limit exceeded after retries');
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error: ${response.status} — ${errText}`);
    }

    const data = await response.json();
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
      return data.candidates[0].content.parts[0].text.trim();
    }
    throw new Error('Unexpected Gemini API response format');
  } catch (error) {
    if (error.message.includes('Rate limit') && retryCount < 2) {
      await new Promise(resolve => setTimeout(resolve, 15000));
      return generateComment(articleText, retryCount + 1);
    }
    
    console.log('Gemini failed, falling back to Grok...');
    try {
      return await generateGrokComment(articleText);
    } catch (grokError) {
      console.error('Grok fallback failed:', grokError.message);
      return 'Artikel ini sangat edukatif dan memotivasi, terima kasih atas insightnya yang mendalam!';
    }
  }
}

// ── Vercel Serverless Handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { urls, name, email, website } = req.body;

  const commenterName = (name || '').trim() || DEFAULT_NAME;
  const commenterEmail = (email || '').trim() || DEFAULT_EMAIL;
  const commenterWebsite = (website || '').trim() || DEFAULT_WEBSITE;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Please provide an array of URLs' });
  }

  if (urls.length > 30) {
    return res.status(400).json({ error: 'Maximum 30 URLs per request' });
  }

  const results = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i].trim();
    if (!url) continue;

    // Add delay between comments (not before the first one)
    if (i > 0) {
      await randomDelay();
    }

    try {
      // 1. Fetch the page HTML
      const html = await fetchPageHtml(url);

      // 2. Extract article text
      const articleText = extractArticleText(html);

      if (articleText.length < 50) {
        results.push({
          url,
          status: 'error',
          comment: '',
          commentUrl: '',
          error: 'Artikel terlalu pendek atau tidak ditemukan',
          commenter: { name: commenterName, email: commenterEmail, website: commenterWebsite },
        });
        continue;
      }

      // 3. Extract comment form data
      const formData = extractCommentFormData(html, url);

      if (!formData) {
        results.push({
          url,
          status: 'error',
          comment: '',
          commentUrl: '',
          error: 'Form komentar tidak ditemukan di halaman ini',
          commenter: { name: commenterName, email: commenterEmail, website: commenterWebsite },
        });
        continue;
      }

      // 4. Generate AI comment
      const comment = await generateComment(articleText);

      // 5. Submit comment to WordPress
      const submitResult = await submitComment({
        ...formData,
        comment,
        name: commenterName,
        email: commenterEmail,
        website: commenterWebsite,
        pageUrl: url,
      });

      results.push({
        url,
        status: 'success',
        comment,
        commentUrl: submitResult.commentUrl || url,
        error: null,
        commenter: { name: commenterName, email: commenterEmail, website: commenterWebsite },
        date: new Date().toLocaleDateString('en-GB'),
      });
    } catch (err) {
      results.push({
        url,
        status: 'error',
        comment: '',
        commentUrl: '',
        error: err.message,
        commenter: { name: commenterName, email: commenterEmail, website: commenterWebsite },
      });
    }
  }

  return res.status(200).json({ results });
}
