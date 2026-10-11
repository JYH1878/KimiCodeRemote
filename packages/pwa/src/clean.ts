// Message-stream cleaning: decide what the chat UI renders and recover the
// user's own words from harness-injected envelopes (injections, skill
// activations, task notifications). Pure functions - no React, no browser APIs.

import type { Message } from './types.js';

export type MessageClass = 'hidden' | 'assistant' | 'user' | 'skill';

export interface CleanedUserMessage {
  /** non-null for skill activations */
  skillName: string | null;
  /** the user's own words, stripped of harness noise; '' -> render nothing */
  userText: string;
  /** skill instructions excerpt for the expandable detail (skill only) */
  rawText: string;
}

export function classifyMessage(m: Message): MessageClass {
  if (m.role === 'tool' || m.role === 'system') return 'hidden';
  const kind = m.metadata?.origin?.kind;
  // injection: <system-reminder> noise; task: background-task <notification>
  if (kind === 'injection' || kind === 'task') return 'hidden';
  if (kind === 'skill_activation') return 'skill';
  if (m.role === 'assistant') return 'assistant';
  return 'user';
}

// <system-reminder>…</system-reminder> and <system>…</system> are harness
// noise injected into prompts (date notices, image-compression notes, …).
export function stripHarnessNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<system>[\s\S]*?<\/system>/g, '')
    .trim();
}

function messageText(m: Message): string {
  return m.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('')
    .trim();
}

// "[name](kimi-code://skill/name) rest…" mention marker prepended to skillArgs
function stripSkillMention(text: string): string {
  return text.replace(/^\s*\[[^\]]*\]\(kimi-code:\/\/skill\/[^)]*\)\s*/, '').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// display_text ends with one bare attachment filename per line - drop those
function stripAttachmentLines(text: string, names: string[]): string {
  if (names.length === 0) return text.trim();
  const lines = text.split('\n');
  while (lines.length > 0) {
    const last = (lines[lines.length - 1] ?? '').trim();
    if (last === '' || names.includes(last)) lines.pop();
    else break;
  }
  return lines.join('\n').trim();
}

function attachmentNames(m: Message): string[] {
  const out: string[] = [];
  for (const cm of m.metadata?.origin?.clientMetadata ?? []) {
    for (const a of cm?.kimi_code_composer?.attachments ?? []) {
      if (a?.name) out.push(a.name);
    }
  }
  return out;
}

// body fallback: drop the activation envelope, keep any real user text
function stripActivationEnvelope(text: string): string {
  return stripHarnessNoise(
    text
      .replace(/<skill-loaded\b[\s\S]*?<\/skill-loaded>/g, '')
      .replace(/User activated the skill "[^"]*"\..*?(\n|$)/g, '')
      .replace(/Skill tool loaded instructions[^\n]*(\n|$)/g, ''),
  );
}

// composer artifact: trailing "Attached image file: <path>" lines are
// attachment serialization noise, not user words
function stripTrailingAttachedLines(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0) {
    const last = (lines[lines.length - 1] ?? '').trim();
    if (last === '' || /^Attached (image|file)(\sfile)?:/i.test(last)) lines.pop();
    else break;
  }
  return lines.join('\n').trim();
}

const EXCERPT_MAX = 600;

// skill instructions excerpt for the expandable detail
function skillExcerpt(rawBody: string): string {
  const m = rawBody.match(/<skill-loaded\b[^>]*>([\s\S]*?)<\/skill-loaded>/);
  const body = stripHarnessNoise(m?.[1] ?? '').trim();
  return body.length > EXCERPT_MAX ? `${body.slice(0, EXCERPT_MAX)}…` : body;
}

export function cleanUserMessage(m: Message): CleanedUserMessage {
  const origin = m.metadata?.origin;
  if (origin?.kind !== 'skill_activation') {
    return { skillName: null, userText: stripHarnessNoise(messageText(m)), rawText: '' };
  }
  const skillName = typeof origin.skillName === 'string' ? origin.skillName : '';
  const rawBody = messageText(m);
  let userText = typeof origin.skillArgs === 'string' ? stripSkillMention(origin.skillArgs) : '';
  if (!userText) {
    const display =
      origin.clientMetadata?.find((cm) => typeof cm?.display_text === 'string')?.display_text ??
      '';
    let d = stripAttachmentLines(display, attachmentNames(m));
    if (skillName) d = d.replace(new RegExp(`^${escapeRegExp(skillName)}\\s*`), '').trim();
    userText = d;
  }
  if (!userText) userText = stripActivationEnvelope(rawBody);
  userText = stripTrailingAttachedLines(userText);
  // safety: the instruction envelope must never surface as the user's words
  // (model-triggered loads carry no user words -> they clean to '')
  if (
    userText.includes('skill-loaded') ||
    userText.includes('User activated the skill') ||
    userText.includes('Skill tool loaded instructions')
  ) {
    userText = '';
  }
  return { skillName, userText, rawText: skillExcerpt(rawBody) };
}
