/**
 * Newsreel WhatsApp — Reply handler
 *
 * When a user taps a poll button or sends a text reply,
 * this generates a conversational response. The tone should
 * feel like a smart friend, not a bot. Think Boardy-level human.
 */

import { loadEnv } from './env.js';
loadEnv();

import { getTodayPolls, logPollResponse, getSubscriberByPhone, logAwaitingRebuttal, getAwaitingRebuttal, clearAwaitingRebuttal, saveUserTake, getUserPollHistory, getPollsByDateAndIdx } from './supabase.js';
import { sendTextReply, sendFollowUp } from './whatsapp.js';
import { getStoryPerspectives, findContrastingVoice, formatPerspectiveMessage, findMultiplePerspectives, formatSpectrumMessage } from './perspectives.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const APP_URL = process.env.APP_URL || 'https://newsreel.co';

/**
 * Handle an incoming poll button tap
 * payload format: "poll:2026-03-13:0:agree" or "poll:2026-03-13:0:strongly_agree"
 */
export async function handlePollResponse(phone, payload) {
  const parts = payload.split(':');
  const date = parts[1];
  const storyIdxStr = parts[2];
  const stance = parts.slice(3).join('_'); // handles "strongly_agree" etc
  const storyIdx = parseInt(storyIdxStr, 10);

  // Log the response
  await logPollResponse(phone, date, storyIdx, stance);

  // Get the poll data for context
  const polls = await getTodayPolls(date);
  const poll = polls.find(p => p.story_idx === storyIdx);
  if (!poll) {
    await sendTextReply(phone, "Got it, logged your answer. Something went wrong loading the story though, sorry about that.");
    return;
  }

  // Get subscriber name
  const sub = await getSubscriberByPhone(phone);
  const name = sub?.first_name || '';

  // Generate a conversational reply using Claude
  const reply = await generateReply(name, poll, stance);
  await sendTextReply(phone, reply);

  // Pull real perspectives from the perspectives database
  // Match the poll's story to a perspectives story by headline similarity
  const stories = await getStoryPerspectives(date);
  const matchedStory = matchStoryToPoll(stories, poll);

  if (matchedStory) {
    // Send a real contrasting voice quote
    const contrastVoice = findContrastingVoice(matchedStory, stance);
    const perspMsg = formatPerspectiveMessage(contrastVoice, stance);

    if (perspMsg) {
      // Small delay so messages arrive in order
      await new Promise(r => setTimeout(r, 1000));
      await sendTextReply(phone, perspMsg);

      // The critical thinking prompt — make them engage with the other side
      await new Promise(r => setTimeout(r, 1500));
      const voiceName = contrastVoice.voiceName.split(' ')[0]; // first name only
      await sendFollowUp(phone,
        `What would you say back to ${voiceName}?`,
        [
          { id: `rebut:${date}:${storyIdx}`, title: 'Send my take' },
          { id: `perspectives:${date}:${storyIdx}`, title: 'See more takes' },
          { id: `read:${date}:${storyIdx}`, title: 'Read the story' },
        ]
      );
      return; // don't send the generic follow-up
    }
  }

  // Fallback follow-up if no perspectives available
  await sendFollowUp(phone,
    `Want to go deeper?`,
    [
      { id: `read:${date}:${storyIdx}`, title: 'Read the story' },
      { id: `perspectives:${date}:${storyIdx}`, title: 'See all perspectives' },
    ]
  );
}

/**
 * Handle a free-text reply (quiz answer, general message)
 */
export async function handleTextReply(phone, text) {
  const cleaned = text.trim().toUpperCase();

  // Check for opt-out first
  if (['STOP', 'UNSUBSCRIBE', 'QUIT'].includes(cleaned)) {
    const { removeSubscriber } = await import('./supabase.js');
    await removeSubscriber(phone);
    await sendTextReply(phone, "You're unsubscribed. No more messages from us. If you ever want back in, just text START.");
    return;
  }

  // Check if it's a poll vote via text reply to template
  const stanceMap = {
    'STRONGLY AGREE': 'strongly_agree',
    'AGREE': 'agree',
    'NEUTRAL': 'neutral',
    'DISAGREE': 'disagree',
    'STRONGLY DISAGREE': 'strongly_disagree',
  };
  if (stanceMap[cleaned]) {
    // Find today's lead poll and treat this as a vote
    const today = new Date().toISOString().split('T')[0];
    const polls = await getTodayPolls(today);
    if (polls.length) {
      // Pick story_idx 0 as the lead (same as what send.js picks)
      const poll = polls.reduce((best, p) => (!best || p.story_idx < best.story_idx) ? p : best, null);
      const payload = `poll:${today}:${poll.story_idx}:${stanceMap[cleaned]}`;
      await handlePollResponse(phone, payload);
      return;
    }
  }

  // Check if it's a quiz answer (A, B, C, D)
  if (['A', 'B', 'C', 'D'].includes(cleaned)) {
    await sendTextReply(phone, `Got it, ${cleaned}. Quiz scoring coming soon.`);
    return;
  }

  // Check if user is in "rebuttal mode" — they tapped "Send my take"
  const pending = await getAwaitingRebuttal(phone);
  if (pending) {
    // Save their rebuttal
    await saveUserTake(phone, pending.date, pending.story_idx, text.trim());
    await clearAwaitingRebuttal(phone);

    await sendTextReply(phone, "Logged. If it's one of the best takes we'll share it anonymously tomorrow. Real people's words hit different than AI summaries.");

    // Trigger the forward prompt after a short delay
    await new Promise(r => setTimeout(r, 1500));
    await sendForwardPrompt(phone, pending.date, pending.story_idx);
    return;
  }

  // General reply — but make it useful, not dismissive
  await sendTextReply(phone, "Noted. I'll have today's poll for you tomorrow morning — that's when the real conversation starts.");
}

/**
 * Handle follow-up button taps (read story, see perspectives)
 */
export async function handleFollowUpButton(phone, buttonId) {
  const [action, date, storyIdxStr] = buttonId.split(':');
  const storyIdx = parseInt(storyIdxStr, 10);

  if (action === 'rebut') {
    // User tapped "Send my take" — prompt them to text their response
    await sendTextReply(phone, 'Just type it out. One or two sentences, in your own words. Best ones get shared anonymously with other readers tomorrow.');
    // Mark this user as "awaiting rebuttal" so we capture their next text
    await logAwaitingRebuttal(phone, date, storyIdx);
    return;
  }

  if (action === 'read') {
    const storyUrl = `${APP_URL}/story/${date}/${storyIdx}`;
    await sendTextReply(phone, storyUrl);

    // After reading, offer the forward prompt
    await new Promise(r => setTimeout(r, 1500));
    await sendFollowUp(phone,
      'Think someone you know would have a strong take on this? Forward this poll to them.',
      [
        { id: `forward:${date}:${storyIdx}`, title: 'Forward this' },
        { id: `skip_forward:${date}:${storyIdx}`, title: "I'm good" },
      ]
    );
    return;
  }

  if (action === 'perspectives') {
    // Pull real perspectives and match to the correct story
    const stories = await getStoryPerspectives(date);
    const polls = await getTodayPolls(date);
    const poll = polls.find(p => p.story_idx === storyIdx);
    const matched = poll ? matchStoryToPoll(stories, poll) : null;
    if (matched) {
      const voices = findMultiplePerspectives(matched, null, 3);
      const spectrumMsg = formatSpectrumMessage(voices);
      if (spectrumMsg) {
        await sendTextReply(phone, spectrumMsg);

        // After perspectives, offer the forward prompt
        await new Promise(r => setTimeout(r, 1500));
        await sendFollowUp(phone,
          'Think someone you know would have a strong take on this? Forward this poll to them.',
          [
            { id: `forward:${date}:${storyIdx}`, title: 'Forward this' },
            { id: `skip_forward:${date}:${storyIdx}`, title: "I'm good" },
          ]
        );
        return;
      }
    }

    // Fallback to link if perspectives unavailable
    const perspUrl = `${APP_URL}/perspectives/${date}/${storyIdx}`;
    await sendTextReply(phone, `${perspUrl}\n\nSee how creators, journalists, and politicians are framing this differently.`);

    await new Promise(r => setTimeout(r, 1500));
    await sendFollowUp(phone,
      'Think someone you know would have a strong take on this? Forward this poll to them.',
      [
        { id: `forward:${date}:${storyIdx}`, title: 'Forward this' },
        { id: `skip_forward:${date}:${storyIdx}`, title: "I'm good" },
      ]
    );
    return;
  }
}

/**
 * Handle the "Forward this" / "I'm good" prompt
 */
export async function handleForwardButton(phone, buttonId) {
  const [action, date, storyIdxStr] = buttonId.split(':');
  const storyIdx = parseInt(storyIdxStr, 10);

  if (action === 'forward') {
    // Send a shareable text block they can copy/forward
    const polls = await getTodayPolls(date);
    const poll = polls.find(p => p.story_idx === storyIdx);
    const question = poll?.question || 'Today\'s Newsreel poll';
    const headline = poll?.headline || '';

    const shareText = [
      `*${headline}*`,
      ``,
      `"${question}"`,
      ``,
      `Vote and see what real people think.`,
      `Text JOIN to +1 (203) 733-0151 to get tomorrow's poll.`,
      ``,
      `— Newsreel`,
    ].join('\n');

    await sendTextReply(phone, shareText);
    await new Promise(r => setTimeout(r, 1000));
    await sendTextReply(phone, 'Just forward that message to whoever you think would have a strong take.');

    // After forward, show the profile prompt
    await new Promise(r => setTimeout(r, 1500));
    await sendProfilePrompt(phone, date, storyIdx);
    return;
  }

  if (action === 'skip_forward') {
    // Skip forward, go straight to profile prompt
    await sendProfilePrompt(phone, date, storyIdx);
    return;
  }
}

/**
 * Handle the "See my profile" / "Maybe later" prompt
 */
export async function handleProfileButton(phone, buttonId) {
  const [action, date, storyIdxStr] = buttonId.split(':');

  if (action === 'profile') {
    // Generate and send their Newsreel profile
    const insight = await generateProfileInsight(phone);
    await sendTextReply(phone, insight);
    await new Promise(r => setTimeout(r, 1000));
    await sendTextReply(phone, "See you tomorrow morning with a new story. Stay sharp.");
    return;
  }

  if (action === 'skip_profile') {
    await sendTextReply(phone, "No worries. See you tomorrow morning.");
    return;
  }
}

/**
 * Send the "Forward to friends" prompt
 */
async function sendForwardPrompt(phone, date, storyIdx) {
  await sendFollowUp(phone,
    'Think someone you know would have a strong take on this? Forward this poll to them.',
    [
      { id: `forward:${date}:${storyIdx}`, title: 'Forward this' },
      { id: `skip_forward:${date}:${storyIdx}`, title: "I'm good" },
    ]
  );
}

/**
 * Send the "See your Newsreel profile" prompt
 */
async function sendProfilePrompt(phone, date, storyIdx) {
  await sendFollowUp(phone,
    'Want to see where you stand? Based on your votes, here\'s your Newsreel profile.',
    [
      { id: `profile:${date}:${storyIdx}`, title: 'See my profile' },
      { id: `skip_profile:${date}:${storyIdx}`, title: 'Maybe later' },
    ]
  );
}

/**
 * Generate a profile insight from the user's voting history using Claude
 */
async function generateProfileInsight(phone) {
  const history = await getUserPollHistory(phone, 20);

  if (!history.length) {
    return "You haven't voted on enough polls yet for a profile. Keep going and check back after a few more.";
  }

  // Enrich with poll questions
  const pairs = history.map(h => ({ date: h.date, story_idx: h.story_idx }));
  const pollData = await getPollsByDateAndIdx(pairs);

  // Build a map for quick lookup
  const pollMap = {};
  for (const p of pollData) {
    pollMap[`${p.date}:${p.story_idx}`] = p;
  }

  // Count patterns
  const total = history.length;
  const counts = { strongly_agree: 0, agree: 0, neutral: 0, disagree: 0, strongly_disagree: 0 };
  for (const h of history) {
    if (counts[h.response] !== undefined) counts[h.response]++;
  }

  const agreeTotal = counts.strongly_agree + counts.agree;
  const disagreeTotal = counts.strongly_disagree + counts.disagree;

  // Build context for Claude
  const voteSummary = history.slice(0, 10).map(h => {
    const poll = pollMap[`${h.date}:${h.story_idx}`];
    return `- "${poll?.question || 'Unknown poll'}" → ${h.response.replace('_', ' ')}`;
  }).join('\n');

  if (!ANTHROPIC_API_KEY) {
    // Fallback without Claude
    const agreePercent = Math.round((agreeTotal / total) * 100);
    const disagreePercent = Math.round((disagreeTotal / total) * 100);
    return `*Your Newsreel Profile*\n\nYou've voted on ${total} poll${total === 1 ? '' : 's'}.\n\nAgreed: ${agreePercent}%\nDisagreed: ${disagreePercent}%\nNeutral: ${Math.round((counts.neutral / total) * 100)}%\n\nYou ${agreeTotal > disagreeTotal ? 'tend to agree with the framing of our poll questions' : disagreeTotal > agreeTotal ? 'tend to push back against the framing' : 'split pretty evenly'}.`;
  }

  const prompt = `You're Newsreel, generating a brief WhatsApp profile insight for a user based on their poll voting history.

Here are their recent votes:
${voteSummary}

Stats: ${total} total votes. Agreed ${agreeTotal} times, disagreed ${disagreeTotal} times, neutral ${counts.neutral} times.

Write a 3-4 sentence WhatsApp-style profile insight. Rules:
- Start with "*Your Newsreel Profile*" (WhatsApp bold)
- Include their vote count
- Note any patterns (do they lean agree or disagree? Are they contrarian or consensus-driven?)
- If possible, note what topics they seem most opinionated on
- Tone: direct, smart, like a friend who actually pays attention
- NEVER use em dashes, emojis, or exclamation marks
- NEVER be patronizing or say "great" or "interesting"
- Keep it under 400 characters total`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error('Claude profile API error:', await res.text());
      return `*Your Newsreel Profile*\n\n${total} polls voted on. You ${agreeTotal > disagreeTotal ? 'lean toward agreement' : 'tend to push back'}. More votes, sharper profile.`;
    }

    const data = await res.json();
    return data.content[0].text;
  } catch (err) {
    console.error('Claude profile failed:', err.message);
    return `*Your Newsreel Profile*\n\n${total} polls voted on. You ${agreeTotal > disagreeTotal ? 'lean toward agreement' : 'tend to push back'}. More votes, sharper profile.`;
  }
}

// ─── Claude-powered reply generation ────

async function generateReply(name, poll, stance) {
  if (!ANTHROPIC_API_KEY) {
    return getFallbackReply(name, poll, stance);
  }

  const prompt = `You're Newsreel, texting someone on WhatsApp about today's news. They just responded to a poll.

The poll statement was: "${poll.question}"
About: ${poll.headline}
They ${
  stance === 'strongly_agree' ? 'strongly agreed' :
  stance === 'agree' ? 'agreed' :
  stance === 'disagree' ? 'disagreed' :
  stance === 'strongly_disagree' ? 'strongly disagreed' :
  'were neutral'
}.
Their name: ${name || 'unknown'}

Write a WhatsApp reply (2-3 sentences max). Rules:
- Sound like a real person texting, not a bot or a brand
- Acknowledge their take genuinely, don't just validate them
- Add one interesting angle or fact they might not have considered
- If they agreed, gently surface the strongest counter-argument
- If they disagreed, acknowledge why someone might see it their way
- NEVER use em dashes, emojis, or exclamation marks
- NEVER say "great point" or "interesting take" or anything patronizing
- Don't start with their name
- Keep it under 200 characters if possible
- End with something that makes them think, not a question`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error('Claude API error:', await res.text());
      return getFallbackReply(name, poll, stance);
    }

    const data = await res.json();
    return data.content[0].text;
  } catch (err) {
    console.error('Claude reply failed:', err.message);
    return getFallbackReply(name, poll, stance);
  }
}

/**
 * Match a perspectives story to a poll by headline keyword overlap.
 * The poll has a headline from the newsletter, the perspectives API
 * has headlines from the voice-clustering pipeline — they may not
 * match exactly, so we do fuzzy keyword matching.
 */
function matchStoryToPoll(stories, poll) {
  if (!stories?.length || !poll?.headline) return null;

  const pollWords = poll.headline.toLowerCase().split(/\s+/)
    .filter(w => w.length > 3); // skip small words

  let bestMatch = null;
  let bestScore = 0;

  for (const story of stories) {
    const storyHeadline = (story.headline || '').toLowerCase();
    const score = pollWords.filter(w => storyHeadline.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = story;
    }
  }

  // Require at least 2 keyword matches to avoid sending wrong story's perspectives
  return bestScore >= 2 ? bestMatch : null;
}

function getFallbackReply(name, poll, stance) {
  const takes = {
    strongly_agree: poll.ai_take_agree,
    agree: poll.ai_take_agree,
    neutral: poll.ai_take_neutral,
    disagree: poll.ai_take_disagree,
    strongly_disagree: poll.ai_take_disagree,
  };

  const take = takes[stance] || takes.neutral;
  if (take) {
    return `Logged. Here's another way to look at it: ${take.split('.').slice(0, 2).join('.')}.`;
  }
  return `Logged your take on "${poll.headline.slice(0, 50)}." More on this tomorrow.`;
}
