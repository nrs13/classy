// Smoke-test Ask Classy against Gemini. Requires web/.env Firebase keys.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const path = join(root, '.env');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = loadEnv();
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || '',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: env.VITE_FIREBASE_APP_ID || '',
};

if (!firebaseConfig.apiKey) {
  console.error('Missing web/.env Firebase keys. Copy .env.example → .env first.');
  process.exit(1);
}

const knowledge = JSON.parse(
  readFileSync(join(root, 'public/data/knowledge.json'), 'utf8'),
);

const systemInstruction = `You are Classy's analyst. Answer briefly from the DATA. No markdown, no LaTeX, no em dashes.
DATA: ${JSON.stringify(knowledge)}`;

const app = initializeApp(firebaseConfig);
const ai = getAI(app, { backend: new GoogleAIBackend() });
const model = getGenerativeModel(ai, {
  model: 'gemini-3.5-flash-lite',
  systemInstruction,
  generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
});

const prompt =
  "Is A_V5's peak activation high or low compared to the other 9 videos? Keep it to 4 sentences.";

const result = await model.generateContent(prompt);
console.log(result.response.text());
