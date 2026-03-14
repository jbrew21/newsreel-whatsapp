/**
 * Newsreel WhatsApp — Perspectives integration
 *
 * Pulls real creator/journalist/commentator quotes from the
 * Newsreel perspectives API and formats them for WhatsApp.
 *
 * The magic: after you vote on a poll, you get REAL human quotes
 * from people who see the story differently than you do.
 * Not AI summaries — actual words from actual people.
 */

import { loadEnv } from './env.js';
loadEnv();

const CMS_API_URL = process.env.CMS_API_URL || 'https://newsreel-cms.onrender.com/api';
const PERSPECTIVES_API = 'https://newsreel-perspectives.onrender.com/api';

/**
 * Fetch today's stories with voice perspectives
 * Falls back to local CMS if perspectives service is down
 */
export async function getStoryPerspectives(date) {
  try {
    const res = await fetch(`${PERSPECTIVES_API}/stories`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      return res.json();
    }
  } catch (err) {
    console.log('  Perspectives API unavailable, skipping:', err.message);
  }
  return [];
}

/**
 * Find the best contrasting perspective for a user's poll stance.
 *
 * If they agreed → find a voice from a critical/opposing cluster
 * If they disagreed → find a voice from a supporting cluster
 * If neutral → find the most interesting take from any cluster
 *
 * Returns { voiceName, quote, clusterName, photo, platform } or null
 */
export function findContrastingVoice(story, userStance) {
  if (!story?.clusters?.length) return null;

  const clusters = story.clusters;

  // Classify clusters as "supportive" or "critical" based on name heuristics
  const criticalKeywords = ['critic', 'opposition', 'against', 'skeptic', 'concern', 'dissent', 'pushback'];
  const supportiveKeywords = ['support', 'hawk', 'benefit', 'favor', 'defend', 'pro-', 'advocate'];

  const isAgreeing = ['agree', 'strongly_agree'].includes(userStance);
  const isDisagreeing = ['disagree', 'strongly_disagree'].includes(userStance);

  // Score each cluster on how "opposing" it is to the user's stance
  const scoredClusters = clusters.map(cluster => {
    const nameLower = (cluster.name || '').toLowerCase();
    let score = 0;

    if (isAgreeing) {
      // User agreed → we want critical/opposing clusters
      if (criticalKeywords.some(k => nameLower.includes(k))) score += 3;
      if (supportiveKeywords.some(k => nameLower.includes(k))) score -= 2;
    } else if (isDisagreeing) {
      // User disagreed → we want supportive clusters
      if (supportiveKeywords.some(k => nameLower.includes(k))) score += 3;
      if (criticalKeywords.some(k => nameLower.includes(k))) score -= 2;
    } else {
      // Neutral → pick the most interesting (highest voice count, not tangential)
      if (nameLower.includes('tangential') || nameLower.includes('broader')) score -= 3;
      score += (cluster.voiceCount || 0);
    }

    // Penalize tangential/broader clusters for everyone
    if (nameLower.includes('tangential')) score -= 5;

    return { cluster, score };
  });

  // Sort by score descending
  scoredClusters.sort((a, b) => b.score - a.score);

  // Pick the best cluster, then the best voice within it
  for (const { cluster } of scoredClusters) {
    const voice = pickBestVoice(cluster.voices);
    if (voice) {
      return {
        voiceName: voice.voiceName,
        quote: cleanQuote(voice.quote),
        clusterName: cluster.name,
        photo: voice.photo,
        platform: voice.platform,
        sourceUrl: voice.sourceUrl,
      };
    }
  }

  return null;
}

/**
 * Format a perspectives message for WhatsApp.
 * Concise, punchy, human. Not a bot.
 */
export function formatPerspectiveMessage(voice, userStance) {
  if (!voice) return null;

  const intro = pickIntro(userStance);
  const attribution = voice.platform
    ? `— ${voice.voiceName} (${voice.platform})`
    : `— ${voice.voiceName}`;

  return `${intro}\n\n"${voice.quote}"\n${attribution}`;
}

/**
 * Get multiple contrasting voices for a richer perspective view
 * Returns up to 2 voices from different clusters
 */
export function findMultiplePerspectives(story, userStance, maxVoices = 2) {
  if (!story?.clusters?.length) return [];

  const voices = [];
  const usedClusters = new Set();

  for (const cluster of story.clusters) {
    if (usedClusters.size >= maxVoices) break;

    const nameLower = (cluster.name || '').toLowerCase();
    // Skip tangential clusters
    if (nameLower.includes('tangential') || nameLower.includes('broader')) continue;

    const voice = pickBestVoice(cluster.voices);
    if (voice && !usedClusters.has(cluster.name)) {
      voices.push({
        voiceName: voice.voiceName,
        quote: cleanQuote(voice.quote),
        clusterName: cluster.name,
        platform: voice.platform,
      });
      usedClusters.add(cluster.name);
    }
  }

  return voices;
}

/**
 * Format a multi-perspective message showing the full spectrum
 */
export function formatSpectrumMessage(voices) {
  if (!voices.length) return null;

  let msg = 'Here\'s how people are seeing this differently:\n';

  for (const v of voices) {
    const platform = v.platform ? ` on ${v.platform}` : '';
    msg += `\n*${v.voiceName}*${platform}:\n"${v.quote}"\n`;
  }

  return msg;
}

// ─── Internal helpers ─────────────────────

function pickBestVoice(voices) {
  if (!voices?.length) return null;

  // Filter for voices with actual substantive quotes
  const good = voices.filter(v => {
    const q = v.quote || '';
    // Skip very short quotes, pure links, or "Video" placeholders
    return q.length > 30 && !q.startsWith('http') && q !== 'Video';
  });

  if (!good.length) return voices[0]; // fallback to first voice

  // Prefer quotes under 200 chars (better for WhatsApp)
  const concise = good.filter(v => v.quote.length <= 200);
  return concise.length ? concise[0] : good[0];
}

function cleanQuote(quote) {
  if (!quote) return '';

  return quote
    // Remove trailing "Video" or "Link" artifacts
    .replace(/\n*Video\s*$/i, '')
    .replace(/\n*Link\s*$/i, '')
    // Collapse multiple newlines
    .replace(/\n{2,}/g, ' ')
    // Trim and cap at 280 chars for WhatsApp readability
    .trim()
    .slice(0, 280);
}

function pickIntro(userStance) {
  const intros = {
    strongly_agree: [
      'Not everyone sees it that way though.',
      'Here\'s the strongest counter-argument.',
      'Worth hearing the other side on this one.',
    ],
    agree: [
      'A lot of people agree with you. But not everyone.',
      'Here\'s a different take worth considering.',
      'Not everyone\'s on the same page here.',
    ],
    neutral: [
      'Here\'s one of the sharper takes on this.',
      'This voice had something interesting to say.',
      'People feel strongly about this one.',
    ],
    disagree: [
      'Here\'s why some people see it differently.',
      'The other side has a case too.',
      'Someone making the opposite argument.',
    ],
    strongly_disagree: [
      'Here\'s the strongest case for the other side.',
      'Not saying they\'re right, but worth hearing.',
      'The most compelling argument you\'d push back on.',
    ],
  };

  const options = intros[userStance] || intros.neutral;
  return options[Math.floor(Math.random() * options.length)];
}
